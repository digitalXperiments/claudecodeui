import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  createIncrementalLookupMap,
  createLastJsonlMatchScanner,
} from '@/modules/providers/shared/jsonl/incremental-jsonl.js';
import {
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * `~/.claude/history.jsonl` grows with every prompt the user ever typed; it
 * used to be fully re-read on every watcher event. The incremental map only
 * parses appended lines (first-wins semantics are append-stable).
 */
const historyNameMap = createIncrementalLookupMap('sessionId', 'display');

/**
 * Remembers, per transcript, the last title-bearing line and how far the file
 * was scanned, so a streaming transcript's title lookup reads only the bytes
 * appended since the previous watcher event instead of the whole file.
 */
const TITLE_LINE_MARKERS = ['"ai-title"', '"last-prompt"', '"custom-title"'];
const titleScanner = createLastJsonlMatchScanner<string>({
  lineFilter: (line) => TITLE_LINE_MARKERS.some((marker) => line.includes(marker)),
});

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript rather than a
   * top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    return path.normalize(filePath).split(path.sep).includes('subagents');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await historyNameMap.get(path.join(this.claudeHome, 'history.jsonl'));
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
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

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await historyNameMap.get(path.join(this.claudeHome, 'history.jsonl'));
    const parsed = await this.processSessionFile(filePath, nameMap);
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

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId, this.provider)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  /**
   * Returns the title from the LAST `ai-title` / `last-prompt` /
   * `custom-title` row for this session (same result as scanning the file
   * backwards), reading only bytes appended since the previous lookup.
   */
  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      return await titleScanner.scan(filePath, `claude-title:${sessionId}`, (value) => {
        if (!value || typeof value !== 'object') {
          return undefined;
        }
        const data = value as Record<string, unknown>;
        if (data.sessionId !== sessionId) {
          return undefined;
        }
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
        const claudeRenamedTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;

        if (
          (eventType === 'ai-title' && aiTitle?.trim()) ||
          (eventType === 'last-prompt' && lastPrompt?.trim()) ||
          (eventType === 'custom-title' && claudeRenamedTitle?.trim())
        ) {
          return aiTitle || lastPrompt || claudeRenamedTitle;
        }
        return undefined;
      });
    } catch {
      // Ignore missing/unreadable files so sync can continue.
      return undefined;
    }
  }
}
