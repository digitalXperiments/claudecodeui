/**
 * Grok ACP session policy for grok.com managed gateway MCPs (team connectors
 * such as Leong Associates).
 *
 * Verified on grok 0.2.112:
 *   - `session/new` attaches the managed gateway catalog (~2–6s after local MCP init)
 *   - `session/load` never runs that catalog fetch (start_type=resumed)
 *
 * CloudCLI therefore defaults chat ACP children to `session/new` so the chat
 * bar can use cloud MCPs. When that forks a new Grok id, we seed the new
 * session's on-disk transcript from the prior id (UI history) and inject a
 * compact prior-context hint on the first prompt (agent memory). Forked ids
 * are still persisted by spawnGrok so Shell can `--resume` the same transcript.
 *
 * Opt into load-first (history-native resume, no managed gateway) with
 * CLOUDCLI_GROK_ACP_SESSION_LOAD=1.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveGrokSessionDir } from './grok-sessions.provider.js';

/** Catalog connection shape from mcpCatalogService.resolveForProvider. */
export type ResolvedMcpConnection = {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};

/**
 * Convert catalog defs into Grok ACP `session/new`/`session/load` `mcpServers`.
 *
 * Verified live (grok 0.2.x): ACP uses an untagged McpServer enum that rejects
 * config.toml-style env maps. Stdio env must be `[{ name, value }, ...]`, and
 * each entry needs an explicit `type` (`stdio` | `http` | `sse`). Omitting or
 * mis-shaping this yields:
 *   Invalid params: data did not match any variant of untagged enum McpServer
 * which previously failed Mission Control produce runs that bound Obsidian/etc.
 */
export function toGrokAcpMcpServers(
  resolvedServers: ResolvedMcpConnection[],
): Array<Record<string, unknown>> {
  return resolvedServers
    .map((server) => {
      if (server.transport === 'stdio') {
        if (typeof server.command !== 'string' || !server.command.trim()) {
          console.warn(`[grok-acp] skipping stdio MCP "${server.name}": missing command`);
          return null;
        }
        const entry: Record<string, unknown> = {
          name: server.name,
          type: 'stdio',
          command: server.command,
          args: Array.isArray(server.args) ? server.args : [],
          env: envRecordToAcpEnv(server.env),
        };
        if (typeof server.cwd === 'string' && server.cwd.trim()) {
          entry.cwd = server.cwd;
        }
        return entry;
      }

      if (typeof server.url !== 'string' || !server.url.trim()) {
        console.warn(`[grok-acp] skipping ${server.transport} MCP "${server.name}": missing url`);
        return null;
      }
      // Grok ACP does not accept placeholder project-mcp URLs over session/new.
      if (server.url.startsWith('grok-project-mcp://')) {
        console.warn(
          `[grok-acp] skipping "${server.name}": placeholder url ${server.url} (managed by Grok CLI)`,
        );
        return null;
      }

      const transport = server.transport === 'sse' ? 'sse' : 'http';
      const entry: Record<string, unknown> = {
        name: server.name,
        type: transport,
        url: server.url,
      };
      const headers = headersRecordToAcpHeaders(server.headers);
      if (headers.length > 0) {
        entry.headers = headers;
      }
      return entry;
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function envRecordToAcpEnv(
  env: Record<string, string> | undefined,
): Array<{ name: string; value: string }> {
  if (!env || typeof env !== 'object') return [];
  return Object.entries(env)
    .filter(([name, value]) => typeof name === 'string' && name && typeof value === 'string')
    .map(([name, value]) => ({ name, value }));
}

function headersRecordToAcpHeaders(
  headers: Record<string, string> | undefined,
): Array<{ name: string; value: string }> {
  // Same wire shape as env in Grok's servers_updated notifications.
  return envRecordToAcpEnv(headers);
}

/** Prefer ACP session/load only when explicitly requested via env. */
export function shouldPreferGrokAcpSessionLoad(
  resumeSessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!resumeSessionId) return false;
  const flag = String(env.CLOUDCLI_GROK_ACP_SESSION_LOAD || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

const SEED_FILES = ['chat_history.jsonl', 'summary.json'] as const;

/**
 * Copy prior session transcript files into a freshly forked session dir so the
 * history reader still shows earlier turns after session/new remaps the id.
 * Never overwrites a non-empty destination file (Grok may have already written).
 */
export function seedGrokSessionTranscript(
  projectPath: string,
  fromSessionId: string,
  toSessionId: string,
): boolean {
  if (!projectPath || !fromSessionId || !toSessionId || fromSessionId === toSessionId) {
    return false;
  }

  try {
    const srcDir = resolveGrokSessionDir(projectPath, fromSessionId);
    const dstDir = resolveGrokSessionDir(projectPath, toSessionId);
    if (!fs.existsSync(srcDir)) {
      return false;
    }
    fs.mkdirSync(dstDir, { recursive: true });

    let copied = false;
    for (const name of SEED_FILES) {
      const src = path.join(srcDir, name);
      const dst = path.join(dstDir, name);
      if (!fs.existsSync(src)) continue;

      let shouldCopy = !fs.existsSync(dst);
      if (!shouldCopy) {
        try {
          const srcSize = fs.statSync(src).size;
          const dstSize = fs.statSync(dst).size;
          // Empty/near-empty dest after session/new — safe to seed.
          shouldCopy = dstSize < 32 && srcSize > dstSize;
        } catch {
          shouldCopy = false;
        }
      }
      if (!shouldCopy) continue;

      fs.copyFileSync(src, dst);
      copied = true;
    }
    return copied;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[grok-acp] seed transcript ${fromSessionId} → ${toSessionId} failed:`, message);
    return false;
  }
}

function extractTextParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function unwrapUserQuery(value: string): string | null {
  const openTag = '<user_query>';
  const closeTag = '</user_query>';
  const openIndex = value.indexOf(openTag);
  if (openIndex >= 0) {
    const afterOpen = value.slice(openIndex + openTag.length);
    const closeIndex = afterOpen.lastIndexOf(closeTag);
    const inner = closeIndex >= 0 ? afterOpen.slice(0, closeIndex) : afterOpen;
    return inner.trim() || null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('<user_info>') || trimmed.startsWith('<system-reminder>')) {
    return null;
  }
  return trimmed;
}

/**
 * Build a compact prior-turn hint for the first prompt after forking via
 * session/new (agent context is empty even when on-disk history was seeded).
 */
export function buildGrokPriorSessionContextHint(
  projectPath: string,
  priorSessionId: string,
  options?: { maxTurns?: number; maxChars?: number },
): string {
  if (!projectPath || !priorSessionId) return '';

  const maxTurns = options?.maxTurns ?? 12;
  const maxChars = options?.maxChars ?? 12_000;
  const historyPath = path.join(
    resolveGrokSessionDir(projectPath, priorSessionId),
    'chat_history.jsonl',
  );

  let raw: string;
  try {
    raw = fs.readFileSync(historyPath, 'utf8');
  } catch {
    return '';
  }
  if (!raw.trim()) return '';

  const turns: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof data.type === 'string' ? data.type : '';
    if (type === 'user') {
      const text = unwrapUserQuery(extractTextParts(data.content));
      if (text) turns.push({ role: 'user', text });
    } else if (type === 'assistant' || type === 'message') {
      const text = extractTextParts(data.content).trim();
      if (text && !text.startsWith('<')) {
        turns.push({ role: 'assistant', text });
      }
    }
  }

  if (turns.length === 0) return '';

  const recent = turns.slice(-maxTurns);
  const lines: string[] = [
    '<system-reminder>',
    'This chat was reopened with a fresh Grok ACP session so grok.com managed',
    'MCP tools (team connectors) are available. Prior turns from the same',
    'CloudCLI conversation (summarized) follow for continuity:',
    '',
  ];

  let used = lines.join('\n').length;
  const body: string[] = [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    const snippet = turn.text.length > 800 ? `${turn.text.slice(0, 800)}…` : turn.text;
    const block = `${turn.role === 'user' ? 'User' : 'Assistant'}: ${snippet}`;
    if (used + block.length + 1 > maxChars) break;
    body.unshift(block);
    used += block.length + 1;
  }

  if (body.length === 0) return '';
  lines.push(...body, '</system-reminder>', '');
  return lines.join('\n');
}
