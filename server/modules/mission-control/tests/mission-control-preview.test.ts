import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { configureMissionControlRuntimes } from '@/modules/mission-control/mission-control-agent.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { previewItemResolution } from '@/modules/mission-control/mission-control-runner.service.js';
import type { McSection } from '@/modules/mission-control/mission-control.types.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

type Writer = {
  send: (event: AnyRecord) => void;
  sendComplete: (event: AnyRecord) => void;
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-preview-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'preview.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    configureMissionControlRuntimes({});
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Installs a fake claude runtime, capturing the prompt for assertions. */
function stubClaudeRuntime(output: string, exitCode: number, errorText?: string): { prompts: string[] } {
  const prompts: string[] = [];
  configureMissionControlRuntimes({
    claude: async (command: string, _options: AnyRecord, writer: unknown) => {
      const w = writer as Writer;
      prompts.push(command);
      if (errorText) {
        w.send({ kind: 'error', provider: 'claude', content: errorText });
      }
      w.send({ kind: 'text', provider: 'claude', content: output });
      w.sendComplete({ exitCode });
    },
  });
  return { prompts };
}

function seedSection(overrides: Partial<McSection> = {}): McSection {
  return missionControlDb.createSection({
    title: 'Jira Drafts',
    mode: 'review',
    provider: 'claude',
    produce_prompt: 'Produce drafts.',
    resolve_prompt: '',
    ...overrides,
  });
}

function insertItem(section: McSection, body: Record<string, unknown> = { approved: true }) {
  const item = missionControlDb.insertItemIfNew(section, {
    title: 'Fix checkout',
    summary: 's',
    body,
    dedupeKey: 'k1',
    confidence: 0.9,
  });
  assert.ok(item);
  return item;
}

test('preview with no resolve prompt returns the static approved body', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = insertItem(section, { fix: 'cart null check' });

    const result = await previewItemResolution(item.item_id);

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.type, 'static');
      assert.equal(result.preview.approved, true);
      assert.deepEqual(result.preview.body, { fix: 'cart null check' });
    }
    // Item untouched.
    const stored = missionControlDb.getItem(item.item_id);
    assert.equal(stored?.status, 'pending');
    assert.equal(stored?.error, null);
  });
});

test('preview with no resolve prompt honours an edited body', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = insertItem(section, { fix: 'cart null check' });

    const result = await previewItemResolution(item.item_id, undefined, { fix: 'edited fix' });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.type, 'static');
      assert.deepEqual(result.preview.body, { fix: 'edited fix' });
    }
    const stored = missionControlDb.getItem(item.item_id);
    assert.deepEqual(stored?.body, { fix: 'cart null check' });
  });
});

test('preview on a dry-run section is static even with a resolve prompt', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection({ resolve_prompt: 'Post the article', dry_run: true });
    const item = insertItem(section);

    const result = await previewItemResolution(item.item_id);

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.type, 'static');
      assert.equal(result.preview.approved, true);
    }
  });
});

test('preview with a resolve prompt runs the agent read-only and returns parsed JSON', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection({ resolve_prompt: 'Polish the article.' });
    const item = insertItem(section, { kind: 'x_article', blocks: [] });

    const stub = stubClaudeRuntime(
      JSON.stringify({ rewritten: true, blocks: [{ type: 'p', text: 'better' }] }),
      0,
    );

    const result = await previewItemResolution(item.item_id, 'approve');

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.type, 'agent');
      assert.equal(result.preview.rewritten, true);
      assert.deepEqual(result.preview.blocks, [{ type: 'p', text: 'better' }]);
    }
    // The agent was told this is read-only.
    assert.match(stub.prompts[0] ?? '', /READ-ONLY preview/);
    // Item untouched.
    const stored = missionControlDb.getItem(item.item_id);
    assert.equal(stored?.status, 'pending');
    assert.equal(stored?.error, null);
    assert.equal(stored?.result, null);
  });
});

test('preview defaults to the first terminal approve action', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection({ resolve_prompt: 'Resolve it.' });
    const item = insertItem(section);

    const stub = stubClaudeRuntime(JSON.stringify({ done: true }), 0);

    const result = await previewItemResolution(item.item_id);

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.type, 'agent');
      assert.equal(result.preview.done, true);
    }
    assert.match(stub.prompts[0] ?? '', /"approve" \(Approve\)/);
  });
});

test('preview with a failing agent returns success:false and does not change status', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection({ resolve_prompt: 'Post the article.' });
    const item = insertItem(section);

    stubClaudeRuntime('', 1, 'Claude Code returned an error result: API unreachable');

    const result = await previewItemResolution(item.item_id, 'approve');

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error, /API unreachable/);
    }
    const stored = missionControlDb.getItem(item.item_id);
    assert.equal(stored?.status, 'pending');
    assert.equal(stored?.error, null);
  });
});

test('preview on a resolving item errors', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = insertItem(section);
    missionControlDb.setItemStatus(item.item_id, 'resolving', { body: item.body });

    await assert.rejects(() => previewItemResolution(item.item_id), /not actionable/);
  });
});

test('preview with an unknown action id errors', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = insertItem(section);

    await assert.rejects(() => previewItemResolution(item.item_id, 'nope'), /not on item/);
  });
});
