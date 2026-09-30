import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { setDisabledProviders } from '@/modules/auth-health/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import type { IProvider } from '@/shared/interfaces.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-coalesce-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('concurrent full syncs never run in parallel and collapse into one follow-up pass', async () => {
  await withIsolatedDatabase(async () => {
    setDisabledProviders([]);
    let running = 0;
    let maxRunning = 0;
    let passes = 0;
    const gates: Array<() => void> = [];

    const fakeProviders = [{
      id: 'claude',
      sessionSynchronizer: {
        synchronize: async () => {
          running += 1;
          passes += 1;
          maxRunning = Math.max(maxRunning, running);
          await new Promise<void>((resolve) => gates.push(resolve));
          running -= 1;
          return 1;
        },
      },
    }] as unknown as IProvider[];

    const listMock = mock.method(providerRegistry, 'listProviders', () => fakeProviders);
    try {
      const first = sessionSynchronizerService.synchronizeSessions();
      // Arrive while the first scan runs: all share ONE queued follow-up.
      const second = sessionSynchronizerService.synchronizeSessions();
      const third = sessionSynchronizerService.synchronizeSessions();
      assert.equal(second, third);
      assert.equal(sessionSynchronizerService.isFullSyncInFlight(), true);

      // Let the first pass start and finish.
      while (gates.length === 0) await new Promise((resolve) => setImmediate(resolve));
      gates.shift()!();
      await first;

      // The follow-up starts only after the first settled.
      while (gates.length === 0) await new Promise((resolve) => setImmediate(resolve));
      gates.shift()!();
      await Promise.all([second, third]);

      assert.equal(passes, 2);
      assert.equal(maxRunning, 1);
      assert.equal(sessionSynchronizerService.isFullSyncInFlight(), false);
    } finally {
      listMock.mock.restore();
    }
  });
});
