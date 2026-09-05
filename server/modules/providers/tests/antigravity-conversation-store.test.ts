import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { makeScratchDir } from '@/shared/scratch.js';
import {
  antigravityConversationsDir,
  antigravityTitleFromPrompt,
  listAntigravityConversations,
  readAntigravityConversation,
  readUserPromptFromStep,
} from '@/modules/providers/list/antigravity/antigravity-conversation-store.js';

// --- protobuf writers, so fixtures are built the way the agent builds them ---

const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
};

const tag = (field: number, wire: number): Buffer => varint(field * 8 + wire);
const pbVarint = (field: number, value: number): Buffer => Buffer.concat([tag(field, 0), varint(value)]);
const pbBytes = (field: number, value: Buffer | string): Buffer => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
};

/** A type-14 (user input) step whose text sits at `19.2`, as 1.1.1 writes it. */
const userInputStep = (text: string): Buffer => Buffer.concat([
  pbVarint(1, 14),
  pbVarint(4, 3),
  pbBytes(5, Buffer.concat([pbBytes(12, 'session-id')])),
  pbBytes(19, Buffer.concat([
    pbBytes(2, text),
    pbBytes(3, pbBytes(1, text)),
  ])),
]);

/** A model step carrying a token record at `5.9`. */
const meteredStep = (input: number, output: number, cached: number): Buffer => Buffer.concat([
  pbVarint(1, 15),
  pbBytes(5, Buffer.concat([
    pbVarint(3, 2),
    pbBytes(9, Buffer.concat([pbVarint(2, input), pbVarint(3, output), pbVarint(5, cached)])),
  ])),
  pbBytes(20, pbBytes(6, 'gen-id')),
]);

const writeConversation = (
  dir: string,
  sessionId: string,
  steps: Array<{ stepType: number; payload: Buffer }>,
  meta: Record<string, unknown> | null = { cwd: '/repo' },
): void => {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `${sessionId}.db`));
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)');
  const insert = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)');
  steps.forEach((step, index) => insert.run(index, step.stepType, step.payload));
  db.close();
  if (meta) fs.writeFileSync(path.join(dir, `${sessionId}.meta`), JSON.stringify(meta));
};

const scratchEnv = (root: string): NodeJS.ProcessEnv => ({
  ...process.env,
  CLOUDCLI_ANTIGRAVITY_DIR: root,
});

describe('antigravity conversation store', () => {
  it('reads the first user prompt out of a type-14 step payload', () => {
    assert.equal(readUserPromptFromStep(userInputStep('Fix the login redirect')), 'Fix the login redirect');
  });

  it('ignores steps that are not user input', () => {
    assert.equal(readUserPromptFromStep(meteredStep(10, 2, 0)), null);
  });

  it('does not mistake random bytes for a prompt', () => {
    assert.equal(readUserPromptFromStep(Buffer.from([0xff, 0xff, 0xff, 0xff])), null);
  });

  it('summarizes a conversation with its title, cwd and step count', async () => {
    const root = await makeScratchDir('antigravity-store');
    const dir = antigravityConversationsDir(scratchEnv(root));
    writeConversation(dir, 'abc', [
      { stepType: 14, payload: userInputStep('  Investigate   the flaky test  ') },
      { stepType: 15, payload: meteredStep(1_000, 50, 0) },
      { stepType: 15, payload: meteredStep(2_000, 25, 900) },
    ], { cwd: '/repo/app' });

    const summary = readAntigravityConversation('abc', scratchEnv(root));
    assert.ok(summary);
    assert.equal(summary.cwd, '/repo/app');
    assert.equal(antigravityTitleFromPrompt(summary.firstPrompt), 'Investigate the flaky test');
    assert.equal(summary.stepCount, 3);
  });

  it('still reports cwd and mtime when the database cannot be opened', async () => {
    const root = await makeScratchDir('antigravity-store-broken');
    const dir = antigravityConversationsDir(scratchEnv(root));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.db'), 'not a database');
    fs.writeFileSync(path.join(dir, 'broken.meta'), JSON.stringify({ cwd: '/repo' }));

    const summary = readAntigravityConversation('broken', scratchEnv(root));
    assert.ok(summary);
    assert.equal(summary.cwd, '/repo');
    assert.equal(summary.firstPrompt, null);
    assert.equal(summary.stepCount, 0);
  });

  it('returns null for a session that has no store on disk', async () => {
    const root = await makeScratchDir('antigravity-store-missing');
    assert.equal(readAntigravityConversation('nope', scratchEnv(root)), null);
  });

  it('strips the images_input plumbing tag out of a title', () => {
    assert.equal(
      antigravityTitleFromPrompt('Compare these\n<images_input>/tmp/a.png</images_input>'),
      'Compare these',
    );
  });

  it('lists conversations newest first and honours the since filter', async () => {
    const root = await makeScratchDir('antigravity-store-list');
    const dir = antigravityConversationsDir(scratchEnv(root));
    writeConversation(dir, 'older', [{ stepType: 14, payload: userInputStep('older work') }]);
    writeConversation(dir, 'newer', [{ stepType: 14, payload: userInputStep('newer work') }]);

    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, 'older.db'), old, old);

    const all = listAntigravityConversations(scratchEnv(root));
    assert.deepEqual(all.map((entry) => entry.sessionId), ['newer', 'older']);

    const recent = listAntigravityConversations(scratchEnv(root), {
      since: new Date(Date.now() - 60 * 1000),
    });
    assert.deepEqual(recent.map((entry) => entry.sessionId), ['newer']);
  });

  it('reads the title from the first user step even when later steps precede it in type order', async () => {
    const root = await makeScratchDir('antigravity-store-titles');
    const dir = antigravityConversationsDir(scratchEnv(root));
    writeConversation(dir, 'abc', [
      { stepType: 15, payload: meteredStep(1_000, 50, 0) },
      { stepType: 14, payload: userInputStep('Title me') },
    ]);

    const summary = readAntigravityConversation('abc', scratchEnv(root));
    assert.equal(antigravityTitleFromPrompt(summary?.firstPrompt ?? null), 'Title me');
  });
});
