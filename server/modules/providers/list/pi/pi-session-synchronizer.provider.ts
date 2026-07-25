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
import { decodePiSessionCwdDir } from '@/modules/providers/list/pi/pi-sessions.provider.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  jsonlPath: string;
};

/**
 * Session indexer for Pi coding-agent JSONL transcripts.
 *
 * Layout: `~/.pi/agent/sessions/--cwd-encoded--/<timestamp>_<uuid>.jsonl`
 * The session id is the UUID portion of the filename (after the last `_`
 * before `.jsonl`). Project path is recovered from the parent directory
 * encoding and/or the session header line inside the file.
 */
export class PiSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'pi' as const;
  private readonly piSessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions');

  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyCreatedAfter(this.piSessionsRoot, '.jsonl', since ?? null);

    let processed = 0;
    for (const filePath of files) {
      if (!filePath.endsWith('.jsonl')) continue;
      const parsed = await this.processSessionFile(filePath);
      if (!parsed) continue;

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        parsed.jsonlPath,
      );
      processed += 1;
    }

    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const parsed = await this.processSessionFile(filePath);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      parsed.jsonlPath,
    );
  }

  private async processSessionFile(filePath: string): Promise<ParsedSession | null> {
    const base = path.basename(filePath, '.jsonl');
    // Prefer UUID after last underscore; fall back to whole stem.
    const underscoreIdx = base.lastIndexOf('_');
    const sessionId = underscoreIdx >= 0 ? base.slice(underscoreIdx + 1) : base;
    if (!sessionId) {
      return null;
    }

    const parentDir = path.basename(path.dirname(filePath));
    let projectPath = decodePiSessionCwdDir(parentDir);
    let sessionName: string | undefined;

    // Prefer header metadata inside the JSONL when present.
    try {
      const fd = await fsSync.promises.open(filePath, 'r');
      try {
        const { buffer } = await fd.read({ buffer: Buffer.alloc(8 * 1024), position: 0 });
        const head = buffer.toString('utf8').split(/\r?\n/)[0] || '';
        if (head.trim()) {
          const header = readObjectRecord(JSON.parse(head.trim()));
          if (header) {
            if (typeof header.cwd === 'string' && header.cwd.trim()) {
              projectPath = header.cwd;
            } else if (typeof header.workingDirectory === 'string' && header.workingDirectory.trim()) {
              projectPath = header.workingDirectory;
            }
            if (typeof header.name === 'string' && header.name.trim()) {
              sessionName = header.name;
            } else if (typeof header.sessionName === 'string' && header.sessionName.trim()) {
              sessionName = header.sessionName;
            }
            if (typeof header.id === 'string' && header.id.trim() && header.type === 'session') {
              // Prefer canonical id from header when available.
              return {
                sessionId: header.id,
                projectPath: projectPath || process.cwd(),
                sessionName: normalizeSessionName(sessionName || '', 'Untitled Pi Session'),
                jsonlPath: filePath,
              };
            }
          }
        }
      } finally {
        await fd.close();
      }
    } catch {
      // Header parse is best-effort.
    }

    if (!projectPath) {
      // Still index with a placeholder so the session appears; user can open it
      // from chat history once they re-select the project.
      projectPath = process.cwd();
    }

    return {
      sessionId,
      projectPath,
      sessionName: normalizeSessionName(sessionName || '', 'Untitled Pi Session'),
      jsonlPath: filePath,
    };
  }
}
