import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ThemeProvider reads localStorage in its useState initializers; give the node
// test runner a stub before anything renders.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  };
}

import { ThemeProvider } from '../../../../contexts/ThemeContext';
import { Markdown, MarkdownBody } from './Markdown';
import StreamingMarkdown from './StreamingMarkdown';

const CLASS_NAME = 'prose prose-sm prose-gray max-w-none font-serif dark:prose-invert';

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<ThemeProvider>{node}</ThemeProvider>);

/**
 * react-markdown emits "\n" text nodes between sibling block elements; the
 * split drops the one at the settled/pending boundary. Whitespace between
 * block-level siblings is insignificant to layout (and splits only ever happen
 * at block boundaries), so the comparison strips it rather than requiring a
 * byte-identical string.
 */
const normalize = (markup: string) => markup.replace(/>\n+</g, '><');

/**
 * Render equivalence: for any reply, StreamingMarkdown (streaming or finished)
 * must produce the same markup as the plain <Markdown> path. This is the
 * contract that lets MessageComponent swap <Markdown> for <StreamingMarkdown>
 * without changing what any provider's reply looks like, and it is what makes
 * the split itself safe — the two halves render exactly like the whole.
 */
const assertRendersLikeMarkdown = (content: string, label: string) => {
  const unsplit = render(<Markdown className={CLASS_NAME}>{content}</Markdown>);
  const streaming = render(
    <StreamingMarkdown content={content} isStreaming className={CLASS_NAME} />,
  );
  const finished = render(
    <StreamingMarkdown content={content} isStreaming={false} className={CLASS_NAME} />,
  );

  assert.equal(normalize(streaming), normalize(unsplit), `${label}: streaming split must render like <Markdown>`);
  assert.equal(normalize(finished), normalize(unsplit), `${label}: finished reply must render like <Markdown>`);
};

const FIXTURES: Record<string, string> = {
  'plain paragraphs': 'First paragraph.\n\nSecond paragraph.\n\nThird still stre',
  'heading then body': '# Title\n\nSome body text\n\nMore body still going',
  'closed code fence': 'Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the block',
  'open code fence': 'Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n',
  'loose ordered list': 'Steps:\n\n1. first\n\n2. second\n\n3. third partial',
  'loose bullet list': '- alpha\n\n- beta\n\n- gamma partial',
  'blockquote run': 'Intro.\n\n> quoted line\n\n> second quote partial',
  'gfm table': 'Data:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n| 3 | 4 |',
  'indented code block': 'Example:\n\n    indented code\n\n    still the same block',
  'link reference definition': 'See [the docs][ref] for more.\n\n[ref]: https://example.com\n\nTail text',
  'display math': 'Intro.\n\n$$\nE = mc^2\n$$\n\nAfter math still going',
  'inline fence normalization': 'Run ```npm test``` locally.\n\nSecond paragraph still stre',
  'mixed long reply': [
    '# Result',
    '',
    'Here is what changed.',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '- item one',
    '- item two',
    '',
    '> a note',
    '',
    'Closing paragraph still bei',
  ].join('\n'),
};

for (const [label, content] of Object.entries(FIXTURES)) {
  test(`renders equivalently: ${label}`, () => {
    assertRendersLikeMarkdown(content, label);
  });
}

test('every prefix of a mixed reply renders equivalently to the unsplit document', () => {
  // Simulates the accumulated-text flushes: at any cut point the split output
  // must match the single-document render.
  const full = 'Intro.\n\n```js\nconst x = 1;\n```\n\nOutro para.\n\nTail';
  for (let end = 1; end <= full.length; end++) {
    assertRendersLikeMarkdown(full.slice(0, end), `prefix of length ${end}`);
  }
});

test('the list guard is load-bearing: splitting a loose list would change the render', () => {
  // Documents why CONTEXT_SENSITIVE_LINE keeps lists intact: forcing a split at
  // the blank line renders a different document (numbering restarts / list
  // becomes two lists), so the guard is not just caution.
  const whole = '1. first\n\n2. second';
  const naiveSplit = (
    <div className={CLASS_NAME}>
      <MarkdownBody>{'1. first\n\n'}</MarkdownBody>
      <MarkdownBody>{'2. second'}</MarkdownBody>
    </div>
  );

  assert.notEqual(
    normalize(render(naiveSplit)),
    normalize(render(<Markdown className={CLASS_NAME}>{whole}</Markdown>)),
    'a forced split inside a list must differ, proving the guard matters',
  );
});

test('stream_end keeps the same element type mounted at the reply position', () => {
  // The DOM-persistence half of the contract: MessageComponent renders
  // StreamingMarkdown for both the streaming and the finished reply, so React
  // reconciles (rather than remounts) the nodes when isStreaming flips false
  // and an in-progress text selection survives stream end. Rendering both
  // states through the one component is what this pins.
  const content = 'A finished reply.\n\nWith two paragraphs.';
  const during = render(<StreamingMarkdown content={content} isStreaming className={CLASS_NAME} />);
  const after = render(<StreamingMarkdown content={content} isStreaming={false} className={CLASS_NAME} />);

  assert.equal(normalize(during), normalize(after), 'markup must be stable across the stream_end flip');
});
