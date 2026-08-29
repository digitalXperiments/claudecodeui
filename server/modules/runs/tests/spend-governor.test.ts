import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const OPUS_FABLE_RE = /\b(opus|fable)\b/i;

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { updateAppFeatures } from '@/modules/app-features/index.js';
import {
  downgradeModelForSoftCap,
  evaluateSpend,
} from '@/modules/runs/index.js';

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('spend-gov-');
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

test('evaluateSpend trips soft then hard', async () => {
  await withTempDb(() => {
    updateAppFeatures({ spendSoftCostUsd: 50, spendHardCostUsd: 100 });
    assert.deepEqual(evaluateSpend(10), {
      spentUsd: 10,
      softUsd: 50,
      hardUsd: 100,
      soft: false,
      hard: false,
    });
    assert.equal(evaluateSpend(50).soft, true);
    assert.equal(evaluateSpend(50).hard, false);
    assert.equal(evaluateSpend(100).hard, true);
  });
});

test('downgradeModelForSoftCap cheapens opus and fable to sonnet', () => {
  // Primary path resolves through the Model Capability Registry, which returns
  // canonical provider-qualified model ids; the regex fallback only fires when
  // the registry is unavailable. Either way the downgrade must land on a
  // cheaper Claude tier, never on opus/fable.
  for (const expensive of ['opus', 'opus[1m]', 'fable']) {
    const downgraded = downgradeModelForSoftCap(expensive);
    assert.ok(downgraded != null && /sonnet/i.test(downgraded), `${expensive} -> ${downgraded}`);
    assert.equal(OPUS_FABLE_RE.test(downgraded), false, `${expensive} -> ${downgraded}`);
  }
});
