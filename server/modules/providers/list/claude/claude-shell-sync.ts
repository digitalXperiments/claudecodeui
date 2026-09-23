import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  adoptShellCreatedSession,
  fileContainsShellPrompt,
  SHELL_ADOPTION_SKEW_MS,
  type ShellSessionAdoptionResult,
} from '@/modules/providers/services/shell-session-adoption.service.js';

import { ClaudeSessionSynchronizer } from './claude-session-synchronizer.provider.js';

export type ClaudeShellRuntime = {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /**
   * When (epoch ms) the user last ran `/model` in the TUI, set only once an
   * assistant reply has followed it. Distinguishes an explicit model switch
   * from per-turn flips (`opusplan`, fallback models) in `message.model`.
   */
  modelCommandAt?: number;
};

const MODEL_COMMAND_MARKER = '<command-name>/model</command-name>';

/** True for the entry Claude Code writes when `/model` runs in the TUI. */
function isModelCommandEntry(entry: JsonRecord): boolean {
  const message = entry.message as JsonRecord | undefined;
  const content = typeof entry.content === 'string'
    ? entry.content
    : typeof message?.content === 'string' ? message.content : '';
  return content.includes(MODEL_COMMAND_MARKER);
}

type JsonRecord = Record<string, unknown>;

const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Claude Code's transcript folder name for a cwd (every non-alphanumeric → `-`). */
export function claudeProjectDirectory(projectPath: string, projectsRoot: string = CLAUDE_PROJECTS_ROOT): string {
  return path.join(projectsRoot, path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Runtime settings the interactive Claude TUI recorded in its session JSONL:
 * assistant entries carry the model that answered (`message.model`) and the
 * turn's `effort`; user entries carry the `permissionMode` the prompt was sent
 * under (Shift+Tab in the TUI changes it for the next prompt).
 *
 * `since` (epoch ms) ignores entries written before the shell PTY started so
 * the previous run's settings never revert a choice just made in chat.
 */
export function parseClaudeShellRuntime(
  lines: string,
  options: { since?: number } = {},
): ClaudeShellRuntime | null {
  let runtime: ClaudeShellRuntime | null = null;
  let pendingModelCommandAt: number | undefined;
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as JsonRecord;
      if (entry.isSidechain === true) continue;
      const writtenAt = Date.parse(readString(entry.timestamp) ?? '');
      if (options.since !== undefined) {
        if (!Number.isFinite(writtenAt) || writtenAt < options.since) continue;
      }
      if (isModelCommandEntry(entry)) {
        pendingModelCommandAt = Number.isFinite(writtenAt) ? writtenAt : Date.now();
      }
      if (entry.type === 'assistant') {
        const message = entry.message as JsonRecord | undefined;
        const model = readString(message?.model);
        const effort = readString(entry.effort);
        // `<synthetic>` marks locally generated notices, not a real model.
        const realModel = model && model !== '<synthetic>' ? model : undefined;
        const modelCommandAt = realModel ? pendingModelCommandAt : undefined;
        if (modelCommandAt !== undefined) pendingModelCommandAt = undefined;
        runtime = {
          ...(runtime ?? {}),
          ...(realModel ? { model: realModel } : {}),
          ...(effort ? { effort } : {}),
          ...(modelCommandAt !== undefined ? { modelCommandAt } : {}),
        };
      } else if (entry.type === 'user') {
        const permissionMode = readString(entry.permissionMode);
        if (permissionMode) {
          runtime = { ...(runtime ?? {}), permissionMode };
        }
      }
    } catch {
      // The TUI may be appending the final line while we read.
    }
  }
  return runtime;
}

export function readClaudeShellRuntime(
  filePath: string | null | undefined,
  options: { since?: number } = {},
): ClaudeShellRuntime | null {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    if (options.since !== undefined && stat.mtimeMs < options.since) return null;
    const tailSize = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(tailSize);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, tailSize, stat.size - tailSize);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString('utf8');
    return parseClaudeShellRuntime(stat.size > tailSize ? text.slice(text.indexOf('\n') + 1) : text, options);
  } catch {
    return null;
  }
}

/**
 * Newest-first top-level transcripts Claude CREATED in this project while the
 * PTY was alive: from `startedAt` to `until` (PTY exit / adoption time).
 */
export function findShellCreatedClaudeTranscripts(
  projectPath: string,
  startedAt: number,
  projectsRoot: string = CLAUDE_PROJECTS_ROOT,
  until: number = Date.now(),
): Array<{ id: string; filePath: string }> {
  const since = startedAt - SHELL_ADOPTION_SKEW_MS;
  const before = until + SHELL_ADOPTION_SKEW_MS;
  const projectDir = claudeProjectDirectory(projectPath, projectsRoot);
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return [];
  }
  const found: Array<{ id: string; filePath: string; birthtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.birthtimeMs < since || stat.birthtimeMs > before) continue;
      found.push({ id: name.slice(0, -'.jsonl'.length), filePath, birthtimeMs: stat.birthtimeMs });
    } catch {
      // Vanished mid-scan.
    }
  }
  return found
    .sort((left, right) => right.birthtimeMs - left.birthtimeMs)
    .map(({ id, filePath }) => ({ id, filePath }));
}

/**
 * Transcript the shell's Claude TUI writes to: the mapped session's JSONL,
 * else the single newest transcript created since the PTY started that no
 * other app row owns (a fresh TUI that has not been adopted yet).
 */
export function resolveClaudeShellTranscript(info: {
  appSessionId: string | null;
  projectPath: string;
  startedAt: number;
  projectsRoot?: string;
}): string | null {
  const appRow = info.appSessionId ? sessionsDb.getSessionById(info.appSessionId) : null;
  if (appRow?.provider === 'claude') {
    if (appRow.jsonl_path) return appRow.jsonl_path;
    if (appRow.provider_session_id) {
      return path.join(
        claudeProjectDirectory(info.projectPath, info.projectsRoot),
        `${appRow.provider_session_id}.jsonl`,
      );
    }
  }
  const unowned = findShellCreatedClaudeTranscripts(info.projectPath, info.startedAt, info.projectsRoot)
    .filter(({ id }) => {
      const owner = sessionsDb.getSessionByProviderSessionId(id, 'claude');
      return !owner || owner.session_id === info.appSessionId || owner.session_id === owner.provider_session_id;
    });
  return unowned.length === 1 ? unowned[0]!.filePath : null;
}

/** Adopts a Claude session the Shell TUI created (see adoptShellCreatedSession). */
export async function syncClaudeShellSession(info: {
  appSessionId: string | null;
  projectPath: string;
  startedAt: number;
  endedAt?: number;
  submittedPrompts?: readonly string[];
  projectsRoot?: string;
}): Promise<ShellSessionAdoptionResult | null> {
  if (!info.projectPath || !Number.isFinite(info.startedAt)) {
    return null;
  }
  const transcripts = findShellCreatedClaudeTranscripts(
    info.projectPath,
    info.startedAt,
    info.projectsRoot,
    info.endedAt ?? Date.now(),
  );
  const synchronizer = new ClaudeSessionSynchronizer();
  for (const transcript of transcripts) {
    await synchronizer.synchronizeFile(transcript.filePath);
  }
  const filePaths = new Map(transcripts.map((transcript) => [transcript.id, transcript.filePath]));
  return adoptShellCreatedSession({
    provider: 'claude',
    appSessionId: info.appSessionId,
    candidates: transcripts.map((transcript) => transcript.id),
    startedAt: info.startedAt,
    submittedPrompts: info.submittedPrompts,
    hasPromptEvidence: (candidateId, evidence) => {
      const filePath = filePaths.get(candidateId);
      return Boolean(filePath && fileContainsShellPrompt(filePath, evidence));
    },
  });
}
