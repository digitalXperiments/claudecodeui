import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';

export const ANTIGRAVITY_PROVIDER = 'antigravity' as const;

/** One ACP content block: a bare string, `{ type, text }`, or `{ content: { text } }`. */
const partText = (part: unknown): string => {
  if (typeof part === 'string') return part;
  const record = readObjectRecord(part);
  if (typeof record?.text === 'string') return record.text;
  const nested = readObjectRecord(record?.content);
  return typeof nested?.text === 'string' ? nested.text : '';
};

/**
 * ACP content arrives as a string, an array of blocks, or — for the chunk
 * updates Antigravity emits — a single unwrapped block object. All three have
 * to read, otherwise `{ content: { text: 'hello' } }` normalizes to an empty
 * delta and the chunk is dropped from the stream.
 */
const textParts = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return partText(value);
  return value
    .map(partText)
    .filter(Boolean)
    .join('\n');
};

/**
 * Live-event normalization for Antigravity's ACP `session/update` stream.
 *
 * The update shapes are the shared ACP ones (agent_message_chunk,
 * agent_thought_chunk, tool_call/tool_call_update), so this mirrors the
 * OpenCode/Kilo/Qwen readers.
 *
 * `fetchHistory` returns an empty page on purpose: Antigravity keeps no
 * CloudCLI-readable transcript store, so history comes from CloudCLI's own
 * session rows. It also has **no rewind capability** — nothing here should be
 * read as supporting one.
 */
export class AntigravitySessionsProvider implements IProviderSessions {
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (typeof raw?.sessionUpdate !== 'string') return [];

    if (raw.sessionUpdate === 'agent_thought_chunk') {
      const text = textParts(raw.content);
      return text
        ? [createNormalizedMessage({ kind: 'thinking', content: text, sessionId, provider: ANTIGRAVITY_PROVIDER })]
        : [];
    }

    if (raw.sessionUpdate === 'agent_message_chunk') {
      const text = textParts(raw.content);
      return text
        ? [createNormalizedMessage({ kind: 'stream_delta', content: text, sessionId, provider: ANTIGRAVITY_PROVIDER })]
        : [];
    }

    if (raw.sessionUpdate === 'user_message_chunk') {
      const text = textParts(raw.content);
      return text
        ? [createNormalizedMessage({ kind: 'text', role: 'user', content: text, sessionId, provider: ANTIGRAVITY_PROVIDER })]
        : [];
    }

    if (raw.sessionUpdate === 'tool_call_update' && (raw.status === 'completed' || raw.status === 'failed')) {
      const content = typeof raw.rawOutput === 'string' ? raw.rawOutput : textParts(raw.content);
      return [createNormalizedMessage({
        kind: 'tool_result',
        toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : '',
        content,
        isError: raw.status === 'failed',
        sessionId,
        provider: ANTIGRAVITY_PROVIDER,
      })];
    }

    if ((raw.sessionUpdate === 'tool_call' || raw.sessionUpdate === 'tool_call_update') && raw.rawInput) {
      const toolName = typeof raw.toolName === 'string' && raw.toolName
        ? raw.toolName
        : typeof raw.title === 'string' && raw.title
          ? raw.title
          : typeof raw.kind === 'string' && raw.kind
            ? raw.kind
            : 'Tool';
      return [createNormalizedMessage({
        kind: 'tool_use',
        toolName,
        toolInput: raw.rawInput,
        toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : generateMessageId('antigravity'),
        sessionId,
        provider: ANTIGRAVITY_PROVIDER,
      })];
    }

    return [];
  }

  async fetchHistory(_sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    return { messages: [], total: 0, hasMore: false, offset, limit };
  }
}
