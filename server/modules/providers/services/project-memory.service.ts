import path from 'node:path';

import { projectMemoryDb, projectsDb } from '@/modules/database/index.js';
import { obsidianSettingsService } from '@/modules/providers/services/obsidian-settings.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { projectSkillsService } from '@/modules/providers/services/project-skills.service.js';
import {
  buildMemorySkillContent,
  MEMORY_SKILL_DIRECTORY_NAME,
} from '@/modules/providers/shared/memory/memory-skill.template.js';
import { scaffoldVault, type ScaffoldResult } from '@/modules/providers/shared/memory/memory.scaffold.js';
import {
  buildObsidianMcpServerInput,
  OBSIDIAN_MCP_SERVER_NAME,
} from '@/modules/providers/shared/memory/obsidian-mcp.config.js';
import type {
  LLMProvider,
  ProjectMemoryConfigInput,
  ProjectMemoryProviderResult,
  ProjectMemoryStatus,
} from '@/shared/types.js';
import {
  AppError,
  normalizeProjectPath,
  readJsonConfig,
  readObjectRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * Project memory (Obsidian second brain).
 *
 * Enabling memory for a project does three things, each reusing existing
 * cross-agent machinery:
 *   1. installs the `obsidian` MCP server into every agent (MCP fan-out), so any
 *      agent run in the workspace can read/write the vault at runtime;
 *   2. installs the canonical "Memory" project skill into every agent (skills
 *      fan-out), teaching them the read/write contract;
 *   3. scaffolds the project's folder inside the vault on disk.
 *
 * A manifest (`.cloudcli/memory/.managed.json`) records what was installed so
 * teardown is exact. Disabling never deletes vault notes — memory is durable.
 */

const MANAGED_DIR_SEGMENTS = ['.cloudcli', 'memory'] as const;
const MANIFEST_FILE_NAME = '.managed.json';

type MemoryManifest = {
  providers: LLMProvider[];
  mcpServerName: string;
  skillInstalled: boolean;
  updatedAt: string;
};

const resolveWorkspacePath = (workspacePath: string): string => {
  const trimmed = (workspacePath ?? '').trim();
  if (!trimmed) {
    throw new AppError('workspacePath is required for project memory.', {
      code: 'PROJECT_MEMORY_WORKSPACE_REQUIRED',
      statusCode: 400,
    });
  }

  return normalizeProjectPath(trimmed);
};

const getManifestPath = (workspacePath: string): string =>
  path.join(workspacePath, ...MANAGED_DIR_SEGMENTS, MANIFEST_FILE_NAME);

const readManifest = async (workspacePath: string): Promise<MemoryManifest | null> => {
  const raw = await readJsonConfig(getManifestPath(workspacePath));
  const record = readObjectRecord(raw.memory);
  if (!record) {
    return null;
  }

  return {
    providers: Array.isArray(record.providers)
      ? (record.providers.filter((item): item is LLMProvider => typeof item === 'string') as LLMProvider[])
      : [],
    mcpServerName: typeof record.mcpServerName === 'string' ? record.mcpServerName : OBSIDIAN_MCP_SERVER_NAME,
    skillInstalled: record.skillInstalled === true,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
};

const writeManifest = async (workspacePath: string, manifest: MemoryManifest): Promise<void> => {
  await writeJsonConfig(getManifestPath(workspacePath), { memory: manifest });
};

/**
 * Normalizes a vault-relative folder: trims, strips surrounding slashes, and
 * rejects absolute paths or `..` traversal. Defaults to a project-derived name.
 */
const normalizeVaultFolder = (vaultFolder: string, workspacePath: string): string => {
  const fallback = `Projects/${path.basename(workspacePath) || 'project'}`;
  const trimmed = (vaultFolder ?? '').trim();
  const candidate = trimmed || fallback;

  const cleaned = candidate.replace(/^[/\\]+|[/\\]+$/g, '');
  const segments = cleaned.split(/[/\\]+/).filter(Boolean);
  if (path.isAbsolute(candidate) || segments.some((segment) => segment === '..')) {
    throw new AppError('vaultFolder must be a relative path inside the vault.', {
      code: 'MEMORY_VAULT_FOLDER_INVALID',
      statusCode: 400,
    });
  }

  return segments.join('/');
};

const resolveProjectName = (workspacePath: string): string => {
  const row = projectsDb.getProjectPath(workspacePath);
  const custom = typeof row?.custom_project_name === 'string' ? row.custom_project_name.trim() : '';
  return custom || path.basename(workspacePath);
};

const buildStatus = async (workspacePath: string): Promise<ProjectMemoryStatus> => {
  const row = projectMemoryDb.get(workspacePath);
  const settings = obsidianSettingsService.getStatus();
  const manifest = await readManifest(workspacePath);

  return {
    workspacePath,
    enabled: Boolean(row?.enabled),
    vaultFolder: row?.vault_folder ?? '',
    vaultPath: settings.vaultPath || null,
    settingsConfigured: settings.configured,
    providers: manifest?.providers ?? [],
    skillInstalled: manifest?.skillInstalled ?? false,
  };
};

/**
 * Builds the system-prompt preamble injected at run start for a memory-enabled
 * workspace. Synchronous (better-sqlite3) so it can be called inline while
 * mapping spawn options. Returns null when memory is not enabled, so callers can
 * skip injection entirely. This is the app-level guarantee that complements the
 * Memory skill: even if an agent ignores the skill, it is told to use memory.
 */
export const getMemoryPreamble = (workspacePath: string | undefined | null): string | null => {
  const trimmed = (workspacePath ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const row = projectMemoryDb.get(normalizeProjectPath(trimmed));
  if (!row || !row.enabled) {
    return null;
  }

  const folder = row.vault_folder;
  return [
    'This project has a persistent Obsidian memory (a shared second brain).',
    `Its notes live under \`${folder}/\` in the Obsidian vault, reachable via the \`obsidian\` MCP tools.`,
    'Before starting work, load context: read `' + folder + '/00-Overview.md` and search memory for terms relevant to the task.',
    'As you work, record durable decisions and entities into memory, and at the end append a dated entry to `' +
      folder +
      "/Sessions/`. Follow the 'project-memory' skill for the exact conventions.",
  ].join(' ');
};

export const projectMemoryService = {
  async getMemoryStatus(workspacePath: string): Promise<ProjectMemoryStatus> {
    return buildStatus(resolveWorkspacePath(workspacePath));
  },

  /**
   * Enables memory for a project: persists the mapping, installs the Obsidian
   * MCP server and Memory skill into every agent, and scaffolds the vault folder.
   */
  async enableMemory(input: ProjectMemoryConfigInput): Promise<{
    status: ProjectMemoryStatus;
    mcpResults: ProjectMemoryProviderResult[];
    scaffold: ScaffoldResult | null;
  }> {
    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const settings = obsidianSettingsService.getSettings();
    if (!obsidianSettingsService.isConfigured(settings)) {
      throw new AppError('Obsidian vault settings are not configured. Set the vault path first.', {
        code: 'MEMORY_SETTINGS_NOT_CONFIGURED',
        statusCode: 400,
      });
    }

    const vaultFolder = normalizeVaultFolder(input.vaultFolder, workspacePath);

    // 1. Persist the per-project mapping.
    projectMemoryDb.upsert(workspacePath, vaultFolder, true);

    // 2. Install the Obsidian MCP server into every agent.
    const mcpServerInput = buildObsidianMcpServerInput(settings);
    const mcpRaw = await providerMcpService.addMcpServerToAllProviders({
      ...mcpServerInput,
      workspacePath,
      scope: 'project',
    });
    const mcpResults: ProjectMemoryProviderResult[] = mcpRaw.map((result) => ({
      provider: result.provider,
      ok: result.created,
      error: result.error,
    }));
    const installedProviders = mcpResults.filter((result) => result.ok).map((result) => result.provider);

    // 3. Install the Memory skill into every agent (best-effort; MCP is the
    //    functional requirement, the skill is guidance).
    let skillInstalled = false;
    try {
      await projectSkillsService.addProjectSkills({
        workspacePath,
        entries: [
          {
            content: buildMemorySkillContent(vaultFolder),
            directoryName: MEMORY_SKILL_DIRECTORY_NAME,
          },
        ],
      });
      skillInstalled = true;
    } catch {
      skillInstalled = false;
    }

    // 4. Scaffold the vault folder on disk.
    let scaffold: ScaffoldResult | null = null;
    try {
      scaffold = await scaffoldVault({
        vaultPath: settings.vaultPath,
        vaultFolder,
        projectName: resolveProjectName(workspacePath),
      });
    } catch (error) {
      // Surface scaffold failures but keep the enable — the mapping + MCP are set.
      if (error instanceof AppError) {
        throw error;
      }
      scaffold = null;
    }

    await writeManifest(workspacePath, {
      providers: installedProviders,
      mcpServerName: OBSIDIAN_MCP_SERVER_NAME,
      skillInstalled,
      updatedAt: new Date().toISOString(),
    });

    return { status: await buildStatus(workspacePath), mcpResults, scaffold };
  },

  /**
   * Re-runs the vault scaffold for an already-enabled project (idempotent).
   */
  async rescaffold(workspacePath: string): Promise<ScaffoldResult> {
    const resolved = resolveWorkspacePath(workspacePath);
    const row = projectMemoryDb.get(resolved);
    if (!row) {
      throw new AppError('Memory is not enabled for this project.', {
        code: 'MEMORY_NOT_ENABLED',
        statusCode: 400,
      });
    }

    const settings = obsidianSettingsService.getSettings();
    if (!obsidianSettingsService.isConfigured(settings)) {
      throw new AppError('Obsidian vault settings are not configured.', {
        code: 'MEMORY_SETTINGS_NOT_CONFIGURED',
        statusCode: 400,
      });
    }

    return scaffoldVault({
      vaultPath: settings.vaultPath,
      vaultFolder: row.vault_folder,
      projectName: resolveProjectName(resolved),
    });
  },

  /**
   * Disables memory: removes the MCP server and Memory skill from every agent
   * and marks the mapping disabled. Vault notes are intentionally preserved.
   */
  async disableMemory(workspacePath: string): Promise<{
    status: ProjectMemoryStatus;
    mcpResults: ProjectMemoryProviderResult[];
  }> {
    const resolved = resolveWorkspacePath(workspacePath);
    const manifest = await readManifest(resolved);

    const mcpRaw = await providerMcpService.removeMcpServerFromAllProviders({
      name: manifest?.mcpServerName ?? OBSIDIAN_MCP_SERVER_NAME,
      scope: 'project',
      workspacePath: resolved,
    });
    const mcpResults: ProjectMemoryProviderResult[] = mcpRaw.map((result) => ({
      provider: result.provider,
      ok: result.removed,
      error: result.error,
    }));

    try {
      await projectSkillsService.removeProjectSkill({
        workspacePath: resolved,
        directoryName: MEMORY_SKILL_DIRECTORY_NAME,
      });
    } catch {
      // Skill may already be gone; disabling is best-effort teardown.
    }

    projectMemoryDb.setEnabled(resolved, false);
    await writeManifest(resolved, {
      providers: [],
      mcpServerName: OBSIDIAN_MCP_SERVER_NAME,
      skillInstalled: false,
      updatedAt: new Date().toISOString(),
    });

    return { status: await buildStatus(resolved), mcpResults };
  },
};
