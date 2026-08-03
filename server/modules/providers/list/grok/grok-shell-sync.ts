import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';

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
 *   session is unowned — with two Grok sessions live in the same project the
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
    const candidates = touched.filter((candidate) => {
      const owner = sessionsDb.getSessionByProviderSessionId(candidate.id);
      return !owner || owner.session_id === appRow.session_id;
    });
    if (candidates.length !== 1) {
      return null;
    }
    const candidate = candidates[0]!;
    sessionsDb.assignProviderSessionId(appRow.session_id, candidate.id);
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
