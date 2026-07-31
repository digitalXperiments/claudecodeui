import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// grok-home.js is plain JS (allowJs, checkJs:false) — its exports are untyped.
import { mergeDirNewestWins, unifySessionsDir } from '../grok-home.js';

async function withTempHomes(runTest: (homes: { sourceHome: string; managedRoot: string }) => void): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'grok-home-'));
  const sourceHome = path.join(tempDirectory, '.grok');
  const managedRoot = path.join(tempDirectory, '.cloudcli', 'grok-runtime');
  fs.mkdirSync(sourceHome, { recursive: true });
  fs.mkdirSync(managedRoot, { recursive: true });
  try {
    await runTest({ sourceHome, managedRoot });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('unifySessionsDir merges a fragmented managed sessions dir and symlinks it', async () => {
  await withTempHomes(({ sourceHome, managedRoot }) => {
    const modeHome = path.join(managedRoot, 'default');
    const fragmented = path.join(modeHome, 'sessions');
    fs.mkdirSync(path.join(fragmented, 'sess-a'), { recursive: true });
    fs.writeFileSync(path.join(fragmented, 'sess-a', 'chat_history.jsonl'), '{"turn":1}\n');

    unifySessionsDir(sourceHome, managedRoot);

    // Transcript moved into the real home…
    const merged = path.join(sourceHome, 'sessions', 'sess-a', 'chat_history.jsonl');
    assert.equal(fs.readFileSync(merged, 'utf8'), '{"turn":1}\n');
    // …and the managed home now symlinks to it.
    const stat = fs.lstatSync(fragmented);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(fs.realpathSync(fragmented), fs.realpathSync(path.join(sourceHome, 'sessions')));
  });
});

test('unifySessionsDir is newest-wins on conflicting files', async () => {
  await withTempHomes(({ sourceHome, managedRoot }) => {
    const userSessions = path.join(sourceHome, 'sessions');
    const modeHome = path.join(managedRoot, 'always-approve');
    const fragmented = path.join(modeHome, 'sessions');
    for (const dir of [userSessions, fragmented]) {
      fs.mkdirSync(path.join(dir, 'sess-b'), { recursive: true });
    }
    fs.writeFileSync(path.join(userSessions, 'sess-b', 'chat_history.jsonl'), 'old\n');
    fs.writeFileSync(path.join(fragmented, 'sess-b', 'chat_history.jsonl'), 'new\n');
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(userSessions, 'sess-b', 'chat_history.jsonl'), past, past);

    unifySessionsDir(sourceHome, managedRoot);

    assert.equal(
      fs.readFileSync(path.join(userSessions, 'sess-b', 'chat_history.jsonl'), 'utf8'),
      'new\n',
    );
  });
});

test('unifySessionsDir leaves existing symlinks alone and is idempotent', async () => {
  await withTempHomes(({ sourceHome, managedRoot }) => {
    const modeHome = path.join(managedRoot, 'plan');
    fs.mkdirSync(modeHome, { recursive: true });

    unifySessionsDir(sourceHome, managedRoot);
    const first = fs.lstatSync(path.join(modeHome, 'sessions'));
    assert.equal(first.isSymbolicLink(), true);

    // Second run must not throw or replace the link.
    unifySessionsDir(sourceHome, managedRoot);
    assert.equal(fs.lstatSync(path.join(modeHome, 'sessions')).isSymbolicLink(), true);
  });
});

test('mergeDirNewestWins moves whole subtrees and keeps destination mtimes when older', async () => {
  await withTempHomes(({ sourceHome }) => {
    const src = path.join(sourceHome, 'src');
    const dest = path.join(sourceHome, 'dest');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'a.txt'), 'a');
    fs.writeFileSync(path.join(src, 'b.txt'), 'src-b');
    fs.writeFileSync(path.join(dest, 'b.txt'), 'dest-b');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dest, 'b.txt'), future, future);

    mergeDirNewestWins(src, dest);

    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'a.txt'), 'utf8'), 'a');
    // Destination copy was newer — source content must not win.
    assert.equal(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'dest-b');
  });
});
