import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { readdir, stat } from 'node:fs/promises';

import { projectMemoryDb, projectsDb } from '@/modules/database/index.js';
import { obsidianSettingsService } from '@/modules/providers/services/obsidian-settings.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { mcpCatalogService } from '@/modules/providers/services/mcp-catalog.service.js';
import { projectSkillsService } from '@/modules/providers/services/project-skills.service.js';
import { globalSkillsService } from '@/modules/providers/services/global-skills.service.js';
import {
  MEMORY_SKILL_DIRECTORY_NAME,
  renderMemorySkillTemplate,
} from '@/modules/providers/shared/memory/memory-skill.template.js';
import { scaffoldVault, type ScaffoldResult } from '@/modules/providers/shared/memory/memory.scaffold.js';
import {
  buildObsidianMcpServerInput,
  OBSIDIAN_MCP_SERVER_NAME,
} from '@/modules/providers/shared/memory/obsidian-mcp.config.js';
import type {
  LLMProvider,
  ObsidianConnectionTestResult,
  ObsidianMemorySettings,
  ProjectMemoryConfigInput,
  ProjectMemoryProviderResult,
  ProjectMemorySkillResyncResult,
  ProjectMemoryStatus,
  ProjectMemoryVaultStats,
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
 *   1. ensures the `obsidian` MCP server exists as a **user-scope CloudCLI
 *      catalog** entry (one local definition) and fans it out to agents — the
 *      REST API connection is machine-global, shared by every project;
 *   2. installs the canonical "Memory" project skill into every agent (skills
 *      fan-out), teaching them the read/write contract for *this* vault folder;
 *   3. scaffolds the project's folder inside the vault on disk.
 *
 * A manifest (`.cloudcli/memory/.managed.json`) records skill install status.
 * Disabling one project never removes the global Obsidian MCP while other
 * projects still use memory. Vault notes are never deleted.
 */

/** Providers that can receive the shared Obsidian MCP projection. */
const MEMORY_MCP_PROVIDERS: LLMProvider[] = [
  'claude',
  'cursor',
  'codex',
  'opencode',
  'grok',
  'kimi',
  'agy',
];

/**
 * Upserts the machine-global Obsidian MCP into the CloudCLI catalog (user scope)
 * and syncs projections to agents. Shared by every memory-enabled project.
 */
const ensureObsidianCatalogMcp = async (
  settings: ObsidianMemorySettings,
): Promise<ProjectMemoryProviderResult[]> => {
  const mcpServerInput = buildObsidianMcpServerInput(settings);
  const entry = await mcpCatalogService.upsert({
    ...mcpServerInput,
    scope: 'user',
    providers: MEMORY_MCP_PROVIDERS,
    kind: 'memory',
  });
  return (entry.syncResults ?? []).map((result) => ({
    provider: result.provider,
    ok: result.ok,
    error: result.error,
  }));
};

/**
 * Removes the catalog Obsidian MCP only when no project still has memory enabled.
 */
const maybeRemoveObsidianCatalogMcp = async (): Promise<ProjectMemoryProviderResult[]> => {
  const stillEnabled = projectMemoryDb.list().some((row) => Boolean(row.enabled));
  if (stillEnabled) {
    return [];
  }
  const result = await mcpCatalogService.remove(OBSIDIAN_MCP_SERVER_NAME);
  return (result.syncResults ?? []).map((r) => ({
    provider: r.provider,
    ok: r.ok,
    error: r.error,
  }));
};

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

const directoryExists = async (directoryPath: string): Promise<boolean> => {
  try {
    const stats = await stat(directoryPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

/**
 * Probes the Obsidian Local REST API root with the saved credentials. The
 * plugin serves a self-signed certificate on https, so verification is disabled
 * there; the API key is the actual credential.
 */
const requestObsidianRoot = (
  settings: ObsidianMemorySettings,
): Promise<{ statusCode: number; body: string }> =>
  new Promise((resolve, reject) => {
    const handleResponse = (response: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    };

    const baseOptions = {
      host: settings.restHost,
      port: settings.restPort,
      path: '/',
      method: 'GET',
      timeout: 5000,
      headers: { Authorization: `Bearer ${settings.restApiKey}` },
    } as const;

    const request = settings.restProtocol === 'https'
      ? https.request({ ...baseOptions, rejectUnauthorized: false }, handleResponse)
      : http.request(baseOptions, handleResponse);

    request.on('timeout', () => request.destroy(new Error('Request timed out.')));
    request.on('error', reject);
    request.end();
  });

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
   * Re-sync the CloudCLI Obsidian MCP catalog entry from current vault settings
   * when at least one project has memory enabled (keeps env/API key projections fresh).
   */
  async syncObsidianCatalogIfNeeded(): Promise<void> {
    const settings = obsidianSettingsService.getSettings();
    if (!obsidianSettingsService.isConfigured(settings)) {
      return;
    }
    const anyEnabled = projectMemoryDb.list().some((row) => Boolean(row.enabled));
    if (!anyEnabled) {
      return;
    }
    await ensureObsidianCatalogMcp(settings);
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

    // 2. Ensure the shared Obsidian MCP lives in the CloudCLI catalog (user-scope)
    //    and is projected to agents. Not per-project — same REST API for all.
    const mcpResults = await ensureObsidianCatalogMcp(settings);
    const installedProviders = mcpResults.filter((result) => result.ok).map((result) => result.provider);

    // 3. Install the Memory skill into every agent (best-effort; MCP is the
    //    functional requirement, the skill is guidance). Rendered from the
    //    active (possibly user-edited) template in the global skills store.
    let skillInstalled = false;
    try {
      const template = await globalSkillsService.getMemorySkillTemplate();
      await projectSkillsService.addProjectSkills({
        workspacePath,
        entries: [
          {
            content: renderMemorySkillTemplate(vaultFolder, template),
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

    try {
      await projectSkillsService.removeProjectSkill({
        workspacePath: resolved,
        directoryName: MEMORY_SKILL_DIRECTORY_NAME,
      });
    } catch {
      // Skill may already be gone; disabling is best-effort teardown.
    }

    // Disable this project first so the catalog teardown check sees remaining enables.
    projectMemoryDb.setEnabled(resolved, false);
    await writeManifest(resolved, {
      providers: [],
      mcpServerName: OBSIDIAN_MCP_SERVER_NAME,
      skillInstalled: false,
      updatedAt: new Date().toISOString(),
    });

    // Also clean legacy per-project MCP projections from older CloudCLI versions.
    const legacyCleanup = await providerMcpService.removeMcpServerFromAllProviders({
      name: manifest?.mcpServerName ?? OBSIDIAN_MCP_SERVER_NAME,
      scope: 'project',
      workspacePath: resolved,
    });

    const catalogCleanup = await maybeRemoveObsidianCatalogMcp();
    const mcpResults: ProjectMemoryProviderResult[] = [
      ...legacyCleanup.map((result) => ({
        provider: result.provider,
        ok: result.removed,
        error: result.error,
      })),
      ...catalogCleanup,
    ];

    return { status: await buildStatus(resolved), mcpResults };
  },

  /**
   * Re-renders the managed memory skill from the active template for every
   * memory-enabled project and re-fans it out to each project's agents. Called
   * after the template is edited from the Global Skills tab, and available as a
   * manual repair action.
   */
  async resyncMemorySkill(): Promise<ProjectMemorySkillResyncResult[]> {
    const enabledRows = projectMemoryDb.list().filter((row) => Boolean(row.enabled));
    const template = await globalSkillsService.getMemorySkillTemplate();

    const results: ProjectMemorySkillResyncResult[] = [];
    for (const row of enabledRows) {
      try {
        await projectSkillsService.addProjectSkills({
          workspacePath: row.project_path,
          entries: [
            {
              content: renderMemorySkillTemplate(row.vault_folder, template),
              directoryName: MEMORY_SKILL_DIRECTORY_NAME,
            },
          ],
        });
        results.push({ workspacePath: row.project_path, ok: true });
      } catch (error) {
        results.push({
          workspacePath: row.project_path,
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to resync memory skill',
        });
      }
    }

    return results;
  },

  /**
   * Probes the Obsidian Local REST API with the saved credentials so users can
   * verify the connection before enabling memory for projects.
   */
  async testObsidianConnection(): Promise<ObsidianConnectionTestResult> {
    const settings = obsidianSettingsService.getSettings();
    if (!settings.restApiKey.trim()) {
      return { ok: false, error: 'REST API key is not set.' };
    }

    let response: { statusCode: number; body: string };
    try {
      response = await requestObsidianRoot(settings);
    } catch (error) {
      const address = `${settings.restProtocol}://${settings.restHost}:${settings.restPort}`;
      return {
        ok: false,
        error: `Cannot reach the Obsidian Local REST API at ${address} (${error instanceof Error ? error.message : 'unknown error'}). Is Obsidian running with the Local REST API plugin enabled?`,
      };
    }

    if (response.statusCode === 401 || response.statusCode === 403) {
      return { ok: false, error: 'The Obsidian Local REST API rejected the API key (HTTP 401). Check the key in the plugin settings.' };
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return { ok: false, error: `Unexpected response from the Obsidian Local REST API (HTTP ${response.statusCode}).` };
    }

    let vaultName: string | undefined;
    let version: string | undefined;
    try {
      const payload = JSON.parse(response.body) as Record<string, unknown>;
      const manifest = payload.manifest;
      if (manifest && typeof manifest === 'object') {
        // The root payload does not carry the vault name; keep the slot for
        // forward compatibility if the plugin adds it.
      }
      const versions = payload.versions;
      if (versions && typeof versions === 'object') {
        const obsidianVersion = (versions as Record<string, unknown>).obsidian;
        if (typeof obsidianVersion === 'string') {
          version = obsidianVersion;
        }
      }
      const self = payload.vault;
      if (typeof self === 'string' && self.trim()) {
        vaultName = self.trim();
      }
    } catch {
      // A 2xx with a non-JSON body still proves reachability + auth.
    }

    return { ok: true, vaultName, version };
  },

  /**
   * Filesystem-derived stats about the project's folder inside the vault. The
   * server is local to the vault, so no REST round-trip is needed.
   */
  async getVaultStats(workspacePath: string): Promise<ProjectMemoryVaultStats> {
    const resolved = resolveWorkspacePath(workspacePath);
    const row = projectMemoryDb.get(resolved);
    const settings = obsidianSettingsService.getSettings();
    const vaultFolder = row?.vault_folder ?? '';

    const base: ProjectMemoryVaultStats = {
      workspacePath: resolved,
      vaultFolder,
      exists: false,
      decisions: 0,
      entities: 0,
      sessions: 0,
      lastSessionWrite: null,
    };

    if (!row || !row.enabled || !settings.vaultPath.trim() || !vaultFolder) {
      return base;
    }

    const folderRoot = path.join(settings.vaultPath, vaultFolder);
    if (!(await directoryExists(folderRoot))) {
      return base;
    }

    const countMarkdownFiles = async (subfolder: string): Promise<number> => {
      try {
        const entries = await readdir(path.join(folderRoot, subfolder), { withFileTypes: true });
        return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md')).length;
      } catch {
        return 0;
      }
    };

    const findLastSessionWrite = async (): Promise<string | null> => {
      try {
        const sessionsDir = path.join(folderRoot, 'Sessions');
        const entries = await readdir(sessionsDir, { withFileTypes: true });
        let latestMs = 0;
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
            continue;
          }
          const stats = await stat(path.join(sessionsDir, entry.name));
          latestMs = Math.max(latestMs, stats.mtimeMs);
        }
        return latestMs > 0 ? new Date(latestMs).toISOString() : null;
      } catch {
        return null;
      }
    };

    const [decisions, entities, sessions, lastSessionWrite] = await Promise.all([
      countMarkdownFiles('Decisions'),
      countMarkdownFiles('Entities'),
      countMarkdownFiles('Sessions'),
      findLastSessionWrite(),
    ]);

    return {
      workspacePath: resolved,
      vaultFolder,
      exists: true,
      decisions,
      entities,
      sessions,
      lastSessionWrite,
    };
  },
};
