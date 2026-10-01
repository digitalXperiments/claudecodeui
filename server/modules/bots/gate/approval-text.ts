/** Plain-language wording for approval cards and "I stopped waiting" messages. */
import os from 'node:os';

import type { BotGateDecision } from '@/modules/bots/bots.types.js';

const PATH_KEYS = ['file_path', 'filePath', 'abs_path', 'absPath', 'target_file', 'file', 'path', 'directory', 'dir', 'target_directory', 'notebook_path'];

const READ_TOOLS = /^(?:read|readfile|viewfile|view|glob|grep|grepsearch|ls|listdir|listdirectory)$/;
const WRITE_TOOLS = /^(?:write|writefile|edit|multiedit|notebookedit|searchreplace|strreplace)$/;

const norm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** `/Users/me/Documents/very/long/path/file.md` -> `~/Documents/.../file.md`, short enough for a title. */
export function shortPath(value: string, max = 48): string {
  let text = value.trim();
  const home = os.homedir();
  if (text === home) text = '~';
  else if (text.startsWith(`${home}/`)) text = `~${text.slice(home.length)}`;
  if (text.length <= max) return text;
  const parts = text.split('/').filter(Boolean);
  const short = `${text.startsWith('~') ? '~' : ''}/\u2026/${parts.slice(-2).join('/')}`;
  return short.length <= max ? short : `\u2026/${parts[parts.length - 1] ?? text}`.slice(-max);
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function shortText(value: string, max = 60): string {
  const line = value.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What a gated call does, as a verb phrase: "change ~/x/y.md", "run: rm -r build", "use send_message". */
export function describeGateAction(row: Pick<BotGateDecision, 'server' | 'tool' | 'args'>): string {
  if (row.server !== 'builtin') return `use ${row.tool}`;
  const key = norm(row.tool);
  const target = firstString(row.args, PATH_KEYS);
  if (READ_TOOLS.test(key)) return target ? `read ${shortPath(target)}` : 'read files';
  if (WRITE_TOOLS.test(key)) return target ? `change ${shortPath(target)}` : 'change files';
  if (key === 'bash' || key === 'shell') {
    const command = firstString(row.args, ['command', 'cmd', 'script']);
    return command ? `run: ${shortText(command)}` : 'run a command';
  }
  if (key === 'webfetch' || key === 'websearch') {
    const url = firstString(row.args, ['url', 'query']);
    if (!url) return 'use the web';
    try {
      return `fetch ${new URL(url).host}`;
    } catch {
      return `search the web for "${shortText(url, 40)}"`;
    }
  }
  return `use ${row.tool}`;
}

/** The approval card title: "Personal Gmail wants to change ~/x/y.md". */
export function approvalCardTitle(botTitle: string, row: Pick<BotGateDecision, 'server' | 'tool' | 'args'>): string {
  return `${botTitle} wants to ${row.server === 'builtin' ? describeGateAction(row) : row.tool}`;
}

/** "30 min", "2 h", "1 h 30 min"; never less than a minute. */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** What the bot says in its thread when an approval timed out. */
export function expiredApprovalMessage(action: string, waitedMs: number): string {
  return `I needed your OK to ${action} but didn't hear back in ${formatWait(waitedMs)}, so I stopped. Reply 'retry' or press Wake now.`;
}
