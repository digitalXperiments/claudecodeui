import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { parseImagesInputTag } from '@/shared/image-attachments.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'pi';
const PI_SESSIONS_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const record = readObjectRecord(part);
      if (!record) return '';
      if (typeof record.text === 'string') return record.text;
      if (typeof record.thinking === 'string') return record.thinking;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractNativeImageAttachments(content: unknown): Array<{ data: string }> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    const record = readObjectRecord(part);
    if (
      record?.type !== 'image'
      || typeof record.data !== 'string'
      || !record.data
    ) {
      return [];
    }
    const mimeType = typeof record.mimeType === 'string' && record.mimeType
      ? record.mimeType
      : 'image/png';
    return [{ data: `data:${mimeType};base64,${record.data}` }];
  });
}

/**
 * Locate a Pi session JSONL file by session UUID (or partial id).
 * Layout: `~/.pi/agent/sessions/--cwd-encoded--/<timestamp>_<uuid>.jsonl`
 */
export function findPiSessionFile(sessionId: string, sessionsRoot = PI_SESSIONS_ROOT): string | null {
  if (!sessionId) {
    return null;
  }

  let workDirs: string[];
  try {
    workDirs = fsSync.readdirSync(sessionsRoot);
  } catch {
    return null;
  }

  for (const workDir of workDirs) {
    const dirPath = path.join(sessionsRoot, workDir);
    let entries: string[];
    try {
      entries = fsSync.readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      // Files are named `<timestamp>_<uuid>.jsonl` or may contain the id.
      if (name.includes(sessionId)) {
        return path.join(dirPath, name);
      }
    }
  }

  return null;
}

/**
 * Decode Pi's cwd directory encoding: `--Users-foo-bar--` → `/Users/foo/bar`
 * (best-effort — Pi replaces `/` with `-` and wraps with `--`).
 */
export function decodePiSessionCwdDir(dirName: string): string | null {
  if (!dirName.startsWith('--') || !dirName.endsWith('--')) {
    return null;
  }
  const inner = dirName.slice(2, -2);
  if (!inner) {
    return null;
  }
  // Absolute paths were encoded with a leading empty segment after the first `--`.
  // e.g. `/Users/x` → `--Users-x--` on Unix (leading slash becomes empty first segment).
  return `/${inner.replace(/-/g, '/')}`;
}

export class PiSessionsProvider implements IProviderSessions {
  constructor(private readonly sessionsRoot = PI_SESSIONS_ROOT) {}

  /**
   * Normalize live Pi RPC events into CloudCLI chat messages.
   * Accepts either a full RPC event object or a simplified shape from pi-cli.js.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    // Pre-normalized helper shape from pi-cli.js
    if (typeof raw.kind === 'string') {
      if (raw.kind === 'stream_delta' && typeof raw.content === 'string' && raw.content) {
        return [createNormalizedMessage({
          kind: 'stream_delta',
          content: raw.content,
          sessionId,
          provider: PROVIDER,
        })];
      }
      if (raw.kind === 'thinking' && typeof raw.content === 'string' && raw.content) {
        return [createNormalizedMessage({
          kind: 'thinking',
          content: raw.content,
          sessionId,
          provider: PROVIDER,
        })];
      }
      if (raw.kind === 'tool_use') {
        return [createNormalizedMessage({
          kind: 'tool_use',
          toolName: typeof raw.toolName === 'string' ? raw.toolName : 'Tool',
          toolInput: raw.toolInput,
          toolId: typeof raw.toolId === 'string' ? raw.toolId : generateMessageId('pi'),
          sessionId,
          provider: PROVIDER,
        })];
      }
      if (raw.kind === 'tool_result') {
        return [createNormalizedMessage({
          kind: 'tool_result',
          toolName: typeof raw.toolName === 'string' ? raw.toolName : 'Tool',
          content: typeof raw.content === 'string' ? raw.content : extractTextContent(raw.content),
          toolId: typeof raw.toolId === 'string' ? raw.toolId : generateMessageId('pi'),
          isError: Boolean(raw.isError),
          sessionId,
          provider: PROVIDER,
        })];
      }
    }

    // Raw RPC events
    const eventType = typeof raw.type === 'string' ? raw.type : '';

    if (eventType === 'message_update') {
      const ame = readObjectRecord(raw.assistantMessageEvent);
      if (!ame) return [];
      const deltaType = typeof ame.type === 'string' ? ame.type : '';
      if (deltaType === 'text_delta' && typeof ame.delta === 'string' && ame.delta) {
        return [createNormalizedMessage({
          kind: 'stream_delta',
          content: ame.delta,
          sessionId,
          provider: PROVIDER,
        })];
      }
      if (deltaType === 'thinking_delta' && typeof ame.delta === 'string' && ame.delta) {
        return [createNormalizedMessage({
          kind: 'thinking',
          content: ame.delta,
          sessionId,
          provider: PROVIDER,
        })];
      }
      if (deltaType === 'error') {
        const error = readObjectRecord(ame.error);
        return [createNormalizedMessage({
          kind: 'error',
          content: typeof error?.errorMessage === 'string'
            ? error.errorMessage
            : 'Pi assistant request failed',
          sessionId,
          provider: PROVIDER,
        })];
      }
      return [];
    }

    if (eventType === 'tool_execution_start') {
      return [createNormalizedMessage({
        kind: 'tool_use',
        toolName: typeof raw.toolName === 'string' ? raw.toolName : 'Tool',
        toolInput: raw.args,
        toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : generateMessageId('pi'),
        sessionId,
        provider: PROVIDER,
      })];
    }

    if (eventType === 'tool_execution_update' || eventType === 'tool_execution_end') {
      const result = readObjectRecord(
        eventType === 'tool_execution_update' ? raw.partialResult : raw.result,
      );
      const content = result ? extractTextContent(result.content) : extractTextContent(
        eventType === 'tool_execution_update' ? raw.partialResult : raw.result,
      );
      return [createNormalizedMessage({
        kind: 'tool_result',
        toolName: typeof raw.toolName === 'string' ? raw.toolName : 'Tool',
        content,
        toolId: typeof raw.toolCallId === 'string' ? raw.toolCallId : generateMessageId('pi'),
        isError: eventType === 'tool_execution_end' && Boolean(raw.isError),
        sessionId,
        provider: PROVIDER,
      })];
    }

    return [];
  }

  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    // The route passes the app-facing session id, while Pi transcripts are
    // keyed by the provider-native UUID. Use the native id whenever the
    // session index has mapped one; otherwise retain direct-call compatibility.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const filePath = findPiSessionFile(providerSessionId, this.sessionsRoot);
    if (!filePath || !fsSync.existsSync(filePath)) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const messages: NormalizedMessage[] = [];
    let content: string;
    try {
      content = fsSync.readFileSync(filePath, 'utf8');
    } catch {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: AnyRecord | null = null;
      try {
        entry = readObjectRecord(JSON.parse(trimmed));
      } catch {
        continue;
      }
      if (!entry) continue;

      // Session header lines have type "session" / similar — skip.
      if (entry.type === 'session' || entry.type === 'header') {
        continue;
      }

      const message = readObjectRecord(entry.message) ?? entry;
      const role = typeof message.role === 'string' ? message.role : '';
      const entryId = typeof entry.id === 'string' && entry.id
        ? entry.id
        : generateMessageId('pi');
      const timestamp = normalizeProviderTimestamp(entry.timestamp ?? message.timestamp);

      if (role === 'user') {
        const text = extractTextContent(message.content);
        const parsed = parseImagesInputTag(text);
        const nativeImages = extractNativeImageAttachments(message.content);
        const pathImages = parsed.attachments.map((attachment) => ({
          path: attachment.path,
          ...(attachment.name ? { name: attachment.name } : {}),
        }));
        const images = [...pathImages, ...nativeImages];
        if (!parsed.text && images.length === 0) continue;
        messages.push(createNormalizedMessage({
          id: `${entryId}_user`,
          kind: 'text',
          content: parsed.text,
          images: images.length > 0 ? images : undefined,
          timestamp,
          sessionId,
          provider: PROVIDER,
        }));
        continue;
      }

      if (role === 'assistant') {
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const [blockIndex, block] of blocks.entries()) {
          const record = readObjectRecord(block);
          if (!record) continue;
          if (record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking) {
            messages.push(createNormalizedMessage({
              id: `${entryId}_thinking_${blockIndex}`,
              kind: 'thinking',
              content: record.thinking,
              timestamp,
              sessionId,
              provider: PROVIDER,
            }));
          } else if (record.type === 'text' && typeof record.text === 'string' && record.text) {
            messages.push(createNormalizedMessage({
              id: `${entryId}_text_${blockIndex}`,
              kind: 'stream_delta',
              content: record.text,
              timestamp,
              sessionId,
              provider: PROVIDER,
            }));
          } else if (record.type === 'toolCall') {
            messages.push(createNormalizedMessage({
              id: `${entryId}_tool_${blockIndex}`,
              kind: 'tool_use',
              toolName: typeof record.name === 'string' ? record.name : 'Tool',
              toolInput: record.arguments,
              toolId: typeof record.id === 'string' ? record.id : generateMessageId('pi'),
              timestamp,
              sessionId,
              provider: PROVIDER,
            }));
          }
        }
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          messages.push(createNormalizedMessage({
            id: `${entryId}_error`,
            kind: 'error',
            content: typeof message.errorMessage === 'string'
              ? message.errorMessage
              : `Pi request ${message.stopReason}`,
            timestamp,
            sessionId,
            provider: PROVIDER,
          }));
        }
        continue;
      }

      if (role === 'toolResult') {
        messages.push(createNormalizedMessage({
          id: `${entryId}_result`,
          kind: 'tool_result',
          toolName: typeof message.toolName === 'string' ? message.toolName : 'Tool',
          content: extractTextContent(message.content),
          toolId: typeof message.toolCallId === 'string' ? message.toolCallId : generateMessageId('pi'),
          isError: Boolean(message.isError),
          timestamp,
          sessionId,
          provider: PROVIDER,
        }));
      }
    }

    // Tool results are transcript plumbing, not standalone chat bubbles. Attach
    // them to their tool call before pagination so the newest page cannot be
    // filled entirely with orphaned tool-result rows (which made Pi sessions
    // appear empty in Chatbar).
    const toolResults = new Map<string, NormalizedMessage>();
    for (const message of messages) {
      if (message.kind === 'tool_result' && message.toolId) {
        toolResults.set(message.toolId, message);
      }
    }
    for (const message of messages) {
      if (message.kind === 'tool_use' && message.toolId) {
        const result = toolResults.get(message.toolId);
        if (result) {
          message.toolResult = {
            content: result.content,
            isError: result.isError,
          };
        }
      }
    }

    const renderableMessages = messages.filter((message) => message.kind !== 'tool_result');
    const offset = options.offset ?? 0;
    const limit = options.limit ?? null;
    const page = sliceTailPage(renderableMessages, limit, offset);
    return {
      messages: page.page,
      total: renderableMessages.length,
      hasMore: page.hasMore,
      offset,
      limit,
    };
  }
}
