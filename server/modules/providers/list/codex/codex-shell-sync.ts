import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  adoptShellCreatedSession,
  fileContainsShellPrompt,
  SHELL_ADOPTION_SKEW_MS,
  type ShellSessionAdoptionResult,
} from '@/modules/providers/services/shell-session-adoption.service.js';

import { mapPermissionModeToCodexOptions } from './codex-permission-mode.js';
import { CodexSessionSynchronizer } from './codex-session-synchronizer.provider.js';

export type CodexShellRuntime = {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  permissionMode?: string;
};

type JsonRecord = Record<string, unknown>;

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readType = (value: unknown): string | undefined =>
  value && typeof value === 'object' ? readString((value as JsonRecord).type) : undefined;

/** Modes the Codex chat runtime exposes (see provider capabilities). */
const CODEX_SHELL_PERMISSION_MODES = ['default', 'auto', 'bypassPermissions'] as const;

/**
 * Inverse of mapPermissionModeToCodexOptions for what Codex records in its
 * rollout. Each chat mode has a distinct approval policy; `never` only counts
 * as bypass with a full-access sandbox, because unattended plan runs also use
 * `never` (read-only). A read-only sandbox is plan, which the chat runtime
 * does not offer for Codex, so it maps to nothing.
 */
export function mapCodexSettingsToPermissionMode(settings: {
  approvalPolicy?: string;
  sandboxType?: string;
  permissionProfileType?: string;
}): string | undefined {
  const { approvalPolicy, sandboxType, permissionProfileType } = settings;
  if (!approvalPolicy || sandboxType === 'read-only') {
    return undefined;
  }
  const fullAccess = sandboxType === 'danger-full-access' || permissionProfileType === 'disabled';
  for (const mode of CODEX_SHELL_PERMISSION_MODES) {
    const options = mapPermissionModeToCodexOptions(mode);
    if (options.approvalPolicy !== approvalPolicy) continue;
    if (mode === 'bypassPermissions' && !fullAccess) return undefined;
    return mode;
  }
  return undefined;
}

/**
 * Extract the authoritative runtime settings Codex persists in rollout JSONL.
 *
 * `since` (epoch ms) ignores entries written before the shell PTY started:
 * the rollout still ends with the previous run's settings until the TUI
 * writes its own, and echoing those would revert a model just picked in chat.
 */
export function parseCodexShellRuntime(
  lines: string,
  options: { since?: number } = {},
): CodexShellRuntime | null {
  let runtime: CodexShellRuntime | null = null;
  const since = options.since;

  for (const line of lines.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as JsonRecord;
      if (since !== undefined) {
        const writtenAt = Date.parse(readString(entry.timestamp) ?? '');
        if (!Number.isFinite(writtenAt) || writtenAt < since) continue;
      }
      const payload = entry.payload as JsonRecord | undefined;
      if (entry.type === 'turn_context' && payload) {
        const previous: CodexShellRuntime = runtime ?? {};
        const model = readString(payload.model);
        const effort = readString(payload.effort);
        const permissionMode = mapCodexSettingsToPermissionMode({
          approvalPolicy: readString(payload.approval_policy),
          sandboxType: readType(payload.sandbox_policy),
          permissionProfileType: readType(payload.permission_profile),
        });
        runtime = {
          ...previous,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        };
      }
      if (entry.type === 'event_msg' && payload?.type === 'thread_settings_applied') {
        const settings = payload.thread_settings as JsonRecord | undefined;
        if (!settings) continue;
        const tier = readString(settings.service_tier);
        const model = readString(settings.model);
        const effort = readString(settings.reasoning_effort);
        const permissionMode = mapCodexSettingsToPermissionMode({
          approvalPolicy: readString(settings.approval_policy),
          sandboxType: readType(settings.sandbox_policy),
          permissionProfileType: readType(settings.permission_profile),
        });
        const previous: CodexShellRuntime = runtime ?? {};
        runtime = {
          ...previous,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(tier ? { fastMode: tier === 'fast' || tier === 'priority' } : {}),
          ...(permissionMode ? { permissionMode } : {}),
        };
      }
    } catch {
      // A rollout can be read while Codex is appending its final line.
    }
  }

  return runtime;
}

export function readCodexShellRuntime(
  filePath: string | null | undefined,
  options: { since?: number } = {},
): CodexShellRuntime | null {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    // Nothing written since the PTY started: skip the tail read entirely.
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
    return parseCodexShellRuntime(stat.size > tailSize ? text.slice(text.indexOf('\n') + 1) : text, options);
  } catch {
    return null;
  }
}

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

/** `YYYY/MM/DD` rollout folders (local time, like Codex) spanning [from, now]. */
function rolloutDayDirs(sessionsRoot: string, from: number): string[] {
  const dirs: string[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  const end = Date.now();
  while (day.getTime() <= end) {
    dirs.push(path.join(
      sessionsRoot,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    ));
    day.setDate(day.getDate() + 1);
  }
  return dirs;
}

function readRolloutSessionMeta(filePath: string): { id: string; cwd: string } | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytes).toString('utf8').split('\n')[0] ?? '';
      const payload = (JSON.parse(firstLine) as JsonRecord).payload as JsonRecord | undefined;
      const id = readString(payload?.id);
      const cwd = readString(payload?.cwd);
      return id && cwd ? { id, cwd } : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Newest-first rollout files Codex CREATED for this project while the shell
 * PTY was alive — from `startedAt` to `until` (PTY exit / adoption time) — a
 * fresh `codex`, or the fallback when `codex resume` failed.
 */
export function findShellCreatedCodexRollouts(
  projectPath: string,
  startedAt: number,
  sessionsRoot: string = CODEX_SESSIONS_ROOT,
  until: number = Date.now(),
): Array<{ id: string; filePath: string }> {
  const since = startedAt - SHELL_ADOPTION_SKEW_MS;
  const before = until + SHELL_ADOPTION_SKEW_MS;
  const resolvedProject = path.resolve(projectPath);
  const found: Array<{ id: string; filePath: string; birthtimeMs: number }> = [];
  for (const dir of rolloutDayDirs(sessionsRoot, since)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(dir, name);
      try {
        const { birthtimeMs } = fs.statSync(filePath);
        if (birthtimeMs < since || birthtimeMs > before) continue;
        const meta = readRolloutSessionMeta(filePath);
        if (!meta || path.resolve(meta.cwd) !== resolvedProject) continue;
        found.push({ id: meta.id, filePath, birthtimeMs });
      } catch {
        // Vanished mid-scan.
      }
    }
  }
  return found
    .sort((left, right) => right.birthtimeMs - left.birthtimeMs)
    .map(({ id, filePath }) => ({ id, filePath }));
}

/** Adopts a Codex session the Shell TUI created (see adoptShellCreatedSession). */
export async function syncCodexShellSession(info: {
  appSessionId: string | null;
  projectPath: string;
  startedAt: number;
  endedAt?: number;
  submittedPrompts?: readonly string[];
  sessionsRoot?: string;
}): Promise<ShellSessionAdoptionResult | null> {
  if (!info.projectPath || !Number.isFinite(info.startedAt)) {
    return null;
  }
  const rollouts = findShellCreatedCodexRollouts(
    info.projectPath,
    info.startedAt,
    info.sessionsRoot,
    info.endedAt ?? Date.now(),
  );
  const synchronizer = new CodexSessionSynchronizer();
  for (const rollout of rollouts) {
    // Index before adoption so the ownership check sees the placeholder row.
    await synchronizer.synchronizeFile(rollout.filePath);
  }
  const filePaths = new Map(rollouts.map((rollout) => [rollout.id, rollout.filePath]));
  return adoptShellCreatedSession({
    provider: 'codex',
    appSessionId: info.appSessionId,
    candidates: rollouts.map((rollout) => rollout.id),
    startedAt: info.startedAt,
    submittedPrompts: info.submittedPrompts,
    hasPromptEvidence: (candidateId, evidence) => {
      const filePath = filePaths.get(candidateId);
      return Boolean(filePath && fileContainsShellPrompt(filePath, evidence));
    },
  });
}
