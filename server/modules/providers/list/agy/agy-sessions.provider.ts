import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord } from '@/shared/utils.js';

const PROVIDER = 'agy';

export class AgySessionsProvider implements IProviderSessions {
  /**
   * Antigravity's `agy --print` headless mode emits plain-text/markdown on
   * stdout with no structured event schema, so agy-cli.js forwards raw text
   * chunks here and they surface as streaming deltas. (An object form is also
   * accepted defensively in case a future CLI version emits `{ text }`.)
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    if (typeof rawMessage === 'string' && rawMessage.length > 0) {
      return [createNormalizedMessage({
        kind: 'stream_delta',
        content: rawMessage,
        sessionId,
        provider: PROVIDER,
      })];
    }

    const raw = readObjectRecord(rawMessage);
    if (typeof raw?.text === 'string' && raw.text.length > 0) {
      return [createNormalizedMessage({
        kind: 'stream_delta',
        content: raw.text,
        sessionId,
        provider: PROVIDER,
      })];
    }

    return [];
  }

  /**
   * Antigravity persists each conversation as protobuf-encoded `step` blobs in
   * a per-conversation SQLite database (`~/.gemini/antigravity-cli/conversations/
   * <id>.db`). That transcript format is proprietary and has no public schema,
   * so past-message history cannot be reconstructed here — resuming an
   * Antigravity session shows only new turns produced within cloudcli. The
   * empty result keeps the shared history contract intact.
   */
  async fetchHistory(
    _sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    return {
      messages: [],
      total: 0,
      hasMore: false,
      offset: options.offset ?? 0,
      limit: options.limit ?? null,
    };
  }
}
