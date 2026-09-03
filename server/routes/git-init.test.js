import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { closeConnection } from '../modules/database/connection.js';
import { initializeDatabase } from '../modules/database/init-db.js';
import { projectsDb } from '../modules/database/repositories/projects.db.js';
import gitRoutes from './git.js';

const testTempRoot = path.join(process.cwd(), 'tmp', 'cloudcli');

async function withGitInitServer(run) {
  const app = express();
  app.use(express.json());
  app.use(gitRoutes);

  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postJson(baseUrl, body) {
  return fetch(`${baseUrl}/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withIsolatedDatabase(run) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  await mkdir(testTempRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(testTempRoot, 'git-init-route-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await run(temporaryDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('POST /init initializes the registered project path as a git repository', async () => {
  await withIsolatedDatabase(async (temporaryDirectory) => {
    const projectPath = path.join(temporaryDirectory, 'project');
    await mkdir(projectPath);
    const created = projectsDb.createProjectPath(projectPath);
    assert.ok(created.project);

    await withGitInitServer(async (baseUrl) => {
      const response = await postJson(baseUrl, { project: created.project.project_id });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.message, 'Git repository initialized successfully');
      await access(path.join(projectPath, '.git'));
    });
  });
});

test('POST /init rejects missing projects and paths outside the workspace policy', async () => {
  await withIsolatedDatabase(async () => {
    const outsideWorkspace = projectsDb.createProjectPath('/etc');
    assert.ok(outsideWorkspace.project);

    await withGitInitServer(async (baseUrl) => {
      const missingProjectResponse = await postJson(baseUrl, {});
      assert.equal(missingProjectResponse.status, 400);
      assert.deepEqual(await missingProjectResponse.json(), { error: 'Project id is required' });

      const outsideWorkspaceResponse = await postJson(baseUrl, {
        project: outsideWorkspace.project.project_id,
      });
      const payload = await outsideWorkspaceResponse.json();
      assert.equal(outsideWorkspaceResponse.status, 403);
      assert.match(payload.error, /system-critical|allowed workspace root/i);
    });
  });
});
