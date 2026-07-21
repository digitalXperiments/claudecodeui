import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { parseImagesInputTag } from '@/shared/image-attachments.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'kimi';
const KIMI_SESSIONS_ROOT = path.join(os.homedir(), '.kimi-code', 'sessions');

function extractKimiTextParts(content: unknown): string {
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

function isInternalKimiText(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return value.trim().startsWith('<system-reminder>');
}

/**
 * Kimi's session directory name (`wd_<sanitized-cwd-basename>_<hash>`) is
 * derived from an internal, undocumented hash of the working directory, so
 * it can't be recomputed from `projectPath` alone. The directory named after
 * the session id itself (`session_<uuid>/`) is always one level under some
 * `wd_*` folder though, so we scan the (typically small) set of `wd_*`
 * folders for one containing our session id rather than guessing the hash.
 */
function findKimiSessionDir(sessionId: string): string | null {
  let workDirs: string[];
  try {
    workDirs = fsSync.readdirSync(KIMI_SESSIONS_ROOT);
  } catch {
    return null;
  }

  for (const workDir of workDirs) {
    const candidate = path.join(KIMI_SESSIONS_ROOT, workDir, sessionId);
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export class KimiSessionsProvider implements IProviderSessions {
  /**
   * Normalizes live Kimi CLI `stream-json` events. Unlike Grok/Cursor's
   * token-by-token streaming-json, Kimi emits one full OpenAI-chat-style
   * message object per line (`role`: `assistant` | `tool` | `meta`) rather
   * than incremental deltas — each is still surfaced as a `stream_delta` so
   * the chat pane's existing append/replace handling picks it up unchanged.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);

    // ACP `session/update` shapes (live, via `kimi acp` - see kimi-cli.js).
    // `sessionUpdate` is the discriminant field ACP uses; the older one-shot
    // `-p --output-format stream-json` shapes below (keyed on `role`) are
    // kept for backward compatibility with anything still reading them.
    if (typeof raw?.sessionUpdate === 'string') {
      const kind = raw.sessionUpdate;

      if (kind === 'agent_thought_chunk') {
        const text = readObjectRecord(raw.content)?.text;
        return typeof text === 'string' && text
          ? [createNormalizedMessage({ kind: 'thinking', content: text, sessionId, provider: PROVIDER })]
          : [];
      }

      if (kind === 'agent_message_chunk') {
        const text = readObjectRecord(raw.content)?.text;
        return typeof text === 'string' && text
          ? [createNormalizedMessage({ kind: 'stream_delta', content: text, sessionId, provider: PROVIDER })]
          : [];
      }

      if (kind === 'tool_call_update' && raw.rawInput) {
        return [createNormalizedMessage({
          kind: 'tool_use',
          toolName: typeof raw.title === 'string' ? raw.title : 'Tool',
          toolInput: raw.rawInput,
          toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : generateMessageId('kimi'),
          sessionId,
          provider: PROVIDER,
        })];
      }

      if (kind === 'tool_call_update' && (raw.status === 'completed' || raw.status === 'failed')) {
        const content = Array.isArray(raw.content)
          ? raw.content.map((part) => readObjectRecord(readObjectRecord(part)?.content)?.text).filter(Boolean).join('\n')
          : '';
        return [createNormalizedMessage({
          kind: 'tool_result',
          toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : '',
          content: typeof raw.rawOutput === 'string' ? raw.rawOutput : content,
          isError: raw.status === 'failed',
          sessionId,
          provider: PROVIDER,
        })];
      }

      // `tool_call` (the initial "pending" event), `available_commands_update`,
      // and `config_option_update` carry no user-visible content.
      return [];
    }

    if (raw?.role === 'assistant' && Array.isArray(raw.tool_calls)) {
      const messages: NormalizedMessage[] = [];
      for (const rawCall of raw.tool_calls) {
        const call = readObjectRecord(rawCall);
        const fn = readObjectRecord(call?.function);
        if (!call || !fn) {
          continue;
        }

        let toolInput: unknown = fn.arguments;
        if (typeof toolInput === 'string') {
          try {
            toolInput = JSON.parse(toolInput);
          } catch {
            // Keep raw string when arguments are not valid JSON.
          }
        }

        messages.push(createNormalizedMessage({
          kind: 'tool_use',
          toolName: typeof fn.name === 'string' ? fn.name : 'Unknown Tool',
          toolInput,
          toolId: typeof call.id === 'string' ? call.id : generateMessageId('kimi'),
          sessionId,
          provider: PROVIDER,
        }));
      }
      return messages;
    }

    if (raw?.role === 'assistant' && typeof raw.content === 'string' && raw.content.trim()) {
      return [createNormalizedMessage({
        kind: 'stream_delta',
        content: raw.content,
        sessionId,
        provider: PROVIDER,
      })];
    }

    if (raw?.role === 'tool') {
      return [createNormalizedMessage({
        kind: 'tool_result',
        content: typeof raw.content === 'string' ? raw.content : '',
        toolId: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '',
        sessionId,
        provider: PROVIDER,
      })];
    }

    // `role: "meta"` (e.g. `session.resume_hint`) carries no user-visible
    // content — session id capture from it happens in kimi-cli.js, not here.
    if (raw?.role === 'meta') {
      return [];
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
   * Reads and paginates a Kimi session's persisted wire.jsonl protocol log.
   *
   * Pagination follows the shared tail contract (`sliceTailPage`): offset 0
   * is the most recent page, matching every other provider.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const providerSessionId = options.providerSessionId ?? sessionId;
    const { limit = null, offset = 0 } = options;

    try {
      const sessionDir = findKimiSessionDir(providerSessionId);
      if (!sessionDir) {
        return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
      }

      const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
      const allNormalized = await this.readKimiWireFile(wirePath, sessionId);
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
      console.warn(`[KimiProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }

  private async readKimiWireFile(wirePath: string, sessionId: string | null): Promise<NormalizedMessage[]> {
    if (!fsSync.existsSync(wirePath)) {
      return [];
    }

    const messages: NormalizedMessage[] = [];
    const toolUseMap = new Map<string, NormalizedMessage>();
    const baseTime = Date.now();

    const fileStream = fsSync.createReadStream(wirePath, { encoding: 'utf8' });
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

      const wireType = typeof data.type === 'string' ? data.type : '';
      const baseId = generateMessageId('kimi');

      try {
        if (wireType === 'context.append_message') {
          const message = readObjectRecord(data.message);
          if (message?.role !== 'user') {
            continue;
          }
          const rawText = extractKimiTextParts(message.content);
          if (!rawText.trim() || isInternalKimiText(rawText)) {
            continue;
          }
          // Attachments sent with a turn ride along as an <images_input> path
          // block; strip it from the displayed text and surface the files.
          const { text, attachments } = parseImagesInputTag(rawText);
          if (!text.trim() && attachments.length === 0) {
            continue;
          }
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
            images: attachments.length > 0 ? attachments : undefined,
          }));
          continue;
        }

        if (wireType !== 'context.append_loop_event') {
          continue;
        }

        const event = readObjectRecord(data.event);
        const eventType = typeof event?.type === 'string' ? event.type : '';

        if (eventType === 'content.part') {
          const part = readObjectRecord(event?.part);
          if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part?.type === 'think' && typeof part.think === 'string' && part.think.trim()) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.think,
            }));
          }
          continue;
        }

        if (eventType === 'tool.call') {
          const toolId = typeof event?.toolCallId === 'string' ? event.toolCallId : baseId;
          const message = createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: typeof event?.name === 'string' ? event.name : 'Unknown Tool',
            toolInput: event?.args,
            toolId,
          });
          messages.push(message);
          toolUseMap.set(toolId, message);
          continue;
        }

        if (eventType === 'tool.result') {
          const toolId = typeof event?.toolCallId === 'string' ? event.toolCallId : '';
          const result = readObjectRecord(event?.result);
          const content = typeof result?.output === 'string' ? result.output : '';
          messages.push(createNormalizedMessage({
            id: `${baseId}_tr`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_result',
            toolId,
            content,
            isError: Boolean(result?.isError),
          }));
        }
      } catch (error) {
        console.warn('Error normalizing kimi wire line:', error);
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
