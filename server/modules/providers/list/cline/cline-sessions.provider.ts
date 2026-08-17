import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  OpenCodeSessionsProvider,
} from '@/modules/providers/list/opencode/opencode-sessions.provider.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, getClineDataDirectory, readObjectRecord, readOptionalString } from '@/shared/utils.js';

const readJson = async (filePath: string): Promise<unknown> => {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
};

export class ClineSessionsProvider extends OpenCodeSessionsProvider {
  private readonly tasksPath = path.join(getClineDataDirectory(), 'tasks');

  constructor() { super({ provider: 'cline' }); }

  override async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const taskPath = path.join(this.tasksPath, sessionId);
    const history = await readJson(path.join(taskPath, 'api_conversation_history.json'));
    if (!Array.isArray(history)) return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };

    const messages: NormalizedMessage[] = [];
    for (const [index, item] of history.entries()) {
      const record = readObjectRecord(item);
      if (!record) continue;
      const role = readOptionalString(record.role);
      const content = typeof record.content === 'string' ? record.content : JSON.stringify(record.content ?? '');
      if (!role || !content.trim()) continue;
      messages.push(createNormalizedMessage({
        id: `${sessionId}-${index}`,
        sessionId,
        provider: 'cline',
        role: role === 'user' ? 'user' : 'assistant',
        kind: role === 'user' ? 'text' : 'text',
        content,
      }));
    }

    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit === null || options.limit === undefined ? null : Math.max(0, options.limit);
    const page = limit === null ? messages.slice(offset) : messages.slice(Math.max(0, messages.length - offset - limit), messages.length - offset || undefined);
    return { messages: page, total: messages.length, hasMore: offset + page.length < messages.length, offset, limit };
  }
}
