import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createIncrementalJsonlReader,
  createIncrementalLookupMap,
  createLastJsonlMatchScanner,
} from '@/modules/providers/shared/jsonl/incremental-jsonl.js';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'incremental-jsonl-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test('incremental reader parses only appended bytes when the file grows', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, line({ n: 1 }) + line({ n: 2 }));
    const reader = createIncrementalJsonlReader();

    const first = await reader.read(file);
    assert.equal(first.mode, 'full');
    assert.deepEqual(first.entries, [{ n: 1 }, { n: 2 }]);

    const unchanged = await reader.read(file);
    assert.equal(unchanged.mode, 'hit');
    assert.equal(unchanged.bytesRead, 0);
    assert.deepEqual(unchanged.entries, [{ n: 1 }, { n: 2 }]);

    const appended = line({ n: 3 });
    await appendFile(file, appended);
    const grown = await reader.read(file);
    assert.equal(grown.mode, 'append');
    assert.equal(grown.bytesRead, Buffer.byteLength(appended));
    assert.deepEqual(grown.entries, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

test('incremental reader keeps a partial trailing line until its newline arrives', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, `${line({ n: 1 })}{"n":`);
    const reader = createIncrementalJsonlReader();

    const partial = await reader.read(file);
    assert.deepEqual(partial.entries, [{ n: 1 }]);

    await appendFile(file, '2, "text": "multi-byte ✓ é"}\n');
    const completed = await reader.read(file);
    assert.equal(completed.mode, 'append');
    assert.deepEqual(completed.entries, [{ n: 1 }, { n: 2, text: 'multi-byte ✓ é' }]);
  });
});

test('an unterminated but complete final JSON line is returned without being committed', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, `${line({ n: 1 })}{"n":2}`);
    const reader = createIncrementalJsonlReader();

    assert.deepEqual((await reader.read(file)).entries, [{ n: 1 }, { n: 2 }]);
    // Same content again: still exactly one copy of the trailing entry.
    assert.deepEqual((await reader.read(file)).entries, [{ n: 1 }, { n: 2 }]);

    await appendFile(file, `\n${line({ n: 3 })}`);
    assert.deepEqual((await reader.read(file)).entries, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

test('truncation, in-place rewrite and atomic replace all force a full reparse', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 't.jsonl');
    const reader = createIncrementalJsonlReader();
    await writeFile(file, line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }));
    await reader.read(file);

    // Truncation below the consumed offset.
    await truncate(file, Buffer.byteLength(line({ n: 1 })));
    const truncated = await reader.read(file);
    assert.equal(truncated.mode, 'full');
    assert.deepEqual(truncated.entries, [{ n: 1 }]);

    // Rewrite that GROWS the file but changes earlier bytes (same inode).
    await writeFile(file, line({ n: 9 }) + line({ n: 8 }));
    const rewritten = await reader.read(file);
    assert.equal(rewritten.mode, 'full');
    assert.deepEqual(rewritten.entries, [{ n: 9 }, { n: 8 }]);

    // Rewrite keeping the head but changing the bytes before the offset.
    await writeFile(file, line({ n: 9 }) + line({ n: 7 }) + line({ n: 6 }));
    const tailChanged = await reader.read(file);
    assert.equal(tailChanged.mode, 'full');
    assert.deepEqual(tailChanged.entries, [{ n: 9 }, { n: 7 }, { n: 6 }]);

    // Atomic replace (new inode) with a longer file.
    const replacement = path.join(dir, 'replacement.jsonl');
    await writeFile(replacement, line({ n: 9 }) + line({ n: 7 }) + line({ n: 6 }) + line({ n: 5 }));
    await rename(replacement, file);
    const replaced = await reader.read(file);
    assert.equal(replaced.mode, 'full');
    assert.deepEqual(replaced.entries, [{ n: 9 }, { n: 7 }, { n: 6 }, { n: 5 }]);
  });
});

test('incremental reader skips malformed/blank lines and matches a from-scratch parse', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, `${line({ n: 1 })}\n  \nnot json\r\n${line({ n: 2 })}`);
    const reader = createIncrementalJsonlReader();
    assert.deepEqual((await reader.read(file)).entries, [{ n: 1 }, { n: 2 }]);

    await appendFile(file, `{"n":3}\r\n`);
    const incremental = (await reader.read(file)).entries;
    const fresh = (await createIncrementalJsonlReader().read(file)).entries;
    assert.deepEqual(incremental, fresh);
    assert.deepEqual(incremental, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

test('concurrent reads of a growing file never duplicate entries', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, line({ n: 1 }));
    const reader = createIncrementalJsonlReader();
    await reader.read(file);
    await appendFile(file, line({ n: 2 }));
    const results = await Promise.all([reader.read(file), reader.read(file), reader.read(file)]);
    for (const result of results) {
      assert.deepEqual(result.entries, [{ n: 1 }, { n: 2 }]);
    }
  });
});

test('reader cache evicts beyond its entry budget and reports missing files', async () => {
  await withTempDir(async (dir) => {
    const reader = createIncrementalJsonlReader({ maxEntries: 2 });
    for (const name of ['a', 'b', 'c']) {
      const file = path.join(dir, `${name}.jsonl`);
      await writeFile(file, line({ name }));
      await reader.read(file);
    }
    assert.equal(reader.size(), 2);
    const missing = await reader.read(path.join(dir, 'nope.jsonl'));
    assert.equal(missing.mode, 'missing');
    assert.deepEqual(missing.entries, []);
  });
});

test('last-match scanner returns the latest match and only rescans appended bytes', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 't.jsonl');
    const extract = (value: unknown) => {
      const record = value as { type?: string; title?: string };
      return record.type === 'title' ? record.title : undefined;
    };
    let parsedLines = 0;
    const scanner = createLastJsonlMatchScanner<string>({
      lineFilter: (raw) => {
        parsedLines += 1;
        return raw.includes('"title"');
      },
    });

    await writeFile(file, line({ type: 'msg' }) + line({ type: 'title', title: 'first' }) + line({ type: 'msg' }));
    assert.equal(await scanner.scan(file, 'k', extract), 'first');
    assert.equal(parsedLines, 3);

    await appendFile(file, line({ type: 'msg' }));
    assert.equal(await scanner.scan(file, 'k', extract), 'first');
    assert.equal(parsedLines, 4, 'only the appended line was scanned');

    await appendFile(file, line({ type: 'title', title: 'second' }));
    assert.equal(await scanner.scan(file, 'k', extract), 'second');

    // Rewrite without any title: full rescan finds nothing.
    await writeFile(file, line({ type: 'msg' }) + line({ type: 'msg' }) + line({ type: 'msg' }) + line({ type: 'msg' }) + line({ type: 'msg' }));
    assert.equal(await scanner.scan(file, 'k', extract), undefined);

    // Different cache keys never share remembered matches.
    await writeFile(file, line({ type: 'title', title: 'x' }));
    assert.equal(await scanner.scan(file, 'other', () => undefined), undefined);
    assert.equal(await scanner.scan(file, 'k', extract), 'x');
  });
});

test('incremental lookup map keeps first-seen values across appends and rebuilds on rewrite', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'history.jsonl');
    const lookup = createIncrementalLookupMap('sessionId', 'display');
    await writeFile(file, line({ sessionId: 's1', display: 'first' }) + line({ sessionId: 's1', display: 'later' }));
    assert.equal((await lookup.get(file)).get('s1'), 'first');

    await appendFile(file, line({ sessionId: 's2', display: 'two' }) + line({ sessionId: 's1', display: 'even later' }));
    const grown = await lookup.get(file);
    assert.equal(grown.get('s1'), 'first');
    assert.equal(grown.get('s2'), 'two');

    await writeFile(file, line({ sessionId: 's3', display: 'three' }));
    const rebuilt = await lookup.get(file);
    assert.equal(rebuilt.has('s1'), false);
    assert.equal(rebuilt.get('s3'), 'three');

    await rm(file);
    assert.equal((await lookup.get(file)).size, 0);
  });
});
