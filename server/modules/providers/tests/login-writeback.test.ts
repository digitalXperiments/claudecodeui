import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import {
  guardedLoginWriteBack,
  sameSnapshot,
  snapshotFile,
} from '@/modules/providers/shared/login/login-writeback.js';

async function fixture(): Promise<{ dir: string; real: string; run: string; seed: (content: string, ageMs?: number) => void; cleanup: () => void }> {
  const dir = await makeScratchDir('login-writeback-');
  const real = path.join(dir, 'real-auth.json');
  const run = path.join(dir, 'run-auth.json');
  return {
    dir,
    real,
    run,
    seed(content, ageMs = 3_600_000) {
      fs.writeFileSync(real, content, { mode: 0o600 });
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(real, when, when);
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const quiet = () => {
  const lines: string[] = [];
  return { lines, log: (message: string) => { lines.push(message); } };
};

test('snapshotFile fingerprints mtime, size and content; sameSnapshot needs all three', async () => {
  const f = await fixture();
  try {
    f.seed('{"a":1}');
    const first = snapshotFile(f.real);
    assert.ok(first);
    assert.equal(first.size, 7);
    assert.equal(first.json, true);
    assert.equal(sameSnapshot(first, snapshotFile(f.real)), true);
    const pinned = fs.statSync(f.real);
    fs.writeFileSync(f.real, '{"a":2}');
    fs.utimesSync(f.real, pinned.atime, pinned.mtime);
    assert.equal(sameSnapshot(first, snapshotFile(f.real)), false, 'same size and mtime, different bytes');
    assert.equal(snapshotFile(path.join(f.dir, 'missing.json')), null);
    assert.equal(sameSnapshot(null, null), false);
  } finally {
    f.cleanup();
  }
});

test('writes back through a staging file and rename, keeps mode 0600, leaves nothing behind', async () => {
  const f = await fixture();
  try {
    f.seed('{"t":"old"}');
    fs.chmodSync(f.real, 0o644);
    const start = snapshotFile(f.real);
    fs.writeFileSync(f.run, '{"t":"new"}');
    const inode = fs.statSync(f.real).ino;
    const { lines, log } = quiet();
    const result = guardedLoginWriteBack({ realFile: f.real, runFile: f.run, startSnapshot: start, label: 'test', log });
    assert.deepEqual(result, { status: 'written' });
    assert.equal(fs.readFileSync(f.real, 'utf8'), '{"t":"new"}');
    assert.equal(fs.statSync(f.real).mode & 0o777, 0o600);
    assert.notEqual(fs.statSync(f.real).ino, inode, 'replaced by rename, not rewritten in place');
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['real-auth.json', 'run-auth.json']);
    assert.deepEqual(lines, []);
  } finally {
    f.cleanup();
  }
});

test('carryMtime gives the real file the run file\'s mtime', async () => {
  const f = await fixture();
  try {
    f.seed('{"t":"old"}');
    const start = snapshotFile(f.real);
    fs.writeFileSync(f.run, '{"t":"new"}');
    const stamp = new Date(Date.now() - 1_000);
    fs.utimesSync(f.run, stamp, stamp);
    assert.equal(guardedLoginWriteBack({ realFile: f.real, runFile: f.run, startSnapshot: start, label: 't', carryMtime: true }).status, 'written');
    assert.equal(Math.floor(fs.statSync(f.real).mtimeMs / 1000), Math.floor(stamp.getTime() / 1000));
  } finally {
    f.cleanup();
  }
});

test('discards when the real login changed during the run, and logs it', async () => {
  const f = await fixture();
  try {
    f.seed('{"t":"start"}');
    const start = snapshotFile(f.real);
    fs.writeFileSync(f.run, '{"t":"run"}');
    fs.writeFileSync(f.real, '{"t":"someone-else"}');
    const { lines, log } = quiet();
    const result = guardedLoginWriteBack({ realFile: f.real, runFile: f.run, startSnapshot: start, label: 'test', log });
    assert.equal(result.status, 'discarded');
    assert.equal(fs.readFileSync(f.real, 'utf8'), '{"t":"someone-else"}');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[test\] login write-back skipped: the real login changed while the run was active/);
  } finally {
    f.cleanup();
  }
});

test('re-checks right before the rename: a change between staging and rename discards and removes the staging file', async () => {
  const f = await fixture();
  try {
    f.seed('{"t":"start"}');
    const start = snapshotFile(f.real);
    fs.writeFileSync(f.run, '{"t":"run"}');
    const { lines, log } = quiet();
    const result = guardedLoginWriteBack({
      realFile: f.real,
      runFile: f.run,
      startSnapshot: start,
      label: 'test',
      log,
      beforeFinalCheck: () => {
        // The window the first check cannot see: someone logs in while the staging file is being written.
        assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith('.tmp')), true, 'the staging file exists in the real file\'s directory');
        fs.writeFileSync(f.real, '{"t":"late-login"}');
      },
    });
    assert.equal(result.status, 'discarded');
    assert.match(lines[0], /changed just before it would have been replaced/);
    assert.equal(fs.readFileSync(f.real, 'utf8'), '{"t":"late-login"}');
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['real-auth.json', 'run-auth.json'], 'staging file removed');
  } finally {
    f.cleanup();
  }
});

test('never creates a login, never resurrects a logout, never resurrects from an unreadable real file', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(f.run, '{"t":"run"}');
    assert.equal(guardedLoginWriteBack({ realFile: f.real, runFile: f.run, startSnapshot: null, label: 't', log: () => {} }).status, 'discarded');
    assert.equal(fs.existsSync(f.real), false, 'no login at start: none is created');

    f.seed('{"t":"start"}');
    const start = snapshotFile(f.real);
    fs.rmSync(f.real); // explicit logout during the run
    assert.equal(guardedLoginWriteBack({ realFile: f.real, runFile: f.run, startSnapshot: start, label: 't', log: () => {} }).status, 'discarded');
    assert.equal(fs.existsSync(f.real), false);
  } finally {
    f.cleanup();
  }
});

test('does nothing when the run file is a link, missing, older, identical, empty or invalid', async () => {
  const f = await fixture();
  try {
    f.seed('{"t":"start"}');
    const start = snapshotFile(f.real);
    const call = () => guardedLoginWriteBack({ realFile: f.real, runFile: f.run, startSnapshot: start, label: 't', log: () => {} });

    assert.equal(call().status, 'unchanged', 'no run file');
    fs.symlinkSync(f.real, f.run);
    assert.equal(call().status, 'unchanged', 'a link means the provider wrote through (or not at all)');
    fs.rmSync(f.run);

    fs.writeFileSync(f.run, '{"t":"older"}');
    const longAgo = new Date(Date.now() - 86_400_000);
    fs.utimesSync(f.run, longAgo, longAgo);
    assert.equal(call().status, 'unchanged', 'not newer than the real login at start');

    fs.writeFileSync(f.run, '{"t":"start"}');
    assert.equal(call().status, 'unchanged', 'same content');

    fs.writeFileSync(f.run, '');
    assert.equal(call().status, 'discarded', 'empty');
    fs.writeFileSync(f.run, '{"t":');
    assert.equal(call().status, 'discarded', 'invalid JSON replacing a JSON login');

    assert.equal(fs.readFileSync(f.real, 'utf8'), '{"t":"start"}');
  } finally {
    f.cleanup();
  }
});

test('a non-JSON login is still written back when it stays non-JSON (the validity check is relative to the original)', async () => {
  const f = await fixture();
  try {
    f.seed('opaque-token-v1');
    const start = snapshotFile(f.real);
    assert.equal(start?.json, false);
    fs.writeFileSync(f.run, 'opaque-token-v2');
    assert.equal(guardedLoginWriteBack({ realFile: f.real, runFile: f.run, startSnapshot: start, label: 't', log: () => {} }).status, 'written');
    assert.equal(fs.readFileSync(f.real, 'utf8'), 'opaque-token-v2');
  } finally {
    f.cleanup();
  }
});
