import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateDiff, createCachedDiffCalculator, type DiffLine } from './messageTransforms';

/** Reference: size of the minimal line edit script via an O(N·M) LCS table. */
function minimalEditCount(oldStr: string, newStr: string): number {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return a.length + b.length - 2 * table[0][0];
}

/** Rebuilds the new text from the old text and the diff; proves the diff is valid. */
function applyDiff(oldStr: string, diff: DiffLine[]): string {
  const oldLines = oldStr.split('\n');
  const removed = new Set(diff.filter((line) => line.type === 'removed').map((line) => line.lineNum));
  const added = diff.filter((line) => line.type === 'added');
  const kept = oldLines.filter((_, index) => !removed.has(index + 1));
  const result: string[] = [];
  let keptIndex = 0;
  let addedIndex = 0;
  const total = kept.length + added.length;
  for (let lineNum = 1; lineNum <= total; lineNum++) {
    if (addedIndex < added.length && added[addedIndex].lineNum === lineNum) {
      result.push(added[addedIndex].content);
      addedIndex++;
    } else {
      result.push(kept[keptIndex]);
      keptIndex++;
    }
  }
  return result.join('\n');
}

test('identical text has no diff', () => {
  assert.deepEqual(calculateDiff('a\nb\nc', 'a\nb\nc'), []);
});

test('a changed line is reported as removed then added with its own line numbers', () => {
  assert.deepEqual(calculateDiff('a\nb\nc', 'a\nB\nc'), [
    { type: 'removed', content: 'b', lineNum: 2 },
    { type: 'added', content: 'B', lineNum: 2 },
  ]);
});

test('an insertion does not cascade into a whole-file change', () => {
  assert.deepEqual(calculateDiff('a\nb\nc', 'a\nx\nb\nc'), [
    { type: 'added', content: 'x', lineNum: 2 },
  ]);
  assert.deepEqual(calculateDiff('a\nb\nc', 'b\nc'), [
    { type: 'removed', content: 'a', lineNum: 1 },
  ]);
});

test('pure additions and pure removals', () => {
  assert.deepEqual(calculateDiff('', 'x'), [
    { type: 'removed', content: '', lineNum: 1 },
    { type: 'added', content: 'x', lineNum: 1 },
  ]);
  assert.deepEqual(calculateDiff('a', 'a\nb\nc'), [
    { type: 'added', content: 'b', lineNum: 2 },
    { type: 'added', content: 'c', lineNum: 3 },
  ]);
});

test('random edits produce a valid and minimal diff', () => {
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = ['a', 'b', 'c', 'd', 'e'];
  for (let round = 0; round < 300; round++) {
    const oldLines = Array.from({ length: Math.floor(random() * 12) }, () => alphabet[Math.floor(random() * alphabet.length)]);
    const newLines = [...oldLines];
    const edits = Math.floor(random() * 6);
    for (let edit = 0; edit < edits; edit++) {
      const position = Math.floor(random() * (newLines.length + 1));
      const kind = random();
      if (kind < 0.4) newLines.splice(position, 0, alphabet[Math.floor(random() * alphabet.length)]);
      else if (kind < 0.8 && newLines.length > 0) newLines.splice(Math.min(position, newLines.length - 1), 1);
      else if (newLines.length > 0) newLines[Math.min(position, newLines.length - 1)] = 'z';
    }
    const oldStr = oldLines.join('\n');
    const newStr = newLines.join('\n');
    const diff = calculateDiff(oldStr, newStr);
    assert.equal(applyDiff(oldStr, diff), newStr, `invalid diff for ${JSON.stringify([oldStr, newStr])}`);
    assert.equal(diff.length, minimalEditCount(oldStr, newStr), `non-minimal diff for ${JSON.stringify([oldStr, newStr])}`);
  }
});

test('over the edit budget the middle is reported as one remove/add hunk', () => {
  const oldStr = ['keep', 'a1', 'a2', 'a3', 'tail'].join('\n');
  const newStr = ['keep', 'b1', 'b2', 'tail'].join('\n');
  const diff = calculateDiff(oldStr, newStr, 1);
  assert.deepEqual(diff.map((line) => `${line.type}:${line.content}:${line.lineNum}`), [
    'removed:a1:2', 'removed:a2:3', 'removed:a3:4', 'added:b1:2', 'added:b2:3',
  ]);
  assert.equal(applyDiff(oldStr, diff), newStr);
});

test('a large file with a few edits diffs quickly', () => {
  const oldLines = Array.from({ length: 20000 }, (_, index) => `line ${index} ${index % 7}`);
  const newLines = [...oldLines];
  newLines.splice(100, 1, 'changed near the top');
  newLines.splice(10000, 0, 'inserted in the middle');
  newLines.splice(19000, 3);
  const oldStr = oldLines.join('\n');
  const newStr = newLines.join('\n');
  const startedAt = performance.now();
  const diff = calculateDiff(oldStr, newStr);
  const elapsed = performance.now() - startedAt;
  assert.equal(applyDiff(oldStr, diff), newStr);
  assert.equal(diff.length, 6);
  // The old LCS table needed 400M cells here; this must stay interactive.
  assert.ok(elapsed < 250, `diff took ${elapsed.toFixed(1)}ms`);
});

test('the cached calculator returns the same result for equal inputs', () => {
  const createDiff = createCachedDiffCalculator(2);
  const first = createDiff('a\nb', 'a\nc');
  assert.equal(createDiff('a\nb', 'a\nc'), first);
  createDiff('x', 'y');
  createDiff('p', 'q');
  // Evicted (capacity 2) — recomputed but equal.
  const again = createDiff('a\nb', 'a\nc');
  assert.notEqual(again, first);
  assert.deepEqual(again, first);
});
