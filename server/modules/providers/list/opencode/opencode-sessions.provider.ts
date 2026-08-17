import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import { parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  getOpenCodeDatabasePath,
  normalizeProviderTimestamp,
  readObjectRecord,
  readJsonRecord,
  readOptionalString,
  sliceTailPage,
  unwrapJsonStringLiteral,
} from '@/shared/utils.js';

const DEFAULT_PROVIDER = 'opencode' as const;

export type OpenCodeSessionsProviderOptions = {
  provider?: LLMProvider;
  databasePath?: string;
};

type OpenCodeHistoryRow = {
  message_id: string;
  message_time_created: number | null;
  message_data: string | null;
  part_id: string | null;
  part_time_created: number | null;
  part_data: string | null;
};

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const openOpenCodeDatabase = (databasePath: string = getOpenCodeDatabasePath()): Database.Database | null => {
  const dbPath = databasePath;
  if (!fsSync.existsSync(dbPath)) {
    return null;
  }

  return new Database(dbPath, { readonly: true, fileMustExist: true });
};

const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') {
    return unwrapJsonStringLiteral(value);
  }

  const record = readObjectRecord(value);
  const text = readOptionalString(record?.text)
    ?? readOptionalString(record?.content)
    ?? '';
  return unwrapJsonStringLiteral(text);
};

const hasUserRole = (value: unknown): boolean => {
  const record = readObjectRecord(value);
  return readOptionalString(record?.role) === 'user';
};

const isUserTextEcho = (raw: AnyRecord): boolean => {
  return readOptionalString(raw.role) === 'user'
    || hasUserRole(raw.message)
    || hasUserRole(raw.part);
};

const buildTokenUsage = (totals: OpenCodeTokenTotals | undefined): AnyRecord | undefined => {
  if (!totals) {
    return undefined;
  }

  const inputTokens = totals.inputTokens;
  const displayInputTokens = inputTokens + totals.cacheReadTokens;
  const outputTokens = totals.outputTokens;
  const used = inputTokens
    + outputTokens
    + totals.reasoningTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens;

  if (used <= 0) {
    return undefined;
  }

  return {
    used,
    inputTokens: displayInputTokens,
    outputTokens,
    breakdown: {
      input: displayInputTokens,
      output: outputTokens,
    },
  };
};

const readOpenCodeSessionColumnTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return undefined;
  }

  const row = db.prepare(`
    SELECT
      tokens_input AS inputTokens,
      tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens,
      tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens
    FROM session
    WHERE id = ?
  `).get(sessionId) as OpenCodeTokenTotals | undefined;

  if (!row) {
    return undefined;
  }

  return buildTokenUsage({
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    reasoningTokens: Number(row.reasoningTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
  });
};

/**
 * OpenCode stores per-message token counts on assistant `message.data` objects
 * (see MessageV2.Assistant). Older DBs also had session-level counters; this
 * matches current `opencode.db` layouts that only persist message JSON.
 */
const aggregateOpenCodeSessionTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const sessionColumnUsage = readOpenCodeSessionColumnTokenUsage(db, sessionId);
  if (sessionColumnUsage) {
    return sessionColumnUsage;
  }

  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  for (const row of rows) {
    const info = readJsonRecord(row.data);
    if (readOptionalString(info?.role) !== 'assistant') {
      continue;
    }

    const tokens = readObjectRecord(info?.tokens);
    if (!tokens) {
      continue;
    }

    inputTokens += Number(tokens.input ?? 0);
    outputTokens += Number(tokens.output ?? 0);
    reasoningTokens += Number(tokens.reasoning ?? 0);
    const cache = readObjectRecord(tokens.cache);
    cacheReadTokens += Number(cache?.read ?? 0);
    cacheWriteTokens += Number(cache?.write ?? 0);
  }

  return buildTokenUsage({
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
};

type NormalizeOpenCodePartOptions = {
  provider: LLMProvider;
  part: AnyRecord;
  id: string;
  sessionId: string | null;
  timestamp: string;
  role: 'user' | 'assistant';
  /** Tool id used when the part carries no `callID` of its own. */
  toolIdFallback: string;
};

/**
 * Normalizes one OpenCode message *part* — the single shape both the live
 * `run --format json` stream and the sqlite transcript speak. Live events wrap
 * it (`{ type: 'text', part: { type: 'text', text } }`); history rows store it
 * directly. Keeping one implementation is what stops the stream and the
 * transcript from disagreeing about what the agent said.
 */
const normalizeOpenCodePart = (options: NormalizeOpenCodePartOptions): NormalizedMessage[] => {
  const { provider, part, id, sessionId, timestamp, role, toolIdFallback } = options;
  const partType = readOptionalString(part.type);
  if (!partType) {
    return [];
  }

  if (partType === 'text') {
    const rawContent = extractText(part);
    // User prompts sent with attachments carry an <images_input> path list;
    // strip it for display and surface the paths as images.
    const { text: content, attachments } = role === 'user'
      ? parseImagesInputTag(rawContent)
      : { text: rawContent, attachments: [] };
    if (!content.trim() && attachments.length === 0) {
      return [];
    }

    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider,
      kind: 'text',
      role,
      content,
      images: attachments.length > 0 ? attachments : undefined,
    })];
  }

  if (partType === 'reasoning') {
    const content = extractText(part);
    if (!content.trim()) {
      return [];
    }

    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider,
      kind: 'thinking',
      content,
    })];
  }

  if (partType === 'tool') {
    const state = readObjectRecord(part.state) ?? {};
    const status = readOptionalString(state.status);
    const toolMessage = createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider,
      kind: 'tool_use',
      toolName: readOptionalString(part.tool) ?? 'Tool',
      toolInput: state.input ?? part.input ?? {},
      toolId: readOptionalString(part.callID) ?? toolIdFallback,
    });

    if (status === 'completed' || status === 'error') {
      toolMessage.toolResult = {
        content: formatToolContent(state.output ?? state.error),
        isError: status === 'error',
      };
    }

    return [toolMessage];
  }

  if (partType === 'step-finish') {
    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider,
      kind: 'stream_end',
    })];
  }

  if (partType === 'patch' || partType === 'agent') {
    return [createNormalizedMessage({
      id,
      sessionId,
      timestamp,
      provider,
      kind: 'tool_use',
      toolName: partType === 'patch' ? 'Patch' : 'Agent',
      toolInput: part,
      toolId: toolIdFallback,
    })];
  }

  return [];
};

/**
 * Normalizes one ACP `session/update` payload (live, via `opencode acp` — see
 * opencode-cli.js). `sessionUpdate` is ACP's discriminant field; the shapes
 * were captured from opencode 1.18.11.
 */
const normalizeAcpUpdate = (
  raw: AnyRecord,
  sessionId: string | null,
  provider: LLMProvider,
): NormalizedMessage[] => {
  const kind = readOptionalString(raw.sessionUpdate);
  // Chunk text must NOT go through readOptionalString: it trims, and a delta
  // that is only a newline or indentation would vanish — which silently
  // reflows every code block and JSON payload the agent streams.
  const chunkText = (value: unknown): string => {
    const text = readObjectRecord(value)?.text;
    return typeof text === 'string' ? text : '';
  };

  if (kind === 'agent_thought_chunk') {
    const text = chunkText(raw.content);
    return text
      ? [createNormalizedMessage({ kind: 'thinking', content: text, sessionId, provider })]
      : [];
  }

  if (kind === 'agent_message_chunk') {
    const text = chunkText(raw.content);
    return text
      ? [createNormalizedMessage({ kind: 'stream_delta', content: text, sessionId, provider })]
      : [];
  }

  const status = readOptionalString(raw.status);
  if (kind === 'tool_call_update' && (status === 'completed' || status === 'failed')) {
    const content = Array.isArray(raw.content)
      ? raw.content
          .map((part) => chunkText(readObjectRecord(part)?.content))
          .filter(Boolean)
          .join('\n')
      : '';
    return [createNormalizedMessage({
      kind: 'tool_result',
      toolId: readOptionalString(raw.toolCallId) ?? '',
      content: content || formatToolContent(raw.rawOutput),
      isError: status === 'failed',
      sessionId,
      provider,
    })];
  }

  if (kind === 'tool_call_update' && raw.rawInput) {
    return [createNormalizedMessage({
      kind: 'tool_use',
      // opencode-cli.js carries the real tool name ("bash") forward as
      // `toolName`; `title` by this point is the command being run.
      toolName: readOptionalString(raw.toolName) ?? readOptionalString(raw.title) ?? 'Tool',
      toolInput: raw.rawInput,
      toolId: readOptionalString(raw.toolCallId) ?? generateMessageId(provider),
      sessionId,
      provider,
    })];
  }

  // `tool_call` (the initial pending event, whose title opencode-cli.js keeps
  // for the name above), `available_commands_update`, `usage_update` and
  // `config_option_update` carry nothing the chat pane renders.
  return [];
};

export class OpenCodeSessionsProvider implements IProviderSessions {
  private readonly provider: LLMProvider;
  private readonly databasePath: string;

  constructor(options: OpenCodeSessionsProviderOptions = {}) {
    this.provider = options.provider ?? DEFAULT_PROVIDER;
    this.databasePath = options.databasePath ?? getOpenCodeDatabasePath();
  }

  /**
   * Normalizes live OpenCode events into frontend messages: ACP
   * `session/update` payloads (`opencode acp`, the current runtime) and the
   * part-wrapped events of the older one-shot `opencode run --format json`.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (typeof raw.sessionUpdate === 'string') {
      return normalizeAcpUpdate(raw, sessionId, this.provider);
    }

    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const eventSessionId = readOptionalString(raw.sessionID) ?? readOptionalString(raw.sessionId) ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.time ?? raw.timestamp);
    const baseId = readOptionalString(raw.id)
      ?? readOptionalString(raw.messageID)
      ?? generateMessageId(this.provider);

    if (type === 'error') {
      // OpenCode reports structured errors (`{ error: { name, data } }`) as
      // well as plain strings; formatting the object beats reporting the
      // useless "Unknown OpenCode error" the string-only read fell back to.
      const content = readOptionalString(raw.error)
        ?? readOptionalString(raw.message)
        ?? formatToolContent(raw.error ?? raw.message)
        ?? '';
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: this.provider,
        kind: 'error',
        content: content.trim() || 'Unknown OpenCode error',
      })];
    }

    // OpenCode (>= 1.x) wraps every streamed event's payload in `part`, where
    // the text/tool fields live — the flat `raw.text` / `raw.tool` shape below
    // is the older format. Without this branch the CLI's answer never becomes
    // a text event at all: the chat pane still renders it (it re-reads the
    // provider's sqlite transcript), but every consumer of the live run —
    // agent swarm, Mission Control, Kanban — sees an empty transcript and
    // treats a successful run as "no output from agent".
    const part = readObjectRecord(raw.part);
    if (part) {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw)) {
        return [];
      }

      const partId = readOptionalString(part.id) ?? baseId;
      return normalizeOpenCodePart({
        provider: this.provider,
        part,
        id: partId,
        sessionId: eventSessionId,
        timestamp,
        role: 'assistant',
        toolIdFallback: partId,
      });
    }

    if (type === 'text') {
      // The client already renders an optimistic user bubble, so provider user
      // echoes must not be streamed back as assistant text.
      if (isUserTextEcho(raw)) {
        return [];
      }

      const content = extractText(raw.text ?? raw.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: this.provider,
        kind: 'stream_delta',
        content,
      })];
    }

    if (type === 'reasoning') {
      const content = extractText(raw.text ?? raw.delta ?? raw.message);
      if (!content.trim()) {
        return [];
      }

      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: this.provider,
        kind: 'thinking',
        content,
      })];
    }

    if (type === 'tool_use') {
      const toolName = readOptionalString(raw.tool) ?? readOptionalString(raw.name) ?? 'Tool';
      const toolId = readOptionalString(raw.callID) ?? readOptionalString(raw.toolCallId) ?? baseId;
      const toolMessage = createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: this.provider,
        kind: 'tool_use',
        toolName,
        toolInput: raw.input ?? raw.arguments ?? {},
        toolId,
      });

      if (raw.output !== undefined || raw.error !== undefined) {
        toolMessage.toolResult = {
          content: formatToolContent(raw.output ?? raw.error),
          isError: raw.error !== undefined,
        };
      }

      return [toolMessage];
    }

    if (type === 'step_finish') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: this.provider,
        kind: 'stream_end',
      })];
    }

    return [];
  }

  /**
   * Loads OpenCode history from the shared SQLite session database.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    // OpenCode's shared sqlite database keys messages by the provider-native
    // session id, not the app-facing id this method is addressed with.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const db = openOpenCodeDatabase(this.databasePath);
    if (!db) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const rows = db.prepare(`
        SELECT
          m.id AS message_id,
          m.time_created AS message_time_created,
          m.data AS message_data,
          p.id AS part_id,
          p.time_created AS part_time_created,
          p.data AS part_data
        FROM message m
        LEFT JOIN part p
          ON p.session_id = m.session_id
         AND p.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY
          COALESCE(m.time_created, 0),
          m.id,
          COALESCE(p.time_created, 0),
          p.id
      `).all(providerSessionId) as OpenCodeHistoryRow[];

      const normalized = this.normalizeHistoryRows(rows, sessionId);
      const tokenUsage = aggregateOpenCodeSessionTokenUsage(db, providerSessionId);

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
        tokenUsage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenCodeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    } finally {
      db.close();
    }
  }

  private normalizeHistoryRows(rows: OpenCodeHistoryRow[], sessionId: string): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    const emittedMessageErrors = new Set<string>();

    for (const row of rows) {
      const timestamp = normalizeProviderTimestamp(row.part_time_created ?? row.message_time_created);
      const baseId = `${row.message_id}_${row.part_id ?? normalized.length}`;
      const messageInfo = readJsonRecord(row.message_data);
      const messageRole = readOptionalString(messageInfo?.role);

      if (
        messageInfo
        && messageRole === 'assistant'
        && messageInfo.error != null
        && !emittedMessageErrors.has(row.message_id)
      ) {
        emittedMessageErrors.add(row.message_id);
        normalized.push(createNormalizedMessage({
          id: `${baseId}_error`,
          sessionId,
          timestamp,
          provider: this.provider,
          kind: 'error',
          content: formatToolContent(messageInfo.error),
        }));
      }

      if (!row.part_id) {
        continue;
      }

      const partData = readJsonRecord(row.part_data) ?? {};
      normalized.push(...normalizeOpenCodePart({
        provider: this.provider,
        part: partData,
        id: baseId,
        sessionId,
        timestamp,
        role: messageRole === 'user' ? 'user' : 'assistant',
        toolIdFallback: row.part_id,
      }));
    }

    return normalized;
  }
}
