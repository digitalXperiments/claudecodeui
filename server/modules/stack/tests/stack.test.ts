import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { configureSecretsKeyDir } from '@/modules/secrets/index.js';
import { stackService } from '@/modules/stack/stack.service.js';

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.resolve('tmp/cloudcli/stack-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  const previousKey = process.env.CLOUDCLI_SECRETS_KEY;
  process.env.CLOUDCLI_SECRETS_KEY = randomBytes(32).toString('base64');
  configureSecretsKeyDir(path.join(root, 'secrets'));
  await initializeDatabase();
  try {
    await callback(root);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousKey === undefined) delete process.env.CLOUDCLI_SECRETS_KEY;
    else process.env.CLOUDCLI_SECRETS_KEY = previousKey;
    configureSecretsKeyDir(null);
    await rm(root, { recursive: true, force: true });
  }
}

test('stack apply writes a capsule, doctor reports missing refs, and export stays redacted', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const config = {
      version: 1,
      project: 'stack-test',
      providers: { required: [], optional: [] },
      mcp: [{ name: 'obsidian', env: { OBSIDIAN_API_KEY: 'actual-secret-value' } }],
      health: { auth: [], mcp: [] },
      ship: { test: { command: 'npm test' } },
      notifications: { channel: 'local' },
      credentials: { tokenRef: '${secret:MISSING_TOKEN}' },
    };
    const applied = await stackService.apply(projectId, config);
    assert.equal(applied.applied, true);
    assert.equal(applied.document.exists, true);
    assert.match(await readFile(path.join(projectPath, '.gitignore'), 'utf8'), /\.cloudcli\/worktrees/);
    assert.match(await readFile(path.join(projectPath, '.cloudcli', 'stack.yaml'), 'utf8'), /project: stack-test/);

    const failed = await stackService.doctor(projectId);
    assert.equal(failed.ok, false);
    assert.ok(failed.interruptIds.length > 0);
    assert.ok(failed.checks.some((check) => check.id === 'secrets' && check.status === 'fail'));

    secretsService.put({ name: 'MISSING_TOKEN', value: 'stored-but-never-exported' });
    const healthy = await stackService.doctor(projectId, { createInterrupts: false });
    assert.equal(healthy.checks.find((check) => check.id === 'secrets')?.status, 'pass');

    const exported = await stackService.export(projectId);
    assert.equal(exported.format, 'yaml');
    assert.doesNotMatch(exported.yaml, /actual-secret-value|stored-but-never-exported/);
    assert.match(exported.yaml, /\$\{secret:MISSING_TOKEN\}/);
  });
});
