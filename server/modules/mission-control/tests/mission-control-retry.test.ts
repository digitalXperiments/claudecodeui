import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { configureMissionControlRuntimes } from '@/modules/mission-control/mission-control-agent.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { retryItem } from '@/modules/mission-control/mission-control-runner.service.js';
import type { McSection } from '@/modules/mission-control/mission-control.types.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

type Writer = {
  send: (event: AnyRecord) => void;
  sendComplete: (event: AnyRecord) => void;
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-retry-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'retry.db');
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

/** Installs a fake claude runtime that emits `output` then exits with `exitCode`. */
function stubClaudeRuntime(output: string, exitCode: number, errorText?: string): void {
  configureMissionControlRuntimes({
    claude: async (_command: string, _options: AnyRecord, writer: unknown) => {
      const w = writer as Writer;
      if (errorText) {
        w.send({ kind: 'error', provider: 'claude', content: errorText });
      }
      w.send({ kind: 'text', provider: 'claude', content: output });
      w.sendComplete({ exitCode });
    },
  });
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

test('retryItem resets a failed item to pending with the refreshed body', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Old title',
      summary: 'old',
      body: { version: 1 },
      dedupeKey: 'k1',
      confidence: 0.5,
    });
    assert.ok(item);
    missionControlDb.setItemStatus(item.item_id, 'failed', { error: 'boom' });

    stubClaudeRuntime(
      JSON.stringify([
        { title: 'Fresh title', summary: 'new', body: { version: 2 }, dedupeKey: 'k1', confidence: 0.95 },
      ]),
      0,
    );

    const result = await retryItem(item.item_id);

    assert.equal(result.success, true);
    assert.equal(result.item.status, 'pending');
    assert.equal(result.item.error, null);
    assert.deepEqual(result.item.body, { version: 2 });
    assert.equal(result.item.title, 'Fresh title');
    assert.equal(result.item.summary, 'new');
    assert.equal(result.item.confidence, 0.95);
  });
});

test('retryItem refreshes a pending item in place by title match', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Same story',
      summary: 'old',
      body: { draft: 'v1' },
      dedupeKey: 'k2',
      confidence: 0.4,
    });
    assert.ok(item);

    // Same title but a different dedupe key: must still match by title.
    stubClaudeRuntime(
      JSON.stringify([
        { title: 'Same story', summary: 'better', body: { draft: 'v2' }, dedupeKey: 'k2-renamed', confidence: 0.8 },
      ]),
      0,
    );

    const result = await retryItem(item.item_id);

    assert.equal(result.success, true);
    assert.equal(result.item.status, 'pending');
    assert.deepEqual(result.item.body, { draft: 'v2' });
    assert.equal(result.item.summary, 'better');
  });
});

test('retryItem keeps a failed item failed with the error when the produce run fails', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Will fail',
      summary: '',
      body: { version: 1 },
      dedupeKey: 'k3',
      confidence: 0.5,
    });
    assert.ok(item);
    missionControlDb.setItemStatus(item.item_id, 'failed', { error: 'original error' });

    stubClaudeRuntime('', 1, 'Claude Code returned an error result: API unreachable');

    const result = await retryItem(item.item_id);

    assert.equal(result.success, false);
    assert.equal(result.item.status, 'failed');
    assert.match(result.error ?? '', /API unreachable/);
  });
});

test('retryItem with no matching draft keeps the item unchanged', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Story A',
      summary: 's',
      body: { draft: 'v1' },
      dedupeKey: 'k4',
      confidence: 0.5,
    });
    assert.ok(item);

    // A completely different story comes back: nothing to apply.
    stubClaudeRuntime(
      JSON.stringify([
        { title: 'Story B', summary: 'other', body: { draft: 'v9' }, dedupeKey: 'k5', confidence: 0.9 },
      ]),
      0,
    );

    const result = await retryItem(item.item_id);

    assert.equal(result.success, false);
    assert.equal(result.error, 'Retry produced no matching item');
    const kept = missionControlDb.getItem(item.item_id);
    assert.equal(kept?.status, 'pending');
    assert.deepEqual(kept?.body, { draft: 'v1' });
  });
});

test('retryItem with an unavailable runtime marks the item failed', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection({ provider: 'grok' });
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'No runtime',
      summary: '',
      body: {},
      dedupeKey: 'k6',
      confidence: 0.5,
    });
    assert.ok(item);
    missionControlDb.setItemStatus(item.item_id, 'failed', { error: 'original error' });

    // No grok spawn fn installed: runMissionControlAgent throws.
    const result = await retryItem(item.item_id);

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /runtime is not available/i);
    assert.equal(result.item.status, 'failed');
  });
});

test('retryItem throws on a non-retryable status', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Resolved',
      summary: '',
      body: {},
      dedupeKey: 'k7',
      confidence: 0.5,
    });
    assert.ok(item);
    missionControlDb.setItemStatus(item.item_id, 'resolved', {
      result: { approved: true },
      resolvedAt: new Date().toISOString(),
    });

    await assert.rejects(() => retryItem(item.item_id), /not retryable/);
  });
});

test('retryItem throws 404 when the item is missing', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(() => retryItem('missing-item'), /Item not found/);
  });
});
