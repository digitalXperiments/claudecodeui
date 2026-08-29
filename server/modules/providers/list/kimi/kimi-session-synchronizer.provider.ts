import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  readObjectRecord,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Kimi Code CLI transcript artifacts.
 *
 * Kimi stores one directory per session under
 * `~/.kimi-code/sessions/wd_<sanitized-cwd>_<hash>/<session-uuid>/`, with a
 * `state.json` carrying the session's working directory + title, and the
 * real transcript at `agents/main/wire.jsonl`. `state.json` is the indexing
 * anchor (one per session) — the directory it lives in IS the session id,
 * unlike Grok/Cursor where the id has to be read out of file contents.
 */
export class KimiSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'kimi' as const;
  private readonly kimiSessionsRoot = path.join(os.homedir(), '.kimi-code', 'sessions');

  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyCreatedAfter(this.kimiSessionsRoot, 'state.json', since ?? null);

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processStateFile(filePath);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    let statePath = filePath;
    if (filePath.endsWith('wire.jsonl')) {
      // wire.jsonl lives at <session>/agents/main/wire.jsonl; state.json is
      // the stable session index anchor and carries the cwd/title metadata.
      statePath = path.join(path.dirname(filePath), '..', '..', 'state.json');
    }

    if (!statePath.endsWith('state.json')) {
      return null;
    }

    const parsed = await this.processStateFile(statePath);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath.endsWith('wire.jsonl') ? filePath : statePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      statePath
    );
  }

  private async processStateFile(filePath: string): Promise<ParsedSession | null> {
    try {
      const content = await fsSync.promises.readFile(filePath, 'utf8');
      const data = readObjectRecord(JSON.parse(content));
      if (!data) {
        return null;
      }

      // The session directory (parent of state.json) is named after the
      // session id itself, e.g. `session_4eeb3816-8a09-4444-9e00-...`.
      const sessionId = path.basename(path.dirname(filePath));
      const projectPath = typeof data.workDir === 'string' ? data.workDir : null;

      if (!sessionId || !projectPath) {
        return null;
      }

      const title = typeof data.title === 'string' && data.title.trim() ? data.title : undefined;

      return {
        sessionId,
        projectPath,
        sessionName: normalizeSessionName(title, 'Untitled Kimi Session'),
      };
    } catch {
      return null;
    }
  }
}
