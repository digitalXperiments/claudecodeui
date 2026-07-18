import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'grok';
const GROK_SESSIONS_ROOT = path.join(os.homedir(), '.grok', 'sessions');

function isInternalGrokText(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim();
  return normalized.startsWith('<user_info>') || normalized.startsWith('<system-reminder>');
}

/**
 * Grok wraps the user-visible prompt as `<user_query>…</user_query>`; the
 * chat_history.jsonl transcript also carries internal `<user_info>` /
 * `<system-reminder>` turns that must not be shown as chat messages.
 */
function unwrapUserQueryText(value: string): string | null {
  const openTag = '<user_query>';
  const closeTag = '</user_query>';
  const openIndex = value.indexOf(openTag);
  if (openIndex >= 0) {
    const afterOpen = value.slice(openIndex + openTag.length);
    const closeIndex = afterOpen.lastIndexOf(closeTag);
    const inner = closeIndex >= 0 ? afterOpen.slice(0, closeIndex) : afterOpen;
    return inner.trim();
  }

  if (isInternalGrokText(value)) {
    return null;
  }

  return value.trim() || null;
}

function extractGrokTextParts(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      const record = readObjectRecord(part);
      return typeof record?.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function resolveGrokSessionDir(projectPath: string, sessionId: string): string {
  const encodedProjectPath = encodeURIComponent(projectPath);
  return path.join(GROK_SESSIONS_ROOT, encodedProjectPath, sessionId);
}

export class GrokSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live Grok CLI streaming-json events (`text` / `thought`).
   * Tool calls are not surfaced as discrete events in Grok's headless
   * streaming-json mode (confirmed against the official CLI docs) — they only
   * appear in the persisted `chat_history.jsonl` transcript, handled in
   * fetchHistory() below.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);

    if (raw?.type === 'text' && typeof raw.data === 'string') {
      return [createNormalizedMessage({
        kind: 'stream_delta',
        content: raw.data,
        sessionId,
        provider: PROVIDER,
      })];
    }

    if (raw?.type === 'thought' && typeof raw.data === 'string') {
      return [createNormalizedMessage({
        kind: 'thinking',
        content: raw.data,
        sessionId,
        provider: PROVIDER,
      })];
    }

    if (typeof rawMessage === 'string' && rawMessage.trim()) {
      return [createNormalizedMessage({
        kind: 'stream_delta',
        content: rawMessage,
        sessionId,
        provider: PROVIDER,
      })];
    }

    return [];
  }

  /**
   * Reads and paginates a Grok session's persisted chat_history.jsonl.
   *
   * Pagination follows the shared tail contract (`sliceTailPage`): offset 0 is
   * the most recent page, matching every other provider.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { projectPath = '', limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    try {
      const sessionDir = resolveGrokSessionDir(projectPath, providerSessionId);
      const historyPath = path.join(sessionDir, 'chat_history.jsonl');
      const allNormalized = await this.readGrokHistoryFile(historyPath, sessionId);
      const renderableMessages = allNormalized.filter((msg) => msg.kind !== 'tool_result');
      const total = renderableMessages.length;
      const { page, hasMore } = sliceTailPage(renderableMessages, limit, offset);

      return {
        messages: page,
        total,
        hasMore,
        offset,
        limit,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[GrokProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }

  private async readGrokHistoryFile(historyPath: string, sessionId: string | null): Promise<NormalizedMessage[]> {
    if (!fsSync.existsSync(historyPath)) {
      return [];
    }

    const messages: NormalizedMessage[] = [];
    const toolUseMap = new Map<string, NormalizedMessage>();
    const baseTime = Date.now();

    const fileStream = fsSync.createReadStream(historyPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let lineIndex = 0;
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      lineIndex += 1;
      const ts = new Date(baseTime + lineIndex * 100).toISOString();

      let data: AnyRecord;
      try {
        data = JSON.parse(line) as AnyRecord;
      } catch {
        continue;
      }

      const type = typeof data.type === 'string' ? data.type : '';
      const baseId = generateMessageId('grok');

      try {
        if (type === 'system') {
          continue;
        }

        if (type === 'user') {
          const text = extractGrokTextParts(data.content);
          const unwrapped = unwrapUserQueryText(text);
          if (!unwrapped) {
            continue;
          }
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: unwrapped,
          }));
          continue;
        }

        if (type === 'reasoning') {
          const summary = Array.isArray(data.summary) ? data.summary : [];
          const text = summary
            .map((entry: unknown) => readObjectRecord(entry)?.text)
            .filter((entry: unknown): entry is string => typeof entry === 'string')
            .join('\n');
          if (!text.trim()) {
            continue;
          }
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: text,
          }));
          continue;
        }

        if (type === 'assistant') {
          const text = extractGrokTextParts(data.content);
          if (text.trim()) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: text,
            }));
          }

          const toolCalls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
          for (let i = 0; i < toolCalls.length; i++) {
            const call = readObjectRecord(toolCalls[i]);
            if (!call) {
              continue;
            }
            const toolId = typeof call.id === 'string' ? call.id : `${baseId}_tool_${i}`;
            const toolName = typeof call.name === 'string' ? call.name : 'Unknown Tool';
            let toolInput: unknown = call.arguments;
            if (typeof toolInput === 'string') {
              try {
                toolInput = JSON.parse(toolInput);
              } catch {
                // Keep raw string when arguments are not valid JSON.
              }
            }

            const message = createNormalizedMessage({
              id: `${baseId}_${i}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName,
              toolInput,
              toolId,
            });
            messages.push(message);
            toolUseMap.set(toolId, message);
          }
          continue;
        }

        if (type === 'tool_result') {
          const toolId = typeof data.tool_call_id === 'string' ? data.tool_call_id : '';
          const content = typeof data.content === 'string' ? data.content : '';
          messages.push(createNormalizedMessage({
            id: `${baseId}_tr`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_result',
            toolId,
            content,
            isError: Boolean(data.is_error),
          }));
        }
      } catch (error) {
        console.warn('Error normalizing grok history line:', error);
      }
    }

    for (const msg of messages) {
      if (msg.kind === 'tool_result' && msg.toolId && toolUseMap.has(msg.toolId)) {
        const toolUse = toolUseMap.get(msg.toolId);
        if (toolUse) {
          toolUse.toolResult = {
            content: msg.content,
            isError: msg.isError,
          };
        }
      }
    }

    return messages;
  }
}
