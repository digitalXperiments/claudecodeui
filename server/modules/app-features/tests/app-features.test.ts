import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  getAppFeatures,
  isKanbanEnabled,
  updateAppFeatures,
} from '@/modules/app-features/app-features.service.js';

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('app-features-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await fn();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('kanban is enabled by default and can be hidden', async () => {
  await withTempDb(() => {
    assert.equal(isKanbanEnabled(), true);
    updateAppFeatures({ kanbanEnabled: false });
    assert.equal(isKanbanEnabled(), false);
    assert.equal(getAppFeatures().kanbanEnabled, false);
  });
});

test('spend caps persist and can be turned off', async () => {
  await withTempDb(() => {
    const defaults = getAppFeatures();
    assert.ok((defaults.spendSoftCostUsd ?? 0) > 0);
    updateAppFeatures({ spendSoftCostUsd: 40, spendHardCostUsd: null });
    const next = getAppFeatures();
    assert.equal(next.spendSoftCostUsd, 40);
    assert.equal(next.spendHardCostUsd, null);
  });
});
