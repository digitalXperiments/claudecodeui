import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { access, mkdir, readdir, stat, writeFile } from 'node:fs/promises';

import { jsonrepair } from 'jsonrepair';

import { projectMemoryDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { obsidianSettingsService } from '@/modules/providers/services/obsidian-settings.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { mcpCatalogService } from '@/modules/providers/services/mcp-catalog.service.js';
import { projectSkillsService } from '@/modules/providers/services/project-skills.service.js';
import { globalSkillsService } from '@/modules/providers/services/global-skills.service.js';
import {
  MEMORY_SKILL_DIRECTORY_NAME,
  renderMemorySkillTemplate,
} from '@/modules/providers/shared/memory/memory-skill.template.js';
import { resolveVaultTargetDir, scaffoldVault, type ScaffoldResult } from '@/modules/providers/shared/memory/memory.scaffold.js';
import {
  buildObsidianMcpServerInput,
  OBSIDIAN_MCP_SERVER_NAME,
} from '@/modules/providers/shared/memory/obsidian-mcp.config.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import type {
  LLMProvider,
  NormalizedMessage,
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
  'kilo',
  'cline',
  'grok',
  'kimi',
  'qwencode',
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

// ---------------------------
//----------------- VAULT STALENESS & CURATION ------------
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_NOTE_DAYS = 90;

export type StaleVaultNote = {
  path: string;
  relativePath: string;
  lastModified: string;
  daysOld: number;
};

export type MemoryCurationSuggestion = {
  action: 'create' | 'update' | 'link';
  path: string;
  content: string;
  reason: string;
  confidence: number;
};

export type MemoryCurationResult = {
  success: boolean;
  suggestions: MemoryCurationSuggestion[];
  error?: string;
};

export type MemoryCurationApplyResult = {
  success: boolean;
  created: boolean;
  path: string;
  error?: string;
};

/**
 * Provider runtime entry points for headless memory-curation runs. Injected by
 * server/index.js (the provider spawn fns live there); empty until configured.
 */
let curationRuntimes: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function configureMemoryCurationRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  curationRuntimes = spawnFns;
}

type VaultFileEntry = {
  path: string;
  relativePath: string;
  mtimeMs: number;
};

/**
 * Recursively walks a folder collecting every file, ignoring hidden entries
 * (`.obsidian`, `.trash`, `.git`, ...). Best-effort: unreadable directories or
 * files are skipped rather than aborting the walk.
 */
const collectVaultFiles = async (vaultRoot: string): Promise<VaultFileEntry[]> => {
  const files: VaultFileEntry[] = [];
  const walk = async (directoryPath: string, relativeDir: string): Promise<void> => {
    const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const filePath = path.join(directoryPath, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(filePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stats = await stat(filePath).catch(() => null);
      if (!stats) {
        continue;
      }
      files.push({ path: filePath, relativePath, mtimeMs: stats.mtimeMs });
    }
  };
  await walk(vaultRoot, '');
  return files;
};

const mapToStaleNotes = (
  files: VaultFileEntry[],
  now: number,
  thresholdMs: number,
): StaleVaultNote[] =>
  files
    .filter((file) => file.relativePath.toLowerCase().endsWith('.md'))
    .filter((file) => now - file.mtimeMs >= thresholdMs)
    .map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      lastModified: new Date(file.mtimeMs).toISOString(),
      daysOld: Math.floor((now - file.mtimeMs) / DAY_MS),
    }))
    .sort((a, b) => b.daysOld - a.daysOld);

/**
 * Walks the vault folder recursively (ignoring hidden directories such as
 * `.obsidian` / `.trash`) and returns markdown notes whose mtime is at least
 * `staleDays` old, newest-to-oldest by age. Returns [] when the vault is
 * missing or the walk fails.
 */
export const listStaleNotes = async (
  vaultPath: string,
  staleDays = DEFAULT_STALE_NOTE_DAYS,
): Promise<StaleVaultNote[]> => {
  const vaultRoot = path.resolve(vaultPath);
  const thresholdMs = staleDays * DAY_MS;
  try {
    if (!(await directoryExists(vaultRoot))) {
      return [];
    }
    const files = await collectVaultFiles(vaultRoot);
    return mapToStaleNotes(files, Date.now(), thresholdMs);
  } catch {
    return [];
  }
};

const CURATION_ENVELOPE =
  'Return ONLY a JSON array of suggestions, each exactly ' +
  '{ "action": "create" | "update" | "link", "path": string (vault-relative, ends in .md), "content": string (markdown body for create/update actions), "reason": string (short), "confidence": number (0-1) }. ' +
  'Do not invent facts that are not supported by the session context. If there is nothing worth recording, return [] (empty array). ' +
  'Strict JSON only — no code fences, no prose. Escape every " and \\ and newline inside strings (use \\n for line breaks).';

const buildMemoryCurationPrompt = (input: {
  workspacePath: string;
  vaultFolder: string;
  notePaths: string[];
  sessions: Array<{ provider: string; sessionId: string; customName: string; updatedAt: string }>;
  transcript: string;
}): string => {
  const now = new Date().toISOString();
  const sessionLines = input.sessions
    .map((session) => `- ${session.provider} session "${session.customName || session.sessionId}" (updated ${session.updatedAt})`)
    .join('\n');
  const noteLines =
    input.notePaths.length > 0 ? input.notePaths.join('\n') : '(vault folder is empty or not readable)';

  return [
    `Current time (ISO 8601): ${now}`,
    `You are curating the Obsidian second brain for the project at "${input.workspacePath}".`,
    `Its vault folder is \`${input.vaultFolder}/\`. Propose concrete edits to the notes below.`,
    '',
    '## Existing notes in the vault folder',
    noteLines,
    '',
    '## Recent sessions for this project',
    sessionLines || '(no persisted sessions found — base suggestions only on the vault content)',
    input.transcript
      ? `\n## Transcript of the most recent session\n${input.transcript}\n`
      : '\n(no transcript available — use the session summaries above)',
    '',
    CURATION_ENVELOPE,
  ].join('\n');
};

const stripCodeFences = (text: string): string =>
  text.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();

const extractFencedBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  const re = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
};

const findBalancedJsonSlices = (text: string): string[] => {
  const slices: string[] = [];
  for (let startIdx = 0; startIdx < text.length; startIdx++) {
    const open = text[startIdx];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\' && inStr) {
        escape = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          slices.push(text.slice(startIdx, i + 1));
          startIdx = i;
          break;
        }
      }
    }
  }
  return slices;
};

const tryParseJson = (candidate: string): unknown => {
  try {
    return JSON.parse(candidate);
  } catch {
    const trimmed = candidate.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      throw new Error('candidate is not JSON-shaped');
    }
    return JSON.parse(jsonrepair(candidate));
  }
};

/**
 * Tolerant parser for agent text: accepts plain arrays, fenced ```json blocks,
 * and common LLM JSON mistakes (via jsonrepair). Mirrors the small approach
 * used by Mission Control without importing from that module.
 */
const parseJsonFromAgentText = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('no JSON object or array found in text');
  }
  const candidates = [
    ...extractFencedBlocks(trimmed),
    trimmed,
    stripCodeFences(trimmed),
    ...findBalancedJsonSlices(stripCodeFences(trimmed)),
    ...findBalancedJsonSlices(trimmed),
  ];
  const unique: string[] = [];
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (value && !unique.includes(value)) unique.push(value);
  }
  let lastError: Error | null = null;
  for (const candidate of unique) {
    try {
      const parsed = tryParseJson(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('no JSON object or array found in text');
};

const normalizeSuggestions = (value: unknown): MemoryCurationSuggestion[] => {
  if (!Array.isArray(value)) {
    throw new Error('Expected a JSON array of memory curation suggestions.');
  }
  const suggestions: MemoryCurationSuggestion[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const action = record.action;
    if (action !== 'create' && action !== 'update' && action !== 'link') continue;
    const notePath = typeof record.path === 'string' ? record.path.trim() : '';
    if (!notePath || !notePath.toLowerCase().endsWith('.md')) continue;
    suggestions.push({
      action,
      path: notePath,
      content: typeof record.content === 'string' ? record.content : '',
      reason: typeof record.reason === 'string' ? record.reason : '',
      confidence: typeof record.confidence === 'number' ? Math.max(0, Math.min(1, record.confidence)) : 0.5,
    });
  }
  return suggestions;
};

type CurationRunOutcome = {
  text: string;
  failed: boolean;
  errorMessage: string | null;
};

const extractRunOutcome = (appSessionId: string): CurationRunOutcome => {
  const events = chatRunRegistry.replayEvents(appSessionId, 0);
  const textChunks: string[] = [];
  const deltaChunks: string[] = [];
  const errorChunks: string[] = [];
  let failed = false;
  for (const event of events) {
    if (event.kind === 'complete') {
      if (typeof event.exitCode === 'number' && event.exitCode !== 0) {
        failed = true;
      }
      continue;
    }
    if (typeof event.content !== 'string') continue;
    if (event.kind === 'error') {
      errorChunks.push(event.content);
    } else if (event.kind === 'text') {
      textChunks.push(event.content);
    } else if (event.kind === 'stream_delta') {
      deltaChunks.push(event.content);
    }
  }
  return {
    text: (textChunks.length > 0 ? textChunks.join('\n') : deltaChunks.join('')).trim(),
    failed,
    errorMessage: errorChunks.join('\n').trim() || null,
  };
};

const renderSessionTranscript = (messages: NormalizedMessage[]): string =>
  messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim(),
    )
    .map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${message.content}`)
    .join('\n');

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
  async getVaultStats(
    workspacePath: string,
  ): Promise<ProjectMemoryVaultStats & { staleNotes: StaleVaultNote[]; totalFiles: number }> {
    const resolved = resolveWorkspacePath(workspacePath);
    const row = projectMemoryDb.get(resolved);
    const settings = obsidianSettingsService.getSettings();
    const vaultFolder = row?.vault_folder ?? '';

    const base: ProjectMemoryVaultStats & { staleNotes: StaleVaultNote[]; totalFiles: number } = {
      workspacePath: resolved,
      vaultFolder,
      exists: false,
      decisions: 0,
      entities: 0,
      sessions: 0,
      lastSessionWrite: null,
      staleNotes: [],
      totalFiles: 0,
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

    let staleNotes: StaleVaultNote[] = [];
    let totalFiles = 0;
    try {
      const vaultFiles = await collectVaultFiles(folderRoot);
      staleNotes = mapToStaleNotes(vaultFiles, Date.now(), DEFAULT_STALE_NOTE_DAYS * DAY_MS);
      totalFiles = vaultFiles.length;
    } catch {
      // Staleness is best-effort; keep the rest of the stats.
    }

    return {
      workspacePath: resolved,
      vaultFolder,
      exists: true,
      decisions,
      entities,
      sessions,
      lastSessionWrite,
      staleNotes,
      totalFiles,
    };
  },

  /**
   * Headless curation pass: a provider agent reviews recent session outcomes
   * for the project and proposes concrete vault edits (create/update/link
   * notes) WITHOUT writing anything. The user reviews and applies each
   * suggestion via `applyMemoryCurationSuggestion`.
   */
  async curateProjectMemory(params: {
    workspacePath: string;
    vaultFolder?: string;
    provider?: LLMProvider;
    limit?: number;
  }): Promise<MemoryCurationResult> {
    const workspacePath = resolveWorkspacePath(params.workspacePath);
    const provider = params.provider ?? 'claude';
    const spawnFn = curationRuntimes[provider];
    if (!spawnFn) {
      throw new AppError(`Provider "${provider}" runtime is not available for memory curation.`, {
        code: 'MEMORY_CURATION_RUNTIME_UNAVAILABLE',
        statusCode: 400,
      });
    }

    const row = projectMemoryDb.get(workspacePath);
    const vaultFolder = normalizeVaultFolder(params.vaultFolder ?? row?.vault_folder ?? '', workspacePath);
    const settings = obsidianSettingsService.getSettings();
    const vaultPath = settings.vaultPath.trim();
    const folderRoot = vaultPath ? path.join(vaultPath, vaultFolder) : '';

    const limit = Math.max(1, Math.min(params.limit ?? 10, 50));

    let sessionRows: ReturnType<typeof sessionsDb.getSessionsByProjectPathPage> = [];
    try {
      sessionRows = sessionsDb.getSessionsByProjectPathPage(workspacePath, limit, 0);
    } catch {
      sessionRows = [];
    }

    const sessions = sessionRows.map((session) => ({
      provider: session.provider,
      sessionId: session.session_id,
      customName: session.custom_name ?? '',
      updatedAt: session.updated_at ?? session.created_at ?? '',
    }));

    let notePaths: string[] = [];
    try {
      if (folderRoot && (await directoryExists(folderRoot))) {
        const vaultFiles = await collectVaultFiles(folderRoot);
        notePaths = vaultFiles
          .filter((file) => file.relativePath.toLowerCase().endsWith('.md'))
          .map((file) => file.relativePath);
      }
    } catch {
      notePaths = [];
    }

    let transcript = '';
    const latest = sessions[0];
    if (latest) {
      try {
        const history = await sessionsService.fetchHistory(latest.sessionId, { limit: 40 });
        transcript = renderSessionTranscript(history.messages);
      } catch {
        transcript = '';
      }
    }

    const prompt = buildMemoryCurationPrompt({
      workspacePath,
      vaultFolder,
      notePaths,
      sessions,
      transcript,
    });

    const created = sessionsService.createAppSession(provider, workspacePath);
    const appSessionId = created.sessionId;

    const result = await startProviderRun({
      appSessionId,
      provider,
      providerSessionId: null,
      projectPath: workspacePath,
      spawnFn,
      content: prompt,
      options: { permissionMode: 'bypassPermissions', unattended: true },
      connection: DETACHED_CONNECTION,
      userId: null,
    });

    if (!result.ok) {
      throw new AppError('A memory curation run is already in progress for this project.', {
        code: 'MEMORY_CURATION_RUN_IN_PROGRESS',
        statusCode: 409,
      });
    }

    await result.completion;
    const { text, failed, errorMessage } = extractRunOutcome(appSessionId);

    if (failed) {
      return {
        success: false,
        suggestions: [],
        error: errorMessage ?? (text || 'Memory curation run failed.'),
      };
    }

    try {
      const parsed = parseJsonFromAgentText(text);
      return { success: true, suggestions: normalizeSuggestions(parsed) };
    } catch (error) {
      return {
        success: false,
        suggestions: [],
        error: error instanceof Error ? error.message : 'Failed to parse curation suggestions.',
      };
    }
  },

  /**
   * Applies one curation suggestion: writes the note into the vault folder
   * (creating parent directories) after enforcing the anti-path-escape rule.
   * `created` reports whether the note did not previously exist.
   */
  async applyMemoryCurationSuggestion(input: {
    vaultPath?: string;
    vaultFolder: string;
    path: string;
    content: string;
  }): Promise<MemoryCurationApplyResult> {
    try {
      const vaultPath = input.vaultPath?.trim() || obsidianSettingsService.getSettings().vaultPath.trim();
      if (!vaultPath) {
        return { success: false, created: false, path: '', error: 'Obsidian vault settings are not configured.' };
      }
      const vaultFolder = input.vaultFolder?.trim() || '';
      if (!vaultFolder) {
        return { success: false, created: false, path: '', error: 'vaultFolder is required.' };
      }
      const notePath = input.path?.trim() || '';
      if (!notePath) {
        return { success: false, created: false, path: '', error: 'Note path is required.' };
      }
      if (!notePath.toLowerCase().endsWith('.md')) {
        return { success: false, created: false, path: '', error: 'Note path must end in .md.' };
      }

      const targetDir = resolveVaultTargetDir(vaultPath, vaultFolder);
      const targetPath = resolveVaultTargetDir(targetDir, notePath);

      await mkdir(path.dirname(targetPath), { recursive: true });
      let created = false;
      try {
        await access(targetPath);
      } catch {
        created = true;
      }
      await writeFile(targetPath, input.content ?? '', 'utf8');
      return { success: true, created, path: targetPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply memory curation suggestion.';
      return { success: false, created: false, path: '', error: message };
    }
  },
};
