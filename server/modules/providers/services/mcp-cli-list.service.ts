import { execFile } from 'node:child_process';
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

async function runMcpCommand(
  bin: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: options?.timeoutMs ?? 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: options?.env ?? process.env,
      cwd: options?.cwd,
    });
    return `${stdout || ''}\n${stderr || ''}`;
  } catch (error) {
    // CLI often writes health progress to stderr and may exit non-zero when
    // some servers need auth — still parse whatever we got.
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const combined = `${err.stdout || ''}\n${err.stderr || ''}`;
    if (combined.trim()) return combined;
    console.warn(`[mcp-cli-list] ${bin} ${args.join(' ')} failed:`, err.message);
    return '';
  }
}

function extractJsonPayload(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  // Prefer last JSON object/array in the stream (doctor prints log lines first).
  const objStart = text.lastIndexOf('\n{');
  const arrStart = text.lastIndexOf('\n[');
  const startCandidates = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
  let start = startCandidates.length ? Math.min(...startCandidates) : -1;
  if (objStart >= 0 || arrStart >= 0) {
    const last = Math.max(objStart >= 0 ? objStart + 1 : -1, arrStart >= 0 ? arrStart + 1 : -1);
    if (last >= 0) start = last;
  }
  if (start < 0) return null;
  const slice = text.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    // Try progressive trim from the end
    for (let end = slice.length; end > 2; end -= 1) {
      try {
        return JSON.parse(slice.slice(0, end));
      } catch {
        // continue
      }
    }
  }
  return null;
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

function parseDoctorJson(raw: string): CliMcpListEntry[] {
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
const LIST_CACHE_TTL_MS = 30_000;
const DOCTOR_CACHE_TTL_MS = 120_000;

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
  }

  const merged = new Map<string, CliMcpListEntry>();

  if (provider === 'claude') {
    const output = await runMcpCommand('claude', ['mcp', 'list']);
    mergeEntries(merged, parseCliMcpListOutput(output));
  } else if (provider === 'grok') {
    const cwds = new Set<string>();
    cwds.add(os.homedir());
    for (const p of options?.workspacePaths ?? []) {
      if (p?.trim()) cwds.add(path.resolve(p.trim()));
    }
    // list --json is fast; run for each cwd (project-scoped entries differ)
    await Promise.all(
      [...cwds].slice(0, 12).map(async (cwd) => {
        const jsonOut = await runMcpCommand('grok', ['mcp', 'list', '--json'], {
          cwd,
          timeoutMs: 20_000,
        });
        let entries = parseListJson(jsonOut);
        if (entries.length === 0) {
          const textOut = await runMcpCommand('grok', ['mcp', 'list'], {
            cwd,
            timeoutMs: 20_000,
          });
          entries = parseCliMcpListOutput(textOut);
        }
        mergeEntries(merged, entries);
      }),
    );

    // Doctor discovers grok.com managed connectors (missing from `list`).
    // Only run from trusted folders + up to a few workspace roots — slow but cached.
    const doctorCwds = new Set<string>();
    for (const p of await readTrustedFolderPaths()) {
      doctorCwds.add(path.resolve(p));
    }
    for (const p of options?.workspacePaths ?? []) {
      if (p?.trim()) doctorCwds.add(path.resolve(p.trim()));
    }
    // Always try home once so non-team machines still work
    if (doctorCwds.size === 0) {
      doctorCwds.add(os.homedir());
    }

    const doctorCacheKey = `grok-doctor::${[...doctorCwds].sort().join('|')}`;
    let doctorEntries: CliMcpListEntry[] | null = null;
    if (!options?.bypassCache) {
      const hit = listCache.get(doctorCacheKey);
      if (hit && Date.now() - hit.at < DOCTOR_CACHE_TTL_MS) {
        doctorEntries = hit.entries;
      }
    }
    if (!doctorEntries) {
      doctorEntries = [];
      const doctorMap = new Map<string, CliMcpListEntry>();
      // Cap to 4 doctor runs to keep settings load reasonable
      for (const cwd of [...doctorCwds].slice(0, 4)) {
        const raw = await runMcpCommand('grok', ['mcp', 'doctor', '--json'], {
          cwd,
          timeoutMs: 60_000,
        });
        mergeEntries(doctorMap, parseDoctorJson(raw));
      }
      doctorEntries = [...doctorMap.values()];
      listCache.set(doctorCacheKey, { at: Date.now(), entries: doctorEntries });
    }
    mergeEntries(merged, doctorEntries);
  } else {
    return [];
  }

  const entries = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  listCache.set(cacheKey, { at: Date.now(), entries });
  return entries;
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
