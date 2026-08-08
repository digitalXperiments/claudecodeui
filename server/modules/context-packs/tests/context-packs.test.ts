import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase, projectsDb, sessionsDb  } from '@/modules/database/index.js';
import { kanbanDb } from '@/modules/kanban/index.js';
import { runService } from '@/modules/runs/index.js';
import {
  attachPackToSession,
  attachPackToRun,
  compileContextPack,
  getContextPack,
} from '@/modules/context-packs/context-packs.service.js';

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('context-pack-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await callback(root);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('context packs rank project files, stay bounded, and attach to runs/sessions', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(path.join(projectPath, 'src'), { recursive: true });
    await writeFile(path.join(projectPath, 'src', 'checkout.ts'), 'export function checkoutPayment() { return "payment"; }\n');
    await writeFile(path.join(projectPath, 'README.md'), '# Checkout\nPayment and checkout flow.\n');
    await writeFile(path.join(projectPath, 'unrelated.ts'), 'export const unrelated = true;\n');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const board = kanbanDb.getOrCreateGlobalBoard();
    const task = kanbanDb.createTask({ boardId: board.board_id, projectId, title: 'Validate checkout payment', description: 'Add payment validation to checkout.' });
    const run = runService.create({ source: 'kanban', projectId, title: 'Checkout implementation' });
    const sessionId = 'session-context-pack-test';
    sessionsDb.createAppSession(sessionId, 'claude', projectPath);

    const pack = await compileContextPack({ projectId, goal: 'Implement checkout payment validation', taskId: task.task_id, budgetTokens: 512 });
    assert.equal(pack.project_id, projectId);
    assert.ok(pack.items.some((item) => item.uri.includes('checkout.ts')));
    assert.ok(pack.items.some((item) => item.kind === 'task'));
    assert.ok(pack.estimatedTokens <= 563, `pack exceeded budget tolerance: ${pack.estimatedTokens}`);
    assert.equal(getContextPack(pack.pack_id).pack_id, pack.pack_id);

    const runAttachment = attachPackToRun(pack.pack_id, run.run_id);
    assert.equal(runAttachment.run_id, run.run_id);
    assert.ok(runService.listEvents(run.run_id).some((event) => event.type === 'pack.attached'));
    const sessionAttachment = attachPackToSession(pack.pack_id, sessionId);
    assert.equal(sessionAttachment.session_id, sessionId);
  });
});
