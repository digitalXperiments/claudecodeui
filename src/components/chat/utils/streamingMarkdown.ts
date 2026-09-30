/**
 * Splits a partially-streamed assistant message into a settled prefix and the
 * block still being written.
 *
 * The realtime handler pushes the whole accumulated reply every 100ms, so
 * rendering it as one markdown document re-parses the entire message ten times
 * a second — O(length) per tick and O(length²) over a reply. Splitting at a
 * block boundary lets the prefix render through a memoized <MarkdownBody>,
 * whose input only changes when a block completes, so each tick only parses the
 * tail.
 *
 * Correctness rests on markdown blocks being independent across a blank line:
 * rendering `settled` and `pending` as two documents must equal rendering their
 * concatenation. That does NOT hold inside a fenced code block, a display-math
 * block, a list, a blockquote, a table, an indented code block, or across a
 * link-reference/footnote definition and its usage — the boundary search skips
 * all of them.
 *
 * This operates on accumulated markdown text only, so it is provider-agnostic:
 * Claude, Codex, Grok, Cursor and ACP streams all flow through the same
 * accumulated-text path.
 */

/** An opening or closing code fence, per CommonMark: up to 3 spaces of indent. */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** A `$$` display-math delimiter. remark-math treats `$$` lines as block math. */
const MATH_DELIMITER_PATTERN = /^ {0,3}\$\$/;

/**
 * Block starters whose meaning depends on the surrounding lines, checked on both
 * sides of a candidate blank line.
 *
 * Three of these are demonstrably load-bearing, each with a fixture in
 * StreamingMarkdown.test.tsx that renders differently if its arm is removed: a
 * blank line between list items makes the list loose (every item gains a <p>),
 * a blank line inside an indented code block does not end it, and a reference
 * definition split away from the text that uses it leaves the link unresolved.
 *
 * The blockquote and table arms are conservative. CommonMark and GFM end both
 * blocks at a blank line, and no input has been found where splitting there
 * renders differently — they are kept because the cost of being wrong is a
 * visible layout break and the cost of being cautious is one more block staying
 * in the pending half for one tick.
 */
const CONTEXT_SENSITIVE_LINE = new RegExp([
  '^\\s*([-*+]|\\d+[.)])\\s',      // list item
  '^( {2,}|\\t)\\S',               // indented continuation or indented code
  '^\\s*>',                        // blockquote
  '^\\s*\\|',                      // table row
  '^ {0,3}\\[[^\\]]*\\]:',         // link reference or footnote definition
].join('|'));

export type StreamingMarkdownSplit = {
  /** Complete blocks. Stable between ticks, so its markdown parse is memoizable. */
  settled: string;
  /** The block still streaming. Re-parsed every tick, but bounded by one block. */
  pending: string;
};

/** The fence currently open, so only a matching marker closes it. */
type OpenFence = { marker: string; length: number };

export function splitStreamingMarkdown(content: string): StreamingMarkdownSplit {
  if (!content) {
    return { settled: '', pending: '' };
  }

  const lines = content.split('\n');
  let openFence: OpenFence | null = null;
  let insideMath = false;
  let boundaryLine = -1;

  // Offset of each line's first character, so the split is an exact slice.
  let offset = 0;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    const fence = readFence(line);
    if (fence) {
      if (!openFence) {
        openFence = fence;
      } else if (closesFence(openFence, fence, line)) {
        // CommonMark: only the same marker, at least as long, with no info string.
        openFence = null;
      }
      continue;
    }

    if (!openFence && MATH_DELIMITER_PATTERN.test(line)) {
      // A self-contained `$$x$$` line opens and closes in one go; toggling on it
      // would leave the tracker stuck open and suppress every later boundary.
      if (countMathDelimiters(line) % 2 === 1) {
        insideMath = !insideMath;
      }
      continue;
    }

    if (openFence || insideMath || line.trim() !== '') {
      continue;
    }

    // Nothing settled yet: a leading blank line has no block before it.
    const previous = previousNonBlank(lines, index);
    if (previous === null || CONTEXT_SENSITIVE_LINE.test(lines[previous])) {
      continue;
    }

    // When a block follows, it must not be one whose meaning spans the blank
    // line. When nothing follows, the pending half is empty and the split is
    // trivially safe.
    const next = nextNonBlank(lines, index);
    if (next !== null && CONTEXT_SENSITIVE_LINE.test(lines[next])) {
      continue;
    }

    boundaryLine = index;
  }

  if (boundaryLine < 0) {
    return { settled: '', pending: content };
  }

  const splitAt = lineOffsets[boundaryLine] + lines[boundaryLine].length + 1;
  return {
    settled: content.slice(0, splitAt),
    pending: content.slice(splitAt),
  };
}

function countMathDelimiters(line: string): number {
  return line.split('$$').length - 1;
}

function readFence(line: string): OpenFence | null {
  const match = FENCE_PATTERN.exec(line);
  return match ? { marker: match[1][0], length: match[1].length } : null;
}

function closesFence(open: OpenFence, candidate: OpenFence, line: string): boolean {
  if (candidate.marker !== open.marker || candidate.length < open.length) {
    return false;
  }
  // A closing fence carries no info string.
  return line.trim().replace(/^[`~]+/, '').trim() === '';
}

function previousNonBlank(lines: string[], from: number): number | null {
  for (let index = from - 1; index >= 0; index--) {
    if (lines[index].trim() !== '') {
      return index;
    }
  }
  return null;
}

function nextNonBlank(lines: string[], from: number): number | null {
  for (let index = from + 1; index < lines.length; index++) {
    if (lines[index].trim() !== '') {
      return index;
    }
  }
  return null;
}

/** Where an unclosed fence starts in the (normalized) text, for plain rendering. */
export type OpenFenceInfo = {
  /** Offset of the opening fence line in `text`. */
  start: number;
  /** True when the opener has no indentation (a top-level block start). */
  topLevel: boolean;
};

export type IncrementalStreamingSplit = StreamingMarkdownSplit & {
  /** The fence-normalized text the split was computed on (`settled + pending`). */
  text: string;
  /** Set while the text ends inside an unclosed fenced code block. */
  openFence: OpenFenceInfo | null;
};

type SplitterNormalizer = (text: string) => string;

/**
 * Incremental twin of `splitStreamingMarkdown(normalize(content))`.
 *
 * Streaming replies only ever grow, and the realtime handler republishes the
 * whole accumulated text every 100ms — re-running the block scan (and the
 * inline-fence normalization) over the entire reply each tick is O(length) per
 * tick. This keeps the scan state for every complete line already seen and
 * only processes newly completed lines plus the partial last line. When the
 * new text is not an extension of the previous one it starts over, so the
 * result is always identical to the stateless function (pinned by tests).
 *
 * `normalize` must only rewrite within single lines (true for
 * normalizeInlineCodeFences), so normalizing line-complete chunks separately
 * equals normalizing the whole text.
 */
export function createStreamingMarkdownSplitter(normalize: SplitterNormalizer = (text) => text) {
  let consumedRaw = '';
  let normalizedPrefix = '';
  let openFence: OpenFence | null = null;
  let openFenceStart = -1;
  let openFenceTopLevel = false;
  let insideMath = false;
  let previousNonBlank: string | null = null;
  let trailingBlankEnd = -1;
  let confirmedBoundary = -1;
  let lastSettled = '';
  let prefixChanged = true;

  const reset = () => {
    prefixChanged = true;
    consumedRaw = '';
    normalizedPrefix = '';
    openFence = null;
    openFenceStart = -1;
    openFenceTopLevel = false;
    insideMath = false;
    previousNonBlank = null;
    trailingBlankEnd = -1;
    confirmedBoundary = -1;
  };

  // A non-blank line settles the fate of the blank run before it.
  const resolveRun = (line: string) => {
    if (trailingBlankEnd >= 0) {
      if (!CONTEXT_SENSITIVE_LINE.test(line)) confirmedBoundary = trailingBlankEnd;
      trailingBlankEnd = -1;
    }
  };

  const processLine = (line: string, lineStart: number) => {
    const fence = readFence(line);
    if (fence) {
      resolveRun(line);
      if (!openFence) {
        openFence = fence;
        openFenceStart = lineStart;
        openFenceTopLevel = line.startsWith(fence.marker);
      } else if (closesFence(openFence, fence, line)) {
        openFence = null;
        openFenceStart = -1;
      }
      previousNonBlank = line;
      return;
    }
    if (!openFence && MATH_DELIMITER_PATTERN.test(line)) {
      resolveRun(line);
      if (countMathDelimiters(line) % 2 === 1) insideMath = !insideMath;
      previousNonBlank = line;
      return;
    }
    if (line.trim() !== '') {
      resolveRun(line);
      previousNonBlank = line;
      return;
    }
    if (openFence || insideMath) return;
    if (previousNonBlank === null || CONTEXT_SENSITIVE_LINE.test(previousNonBlank)) return;
    trailingBlankEnd = lineStart + line.length + 1;
  };

  const split = (content: string): IncrementalStreamingSplit => {
    if (!content) {
      reset();
      lastSettled = '';
      prefixChanged = false;
      return { settled: '', pending: '', text: '', openFence: null };
    }
    if (!content.startsWith(consumedRaw)) reset();

    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline + 1 > consumedRaw.length) {
      const chunk = normalize(content.slice(consumedRaw.length, lastNewline + 1));
      let lineStart = normalizedPrefix.length;
      let cursor = 0;
      while (cursor < chunk.length) {
        const end = chunk.indexOf('\n', cursor);
        const line = chunk.slice(cursor, end);
        processLine(line, lineStart);
        lineStart += line.length + 1;
        cursor = end + 1;
      }
      normalizedPrefix += chunk;
      consumedRaw = content.slice(0, lastNewline + 1);
    }

    const tail = normalize(content.slice(consumedRaw.length));
    const text = tail ? normalizedPrefix + tail : normalizedPrefix;

    let splitAt = confirmedBoundary;
    if (tail.trim() !== '') {
      if (trailingBlankEnd >= 0 && !CONTEXT_SENSITIVE_LINE.test(tail)) splitAt = trailingBlankEnd;
    } else if (
      !openFence
      && !insideMath
      && previousNonBlank !== null
      && !CONTEXT_SENSITIVE_LINE.test(previousNonBlank)
    ) {
      // A trailing blank line with nothing after it is always a safe split.
      splitAt = text.length;
    }

    let fenceInfo: OpenFenceInfo | null = null;
    const tailFence = readFence(tail);
    if (openFence) {
      if (!(tailFence && closesFence(openFence, tailFence, tail))) {
        fenceInfo = { start: openFenceStart, topLevel: openFenceTopLevel };
      }
    } else if (tailFence && !insideMath) {
      fenceInfo = { start: normalizedPrefix.length, topLevel: tail.startsWith(tailFence.marker) };
    }

    if (splitAt < 0) {
      lastSettled = '';
      prefixChanged = false;
      return { settled: '', pending: text, text, openFence: fenceInfo };
    }
    // Reuse the previous settled string when the boundary did not move, so the
    // memoized settled renderer compares by identity instead of by content.
    const settled = !prefixChanged && lastSettled.length === splitAt
      ? lastSettled
      : text.slice(0, splitAt);
    lastSettled = settled;
    prefixChanged = false;
    return { settled, pending: text.slice(splitAt), text, openFence: fenceInfo };
  };

  return { split, reset };
}
