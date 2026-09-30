import { memo, useMemo, useRef } from 'react';

import { useTheme } from '../../../../contexts/ThemeContext';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { createStreamingMarkdownSplitter } from '../../utils/streamingMarkdown';

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
 * That crossing is not one-way. The boundary is (incrementally) re-evaluated on
 * each tick, so an already-settled block returns to pending whenever the text that
 * follows it makes the old boundary unsafe to split at — a soft-wrapped line, or
 * a list, table or blockquote starting after it. Retracting is what keeps the
 * two halves rendering identically to the unsplit document, so it is correct,
 * not a bug. Only blocks in a message still being streamed are affected.
 */
type StreamingParts = {
  settled: string;
  pending: string;
  /** An unclosed top-level fenced code block still being written. */
  openCode: { language: string; code: string } | null;
};

const FENCE_OPENER = /^(`{3,}|~{3,})[ \t]*([^\s`]*)/;

function parseOpenFence(fenceText: string): { language: string; code: string } {
  const newline = fenceText.indexOf('\n');
  const opener = newline === -1 ? fenceText : fenceText.slice(0, newline);
  const match = FENCE_OPENER.exec(opener);
  const language = match?.[2] || 'text';
  let code = newline === -1 ? '' : fenceText.slice(newline + 1);
  if (code.endsWith('\n')) code = code.slice(0, -1);
  return { language, code };
}

/**
 * Plain stand-in for a code block that is still streaming. Syntax
 * highlighting (Prism) re-tokenizes the whole block on every 100ms flush, the
 * dominant cost of long code replies; the block is highlighted once, as soon
 * as its closing fence arrives. Mirrors CodeBlock's frame (label, radius,
 * padding, background) so the swap does not shift layout.
 */
const StreamingCodePreview = memo(function StreamingCodePreview({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const { isDarkMode } = useTheme();
  const labelled = Boolean(language && language !== 'text');
  return (
    <div className="group relative my-2" data-streaming-code>
      {labelled && (
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-gray-400">{language}</div>
      )}
      <pre
        style={{
          margin: 0,
          borderRadius: '0.75rem',
          fontSize: '0.875rem',
          padding: labelled ? '2rem 1rem 1rem 1rem' : '1rem',
          lineHeight: 1.5,
          whiteSpace: 'pre',
          overflow: 'auto',
          tabSize: 2,
          background: isDarkMode ? 'hsl(220, 13%, 18%)' : 'hsl(var(--muted))',
          color: isDarkMode ? 'hsl(220, 14%, 71%)' : 'hsl(230, 8%, 24%)',
        }}
      >
        <code
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            background: 'transparent',
          }}
        >
          {code}
        </code>
      </pre>
    </div>
  );
});

export default function StreamingMarkdown({
  content,
  isStreaming,
  className,
}: StreamingMarkdownProps) {
  // Incremental splitter: remembers the scan state of the text already seen,
  // so each flush only scans the newly streamed lines (see
  // createStreamingMarkdownSplitter). Output equals splitStreamingMarkdown.
  const splitterRef = useRef<ReturnType<typeof createStreamingMarkdownSplitter> | null>(null);
  const { settled, pending, openCode } = useMemo((): StreamingParts => {
    const text = String(content ?? '');
    if (!isStreaming) {
      splitterRef.current?.reset();
      return { settled: text, pending: '', openCode: null };
    }
    if (!splitterRef.current) {
      splitterRef.current = createStreamingMarkdownSplitter(normalizeInlineCodeFences);
    }
    const result = splitterRef.current.split(text);
    // Only a top-level (unindented) opener: it always starts a new block, so
    // the text before it renders identically on its own. An indented fence
    // may belong to a list item and stays in the markdown path.
    if (result.openFence?.topLevel && result.openFence.start >= result.settled.length) {
      return {
        settled: result.settled,
        pending: result.text.slice(result.settled.length, result.openFence.start),
        openCode: parseOpenFence(result.text.slice(result.openFence.start)),
      };
    }
    return { settled: result.settled, pending: result.pending, openCode: null };
  }, [content, isStreaming]);

  return (
    <div className={className}>
      {settled && <MarkdownBody>{settled}</MarkdownBody>}
      {pending && <MarkdownBody>{pending}</MarkdownBody>}
      {openCode && <StreamingCodePreview language={openCode.language} code={openCode.code} />}
    </div>
  );
}
