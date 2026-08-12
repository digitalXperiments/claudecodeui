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

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      const record = readObjectRecord(part);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join(' ');
}

function extractUserTitle(record: Record<string, unknown>): string | undefined {
  const message = readObjectRecord(record.message) ?? record;
  if (message.role !== 'user') {
    return undefined;
  }

  const text = extractTextContent(message.content);
  const firstLine = text
    .replace(/<images_input>[\s\S]*?<\/images_input>/g, '')
    .trim()
    .split(/\r?\n/)[0];
  return firstLine || undefined;
}

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
    // Pi has no separate session metadata/title index. Re-scan transcript
    // headers on startup so existing "Untitled Pi Session" rows get their
    // first-prompt title populated after upgrading CloudCLI.
    void since;
    const files = await findFilesRecursivelyCreatedAfter(this.piSessionsRoot, '.jsonl', null);

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

    // The session header does not normally contain a display name. Read a
    // bounded prefix and use the first user prompt as the Chatbar title,
    // just like the other provider synchronizers do.
    try {
      const fd = await fsSync.promises.open(filePath, 'r');
      try {
        const { buffer } = await fd.read({ buffer: Buffer.alloc(64 * 1024), position: 0 });
        const lines = buffer.toString('utf8').split(/\r?\n/);
        let canonicalSessionId: string | undefined;

        for (const line of lines) {
          if (!line.trim()) continue;
          const record = readObjectRecord(JSON.parse(line.trim()));
          if (!record) continue;

          if (record.type === 'session') {
            if (typeof record.cwd === 'string' && record.cwd.trim()) {
              projectPath = record.cwd;
            } else if (typeof record.workingDirectory === 'string' && record.workingDirectory.trim()) {
              projectPath = record.workingDirectory;
            }
            if (typeof record.name === 'string' && record.name.trim()) {
              sessionName = record.name;
            } else if (typeof record.sessionName === 'string' && record.sessionName.trim()) {
              sessionName = record.sessionName;
            }
            if (typeof record.id === 'string' && record.id.trim()) {
              canonicalSessionId = record.id;
            }
          }

          if (!sessionName) {
            sessionName = extractUserTitle(record);
          }
        }

        if (canonicalSessionId) {
          return {
            sessionId: canonicalSessionId,
            projectPath: projectPath || process.cwd(),
            sessionName: normalizeSessionName(sessionName, 'Untitled Pi Session'),
            jsonlPath: filePath,
          };
        }
      } finally {
        await fd.close();
      }
    } catch {
      // Header/title parse is best-effort.
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
