import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import {
  adoptShellCreatedSession,
  SHELL_ADOPTION_SKEW_MS,
  textContainsShellPrompt,
  type ShellSessionAdoptionResult,
} from '@/modules/providers/services/shell-session-adoption.service.js';
import { getOpenCodeDatabasePath } from '@/shared/utils.js';

import { OpenCodeSessionSynchronizer } from './opencode-session-synchronizer.provider.js';

export type OpenCodeShellRuntime = {
  /** `providerID/modelID`, the same shape the chat picker and `-m` use. */
  model?: string;
  /** OpenCode's model variant — what the chat runtime sets as `effort`. */
  effort?: string;
  /** Primary agent (`build` / `plan`) the last reply ran under. */
  agent?: string;
  providerSessionId: string;
};

type JsonRecord = Record<string, unknown>;

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function parseAssistantData(raw: string | null | undefined): Omit<OpenCodeShellRuntime, 'providerSessionId'> | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as JsonRecord;
    if (data.role !== 'assistant') return null;
    const providerId = readString(data.providerID);
    const modelId = readString(data.modelID);
    const effort = readString(data.variant);
    const agent = readString(data.agent) ?? readString(data.mode);
    return {
      ...(providerId && modelId ? { model: `${providerId}/${modelId}` } : {}),
      ...(effort ? { effort } : {}),
      ...(agent ? { agent } : {}),
    };
  } catch {
    return null;
  }
}

function openReadonly(dbPath: string): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function readLatestAssistant(
  db: Database.Database,
  sessionId: string,
  since: number | undefined,
): Omit<OpenCodeShellRuntime, 'providerSessionId'> | null {
  const rows = db.prepare(`
    SELECT data FROM message
    WHERE session_id = ? AND time_created >= ?
    ORDER BY time_created DESC, id DESC
    LIMIT 5
  `).all(sessionId, since ?? 0) as Array<{ data: string | null }>;
  for (const row of rows) {
    const parsed = parseAssistantData(row.data);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Model / variant / agent of the newest assistant reply the interactive
 * OpenCode TUI wrote since the shell PTY started (`since`). With no mapped
 * provider session, the newest top-level session in the project touched
 * since then — and not owned by another app row — is used instead.
 */
export function readOpenCodeShellRuntime(info: {
  providerSessionId?: string | null;
  projectPath: string;
  appSessionId?: string | null;
  since?: number;
  databasePath?: string;
}): OpenCodeShellRuntime | null {
  const db = openReadonly(info.databasePath ?? getOpenCodeDatabasePath());
  if (!db) return null;
  try {
    if (info.providerSessionId) {
      const runtime = readLatestAssistant(db, info.providerSessionId, info.since);
      return runtime ? { ...runtime, providerSessionId: info.providerSessionId } : null;
    }
    const sessions = db.prepare(`
      SELECT id FROM session
      WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL
        AND COALESCE(time_updated, time_created, 0) >= ?
      ORDER BY COALESCE(time_updated, time_created, 0) DESC
      LIMIT 5
    `).all(path.resolve(info.projectPath), info.since ?? 0) as Array<{ id: string }>;
    for (const { id } of sessions) {
      const owner = sessionsDb.getSessionByProviderSessionId(id, 'opencode');
      if (owner && owner.session_id !== info.appSessionId && owner.session_id !== owner.provider_session_id) {
        continue;
      }
      const runtime = readLatestAssistant(db, id, info.since);
      if (runtime) return { ...runtime, providerSessionId: id };
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Newest-first top-level OpenCode sessions CREATED in this project while the
 * PTY was alive: from `startedAt` to `until` (PTY exit / adoption time).
 */
export function findShellCreatedOpenCodeSessions(
  projectPath: string,
  startedAt: number,
  databasePath: string = getOpenCodeDatabasePath(),
  until: number = Date.now(),
): string[] {
  const db = openReadonly(databasePath);
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT id FROM session
      WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL
        AND COALESCE(time_created, 0) >= ?
        AND COALESCE(time_created, 0) <= ?
      ORDER BY COALESCE(time_created, 0) DESC, id DESC
    `).all(
      path.resolve(projectPath),
      startedAt - SHELL_ADOPTION_SKEW_MS,
      until + SHELL_ADOPTION_SKEW_MS,
    ) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** True when one OpenCode session's message parts contain a typed prompt. */
export function openCodeSessionContainsPrompt(
  sessionId: string,
  evidence: readonly string[],
  databasePath: string = getOpenCodeDatabasePath(),
): boolean {
  if (evidence.length === 0) return false;
  const db = openReadonly(databasePath);
  if (!db) return false;
  try {
    const rows = db.prepare('SELECT data FROM part WHERE session_id = ?')
      .all(sessionId) as Array<{ data: string | null }>;
    return rows.some((row) => textContainsShellPrompt(row.data ?? '', evidence));
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Adopts an OpenCode session the Shell TUI created (see adoptShellCreatedSession). */
export async function syncOpenCodeShellSession(info: {
  appSessionId: string | null;
  projectPath: string;
  startedAt: number;
  endedAt?: number;
  submittedPrompts?: readonly string[];
  databasePath?: string;
}): Promise<ShellSessionAdoptionResult | null> {
  if (!info.projectPath || !Number.isFinite(info.startedAt)) {
    return null;
  }
  const candidates = findShellCreatedOpenCodeSessions(
    info.projectPath,
    info.startedAt,
    info.databasePath,
    info.endedAt ?? Date.now(),
  );
  if (candidates.length > 0) {
    await new OpenCodeSessionSynchronizer(
      info.databasePath ? { databasePath: info.databasePath } : {},
    ).synchronize(new Date(info.startedAt - SHELL_ADOPTION_SKEW_MS));
  }
  return adoptShellCreatedSession({
    provider: 'opencode',
    appSessionId: info.appSessionId,
    candidates,
    startedAt: info.startedAt,
    submittedPrompts: info.submittedPrompts,
    hasPromptEvidence: (candidateId, evidence) =>
      openCodeSessionContainsPrompt(candidateId, evidence, info.databasePath),
  });
}
