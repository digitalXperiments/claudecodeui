export interface DiffLine {
  type: 'added' | 'removed';
  content: string;
  lineNum: number;
}

export type DiffCalculator = (oldStr: string, newStr: string) => DiffLine[];

/**
 * Beyond this many edits (inserted + removed lines, after the common prefix
 * and suffix are trimmed) the middle section is reported as "all removed,
 * then all added" instead of searching for a minimal alignment. Keeps the
 * worst case bounded (the search is O((N+M)·D) time, O(D²) memory) for tool
 * calls that rewrite a whole large file.
 */
export const DEFAULT_MAX_EDIT_DISTANCE = 2000;

type EditOp = 0 | 1 | 2; // 0 = equal, 1 = removed (old), 2 = added (new)

/**
 * Myers' O((N+M)·D) shortest-edit-script over integer line ids. Returns the
 * ops in forward order, or null when the edit distance exceeds `maxD`.
 */
function myersEditScript(a: Int32Array, b: Int32Array, maxD: number): EditOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[k] for k in [-d, d] as it was BEFORE step d ran.
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // Backtrack. trace[d] is the v state before step d, i.e. the result of d-1.
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const get = (k: number) => prev[k + d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && get(k - 1) < get(k + 1))) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(0);
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push(2);
      y--;
    } else {
      ops.push(1);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(0);
    x--;
    y--;
  }
  ops.reverse();
  return ops;
}

/**
 * Line diff for the tool-call diff views: only changed lines are returned,
 * `lineNum` is the 1-based line in the old text (removed) or new text (added),
 * and within each changed hunk removals are listed before additions.
 *
 * Replaces an O(N·M)-time/space LCS table (a 5k-line file edit allocated a
 * 25M-cell table on the main thread). Common prefix/suffix are trimmed first,
 * which makes the typical small edit near-linear.
 */
export const calculateDiff = (
  oldStr: string,
  newStr: string,
  maxEditDistance: number = DEFAULT_MAX_EDIT_DISTANCE,
): DiffLine[] => {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  let start = 0;
  const minLength = Math.min(oldLines.length, newLines.length);
  while (start < minLength && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  const diffLines: DiffLine[] = [];
  if (oldCount === 0 && newCount === 0) return diffLines;

  let ops: EditOp[] | null = null;
  if (oldCount > 0 && newCount > 0) {
    // Intern lines so the inner loop compares integers.
    const ids = new Map<string, number>();
    const intern = (line: string) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    };
    const a = new Int32Array(oldCount);
    const b = new Int32Array(newCount);
    for (let index = 0; index < oldCount; index++) a[index] = intern(oldLines[start + index]);
    for (let index = 0; index < newCount; index++) b[index] = intern(newLines[start + index]);
    ops = myersEditScript(a, b, maxEditDistance);
  }
  if (!ops) {
    // Pure insertion/deletion, or over the edit budget: one hunk.
    ops = [];
    for (let index = 0; index < oldCount; index++) ops.push(1);
    for (let index = 0; index < newCount; index++) ops.push(2);
  }

  // Emit hunk by hunk: removals first, then additions.
  let oldIndex = start;
  let newIndex = start;
  let cursor = 0;
  while (cursor < ops.length) {
    if (ops[cursor] === 0) {
      oldIndex++;
      newIndex++;
      cursor++;
      continue;
    }
    let hunkEnd = cursor;
    while (hunkEnd < ops.length && ops[hunkEnd] !== 0) hunkEnd++;
    let addedInHunk = 0;
    for (let index = cursor; index < hunkEnd; index++) {
      if (ops[index] === 1) {
        diffLines.push({ type: 'removed', content: oldLines[oldIndex], lineNum: oldIndex + 1 });
        oldIndex++;
      } else {
        addedInHunk++;
      }
    }
    for (let added = 0; added < addedInHunk; added++) {
      diffLines.push({ type: 'added', content: newLines[newIndex], lineNum: newIndex + 1 });
      newIndex++;
    }
    cursor = hunkEnd;
  }

  return diffLines;
};

/** FNV-1a over a string, for cache keys (collisions are re-checked). */
function hashString(value: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

type DiffCacheEntry = { oldStr: string; newStr: string; lines: DiffLine[] };

export const createCachedDiffCalculator = (maxEntries = 100): DiffCalculator => {
  // Keyed by lengths + hash instead of JSON.stringify([old, new]), which
  // built (and then hashed) a string as large as both inputs on every call.
  const cache = new Map<string, DiffCacheEntry>();

  return (oldStr: string, newStr: string) => {
    const key = `${oldStr.length}:${newStr.length}:${hashString(oldStr)}:${hashString(newStr, 0x9e3779b9)}`;
    const cached = cache.get(key);
    if (cached && cached.oldStr === oldStr && cached.newStr === newStr) {
      return cached.lines;
    }

    const calculated = calculateDiff(oldStr, newStr);
    cache.set(key, { oldStr, newStr, lines: calculated });
    if (cache.size > maxEntries) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }
    return calculated;
  };
};
