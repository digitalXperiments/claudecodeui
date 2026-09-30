import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, scanStateDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import {
  clearDisplayNameCache,
  generateDisplayName,
  getProjectsWithSessions,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

async function withIsolatedDatabase(runTest: (tempDirectory: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-fetch-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  clearDisplayNameCache();
  try {
    await runTest(tempDirectory);
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

type SyncResult = Awaited<ReturnType<typeof sessionSynchronizerService.synchronizeSessions>>;

function mockSync() {
  return mock.method(sessionSynchronizerService, 'synchronizeSessions', async () => ({
    processedByProvider: {},
    failures: [],
  }) as unknown as SyncResult);
}

test('project list is DB-only by default and only rescans when asked (or never scanned)', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const syncMock = mockSync();
    try {
      const projectPath = path.join(tempDirectory, 'alpha');
      await mkdir(projectPath);
      projectsDb.createProjectPath(projectPath);

      // Never scanned yet: the first request populates the index.
      await getProjectsWithSessions();
      assert.equal(syncMock.mock.callCount(), 1);

      scanStateDb.updateLastScannedAt(new Date());
      const projects = await getProjectsWithSessions();
      assert.equal(syncMock.mock.callCount(), 1, 'default read must not rescan');
      assert.equal(projects.length, 1);
      assert.equal(projects[0].displayName, 'alpha');

      await getProjectsWithSessions({ synchronize: true });
      assert.equal(syncMock.mock.callCount(), 2);

      await getProjectsWithSessions({ synchronize: true, skipSynchronization: true });
      assert.equal(syncMock.mock.callCount(), 2, 'skipSynchronization always wins');
    } finally {
      syncMock.mock.restore();
    }
  });
});

test('display names come from package.json and are revalidated by its mtime', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const projectPath = path.join(tempDirectory, 'beta');
    await mkdir(projectPath);
    const packageJsonPath = path.join(projectPath, 'package.json');

    assert.equal(await generateDisplayName('beta', projectPath), 'beta');

    await writeFile(packageJsonPath, JSON.stringify({ name: 'beta-pkg' }));
    assert.equal(await generateDisplayName('beta', projectPath), 'beta-pkg');

    // Rewritten package.json with a new mtime is picked up.
    await writeFile(packageJsonPath, JSON.stringify({ name: 'beta-renamed' }));
    const later = new Date(Date.now() + 5_000);
    await utimes(packageJsonPath, later, later);
    assert.equal(await generateDisplayName('beta', projectPath), 'beta-renamed');

    await rm(packageJsonPath);
    assert.equal(await generateDisplayName('beta', projectPath), 'beta');
  });
});

test('project rows keep DB order and custom names across the concurrent name lookup', async () => {
  await withIsolatedDatabase(async (tempDirectory) => {
    const syncMock = mockSync();
    try {
      scanStateDb.updateLastScannedAt(new Date());
      const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
      for (const name of names) {
        const projectPath = path.join(tempDirectory, name);
        await mkdir(projectPath);
        projectsDb.createProjectPath(projectPath, name === 'p3' ? 'Custom Three' : null);
      }
      const expectedOrder = (projectsDb.getProjectPaths() as Array<{ project_path: string }>).map((row) => row.project_path);

      const projects = await getProjectsWithSessions();
      assert.deepEqual(projects.map((project) => project.path), expectedOrder);
      const three = projects.find((project) => project.path.endsWith(`${path.sep}p3`));
      assert.equal(three?.displayName, 'Custom Three');
      assert.equal(syncMock.mock.callCount(), 0);
    } finally {
      syncMock.mock.restore();
    }
  });
});
