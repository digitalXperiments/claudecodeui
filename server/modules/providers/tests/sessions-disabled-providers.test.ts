import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { setDisabledProviders } from '@/modules/auth-health/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { getEnabledProviderWatchPaths } from '@/modules/providers/services/sessions-watcher.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-disabled-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('watch paths exclude disabled providers (and re-include them when re-armed)', () => {
  const all = getEnabledProviderWatchPaths(new Set());
  assert.deepEqual(
    all.map((entry) => entry.provider).sort(),
    ['claude', 'codex', 'cursor', 'opencode', 'pi'],
  );

  // Recomputing with a disabled set is what a watcher re-arm does: the
  // disabled provider's watcher is dropped, the rest stay.
  const withoutClaude = getEnabledProviderWatchPaths(new Set(['claude']));
  assert.equal(withoutClaude.some((entry) => entry.provider === 'claude'), false);
  assert.equal(withoutClaude.length, all.length - 1);

  const reEnabled = getEnabledProviderWatchPaths(new Set());
  assert.equal(reEnabled.some((entry) => entry.provider === 'claude'), true);
});

test('synchronizeSessions skips providers disabled in Settings → Agents', async () => {
  await withIsolatedDatabase(async () => {
    const synchronized: string[] = [];
    const fakeProviders = (['claude', 'codex'] as LLMProvider[]).map((id) => ({
      id,
      sessionSynchronizer: {
        synchronize: async () => {
          synchronized.push(id);
          return 1;
        },
      },
    })) as unknown as IProvider[];

    const listMock = mock.method(providerRegistry, 'listProviders', () => fakeProviders);
    try {
      setDisabledProviders(['claude']);

      const result = await sessionSynchronizerService.synchronizeSessions();

      assert.deepEqual(synchronized, ['codex']);
      assert.equal(result.processedByProvider.claude, 0);
      assert.equal(result.processedByProvider.codex, 1);
      assert.deepEqual(result.failures, []);
    } finally {
      listMock.mock.restore();
    }
  });
});
