import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, McpScope, ProviderMcpServer } from '@/shared/types.js';

const execFileAsync = promisify(execFile);

export type CliMcpListEntry = {
  name: string;
  /** Raw target from CLI (URL or command string). */
  target: string;
  connected: boolean | null;
  needsAuth: boolean;
  /** Present when CLI marks the entry as project-scoped. */
  projectScoped: boolean;
  /** Config origin when known: config.toml, managed/grok.com, claude.json, etc. */
  source?: string;
  transport?: 'stdio' | 'http' | 'sse';
  /**
   * Which agent actually owns this definition. Doctor can surface Claude
   * servers while invoked as Grok — do not stamp the invoker as owner.
   */
  ownerProvider?: LLMProvider;
};

/**
 * Parse `claude mcp list` / similar human-readable output.
 *
 * Examples:
 *   claude.ai Superhuman Docs: https://docs.superhuman.com/apis/mcp - ! Needs authentication
 *   claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
 *   obsidian: npx -y @fazer-ai/mcp-obsidian@latest - ✔ Connected
 *   leong-associates-mcp: https://… (HTTP) - ✔ Connected
 *   claude.ai Figma: https://mcp.figma.com/mcp - ! Needs authentication
 *   Composio: https://connect.composio.dev/mcp
 *   obsidian: npx -y @fazer-ai/mcp-obsidian@latest (project)
 */
export function parseCliMcpListOutput(stdout: string): CliMcpListEntry[] {
  const entries: CliMcpListEntry[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Checking ') || line.startsWith('Usage:')) continue;

    // name: target [status…]
    const match = line.match(/^(.+?):\s+(.+)$/);
    if (!match) continue;
    let name = match[1].trim();
    let rest = match[2].trim();
    if (!name || !rest) continue;

    const projectScoped = /\(project\)\s*$/i.test(rest) || /\(project\)/i.test(rest);
    rest = rest.replace(/\s*\(project\)\s*/gi, ' ').trim();

    let connected: boolean | null = null;
    let needsAuth = false;
    if (/Needs authentication/i.test(rest)) {
      needsAuth = true;
      connected = false;
      rest = rest.replace(/\s*[-–—]?\s*!\s*Needs authentication\s*$/i, '').trim();
    } else if (/Connected/i.test(rest) || /✔/.test(rest)) {
      connected = true;
      rest = rest.replace(/\s*[-–—]?\s*[✔✓]?\s*Connected\s*$/i, '').trim();
    } else if (/Failed|Error|✘|✗/i.test(rest)) {
      connected = false;
      rest = rest.replace(/\s*[-–—]?\s*[✘✗]?\s*(Failed|Error).*$/i, '').trim();
    }

    // Drop trailing "(HTTP)" transport tags
    rest = rest.replace(/\s*\(HTTP\)\s*$/i, '').trim();

    entries.push({
      name,
      target: rest,
      connected,
      needsAuth,
      projectScoped,
    });
  }
  return entries;
}

/**
 * Humanize Grok managed ids: `grok_com_leong_associates_mcp` → `Leong Associates MCP`
 * while keeping the original as a fallback identity when needed.
 */
export function friendlyGrokManagedName(name: string): string {
  let n = name.trim();
  if (/^grok_com_/i.test(n)) {
    n = n.replace(/^grok_com_/i, '');
  }
  n = n.replace(/_mcp$/i, '').replace(/-/g, '_');
  const words = n.split('_').filter(Boolean);
  if (words.length === 0) return name;
  const titled = words
    .map((w) => (w.toLowerCase() === 'mcp' ? 'MCP' : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
  return /mcp$/i.test(titled) ? titled : `${titled} MCP`;
}

function targetToServer(
  provider: LLMProvider,
  scope: McpScope,
  entry: CliMcpListEntry,
): ProviderMcpServer {
  const target = entry.target;
  const looksUrl = /^https?:\/\//i.test(target);
  if (looksUrl || entry.transport === 'http' || entry.transport === 'sse') {
    return {
      provider,
      name: entry.name,
      scope,
      transport: entry.transport === 'sse' ? 'sse' : 'http',
      url: looksUrl ? target.split(/\s+/)[0] : target,
    };
  }

  // Command form: "npx -y pkg" or absolute path + args
  const parts = target.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [target];
  const tokens = parts.map((p) => p.replace(/^['"]|['"]$/g, ''));
  return {
    provider,
    name: entry.name,
    scope: entry.projectScoped ? 'project' : scope,
    transport: 'stdio',
    command: tokens[0] || target,
    args: tokens.slice(1),
  };
}

type RunMcpResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  skipped: boolean;
};

async function directoryExists(dir?: string): Promise<boolean> {
  if (!dir) return true;
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * LaunchAgent PATH is complete, but `execFile('grok')` still ENOENTs when
 * `cwd` is a deleted CloudCLI project. Always resolve a real binary and skip
 * missing folders — Node reports both failures as `spawn ENOENT`.
 */
export function resolveProviderCli(name: 'claude' | 'grok'): string {
  const home = os.homedir();
  const candidates = name === 'grok'
    ? [
      path.join(home, '.grok', 'bin', 'grok'),
      path.join(home, '.local', 'bin', 'grok'),
      '/opt/homebrew/bin/grok',
      '/usr/local/bin/grok',
    ]
    : [
      process.env.CLAUDE_CLI_PATH,
      path.join(home, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return name;
}

async function runMcpCommand(
  bin: 'claude' | 'grok',
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<RunMcpResult> {
  if (options?.cwd && !(await directoryExists(options.cwd))) {
    console.warn(`[mcp-cli-list] skip ${bin} ${args.join(' ')}: cwd missing ${options.cwd}`);
    return { stdout: '', stderr: '', timedOut: false, skipped: true };
  }

  const resolved = resolveProviderCli(bin);
  try {
    const { stdout, stderr } = await execFileAsync(resolved, args, {
      timeout: options?.timeoutMs ?? 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: options?.env ?? process.env,
      cwd: options?.cwd,
    });
    return {
      stdout: stdout || '',
      stderr: stderr || '',
      timedOut: false,
      skipped: false,
    };
  } catch (error) {
    // CLI often writes health progress to stderr and may exit non-zero when
    // some servers need auth — still parse whatever we got.
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    const timedOut = err.killed === true || err.signal === 'SIGTERM';
    if (!err.stdout && !err.stderr) {
      console.warn(`[mcp-cli-list] ${resolved} ${args.join(' ')} failed:`, err.message);
    }
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      timedOut,
      skipped: false,
    };
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Doctor prints ANSI log lines (and sometimes a `{...}` snippet inside an
 * error string) before/after the real payload. Prefer line-started objects
 * and never walk the string one character at a time.
 */
export function extractJsonPayload(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;

  const direct = tryParseJson(text);
  if (direct !== null) return direct;

  const starts: number[] = [];
  if (text.startsWith('{') || text.startsWith('[')) starts.push(0);
  for (const match of text.matchAll(/\n([\[{])/g)) {
    if (typeof match.index === 'number') starts.push(match.index + 1);
  }
  // Last brace on a line is usually the real payload; first `{` may be a log.
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const slice = text.slice(starts[i]);
    const parsed = tryParseJson(slice);
    if (parsed !== null) return parsed;
    const lastClose = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
    if (lastClose > 0) {
      const trimmed = tryParseJson(slice.slice(0, lastClose + 1));
      if (trimmed !== null) return trimmed;
    }
  }
  return null;
}

function parseEntriesFromCommand(
  result: RunMcpResult,
  parsers: Array<(raw: string) => CliMcpListEntry[]>,
): CliMcpListEntry[] {
  // stdout first — doctor JSON lives there; stderr is noisy HTTP 405 lines.
  const chunks = [result.stdout, result.stderr, `${result.stdout}\n${result.stderr}`];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    for (const parse of parsers) {
      const entries = parse(chunk);
      if (entries.length > 0) return entries;
    }
  }
  return [];
}

function parseListJson(raw: string): CliMcpListEntry[] {
  const data = extractJsonPayload(raw);
  if (!Array.isArray(data)) return [];
  const entries: CliMcpListEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const url = typeof rec.url === 'string' ? rec.url : '';
    const command = typeof rec.command === 'string' ? rec.command : '';
    const args = Array.isArray(rec.args) ? rec.args.filter((a): a is string => typeof a === 'string') : [];
    const scope = rec.scope === 'project' || rec.scope === 'local' ? 'project' : 'user';
    const target = url || [command, ...args].filter(Boolean).join(' ');
    if (!target) continue;
    entries.push({
      name,
      target,
      connected: null,
      needsAuth: false,
      projectScoped: scope === 'project',
      transport: url ? 'http' : 'stdio',
      source: 'list',
    });
  }
  return entries;
}

export function parseDoctorJson(raw: string): CliMcpListEntry[] {
  const data = extractJsonPayload(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const servers = (data as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return [];
  const entries: CliMcpListEntry[] = [];
  for (const item of servers) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const target = typeof rec.target === 'string' ? rec.target.trim() : '';
    if (!target) continue;
    const transportRaw = typeof rec.transport === 'string' ? rec.transport.toLowerCase() : '';
    const transport = transportRaw === 'sse' || transportRaw === 'http' || transportRaw === 'stdio'
      ? transportRaw
      : undefined;
    const source = typeof rec.source === 'string' ? rec.source : undefined;
    const healthy = rec.healthy === true;
    const checks = Array.isArray(rec.checks) ? rec.checks : [];
    let needsAuth = false;
    let connected: boolean | null = healthy ? true : false;
    for (const check of checks) {
      if (!check || typeof check !== 'object') continue;
      const label = String((check as { label?: string }).label || '');
      const detail = String((check as { detail?: string }).detail || '');
      if (/auth/i.test(label) || /auth/i.test(detail)) {
        needsAuth = true;
        connected = false;
      }
    }
    // Prefer display name for managed grok.com connectors
    const displayName = source === 'managed' || source === 'grok.com' || /^grok_com_/i.test(name)
      ? friendlyGrokManagedName(name)
      : name;

    // Map doctor source path → owning provider (critical for correct chips).
    let ownerProvider: LLMProvider | undefined;
    const src = (source || '').toLowerCase();
    if (src === 'managed' || src === 'grok.com' || src.includes('config.toml') || src.includes('.grok')) {
      ownerProvider = 'grok';
    } else if (src.includes('claude.json') || src.includes('.claude')) {
      ownerProvider = 'claude';
    } else if (src.includes('.cursor')) {
      ownerProvider = 'cursor';
    } else if (src.includes('codex') || src.includes('.openai')) {
      ownerProvider = 'codex';
    }

    entries.push({
      name: displayName,
      target,
      connected,
      needsAuth,
      projectScoped: source === 'managed' || source === 'grok.com',
      source: source === 'managed' ? 'grok.com' : source,
      transport: transport as CliMcpListEntry['transport'],
      ownerProvider,
    });
  }
  return entries;
}

const listCache = new Map<string, { at: number; entries: CliMcpListEntry[] }>();
/** In-flight de-dupe so concurrent Settings opens share one CLI fan-out. */
const listInflight = new Map<string, Promise<CliMcpListEntry[]>>();
/** Settings UI: prefer a snappy cache hit over re-probing every open. */
const LIST_CACHE_TTL_MS = 120_000;
const DOCTOR_CACHE_TTL_MS = 300_000;
/**
 * `claude mcp list` health-checks every connector (20+ on this machine ≈ 14s).
 * A 12s kill dropped the entire buffered stdout → Account = 0.
 */
const CLAUDE_LIST_TIMEOUT_MS = 90_000;
const GROK_LIST_TIMEOUT_MS = 15_000;
const CLI_DOCTOR_TIMEOUT_MS = 45_000;
const MAX_GROK_LIST_CWDS = 8;
const MAX_GROK_DOCTOR_CWDS = 8;

async function readTrustedFolderPaths(): Promise<string[]> {
  const filePath = path.join(os.homedir(), '.grok', 'trusted_folders.toml');
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const paths: string[] = [];
    for (const match of text.matchAll(/\[folders\."([^"]+)"\]/g)) {
      if (match[1]) paths.push(match[1]);
    }
    return paths;
  } catch {
    return [];
  }
}

function mergeEntries(into: Map<string, CliMcpListEntry>, entries: CliMcpListEntry[]): void {
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    const existing = into.get(key);
    if (!existing) {
      into.set(key, entry);
      continue;
    }
    // Prefer managed/grok.com and richer targets (URLs over placeholders)
    const preferNew = (
      (entry.source === 'grok.com' && existing.source !== 'grok.com')
      || (/^https?:\/\//i.test(entry.target) && !/^https?:\/\//i.test(existing.target))
      || (entry.connected === true && existing.connected !== true)
    );
    if (preferNew) {
      into.set(key, entry);
    }
  }
}

/**
 * Live MCP inventory from the provider CLI (includes claude.ai connectors and
 * grok.com-linked servers that never appear in local config files).
 *
 * Grok.com team connectors (e.g. "Leong Associates MCP") are **cwd-sensitive**:
 * they only resolve when `grok mcp doctor` / list runs from a trusted project
 * folder. We therefore merge:
 *   1. `grok mcp list --json` from home + optional workspace paths
 *   2. `grok mcp doctor --json` from trusted folders (cached) for managed sources
 */
function scoreDoctorCwd(cwd: string): number {
  const lower = cwd.toLowerCase();
  let score = 0;
  if (/leong/.test(lower)) score += 100;
  if (/cloudcli|fluxito|warehouse/.test(lower)) score += 30;
  if (/\/work\//.test(lower)) score += 10;
  return score;
}

async function existingDirectories(paths: Iterable<string>): Promise<string[]> {
  const unique = [...new Set([...paths].map((p) => path.resolve(p)).filter(Boolean))];
  const existing: string[] = [];
  await Promise.all(unique.map(async (dir) => {
    if (await directoryExists(dir)) existing.push(dir);
  }));
  return existing;
}

async function listMcpServersFromCliUncached(
  provider: LLMProvider,
  options?: {
    bypassCache?: boolean;
    workspacePaths?: string[];
  },
): Promise<CliMcpListEntry[]> {
  const merged = new Map<string, CliMcpListEntry>();

  if (provider === 'claude') {
    const output = await runMcpCommand('claude', ['mcp', 'list'], {
      timeoutMs: CLAUDE_LIST_TIMEOUT_MS,
    });
    mergeEntries(merged, parseEntriesFromCommand(output, [parseCliMcpListOutput]));
  } else if (provider === 'grok') {
    const cwdCandidates = new Set<string>([os.homedir()]);
    for (const p of options?.workspacePaths ?? []) {
      if (p?.trim()) cwdCandidates.add(path.resolve(p.trim()));
    }
    const listCwds = (await existingDirectories(cwdCandidates))
      .slice(0, MAX_GROK_LIST_CWDS);

    await Promise.all(
      listCwds.map(async (cwd) => {
        const jsonOut = await runMcpCommand('grok', ['mcp', 'list', '--json'], {
          cwd,
          timeoutMs: GROK_LIST_TIMEOUT_MS,
        });
        let entries = parseEntriesFromCommand(jsonOut, [parseListJson]);
        if (entries.length === 0) {
          const textOut = await runMcpCommand('grok', ['mcp', 'list'], {
            cwd,
            timeoutMs: GROK_LIST_TIMEOUT_MS,
          });
          entries = parseEntriesFromCommand(textOut, [parseCliMcpListOutput]);
        }
        mergeEntries(merged, entries);
      }),
    );

    // Doctor discovers grok.com managed connectors (missing from `list`).
    const doctorCandidates = new Set<string>();
    for (const p of await readTrustedFolderPaths()) {
      doctorCandidates.add(path.resolve(p));
    }
    for (const p of options?.workspacePaths ?? []) {
      if (p?.trim()) doctorCandidates.add(path.resolve(p.trim()));
    }
    doctorCandidates.add(os.homedir());

    const doctorCwdList = (await existingDirectories(doctorCandidates))
      .sort((a, b) => scoreDoctorCwd(b) - scoreDoctorCwd(a))
      .slice(0, MAX_GROK_DOCTOR_CWDS);
    const doctorCacheKey = `grok-doctor::${doctorCwdList.slice().sort().join('|')}`;
    let doctorEntries: CliMcpListEntry[] | null = null;
    if (!options?.bypassCache) {
      const hit = listCache.get(doctorCacheKey);
      if (hit && Date.now() - hit.at < DOCTOR_CACHE_TTL_MS && hit.entries.length > 0) {
        doctorEntries = hit.entries;
      }
    }
    if (!doctorEntries) {
      const doctorMap = new Map<string, CliMcpListEntry>();
      await Promise.all(
        doctorCwdList.map(async (cwd) => {
          const raw = await runMcpCommand('grok', ['mcp', 'doctor', '--json'], {
            cwd,
            timeoutMs: CLI_DOCTOR_TIMEOUT_MS,
          });
          mergeEntries(doctorMap, parseEntriesFromCommand(raw, [parseDoctorJson]));
        }),
      );
      doctorEntries = [...doctorMap.values()];
      if (doctorEntries.length > 0) {
        listCache.set(doctorCacheKey, { at: Date.now(), entries: doctorEntries });
      }
    }
    mergeEntries(merged, doctorEntries);
  } else {
    return [];
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMcpServersFromCli(
  provider: LLMProvider,
  options?: {
    bypassCache?: boolean;
    /** Extra working directories to query (CloudCLI project paths). */
    workspacePaths?: string[];
  },
): Promise<CliMcpListEntry[]> {
  const workspaceKey = (options?.workspacePaths ?? []).slice().sort().join('|');
  const cacheKey = `${provider}::${workspaceKey}`;
  if (!options?.bypassCache) {
    const hit = listCache.get(cacheKey);
    if (hit && Date.now() - hit.at < LIST_CACHE_TTL_MS) {
      return hit.entries;
    }
    const inflight = listInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }
  }

  const promise = listMcpServersFromCliUncached(provider, options)
    .then((entries) => {
      if (entries.length > 0) {
        listCache.set(cacheKey, { at: Date.now(), entries });
        return entries;
      }
      // A timed-out / missing-cwd probe must not replace a good cache with [].
      const previous = listCache.get(cacheKey);
      if (previous?.entries.length) return previous.entries;
      return entries;
    })
    .finally(() => {
      listInflight.delete(cacheKey);
    });

  if (!options?.bypassCache) {
    listInflight.set(cacheKey, promise);
  }
  return promise;
}

/** Drop CLI list/doctor caches (used after catalog mutations + explicit Refresh). */
export function clearMcpCliListCache(): void {
  listCache.clear();
  listInflight.clear();
}

/**
 * Convert CLI entries into ProviderMcpServer rows, merging by name over an
 * existing file-based list (CLI wins for discovery of hosted connectors).
 */
export function mergeCliMcpEntries(
  provider: LLMProvider,
  scope: McpScope,
  existing: ProviderMcpServer[],
  cliEntries: CliMcpListEntry[],
): ProviderMcpServer[] {
  const byName = new Map<string, ProviderMcpServer>();
  for (const server of existing) {
    byName.set(server.name, server);
  }
  for (const entry of cliEntries) {
    // Prefer richer file-based config (env, headers) when names collide.
    if (byName.has(entry.name)) continue;
    // Project-only CLI entries only belong in project/local listings.
    if (entry.projectScoped && scope === 'user') {
      // Still surface them under user so Mission Control global sections can
      // select them — they are real available servers on this machine.
    }
    byName.set(entry.name, targetToServer(provider, scope, entry));
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
