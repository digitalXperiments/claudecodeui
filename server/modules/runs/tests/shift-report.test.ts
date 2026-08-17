import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { collectShiftReport, formatShiftReport, publishShiftReport } from '@/modules/runs/shift-report.service.js';

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('shift-report-');
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

test('collectShiftReport is empty on a fresh database', async () => {
  await withTempDb(() => {
    const report = collectShiftReport();
    assert.equal(report.prs.length, 0);
    assert.equal(report.waiting, 0);
    assert.equal(report.spendUsd, 0);
    const formatted = formatShiftReport(report);
    assert.match(formatted.title, /Shift report/);
  });
});

test('publishShiftReport no-ops outside the 9am window', async () => {
  await withTempDb(() => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    assert.equal(publishShiftReport(noon), null);
  });
});
