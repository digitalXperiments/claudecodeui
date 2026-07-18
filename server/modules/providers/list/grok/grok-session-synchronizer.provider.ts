import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

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
 * Session indexer for Grok Build transcript artifacts.
 *
 * Grok stores one directory per session under
 * `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/`, with a `summary.json`
 * carrying the session's working directory and a `chat_history.jsonl`
 * transcript. `summary.json` is the indexing anchor (one per session,
 * unlike the multi-file session directory) — analogous to how Codex/Cursor
 * anchor on their own JSONL transcript file.
 */
export class GrokSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'grok' as const;
  private readonly grokSessionsRoot = path.join(os.homedir(), '.grok', 'sessions');

  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyCreatedAfter(this.grokSessionsRoot, 'summary.json', since ?? null);

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSummaryFile(filePath);
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
    if (!filePath.endsWith('summary.json')) {
      return null;
    }

    const parsed = await this.processSummaryFile(filePath);
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
      filePath
    );
  }

  private async processSummaryFile(filePath: string): Promise<ParsedSession | null> {
    try {
      const content = await fsSync.promises.readFile(filePath, 'utf8');
      const data = readObjectRecord(JSON.parse(content));
      if (!data) {
        return null;
      }

      const info = readObjectRecord(data.info);
      const sessionId = typeof info?.id === 'string' ? info.id : path.basename(path.dirname(filePath));
      const projectPath = typeof info?.cwd === 'string' ? info.cwd : null;

      if (!sessionId || !projectPath) {
        return null;
      }

      const summaryText = typeof data.session_summary === 'string' && data.session_summary.trim()
        ? data.session_summary
        : await this.extractFirstUserQuery(path.join(path.dirname(filePath), 'chat_history.jsonl'));

      return {
        sessionId,
        projectPath,
        sessionName: normalizeSessionName(summaryText, 'Untitled Grok Session'),
      };
    } catch {
      return null;
    }
  }

  /**
   * Reads the first real `<user_query>` turn out of chat_history.jsonl to
   * title sessions whose summary.json has no session_summary yet.
   */
  private async extractFirstUserQuery(historyPath: string): Promise<string | undefined> {
    if (!fsSync.existsSync(historyPath)) {
      return undefined;
    }

    try {
      const fileStream = fsSync.createReadStream(historyPath, { encoding: 'utf8' });
      const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of lineReader) {
        if (!line.trim()) {
          continue;
        }

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }

        if (data.type !== 'user') {
          continue;
        }

        const content = Array.isArray(data.content) ? data.content : [];
        const text = content
          .map((part) => (typeof part === 'object' && part !== null ? (part as Record<string, unknown>).text : undefined))
          .find((value): value is string => typeof value === 'string');

        if (!text) {
          continue;
        }

        const openTag = '<user_query>';
        const closeTag = '</user_query>';
        const openIndex = text.indexOf(openTag);
        if (openIndex < 0) {
          continue;
        }

        const afterOpen = text.slice(openIndex + openTag.length);
        const closeIndex = afterOpen.lastIndexOf(closeTag);
        const inner = (closeIndex >= 0 ? afterOpen.slice(0, closeIndex) : afterOpen).trim();
        if (inner) {
          lineReader.close();
          fileStream.close();
          return inner.split('\n')[0];
        }
      }
    } catch {
      // Missing/partial transcripts are valid for in-progress sessions.
    }

    return undefined;
  }
}
