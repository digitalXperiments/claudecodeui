import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, sliceTailPage } from '@/shared/utils.js';

import { stripAntigravityPromptPlumbing } from './antigravity-conversation-store.js';
import { readAntigravityHistoryUpdates } from './antigravity-history.js';

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
 * Text for a completed tool call.
 *
 * Antigravity puts the result in `rawOutput`, and — unlike the other ACP
 * agents — it is an OBJECT, not a string: the shell tool sends
 * `{ commandLine, exitCode, combinedOutput, formatted_output }`. Reading only
 * the string case left every tool result blank in the transcript, so the known
 * text fields are preferred and anything unrecognized falls back to pretty
 * JSON rather than an empty bubble.
 *
 * `combinedOutput` and `formatted_output` are duplicates of each other on the
 * shell tool; picking one avoids rendering the command output twice.
 */
const toolResultText = (raw: Record<string, unknown>): string => {
  const rawOutput = raw.rawOutput;
  if (typeof rawOutput === 'string') return rawOutput;

  const record = readObjectRecord(rawOutput);
  if (record) {
    for (const key of ['combinedOutput', 'formatted_output', 'output', 'stdout', 'text', 'content']) {
      const value = record[key];
      if (typeof value === 'string' && value) return value;
    }
    try {
      return JSON.stringify(rawOutput, null, 2);
    } catch {
      return String(rawOutput);
    }
  }

  return textParts(raw.content);
};

/**
 * Key the ACP runtime uses to hand `normalizeMessage` the path a tool call
 * ANNOUNCED, so a failure can be checked against the call it is attached to.
 * Not part of the ACP schema — CloudCLI adds it, like `toolName`.
 */
export const ANTIGRAVITY_ANNOUNCED_PATH_KEY = 'announcedToolPath';

/**
 * The path a `tool_call` says it will touch: ACP `locations` first (Antigravity
 * always populates it for file tools), then the tool's own argument under any
 * of the casings it accepts (`AbsolutePath`/`absolute_path`, and the directory
 * and search variants).
 */
export function antigravityAnnouncedToolPath(update: unknown): string {
  const raw = readObjectRecord(update);
  if (!raw) return '';

  const locations = Array.isArray(raw.locations) ? raw.locations : [];
  for (const location of locations) {
    const path = readObjectRecord(location)?.path;
    if (typeof path === 'string' && path) return path;
  }

  // Antigravity sends builtin-tool arguments as a JSON *string*, MCP-tool
  // arguments as an object; both have to parse or the check silently no-ops.
  let input: Record<string, unknown> | null = readObjectRecord(raw.rawInput);
  if (!input && typeof raw.rawInput === 'string') {
    try {
      input = readObjectRecord(JSON.parse(raw.rawInput));
    } catch {
      input = null;
    }
  }
  if (!input) return '';

  for (const key of ['AbsolutePath', 'absolute_path', 'DirectoryPath', 'directory_path', 'SearchPath', 'TargetFile']) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/** The path a sandbox denial names, or `''` when the failure is something else. */
const deniedPath = (text: string): string => {
  const match = /Access to path "([^"]+)" is denied/.exec(text);
  return match ? match[1] : '';
};

/**
 * Antigravity 1.1.1 misattributes tool failures.
 *
 * Verified live against a bare ACP client (CloudCLI entirely out of the path):
 * a step that issues several tool calls emits fewer `tool_call` announcements
 * than it executes, then reports a LATER call's failure under an EARLIER call's
 * `toolCallId`:
 *
 *   tool_call        id=call_344591 rawInput={"AbsolutePath": ".../package.json"}
 *   tool_call_update id=call_344591 status=failed
 *                    rawOutput='Access to path "/Users/me/.codex/config.toml" is denied...'
 *
 * Attaching that verbatim paints an innocent, successful call red with someone
 * else's error — which is what made a handful of real denials look like a
 * transcript full of failures. When the denial names a path the call never
 * asked for, the result is detached from the call (rendered as its own error
 * entry) instead of being pinned to it. The error is never dropped: it is real
 * and the user still needs to see it, just not against the wrong call.
 */
export function isMisattributedDenial(announced: string, denied: string): boolean {
  if (!announced || !denied || announced === denied) return false;
  // The announcement may be workspace-relative while the denial is absolute.
  if (!announced.startsWith('/') && denied.endsWith(`/${announced}`)) return false;
  return true;
}

/**
 * Live-event normalization for Antigravity's ACP `session/update` stream.
 *
 * The update shapes are the shared ACP ones (agent_message_chunk,
 * agent_thought_chunk, tool_call/tool_call_update), so this mirrors the
 * OpenCode/Kilo/Qwen readers.
 *
 * `fetchHistory` replays the stored conversation through ACP `session/load`
 * and feeds the resulting updates back through `normalizeMessage`, so a
 * re-opened session renders exactly what the live stream rendered. Antigravity
 * still has **no rewind capability** — nothing here should be read as
 * supporting one.
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
      const content = toolResultText(raw);
      const announced = typeof raw[ANTIGRAVITY_ANNOUNCED_PATH_KEY] === 'string'
        ? raw[ANTIGRAVITY_ANNOUNCED_PATH_KEY] as string
        : '';
      // An empty toolId is what detaches the result: the chat reader renders a
      // result it cannot pair as a standalone error rather than a tool card.
      const misattributed = raw.status === 'failed'
        && isMisattributedDenial(announced, deniedPath(content));
      return [createNormalizedMessage({
        kind: 'tool_result',
        toolId: misattributed || typeof raw.toolCallId !== 'string' ? '' : raw.toolCallId,
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

  /**
   * Collapse a replayed update stream into displayable history.
   *
   * The replay is chunk-granular — one `agent_message_chunk` per token-ish
   * slice — so emitting `normalizeMessage`'s output verbatim would render a
   * paragraph as hundreds of one-word bubbles. Consecutive chunks of the same
   * stream (assistant text, thinking, or a user turn) are therefore joined
   * into one message, flushed as soon as anything else interrupts them.
   *
   * Replayed updates carry no timestamps, so messages keep array order; the
   * frontend renders history in the order the reader returns it.
   */
  private normalizeHistoryUpdates(
    updates: Record<string, unknown>[],
    sessionId: string,
  ): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];
    let buffer: { stream: 'assistant' | 'thinking' | 'user'; content: string } | null = null;

    const flush = () => {
      if (!buffer) return;
      const { stream, content } = buffer;
      buffer = null;
      // A replayed user turn still carries the machine-only blocks CloudCLI
      // wrapped around it (`<images_input>`, `<workspace_boundary>`); they are
      // plumbing, not something to render back at the user.
      const text = stream === 'user' ? stripAntigravityPromptPlumbing(content).trim() : content;
      if (!text.trim()) return;
      normalized.push(createNormalizedMessage({
        kind: stream === 'thinking' ? 'thinking' : 'text',
        ...(stream === 'thinking' ? {} : { role: stream }),
        content: text,
        sessionId,
        provider: ANTIGRAVITY_PROVIDER,
      }));
    };

    // toolCallId -> the path the call announced, so a misattributed denial in a
    // later `tool_call_update` can be detached the same way the live stream
    // detaches it (see `isMisattributedDenial`).
    const announcedPaths = new Map<string, string>();

    for (const update of updates) {
      const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (update.sessionUpdate === 'tool_call' && toolCallId) {
        const announced = antigravityAnnouncedToolPath(update);
        if (announced) announcedPaths.set(toolCallId, announced);
      }
      const enriched = announcedPaths.has(toolCallId)
        ? { ...update, [ANTIGRAVITY_ANNOUNCED_PATH_KEY]: announcedPaths.get(toolCallId) }
        : update;

      for (const message of this.normalizeMessage(enriched, sessionId)) {
        const stream = message.kind === 'stream_delta'
          ? 'assistant' as const
          : message.kind === 'thinking'
            ? 'thinking' as const
            : message.kind === 'text' && message.role === 'user'
              ? 'user' as const
              : null;
        if (stream) {
          const content = typeof message.content === 'string' ? message.content : '';
          if (buffer && buffer.stream === stream) {
            buffer.content += content;
          } else {
            flush();
            buffer = { stream, content };
          }
          continue;
        }
        flush();
        normalized.push(message);
      }
    }
    flush();

    return normalized;
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    // `session/load` is addressed with the agent's own session id, and it
    // rejects a cwd that does not match the one the session was created in.
    const providerSessionId = options.providerSessionId ?? sessionId;
    const cwd = options.projectPath ?? '';
    if (!cwd) {
      return { messages: [], total: 0, hasMore: false, offset: normalizedOffset, limit: normalizedLimit };
    }

    const updates = await readAntigravityHistoryUpdates(providerSessionId, cwd);
    const normalized = this.normalizeHistoryUpdates(updates, sessionId);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total: normalized.length,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
