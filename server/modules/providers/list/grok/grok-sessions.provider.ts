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
   * Normalizes live Grok events.
   *
   * Grok runs over the Agent Client Protocol (`grok agent stdio`, see
   * grok-cli.js), which streams `session/update` notifications discriminated by
   * `sessionUpdate` — the same wire vocabulary Kimi uses. This carries live
   * tool calls, results, thoughts and plans, unlike the old headless
   * `--output-format streaming-json` path (which only ever emitted
   * `text`/`thought`/`end`). The legacy `type: 'text' | 'thought'` shapes are
   * still handled below for backward compatibility with any pre-ACP transcript
   * reader; persisted history is handled in fetchHistory().
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);

    // --- ACP `session/update` shapes (live, via `grok agent stdio`) ---
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

      // The initial tool invocation carries the tool title + input; surface it
      // immediately so the card appears the moment the tool starts.
      if (kind === 'tool_call') {
        // Prefer the structured Grok tool name (`_meta["x.ai/tool"].name`) so
        // interactive tools map onto CloudCLI's Claude-compatible panel ids
        // (ask_user_question → AskUserQuestion, exit_plan_mode → ExitPlanMode).
        const metaTool = readObjectRecord(readObjectRecord(raw._meta)?.['x.ai/tool']);
        const metaName = typeof metaTool?.name === 'string' ? metaTool.name : '';
        const title = typeof raw.title === 'string' ? raw.title : '';
        let toolName = metaName || title || 'Tool';
        if (toolName === 'ask_user_question') toolName = 'AskUserQuestion';
        if (toolName === 'exit_plan_mode') toolName = 'ExitPlanMode';

        return [createNormalizedMessage({
          kind: 'tool_use',
          toolName,
          toolInput: raw.rawInput ?? raw.content,
          toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : generateMessageId('grok'),
          sessionId,
          provider: PROVIDER,
        })];
      }

      // Only the terminal tool_call_update carries the result; intermediate
      // in-progress updates (partial input, status changes) are folded into the
      // existing card by toolId and add no new user-visible row.
      if (kind === 'tool_call_update' && (raw.status === 'completed' || raw.status === 'failed')) {
        // ACP terminal output arrives in a few shapes. `rawOutput` is either a
        // plain string OR a tagged-enum object like
        // `{ type:'ListDir', Content:{ content:'...' } }` (read/list tools) —
        // dig the payload's string `content`/`text` out of the wrapper. Failing
        // that, a `content` array whose parts are `{type:'content',
        // content:{text}}`, `{type:'text', text}`, or `{type:'diff', path,
        // newText}` (edit/write tools). Pull a string body out of whichever is
        // present so the result card isn't blank.
        let rawOutputText = '';
        if (typeof raw.rawOutput === 'string') {
          rawOutputText = raw.rawOutput;
        } else {
          const rawOutput = readObjectRecord(raw.rawOutput);
          if (rawOutput) {
            const fromWrapper = Object.values(rawOutput)
              .map((value) => {
                const payload = readObjectRecord(value);
                if (typeof payload?.content === 'string') return payload.content;
                if (typeof payload?.text === 'string') return payload.text;
                return '';
              })
              .find(Boolean);
            rawOutputText = fromWrapper
              || (typeof rawOutput.content === 'string' ? rawOutput.content : '')
              || (typeof rawOutput.text === 'string' ? rawOutput.text : '');
          }
        }

        const content = Array.isArray(raw.content)
          ? raw.content
              .map((rawPart) => {
                const part = readObjectRecord(rawPart);
                if (!part) {
                  return '';
                }
                const nestedText = readObjectRecord(part.content)?.text;
                if (typeof nestedText === 'string') {
                  return nestedText;
                }
                if (typeof part.text === 'string') {
                  return part.text;
                }
                if (part.type === 'diff') {
                  const filePath = typeof part.path === 'string' ? part.path : '';
                  const newText = typeof part.newText === 'string' ? part.newText : '';
                  return filePath ? `Edited ${filePath}\n${newText}`.trim() : newText;
                }
                return '';
              })
              .filter(Boolean)
              .join('\n')
          : '';
        return [createNormalizedMessage({
          kind: 'tool_result',
          toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : '',
          content: rawOutputText || content,
          isError: raw.status === 'failed',
          sessionId,
          provider: PROVIDER,
        })];
      }

      // `plan`, `available_commands_update`, `user_message_chunk`,
      // `turn_completed`, and intermediate `tool_call_update`s carry no new
      // chat row here (turn_completed usage is read by the /token-usage route).
      return [];
    }

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
          // Attachments sent with a turn ride along as an <images_input> path
          // block; strip it from the displayed text and surface the files.
          const { text: promptText, attachments } = parseImagesInputTag(unwrapped);
          if (!promptText && attachments.length === 0) {
            continue;
          }
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: promptText,
            images: attachments.length > 0 ? attachments : undefined,
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
