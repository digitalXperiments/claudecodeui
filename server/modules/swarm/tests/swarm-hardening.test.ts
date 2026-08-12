import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { makeScratchDir } from '@/shared/scratch.js';
import { swarmDb, redactSwarmText } from '@/modules/swarm/swarm.repository.js';

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await makeScratchDir('swarm-hardening-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await callback(root);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('swarm blackboard appends are durable, ordered, and redact secrets', async () => {
  await withDatabase(async (root) => {
    const project = projectsDb.createProjectPath(root).project;
    assert.ok(project);
    const swarm = swarmDb.create({
      projectId: project.project_id,
      goal: 'Test durable swarm messages',
      parentRunId: null,
      roles: [],
      status: 'running',
      approvalStatus: null,
    });

    const writes = Array.from({ length: 40 }, (_, index) =>
      Promise.resolve(
        swarmDb.appendMessage(swarm.swarm_id, {
          id: `message-${index}`,
          from: 'worker',
          kind: 'note',
          content: index === 7 ? 'token=super-secret-value' : `finding ${index}`,
          at: new Date().toISOString(),
        }),
      ),
    );
    await Promise.all(writes);

    const stored = swarmDb.get(swarm.swarm_id)!;
    assert.equal(stored.blackboard.length, 40);
    assert.deepEqual(
      stored.blackboard.map((message) => message.id),
      Array.from({ length: 40 }, (_, index) => `message-${index}`),
    );
    assert.ok(stored.blackboard.some((message) => message.content.includes('[REDACTED]')));
    assert.equal(swarmDb.listArtifacts(swarm.swarm_id).length, 0);
  });
});

test('swarm text redaction covers bearer and credential-shaped values', () => {
  const redacted = redactSwarmText(
    'Authorization: Bearer abc.def.ghi API_KEY=secret-value password=hunter2 ghp_1234567890abcdef',
  );
  assert.ok(!redacted.includes('abc.def.ghi'));
  assert.ok(!redacted.includes('secret-value'));
  assert.ok(!redacted.includes('hunter2'));
  assert.ok(!redacted.includes('1234567890abcdef'));
});
