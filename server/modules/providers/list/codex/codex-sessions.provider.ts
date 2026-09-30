import fsSync from 'node:fs';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import { parseImagesInputTag, toImageAttachments } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

import { buildCodexTokenUsage } from './codex-token-usage.js';

const PROVIDER = 'codex';

type CodexHistoryResult =
  | AnyRecord[]
  | {
      messages?: AnyRecord[];
      total?: number;
      hasMore?: boolean;
      offset?: number;
      limit?: number | null;
      tokenUsage?: unknown;
    };

function isVisibleCodexUserMessage(payload: AnyRecord | null | undefined): boolean {
  if (!payload || payload.type !== 'user_message') {
    return false;
  }

  if (payload.kind && payload.kind !== 'plain') {
    return false;
  }

  return typeof payload.message === 'string' && payload.message.trim().length > 0;
}

/**
 * Reads the image attachments Codex records on `user_message` events.
 * Turns sent with `local_image` input items land in `local_images` as file
 * paths (verified against real rollout JSONL); the `images` array can carry
 * base64 data URLs, which are passed through as inline `data` attachments so
 * the UI can preview them without a file lookup.
 *
 * Exported for tests.
 */
export function extractCodexUserImages(
  payload: AnyRecord | null | undefined,
): Array<{ path?: string; data?: string }> | undefined {
  if (!payload) {
    return undefined;
  }

  const candidates = [
    ...(Array.isArray(payload.local_images) ? payload.local_images : []),
    ...(Array.isArray(payload.images) ? payload.images : []),
  ];

  const attachments: Array<{ path?: string; data?: string }> = [];
  for (const entry of candidates) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    if (entry.startsWith('data:')) {
      attachments.push({ data: entry });
    } else {
      attachments.push(...toImageAttachments([entry]));
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

function extractCodexTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }

      const record = item as AnyRecord;
      if (
        (record.type === 'input_text' || record.type === 'output_text' || record.type === 'text')
        && typeof record.text === 'string'
      ) {
        return record.text;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isNonterminalCodexToolStatus(status: unknown): boolean {
  return status === 'in_progress'
    || status === 'inProgress'
    || status === 'running'
    || status === 'pending';
}

function formatCodexToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === undefined || content === null) {
    return '';
  }

  try {
    return JSON.stringify(content) ?? String(content);
  } catch {
    return String(content);
  }
}

function codexToolResult(
  status: unknown,
  content: unknown,
  isError = false,
): NormalizedMessage['toolResult'] | undefined {
  if (isNonterminalCodexToolStatus(status)) {
    return undefined;
  }

  return {
    content: formatCodexToolResultContent(content),
    isError: isError || status === 'failed' || status === 'error',
  };
}

export type CodexFileChange = {
  path: string;
  kind?: string;
  diff?: string;
  move_path?: string;
};

function readChangeKind(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  const record = readObjectRecord(value);
  return typeof record?.type === 'string' ? record.type : undefined;
}

function readChangeDiff(record: AnyRecord): string | undefined {
  for (const key of ['diff', 'unified_diff', 'content']) {
    if (typeof record[key] === 'string') {
      return record[key];
    }
  }
  return undefined;
}

/**
 * Normalizes Codex file-change payloads into `[{ path, kind, diff }]`.
 * The app-server sends an array (`[{ path, kind, diff }]`, where `kind` may be
 * `{ type }`), while rollout `item_completed` FileChange items store a map
 * keyed by path (`{ [path]: { type, unified_diff | content, move_path } }`).
 *
 * Exported for tests.
 */
export function normalizeCodexFileChanges(changes: unknown): {
  changes: CodexFileChange[];
  paths: string[];
} {
  const normalized: CodexFileChange[] = [];

  const pushChange = (filePath: unknown, record: AnyRecord) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return;
    }
    const kind = readChangeKind(record.kind) ?? readChangeKind(record.type);
    const movePath = typeof record.move_path === 'string'
      ? record.move_path
      : readObjectRecord(record.kind)?.move_path;
    normalized.push({
      path: filePath,
      ...(kind ? { kind } : {}),
      ...(readChangeDiff(record) !== undefined ? { diff: readChangeDiff(record) } : {}),
      ...(typeof movePath === 'string' && movePath ? { move_path: movePath } : {}),
    });
  };

  if (Array.isArray(changes)) {
    for (const entry of changes) {
      const record = readObjectRecord(entry);
      if (record) {
        pushChange(record.path ?? record.file_path, record);
      }
    }
  } else {
    const map = readObjectRecord(changes);
    if (map) {
      for (const [filePath, value] of Object.entries(map)) {
        pushChange(filePath, readObjectRecord(value) ?? {});
      }
    }
  }

  return { changes: normalized, paths: normalized.map((change) => change.path) };
}

export function buildCodexFileChangesInput(changes: unknown): { changes: CodexFileChange[]; file_path: string } {
  const normalized = normalizeCodexFileChanges(changes);
  return { changes: normalized.changes, file_path: normalized.paths.join(', ') };
}

/**
 * Codex runs commands through a login shell (`["/bin/zsh", "-lc", script]`);
 * show the script itself rather than the wrapper.
 */
function codexCommandText(command: unknown): string {
  if (typeof command === 'string') {
    return command;
  }
  if (!Array.isArray(command)) {
    return '';
  }
  const parts = command.filter((part): part is string => typeof part === 'string');
  if (
    parts.length === 3
    && /(^|\/)(ba|z|da|k)?sh$/.test(parts[0])
    && (parts[1] === '-lc' || parts[1] === '-c')
  ) {
    return parts[2];
  }
  return parts.join(' ');
}

/**
 * App-server item types that never render as tool rows: user/agent messages
 * and reasoning already come from their dedicated paths, and the rest are
 * lifecycle markers.
 */
const CODEX_NON_TOOL_ITEM_TYPES = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'contextCompaction',
  'enteredReviewMode',
  'exitedReviewMode',
]);

type CodexHistoryItemResult = {
  entries: AnyRecord[];
  /** True when the item is a nested tool call we render as its own row. */
  isNestedTool: boolean;
  /** Set for UserMessage items (fallback user rows). */
  userEntry?: AnyRecord;
};

/**
 * Converts an `event_msg` / `item_completed` rollout record into history
 * entries. Tool rows use `item.id` as toolCallId, which is the same id the
 * app-server stream uses as the live `toolId`, so live/history rows merge.
 *
 * Exported for tests.
 */
export function codexItemCompletedToHistory(
  payload: AnyRecord,
  timestamp: string | undefined,
): CodexHistoryItemResult {
  const item = readObjectRecord(payload.item);
  if (!item || typeof item.id !== 'string') {
    return { entries: [], isNestedTool: false };
  }

  const status = item.status ?? 'completed';
  const pushResult = (entries: AnyRecord[], output: unknown, isError: boolean) => {
    if (isNonterminalCodexToolStatus(status)) {
      return;
    }
    entries.push({
      type: 'tool_result',
      timestamp,
      toolCallId: item.id,
      output: formatCodexToolResultContent(output),
      isError: isError || status === 'failed' || status === 'error',
    });
  };

  switch (item.type) {
    case 'CommandExecution': {
      const parsedCommand = Array.isArray(item.parsed_cmd)
        ? item.parsed_cmd
            .map((part: AnyRecord) => (typeof part?.cmd === 'string' ? part.cmd : ''))
            .filter(Boolean)
            .join(' && ')
        : '';
      const command = codexCommandText(item.command) || parsedCommand;
      const entries: AnyRecord[] = [{
        type: 'tool_use',
        timestamp,
        toolName: 'Bash',
        toolInput: { command },
        toolCallId: item.id,
      }];
      const output = item.aggregated_output ?? item.formatted_output ?? item.stdout ?? '';
      pushResult(entries, output, typeof item.exit_code === 'number' && item.exit_code !== 0);
      return { entries, isNestedTool: true };
    }
    case 'FileChange': {
      const input = buildCodexFileChangesInput(item.changes);
      const entries: AnyRecord[] = [{
        type: 'tool_use',
        timestamp,
        toolName: 'FileChanges',
        toolInput: input,
        toolCallId: item.id,
      }];
      const output = [item.stdout, item.stderr]
        .filter((part) => typeof part === 'string' && part.trim())
        .join('\n') || input.file_path;
      pushResult(entries, output, false);
      return { entries, isNestedTool: true };
    }
    case 'McpToolCall': {
      const entries: AnyRecord[] = [{
        type: 'tool_use',
        timestamp,
        toolName: typeof item.tool === 'string' && item.tool ? item.tool : 'MCP',
        toolInput: item.arguments ?? {},
        toolCallId: item.id,
      }];
      const hasError = item.error !== undefined && item.error !== null;
      pushResult(
        entries,
        hasError ? item.error : item.result,
        hasError || readObjectRecord(item.result)?.isError === true,
      );
      return { entries, isNestedTool: true };
    }
    case 'UserMessage': {
      const rawText = extractCodexTextContent(item.content);
      const { text, attachments } = parseImagesInputTag(rawText);
      const localImages = Array.isArray(item.content)
        ? item.content
            .filter((part: AnyRecord) => part?.type === 'local_image' && typeof part.path === 'string')
            .map((part: AnyRecord) => part.path as string)
        : [];
      const images = [...toImageAttachments(localImages), ...attachments];
      if (!text.trim() && images.length === 0) {
        return { entries: [], isNestedTool: false };
      }
      return {
        entries: [],
        isNestedTool: false,
        userEntry: {
          type: 'user',
          timestamp,
          message: { role: 'user', content: text },
          images: images.length > 0 ? images : undefined,
        },
      };
    }
    default:
      // AgentMessage / Reasoning are persisted as response_items too; other
      // item types (ContextCompaction, Extension, ...) are not rendered.
      return { entries: [], isNestedTool: false };
  }
}

async function getCodexSessionMessages(
  sessionId: string,
  limit: number | null = null,
  offset = 0,
): Promise<CodexHistoryResult> {
  try {
    const sessionFilePath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!sessionFilePath) {
      console.warn(`Codex session file not found for session ${sessionId}`);
      return { messages: [], total: 0, hasMore: false };
    }

    const messages: AnyRecord[] = [];
    let tokenUsage: AnyRecord | null = null;
    // Code-mode Codex wraps nested tool calls in `custom_tool_call name:"exec"`
    // (a JS snippet) and records each nested call as an `item_completed`
    // event. Render the nested items (whose ids match the live stream) and
    // drop the wrapper `exec` rows for turns that have them.
    let currentTurnId: string | null = null;
    let sawLegacyUserMessage = false;
    const itemUserMessages: AnyRecord[] = [];
    const turnsWithNestedTools = new Set<string>();
    const execCalls: Array<{ message: AnyRecord; callId: unknown; turnId: string | null }> = [];
    const fileStream = fsSync.createReadStream(sessionFilePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
          const info = entry.payload.info as AnyRecord;
          const normalizedUsage = buildCodexTokenUsage({
            total: info.total_token_usage,
            last: info.last_token_usage,
            modelContextWindow: info.model_context_window,
          });
          if (normalizedUsage) {
            tokenUsage = normalizedUsage;
          }
        }

        if (
          entry.type === 'event_msg'
          && entry.payload?.type === 'task_started'
          && typeof entry.payload.turn_id === 'string'
        ) {
          currentTurnId = entry.payload.turn_id;
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'item_completed') {
          const payload = entry.payload as AnyRecord;
          const converted = codexItemCompletedToHistory(payload, entry.timestamp);
          messages.push(...converted.entries);
          if (converted.userEntry) {
            itemUserMessages.push(converted.userEntry);
          }
          const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : currentTurnId;
          if (converted.isNestedTool && turnId) {
            turnsWithNestedTools.add(turnId);
          }
        }

        if (entry.type === 'event_msg' && isVisibleCodexUserMessage(entry.payload as AnyRecord)) {
          sawLegacyUserMessage = true;
          // Non-image attachments ride along as an `<images_input>` path block
          // appended to the prompt; strip it from the displayed text and
          // surface the referenced files alongside any inline images.
          const { text, attachments } = parseImagesInputTag(String(entry.payload.message));
          const inlineImages = extractCodexUserImages(entry.payload as AnyRecord) ?? [];
          const images = [...inlineImages, ...attachments];
          messages.push({
            type: 'user',
            timestamp: entry.timestamp,
            message: {
              role: 'user',
              content: text,
            },
            images: images.length > 0 ? images : undefined,
          });
        }

        if (
          entry.type === 'response_item' &&
          entry.payload?.type === 'message' &&
          entry.payload.role === 'assistant'
        ) {
          const textContent = extractCodexTextContent(entry.payload.content);
          if (textContent.trim()) {
            const isCommentary = entry.payload.phase === 'commentary';
            messages.push({
              type: isCommentary ? 'thinking' : 'assistant',
              timestamp: entry.timestamp,
              message: {
                role: 'assistant',
                content: textContent,
                isReasoning: isCommentary,
              },
              phase: entry.payload.phase,
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'reasoning') {
          const summaryText = Array.isArray(entry.payload.summary)
            ? entry.payload.summary
                .map((item: AnyRecord) => item?.text)
                .filter(Boolean)
                .join('\n')
            : '';

          if (summaryText.trim()) {
            messages.push({
              type: 'thinking',
              timestamp: entry.timestamp,
              message: {
                role: 'assistant',
                content: summaryText,
              },
            });
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
          let toolName = entry.payload.name;
          let toolInput = entry.payload.arguments;

          if (toolName === 'shell_command') {
            toolName = 'Bash';
            try {
              const args = JSON.parse(entry.payload.arguments) as AnyRecord;
              toolInput = JSON.stringify({ command: args.command });
            } catch {
              // Keep original arguments when parsing fails.
            }
          }

          messages.push({
            type: 'tool_use',
            timestamp: entry.timestamp,
            toolName,
            toolInput,
            toolCallId: entry.payload.call_id,
          });
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call_output') {
          messages.push({
            type: 'tool_result',
            timestamp: entry.timestamp,
            toolCallId: entry.payload.call_id,
            output: entry.payload.output,
          });
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call') {
          const toolName = entry.payload.name || 'custom_tool';
          const input = entry.payload.input || '';

          if (toolName === 'apply_patch') {
            const fileMatch = String(input).match(/\*\*\* Update File: (.+)/);
            const filePath = fileMatch ? fileMatch[1].trim() : 'unknown';
            const lines = String(input).split('\n');
            const oldLines: string[] = [];
            const newLines: string[] = [];

            for (const lineContent of lines) {
              if (lineContent.startsWith('-') && !lineContent.startsWith('---')) {
                oldLines.push(lineContent.slice(1));
              } else if (lineContent.startsWith('+') && !lineContent.startsWith('+++')) {
                newLines.push(lineContent.slice(1));
              }
            }

            messages.push({
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName: 'Edit',
              toolInput: JSON.stringify({
                file_path: filePath,
                old_string: oldLines.join('\n'),
                new_string: newLines.join('\n'),
              }),
              toolCallId: entry.payload.call_id,
            });
          } else {
            const message = {
              type: 'tool_use',
              timestamp: entry.timestamp,
              toolName,
              toolInput: input,
              toolCallId: entry.payload.call_id,
            };
            messages.push(message);
            if (toolName === 'exec') {
              const passthroughTurnId = entry.payload.internal_chat_message_metadata_passthrough?.turn_id;
              execCalls.push({
                message,
                callId: entry.payload.call_id,
                turnId: typeof passthroughTurnId === 'string' ? passthroughTurnId : currentTurnId,
              });
            }
          }
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'custom_tool_call_output') {
          messages.push({
            type: 'tool_result',
            timestamp: entry.timestamp,
            toolCallId: entry.payload.call_id,
            output: entry.payload.output || '',
          });
        }
      } catch {
        // Skip malformed lines.
      }
    }

    // Newer Codex rollouts no longer write `user_message` events; the prompt
    // only exists as an item_completed UserMessage. Use those as a fallback so
    // older transcripts (which have both) don't get duplicate user rows.
    if (!sawLegacyUserMessage) {
      messages.push(...itemUserMessages);
    }

    const suppressedExecMessages = new Set<AnyRecord>();
    const suppressedExecCallIds = new Set<unknown>();
    for (const execCall of execCalls) {
      if (execCall.turnId && turnsWithNestedTools.has(execCall.turnId)) {
        suppressedExecMessages.add(execCall.message);
        if (execCall.callId) {
          suppressedExecCallIds.add(execCall.callId);
        }
      }
    }
    if (suppressedExecMessages.size > 0) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (
          suppressedExecMessages.has(message)
          || (message.type === 'tool_result' && suppressedExecCallIds.has(message.toolCallId))
        ) {
          messages.splice(index, 1);
        }
      }
    }

    messages.sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = messages.length;

    if (limit !== null) {
      const startIndex = Math.max(0, total - offset - limit);
      const endIndex = total - offset;
      const paginatedMessages = messages.slice(startIndex, endIndex);
      const hasMore = startIndex > 0;

      return {
        messages: paginatedMessages,
        total,
        hasMore,
        offset,
        limit,
        tokenUsage,
      };
    }

    return { messages, tokenUsage };
  } catch (error) {
    console.error(`Error reading Codex session messages for ${sessionId}:`, error);
    return { messages: [], total: 0, hasMore: false };
  }
}

export class CodexSessionsProvider implements IProviderSessions {
  /**
   * Normalizes a persisted Codex JSONL entry.
   *
   * Live Codex SDK events are transformed before they reach normalizeMessage(),
   * while history entries already use a compact message/tool shape from projects.js.
   */
  private normalizeHistoryEntry(raw: AnyRecord, sessionId: string | null): NormalizedMessage[] {
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'thinking' || raw.isReasoning || raw.phase === 'commentary') {
      const thinkingContent = typeof raw.message?.content === 'string'
        ? raw.message.content
        : '';
      if (!thinkingContent.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: thinkingContent,
      })];
    }

    if (raw.message?.role === 'user') {
      const rawContent = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : String(raw.message.content || '');
      // Non-image attachments ride along as an <images_input> path block; strip
      // it from the displayed text and surface the referenced files.
      const { text: content, attachments } = parseImagesInputTag(rawContent);
      const rawImages = Array.isArray(raw.images) && raw.images.length > 0 ? raw.images : [];
      const images = [...rawImages, ...attachments];
      if (!content.trim() && images.length === 0) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content,
        images: images.length > 0 ? images : undefined,
      })];
    }

    if (raw.message?.role === 'assistant') {
      const content = typeof raw.message.content === 'string'
        ? raw.message.content
        : Array.isArray(raw.message.content)
          ? raw.message.content
              .map((part: string | AnyRecord) => typeof part === 'string' ? part : part?.text || '')
              .filter(Boolean)
              .join('\n')
          : '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content,
      })];
    }

    if (raw.type === 'tool_use' || raw.toolName) {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName || 'Unknown',
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      })];
    }

    if (raw.type === 'tool_result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: Boolean(raw.isError),
      })];
    }

    return [];
  }

  /**
   * Normalizes either a Codex history entry or a transformed live SDK event.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.message?.role) {
      return this.normalizeHistoryEntry(raw, sessionId);
    }

    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('codex');

    if (raw.type === 'item') {
      switch (raw.itemType) {
        case 'agent_message':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: raw.message?.content || '',
          })];
        case 'reasoning':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'thinking',
            content: raw.message?.content || '',
          })];
        case 'command_execution':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'Bash',
            toolInput: { command: raw.command },
            toolId: baseId,
            output: raw.output,
            exitCode: raw.exitCode,
            status: raw.status,
            toolResult: codexToolResult(
              raw.status,
              raw.output,
              typeof raw.exitCode === 'number' && raw.exitCode !== 0,
            ),
          })];
        case 'file_change':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'FileChanges',
            toolInput: buildCodexFileChangesInput(raw.changes),
            toolId: baseId,
            status: raw.status,
            toolResult: codexToolResult(raw.status, raw.changes),
          })];
        case 'mcp_tool_call':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.tool || 'MCP',
            toolInput: raw.arguments,
            toolId: baseId,
            server: raw.server,
            result: raw.result,
            error: raw.error,
            status: raw.status,
            toolResult: codexToolResult(
              raw.status,
              raw.error ?? raw.result,
              raw.error !== undefined && raw.error !== null,
            ),
          })];
        case 'web_search':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'WebSearch',
            toolInput: { query: raw.query },
            toolId: baseId,
            status: raw.status,
            // Only item/completed reaches here, so a missing status is terminal.
            toolResult: codexToolResult(raw.status ?? 'completed', ''),
          })];
        case 'todo_list':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: 'TodoList',
            toolInput: { items: raw.items },
            toolId: baseId,
            status: raw.status,
            toolResult: codexToolResult(raw.status ?? 'completed', ''),
          })];
        case 'error':
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'error',
            content: raw.message?.content || 'Unknown error',
          })];
        default: {
          if (CODEX_NON_TOOL_ITEM_TYPES.has(raw.itemType)) {
            return [];
          }
          const status = raw.status ?? raw.item?.status ?? 'completed';
          return [createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'tool_use',
            toolName: raw.itemType || 'Unknown',
            toolInput: raw.item || raw,
            toolId: baseId,
            status,
            toolResult: codexToolResult(status, ''),
          })];
        }
      }
    }

    if (raw.type === 'turn_complete') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'complete',
      })];
    }
    if (raw.type === 'turn_failed') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'error',
        content: raw.error?.message || 'Turn failed',
      })];
    }

    return [];
  }

  /**
   * Loads Codex JSONL history and keeps token usage metadata when projects.js
   * provides it.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: CodexHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getCodexSessionMessages(sessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);
    const tokenUsage = Array.isArray(result) ? undefined : result.tokenUsage;

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeHistoryEntry(raw, sessionId));
    }

    const toolResultMap = new Map<string, NormalizedMessage>();
    for (const msg of normalized) {
      if (msg.kind === 'tool_result' && msg.toolId) {
        toolResultMap.set(msg.toolId, msg);
      }
    }
    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (toolResult) {
          msg.toolResult = { content: toolResult.content, isError: toolResult.isError };
        }
      }
    }

    // `total` counts exactly the rows `offset`/`limit` slice over. Excluding
    // tool_result rows here made clients' offset (which includes them) run
    // ahead of total, skewing "N of M", hasMore, and tail-bridge planning.
    const total = normalized.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      tokenUsage,
    };
  }
}
