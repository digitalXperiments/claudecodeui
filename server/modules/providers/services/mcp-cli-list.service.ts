import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
};

/**
 * Parse `claude mcp list` / similar human-readable output.
 *
 * Examples:
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

function targetToServer(
  provider: LLMProvider,
  scope: McpScope,
  entry: CliMcpListEntry,
): ProviderMcpServer {
  const target = entry.target;
  const looksUrl = /^https?:\/\//i.test(target);
  if (looksUrl) {
    return {
      provider,
      name: entry.name,
      scope,
      transport: 'http',
      url: target.split(/\s+/)[0],
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

async function runMcpList(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
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

const listCache = new Map<string, { at: number; entries: CliMcpListEntry[] }>();
const CACHE_TTL_MS = 30_000;

/**
 * Live MCP inventory from the provider CLI (includes claude.ai connectors and
 * grok.com-linked servers that never appear in local config files).
 */
export async function listMcpServersFromCli(
  provider: LLMProvider,
  options?: { bypassCache?: boolean },
): Promise<CliMcpListEntry[]> {
  const cacheKey = provider;
  if (!options?.bypassCache) {
    const hit = listCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return hit.entries;
    }
  }

  let output = '';
  if (provider === 'claude') {
    output = await runMcpList('claude', ['mcp', 'list']);
  } else if (provider === 'grok') {
    output = await runMcpList('grok', ['mcp', 'list']);
  } else {
    return [];
  }

  const entries = parseCliMcpListOutput(output);
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
