import type { ChatMessage } from '../types/types';

/**
 * Content-based placeholder heights for transcript rows that have never been
 * measured. A flat 100px estimate made every first mount of a long reply (or a
 * 40px collapsed tool row) a large geometry correction while scrolling; these
 * approximations keep that correction small. Real heights replace them as soon
 * as a row is measured (see rowHeightCache).
 *
 * Numbers mirror MessageComponent / ToolGroupContainer at the pane's max width
 * (54.25rem, text-sm prose): 24px lines, ~100 chars per assistant line, ~64
 * per user-bubble line, 40px provider header for ungrouped assistant rows.
 */

const LINE_PX = 24;
const CODE_LINE_PX = 20;
const ASSISTANT_CHARS_PER_LINE = 100;
const USER_CHARS_PER_LINE = 64;
const HEADER_PX = 40;
const COLLAPSED_TOOL_PX = 40;
const MAX_ESTIMATE_PX = 6000;

export const COLLAPSED_TOOL_GROUP_ESTIMATE_PX = 40;

function wrappedLines(text: string, charsPerLine: number): { prose: number; code: number; blocks: number } {
  let prose = 0;
  let code = 0;
  let blocks = 0;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (!inFence) blocks++;
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      code++;
    } else if (line.trim().length === 0) {
      prose += 0.5;
    } else {
      prose += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
  }
  return { prose, code, blocks };
}

// Projected ChatMessage objects are identity-stable across renders, so the
// content scan runs once per message rather than on every transcript render.
const bodyEstimateCache = new WeakMap<ChatMessage, number>();

export function estimateMessageRowHeight(message: ChatMessage, prevMessage: ChatMessage | null): number {
  if (message.isTaskNotification || message.isThinking || message.isToolUse) {
    return estimateUncached(message, prevMessage);
  }
  const grouped = Boolean(prevMessage && prevMessage.type === message.type && !prevMessage.isTaskNotification);
  let body = bodyEstimateCache.get(message);
  if (body === undefined) {
    body = estimateUncached(message, message);
    bodyEstimateCache.set(message, body);
  }
  return Math.min(MAX_ESTIMATE_PX, body + (grouped || message.type === 'user' ? 0 : HEADER_PX));
}

function estimateUncached(message: ChatMessage, prevMessage: ChatMessage | null): number {
  if (message.isTaskNotification) return 24;
  if (message.isThinking) return 36;
  const content = typeof message.content === 'string' ? message.content : '';

  if (message.type === 'user') {
    const { prose, code } = wrappedLines(content, USER_CHARS_PER_LINE);
    const images = Array.isArray(message.images) && message.images.length > 0 ? 88 : 0;
    return Math.min(MAX_ESTIMATE_PX, 16 + 20 + (prose + code) * 20 + images);
  }

  const grouped = Boolean(prevMessage && prevMessage.type === message.type && !prevMessage.isTaskNotification);
  const header = grouped ? 0 : HEADER_PX;

  if (message.isToolUse) return header + COLLAPSED_TOOL_PX;

  const { prose, code, blocks } = wrappedLines(content, ASSISTANT_CHARS_PER_LINE);
  return Math.min(
    MAX_ESTIMATE_PX,
    header + Math.max(1, prose) * LINE_PX + code * CODE_LINE_PX + blocks * 48,
  );
}
