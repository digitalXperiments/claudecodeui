import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionsDb } from '@/modules/database/index.js';
import { normalizeSessionName, readFileTimestamps, readObjectRecord } from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

const AGY_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const AGY_CONVERSATIONS_DIR = path.join(AGY_DATA_DIR, 'conversations');
const AGY_METADATA_PATH = path.join(AGY_DATA_DIR, 'cache', 'conversation_metadata.json');

type AgyParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Antigravity CLI conversations.
 *
 * Antigravity stores one SQLite database per conversation under
 * `~/.gemini/antigravity-cli/conversations/<conversation-id>.db`, and mirrors
 * lightweight metadata (workspace, title) in `cache/conversation_metadata.json`.
 * The `.db` file is the indexing anchor (one per conversation); its transcript
 * itself is protobuf and not read here — only the conversation is registered so
 * it appears in the sidebar. Title/preview come from the metadata cache when
 * present.
 */
export class AgySessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'agy' as const;

  private readMetadata(): Record<string, unknown> {
    try {
      const content = fsSync.readFileSync(AGY_METADATA_PATH, 'utf8');
      const parsed = readObjectRecord(JSON.parse(content));
      return readObjectRecord(parsed?.conversations) ?? {};
    } catch {
      return {};
    }
  }

  async synchronize(since?: Date): Promise<number> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fsSync.promises.readdir(AGY_CONVERSATIONS_DIR, { withFileTypes: true });
    } catch {
      return 0;
    }

    const metadata = this.readMetadata();
    let processed = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) {
        continue;
      }

      const dbPath = path.join(AGY_CONVERSATIONS_DIR, entry.name);
      const timestamps = await readFileTimestamps(dbPath);
      if (since && timestamps.updatedAt && new Date(timestamps.updatedAt) < since) {
        continue;
      }

      const parsed = this.parseConversation(entry.name, metadata);
      if (!parsed) {
        continue;
      }

      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        dbPath,
      );
      processed += 1;
    }

    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.db') || path.dirname(filePath) !== AGY_CONVERSATIONS_DIR) {
      return null;
    }

    const parsed = this.parseConversation(path.basename(filePath), this.readMetadata());
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
      filePath,
    );
  }

  private parseConversation(fileName: string, metadata: Record<string, unknown>): AgyParsedSession | null {
    const sessionId = fileName.replace(/\.db$/, '');
    if (!sessionId) {
      return null;
    }

    const entry = readObjectRecord(metadata[sessionId]);
    const summary = readObjectRecord(entry?.summary);
    const workspaceUris = Array.isArray(summary?.WorkspaceURIs) ? summary.WorkspaceURIs : [];
    const firstUri = workspaceUris.find((uri): uri is string => typeof uri === 'string');
    if (!firstUri) {
      return null;
    }

    let projectPath: string;
    try {
      projectPath = firstUri.startsWith('file://') ? fileURLToPath(firstUri) : firstUri;
    } catch {
      return null;
    }

    const title = typeof summary?.Title === 'string' && summary.Title.trim()
      ? summary.Title
      : typeof summary?.Preview === 'string'
        ? summary.Preview
        : '';

    return {
      sessionId,
      projectPath,
      sessionName: normalizeSessionName(title, 'Untitled Antigravity Session'),
    };
  }
}
