import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeInlineCodeFences } from './chatFormatting';
import { createStreamingMarkdownSplitter, splitStreamingMarkdown } from './streamingMarkdown';

/**
 * The split is only sound if `settled + pending === content` and the two halves
 * render the same as the whole. Every case below either asserts a safe boundary
 * or asserts that a context-sensitive construct is kept intact. The
 * halves-render-like-the-whole property itself is pinned by
 * StreamingMarkdown.test.tsx.
 */

const assertLossless = (content: string) => {
  const { settled, pending } = splitStreamingMarkdown(content);
  assert.equal(settled + pending, content, 'split must not lose or duplicate text');
};

test('an empty message splits into nothing', () => {
  assert.deepEqual(splitStreamingMarkdown(''), { settled: '', pending: '' });
});

test('a message with no completed block is entirely pending', () => {
  const content = 'The first sentence is still being written';
  assert.deepEqual(splitStreamingMarkdown(content), { settled: '', pending: content });
  assertLossless(content);
});

test('a completed paragraph settles and the partial one stays pending', () => {
  const content = 'First paragraph.\n\nSecond para still stre';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, 'First paragraph.\n\n');
  assert.equal(pending, 'Second para still stre');
  assertLossless(content);
});

test('the boundary advances to the last completed block', () => {
  const content = 'One.\n\nTwo.\n\nThree partial';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, 'One.\n\nTwo.\n\n');
  assert.equal(pending, 'Three partial');
});

test('an unterminated code fence keeps the whole block pending', () => {
  const content = 'Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, 'Intro.\n\n');
  assert.ok(pending.startsWith('```ts'), 'the open fence must stay in one piece');
  assertLossless(content);
});

test('a closed code fence can be settled', () => {
  const content = '```ts\nconst a = 1;\n```\n\nAfter the block';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, '```ts\nconst a = 1;\n```\n\n');
  assert.equal(pending, 'After the block');
});

test('a blank line inside a loose list is not a boundary', () => {
  // Splitting here would restart the numbering at 1 in the second half.
  const content = '1. first\n\n2. second\n\n3. third partial';
  const { settled } = splitStreamingMarkdown(content);

  assert.equal(settled, '', 'must never split a list');
});

test('a blank line between bullet items is not a boundary', () => {
  const content = '- alpha\n\n- beta\n\n- gamma partial';
  assert.equal(splitStreamingMarkdown(content).settled, '');
});

test('a blank line adjacent to a blockquote is not a boundary', () => {
  const content = '> quoted line\n\n> continued quote partial';
  assert.equal(splitStreamingMarkdown(content).settled, '');
});

test('a blank line adjacent to a table is not a boundary', () => {
  const content = '| a | b |\n| - | - |\n\n| 1 | 2 |';
  assert.equal(splitStreamingMarkdown(content).settled, '');
});

test('a paragraph before a list settles without splitting the list', () => {
  const content = 'Here are the steps.\n\n- first\n- second partial';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, '', 'the list start is context-sensitive, so no split yet');
  assert.equal(pending, content);
});

test('a heading is a safe boundary', () => {
  const content = '# Title\n\nBody text still coming';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, '# Title\n\n');
  assert.equal(pending, 'Body text still coming');
});

test('content ending exactly on a boundary leaves nothing pending', () => {
  const content = 'Done.\n\n';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, 'Done.\n\n');
  assert.equal(pending, '');
});

test('the settled prefix only grows as more of the reply arrives', () => {
  const full = 'Alpha para.\n\nBeta para.\n\nGamma still going';
  let previousSettledLength = 0;

  for (let end = 1; end <= full.length; end++) {
    const chunk = full.slice(0, end);
    const { settled } = splitStreamingMarkdown(chunk);
    assertLossless(chunk);
    assert.ok(
      settled.length >= previousSettledLength,
      `settled prefix shrank at length ${end}: ${settled.length} < ${previousSettledLength}`,
    );
    previousSettledLength = settled.length;
  }
});

test('every prefix of a fenced reply stays lossless', () => {
  const full = 'Intro.\n\n```js\nconst x = 1;\n```\n\nOutro para.\n\nTail';
  for (let end = 1; end <= full.length; end++) {
    assertLossless(full.slice(0, end));
  }
});

test('a self-closing $$x$$ line does not leave math tracking stuck open', () => {
  // Toggling on a line that opens and closes in one go would suppress every
  // later boundary, silently disabling the optimisation for the rest of the reply.
  const content = 'Intro.\n\n$$E = mc^2$$\n\nA settled paragraph.\n\nStill writing';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(pending, 'Still writing');
  assert.ok(settled.includes('A settled paragraph.'));
});

test('a blank line inside an unterminated $$ block is not a boundary', () => {
  // This is the shape mid-stream: the closing $$ has not arrived yet.
  const content = 'Intro.\n\n$$\na = b\n\nc = d';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, 'Intro.\n\n', 'the open math block must stay in one piece');
  assert.equal(pending, '$$\na = b\n\nc = d');
});

test('a closed $$ block can be settled once its delimiter arrives', () => {
  const content = 'Intro.\n\n$$\na = b\n\nc = d\n$$\n\nAfter';
  const { settled, pending } = splitStreamingMarkdown(content);

  assert.equal(settled, 'Intro.\n\n$$\na = b\n\nc = d\n$$\n\n');
  assert.equal(pending, 'After');
});

// ─── Incremental splitter ─────────────────────────────────────────────────

const INCREMENTAL_FIXTURES = [
  'One.\n\nTwo.\n\nThree partial',
  'Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the block\n\n- a\n\n- b\n\nTail',
  '# Heading\n\nText with ```inline``` fence.\n\n> quote\n\nPara\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEnd.\n\n',
  'Math:\n\n$$\nx = 1\n\ny = 2\n$$\n\n$$z$$\n\nAfter\n\n    indented code\n\n    more\n\nDone',
  '[ref]: https://example.com\n\nUse [ref].\n\n1. one\n2. two\n\n~~~\ncode\n\n~~~\n\n```\nunclosed\n\nstill',
  '\n\nleading blanks\n\n\n\nmany blanks  \n  \n\nx',
  'para\n```js\nlet a;\n\n``\n```\n\nnext',
];

test('the incremental splitter matches the stateless split on every streamed prefix', () => {
  for (const fixture of INCREMENTAL_FIXTURES) {
    const splitter = createStreamingMarkdownSplitter(normalizeInlineCodeFences);
    for (let length = 0; length <= fixture.length; length++) {
      const prefix = fixture.slice(0, length);
      const expected = splitStreamingMarkdown(normalizeInlineCodeFences(prefix));
      const actual = splitter.split(prefix);
      assert.equal(actual.settled, expected.settled, `settled mismatch at ${length} of ${JSON.stringify(fixture)}`);
      assert.equal(actual.pending, expected.pending, `pending mismatch at ${length} of ${JSON.stringify(fixture)}`);
      assert.equal(actual.text, normalizeInlineCodeFences(prefix));
    }
  }
});

test('the incremental splitter matches with irregular chunks and restarts on non-extensions', () => {
  const splitter = createStreamingMarkdownSplitter(normalizeInlineCodeFences);
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let round = 0; round < 50; round++) {
    const fixture = INCREMENTAL_FIXTURES[round % INCREMENTAL_FIXTURES.length];
    let length = 0;
    while (length <= fixture.length) {
      const prefix = fixture.slice(0, length);
      const expected = splitStreamingMarkdown(normalizeInlineCodeFences(prefix));
      assert.deepEqual(
        { settled: splitter.split(prefix).settled, pending: splitter.split(prefix).pending },
        expected,
      );
      length += 1 + Math.floor(random() * 40);
    }
    // Next round starts from a different (non-extension) document.
  }
});

test('the settled string keeps its identity while the boundary does not move', () => {
  const splitter = createStreamingMarkdownSplitter();
  const first = splitter.split('Para one.\n\nPara two is gro');
  const second = splitter.split('Para one.\n\nPara two is growing longer');
  assert.equal(first.settled, 'Para one.\n\n');
  assert.ok(Object.is(first.settled, second.settled));
});

test('an unclosed fence is reported until its closing marker arrives', () => {
  const splitter = createStreamingMarkdownSplitter();
  const open = splitter.split('Intro.\n\n```py\nprint(1)\n\nprint(2)');
  assert.deepEqual(open.openFence, { start: 'Intro.\n\n'.length, topLevel: true });
  assert.equal(open.settled, 'Intro.\n\n');

  const closing = splitter.split('Intro.\n\n```py\nprint(1)\n\nprint(2)\n```');
  assert.equal(closing.openFence, null, 'a closing marker on the partial line closes the fence');

  const indented = createStreamingMarkdownSplitter().split('- item\n\n   ```\ncode');
  assert.equal(indented.openFence?.topLevel, false);

  assert.equal(createStreamingMarkdownSplitter().split('No fences here').openFence, null);
});
