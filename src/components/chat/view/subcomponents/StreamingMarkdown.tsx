import { useMemo } from 'react';

import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { splitStreamingMarkdown } from '../../utils/streamingMarkdown';

import { MarkdownBody } from './Markdown';

type StreamingMarkdownProps = {
  content: string;
  /** False once the reply is complete, which stops the splitting. */
  isStreaming: boolean;
  className?: string;
};

/**
 * Used by chat's MessageComponent for an assistant reply, streaming or not.
 * Provider-agnostic: it only ever sees the accumulated markdown text, so
 * Claude, Codex, Grok, Cursor and ACP streams all take the same path.
 *
 * The realtime handler republishes the whole accumulated reply every 100ms, so
 * a single <Markdown> would re-parse the entire message ten times a second.
 * Splitting at a block boundary keeps the settled half's props stable, so
 * memo(MarkdownBody) skips it and only the block still being written is
 * re-parsed. Markdown blocks are independent across the boundaries
 * splitStreamingMarkdown chooses, so the rendered output matches the unsplit
 * document — including block spacing, because both halves are siblings inside
 * the single prose container below (react-markdown adds no wrapper element).
 *
 * The split runs on the fence-normalized text — the exact string MarkdownBody
 * parses — so the boundary tracker and the renderer agree on what is a code
 * fence. normalizeInlineCodeFences only rewrites within a single line, so
 * re-normalizing each half inside MarkdownBody is a no-op.
 *
 * It renders the finished reply too, with isStreaming false and no split at all
 * — there is nothing left to grow, so a second parse buys nothing. The reason it
 * handles that case rather than deferring to <Markdown> is that React treats a
 * different element type in the same position as a different component: if
 * MessageComponent switched components at stream end, every completed reply
 * would throw away its DOM and rebuild it, losing any selection the user had
 * started making inside it. One component there means the nodes are reconciled.
 *
 * A block changes parent when it crosses from pending to settled, so its DOM is
 * recreated at that moment, dropping transient in-block state (a code block's
 * "Copied" tick, a text selection).
 *
 * That crossing is not one-way. The boundary is recomputed from scratch on each
 * tick, so an already-settled block returns to pending whenever the text that
 * follows it makes the old boundary unsafe to split at — a soft-wrapped line, or
 * a list, table or blockquote starting after it. Retracting is what keeps the
 * two halves rendering identically to the unsplit document, so it is correct,
 * not a bug. Only blocks in a message still being streamed are affected.
 */
export default function StreamingMarkdown({
  content,
  isStreaming,
  className,
}: StreamingMarkdownProps) {
  const { settled, pending } = useMemo(() => {
    const text = String(content ?? '');
    if (!isStreaming) {
      return { settled: text, pending: '' };
    }
    return splitStreamingMarkdown(normalizeInlineCodeFences(text));
  }, [content, isStreaming]);

  return (
    <div className={className}>
      {settled && <MarkdownBody>{settled}</MarkdownBody>}
      {pending && <MarkdownBody>{pending}</MarkdownBody>}
    </div>
  );
}
