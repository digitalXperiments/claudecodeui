import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord } from '@/shared/utils.js';

const PROVIDER = 'agy';
const AGY_CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');

/**
 * State tracking per session for streaming thinking tag parsing.
 */
type SessionThinkingState = {
  inThought: boolean;
  currentTag: string | null;
  buffer: string;
};

const activeSessionStates = new Map<string, SessionThinkingState>();

export class AgySessionsProvider implements IProviderSessions {
  /**
   * Normalizes incoming agy message chunks. Detects thought/thinking blocks
   * (e.g. `<thought>...</thought>`, `<thinking>...</thinking>`, `<think>...</think>`,
   * or `[Thinking: ...]`) and streams them as `kind: 'thinking'` so the frontend
   * renders animated thinking accordions.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    let text = '';
    if (typeof rawMessage === 'string') {
      text = rawMessage;
    } else {
      const raw = readObjectRecord(rawMessage);
      if (typeof raw?.text === 'string') {
        text = raw.text;
      }
    }

    if (!text) {
      return [];
    }

    const key = sessionId || 'global';
    let state = activeSessionStates.get(key);
    if (!state) {
      state = { inThought: false, currentTag: null, buffer: '' };
      activeSessionStates.set(key, state);
    }

    state.buffer += text;
    const results: NormalizedMessage[] = [];

    // Parse thoughts inside buffer
    const THOUGHT_START_REGEX = /<(thought|thinking|think)>|\[Thinking:\s*/i;
    const THOUGHT_END_MAP: Record<string, RegExp> = {
      thought: /<\/thought>/i,
      thinking: /<\/thinking>/i,
      think: /<\/think>/i,
      '[Thinking:': /\]|\n\n/i,
    };

    while (state.buffer.length > 0) {
      if (!state.inThought) {
        const match = THOUGHT_START_REGEX.exec(state.buffer);
        if (match) {
          const prefix = state.buffer.slice(0, match.index);
          if (prefix) {
            results.push(createNormalizedMessage({
              kind: 'stream_delta',
              content: prefix,
              sessionId,
              provider: PROVIDER,
            }));
          }
          state.inThought = true;
          state.currentTag = match[1] ? match[1].toLowerCase() : '[Thinking:';
          state.buffer = state.buffer.slice(match.index + match[0].length);
        } else {
          // No thought start tag found; emit buffer
          results.push(createNormalizedMessage({
            kind: 'stream_delta',
            content: state.buffer,
            sessionId,
            provider: PROVIDER,
          }));
          state.buffer = '';
        }
      } else {
        const endRegex = state.currentTag ? THOUGHT_END_MAP[state.currentTag] || /<\/thought>|<\/thinking>|<\/think>/i : /<\/thought>/i;
        const endMatch = endRegex.exec(state.buffer);
        if (endMatch) {
          const thoughtContent = state.buffer.slice(0, endMatch.index);
          if (thoughtContent) {
            results.push(createNormalizedMessage({
              kind: 'thinking',
              content: thoughtContent,
              sessionId,
              provider: PROVIDER,
            }));
          }
          state.inThought = false;
          state.currentTag = null;
          state.buffer = state.buffer.slice(endMatch.index + endMatch[0].length);
        } else {
          // Mid-thought chunk
          results.push(createNormalizedMessage({
            kind: 'thinking',
            content: state.buffer,
            sessionId,
            provider: PROVIDER,
          }));
          state.buffer = '';
        }
      }
    }

    return results;
  }

  /**
   * Fetches past conversation history for an Antigravity session.
   * Reads from the SQLite database at `~/.gemini/antigravity-cli/conversations/<id>.db`
   * if available, extracting readable turn text.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const dbPath = path.join(AGY_CONVERSATIONS_DIR, `${sessionId}.db`);
    if (!existsSync(dbPath)) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options.offset ?? 0,
        limit: options.limit ?? null,
      };
    }

    const messages: NormalizedMessage[] = [];
    try {
      const buffer = readFileSync(dbPath);
      // Extract printable text chunks from step payload binary blobs
      const str = buffer.toString('utf8');
      const printableMatches = Array.from(str.matchAll(/[\x20-\x7E\s]{10,}/g)).map((m) => m[0].trim());

      const filtered = printableMatches.filter((s) => (
        !s.startsWith('CREATE TABLE') &&
        !s.startsWith('idx_steps') &&
        !s.includes('.json') &&
        !s.includes('.db') &&
        !s.includes('.log') &&
        !s.includes('default-cli-project') &&
        s.length > 5
      ));

      // Build turn pairs from extracted text
      let currentRole: 'user' | 'assistant' = 'user';
      for (const textChunk of filtered.slice(0, 100)) {
        messages.push(createNormalizedMessage({
          kind: currentRole === 'user' ? 'text' : 'stream_delta',
          content: textChunk,
          sessionId,
          provider: PROVIDER,
        }));
        currentRole = currentRole === 'user' ? 'assistant' : 'user';
      }
    } catch {
      // Fall back to empty history if parse fails
    }

    return {
      messages,
      total: messages.length,
      hasMore: false,
      offset: options.offset ?? 0,
      limit: options.limit ?? null,
    };
  }
}

