import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  fileContainsShellPrompt,
  shellPromptEvidence,
} from '@/modules/providers/services/shell-session-adoption.service.js';
import { broadcastSessionRemoved } from '@/modules/websocket/index.js';

import { GrokSessionSynchronizer } from './grok-session-synchronizer.provider.js';

const GROK_SESSIONS_ROOT = path.join(os.homedir(), '.grok', 'sessions');

// Allowance for clock skew and transcript write lag when matching session
// directories the shell PTY touched.
const SINCE_SKEW_MS = 15_000;

export type GrokShellSyncResult = {
  /** Canonical app session id to broadcast a session_upserted for. */
  appSessionId: string;
  providerSessionId: string;
  /** True when this call changed the app↔provider mapping or created a row. */
  adopted: boolean;
};

/**
 * Adopts whatever Grok session the interactive Shell TUI touched back into
 * the app, keeping Chat ↔ Shell on ONE transcript.
 *
 * The Shell tab spawns `grok` / `grok --resume <id>` in a PTY. When it starts
 * fresh (no mapping yet, or a stale resume id) Grok allocates a session id the
 * app has never seen; without adoption the Chat tab, the history reader, and
 * the next `--resume` all keep pointing at the old (or no) transcript — the
 * "chat and shell drift apart" bug. This scans the project's session dir for
 * directories touched while the PTY was alive and:
 *
 * - app session exists: report the already-mapped id when the TUI resumed it;
 *   otherwise bind a shell-created provider id only when exactly ONE touched
 *   session is unowned AND its chat history contains a prompt typed into this
 *   PTY — with two Grok sessions live in the same project the
 *   newest-touched dir can belong to the other conversation before its DB row
 *   exists, so an ambiguous scan is left unbound instead of guessed. An
 *   existing mapping came from the provider runtime itself and is never
 *   overwritten here;
 * - no app session (shell opened on an unsent "new chat"): index the TUI
 *   session as its own sidebar row via the regular synchronizer path.
 *
 * Session dirs live under the real `~/.grok/sessions` because every managed
 * GROK_HOME symlinks `sessions` there (see grok-home.js unifySessionsDir).
 */
export async function syncGrokShellSession(info: {
  appSessionId: string | null;
  projectPath: string;
  startedAt: number;
  /** Prompts submitted into the PTY: evidence a touched session is this shell's. */
  submittedPrompts?: readonly string[];
  /** Test hook: override the on-disk sessions root (defaults to real ~/.grok). */
  sessionsRoot?: string;
}): Promise<GrokShellSyncResult | null> {
  const { appSessionId, projectPath, startedAt } = info;
  if (!projectPath || !Number.isFinite(startedAt)) {
    return null;
  }

  const sessionsRoot = info.sessionsRoot ?? GROK_SESSIONS_ROOT;
  const projectDir = path.join(sessionsRoot, encodeURIComponent(path.resolve(projectPath)));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }

  // Every session dir touched since the PTY started, newest first.
  const touched: { id: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const { mtimeMs } = fs.statSync(path.join(projectDir, entry.name));
      if (mtimeMs >= startedAt - SINCE_SKEW_MS) {
        touched.push({ id: entry.name, mtimeMs });
      }
    } catch {
      // Vanished mid-scan; skip.
    }
  }
  if (touched.length === 0) {
    return null;
  }
  touched.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const appRow = appSessionId ? sessionsDb.getSessionById(appSessionId) : null;

  if (appRow) {
    // The TUI resumed the already-mapped session: no remap, but still report
    // it so the caller broadcasts an upsert and open chat views refetch the
    // turns the shell just wrote.
    if (appRow.provider_session_id && touched.some((t) => t.id === appRow.provider_session_id)) {
      return {
        appSessionId: appRow.session_id,
        providerSessionId: appRow.provider_session_id,
        adopted: false,
      };
    }

    // An existing mapping was announced by the provider runtime itself; never
    // overwrite it from an mtime heuristic. A stale `--resume` that forked a
    // fresh id is left unbound rather than re-pointed at a guessed directory.
    if (appRow.provider_session_id) {
      return null;
    }

    // Adopt only when exactly ONE touched session is not owned by another app
    // row. Two live Grok sessions in the same project (a chat run + a shell,
    // or two chats) touch two directories, and a concurrent chat's row may
    // not exist yet for the ownership check to see — binding the newest then
    // permanently points this session at the other transcript. Ambiguity is
    // skipped: the row stays unbound instead of being bound wrong.
    // An external `grok` in the same project (not indexed yet, so unowned)
    // never carries this PTY's prompts; without one nothing is adopted.
    const evidence = shellPromptEvidence(info.submittedPrompts);
    if (evidence.length === 0) {
      return null;
    }
    const candidates = touched.filter((candidate) => {
      const owner = sessionsDb.getSessionByProviderSessionId(candidate.id, 'grok');
      return (!owner || owner.session_id === appRow.session_id)
        && fileContainsShellPrompt(path.join(projectDir, candidate.id, 'chat_history.jsonl'), evidence);
    });
    if (candidates.length !== 1) {
      return null;
    }
    const candidate = candidates[0]!;
    const mapping = sessionsDb.assignProviderSessionId(appRow.session_id, candidate.id);
    if (mapping.deletedSessionId && mapping.deletedSessionId !== appRow.session_id) {
      broadcastSessionRemoved(mapping.deletedSessionId);
    }
    console.info(
      `[grok-shell-sync] Adopted shell-created Grok session ${candidate.id} ` +
      `onto app session ${appRow.session_id}`,
    );
    return { appSessionId: appRow.session_id, providerSessionId: candidate.id, adopted: true };
  }

  // No app session: index the TUI session as its own sidebar row (idempotent;
  // createSession merges on provider_session_id).
  const synchronizer = new GrokSessionSynchronizer();
  for (const candidate of touched) {
    const summaryPath = path.join(projectDir, candidate.id, 'summary.json');
    if (!fs.existsSync(summaryPath)) {
      continue;
    }
    const canonicalId = await synchronizer.synchronizeFile(summaryPath);
    if (canonicalId) {
      console.info(
        `[grok-shell-sync] Indexed shell-created Grok session ${candidate.id} ` +
        `as app session ${canonicalId}`,
      );
      return { appSessionId: canonicalId, providerSessionId: candidate.id, adopted: true };
    }
  }
  return null;
}

/**
 * Model and reasoning effort the interactive Grok TUI last wrote for a session.
 * `summary.json` is updated by `/model` and `/effort`, which the chat composer
 * does not see on its own.
 */
function readGrokSummaryRuntime(summaryPath: string): { model: string | null; effort: string | null } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Record<string, unknown>;
    const model = typeof parsed.current_model_id === 'string' ? parsed.current_model_id.trim() : '';
    const effort = typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort.trim() : '';
    if (!model && !effort) {
      return null;
    }
    return { model: model || null, effort: effort || null };
  } catch {
    return null;
  }
}

export type GrokShellRuntimeReadOptions = {
  /**
   * Epoch ms the shell PTY started. A summary.json last written before this
   * still carries the previous run's model/effort; echoing it would revert a
   * choice just made in chat, so older summaries are ignored.
   */
  since?: number;
  /** App session the shell belongs to; sessions owned by other rows are skipped. */
  appSessionId?: string | null;
};

function isSummaryWrittenSince(summaryPath: string, since: number | undefined): boolean {
  if (since === undefined) {
    return true;
  }
  try {
    return fs.statSync(summaryPath).mtimeMs >= since;
  } catch {
    return false;
  }
}

export function readGrokSessionRuntime(
  projectPath: string,
  providerSessionId: string,
  sessionsRoot: string = GROK_SESSIONS_ROOT,
  options: GrokShellRuntimeReadOptions = {},
): { model: string | null; effort: string | null } | null {
  const sessionId = providerSessionId.trim();
  if (!projectPath || !sessionId) {
    return null;
  }
  const summaryPath = path.join(
    sessionsRoot,
    encodeURIComponent(path.resolve(projectPath)),
    sessionId,
    'summary.json',
  );
  if (!isSummaryWrittenSince(summaryPath, options.since)) {
    return null;
  }
  return readGrokSummaryRuntime(summaryPath);
}

/**
 * Newest session summary for this project — used when the TUI has not been
 * mapped yet. With `since`, only sessions the shell touched count, and a
 * session another app row owns (a concurrent chat in the same project) is
 * never mistaken for this shell's.
 */
export function readLatestGrokSessionRuntime(
  projectPath: string,
  sessionsRoot: string = GROK_SESSIONS_ROOT,
  options: GrokShellRuntimeReadOptions = {},
): { model: string | null; effort: string | null; providerSessionId: string } | null {
  if (!projectPath) {
    return null;
  }
  const projectDir = path.join(sessionsRoot, encodeURIComponent(path.resolve(projectPath)));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: {
    mtimeMs: number;
    runtime: { model: string | null; effort: string | null; providerSessionId: string };
  } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const summaryPath = path.join(projectDir, entry.name, 'summary.json');
    try {
      const { mtimeMs } = fs.statSync(summaryPath);
      if (options.since !== undefined && mtimeMs < options.since) {
        continue;
      }
      if (newest && mtimeMs < newest.mtimeMs) {
        continue;
      }
      if (options.since !== undefined) {
        const owner = sessionsDb.getSessionByProviderSessionId(entry.name, 'grok');
        const ownedElsewhere = owner
          && owner.session_id !== options.appSessionId
          && owner.session_id !== owner.provider_session_id;
        if (ownedElsewhere) {
          continue;
        }
      }
      const runtime = readGrokSummaryRuntime(summaryPath);
      if (!runtime) {
        continue;
      }
      newest = { mtimeMs, runtime: { ...runtime, providerSessionId: entry.name } };
    } catch {
      // Missing summary.
    }
  }
  return newest?.runtime ?? null;
}
