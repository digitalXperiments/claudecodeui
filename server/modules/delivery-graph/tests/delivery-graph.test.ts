import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { kanbanDb } from '@/modules/kanban/index.js';
import {
  applyDeliveryGraph,
  generateDeliveryGraph,
  importTaskMasterTasks,
} from '@/modules/delivery-graph/delivery-graph.service.js';

async function withDatabase(callback: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.resolve('tmp/cloudcli/delivery-graph-'));
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

test('generates a structured graph and applies dependencies idempotently', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      path.join(projectPath, 'prd.md'),
      '# Checkout\n\n## Requirements\n- Support guest checkout\n- Validate payment\n\n## Acceptance Criteria\n- A guest can place an order\n\n## Build API\n- Add endpoint\n\n## Build UI\n- Add form\n',
    );
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const generated = await generateDeliveryGraph({ projectId, prdPath: 'prd.md' });
    assert.equal(generated.graph.version, 1);
    assert.equal(generated.graph.tasks.length, 2);
    assert.ok(generated.graph.requirements.length >= 2);

    generated.graph.tasks[1].dependsOn = [generated.graph.tasks[0].tempId];
    const board = kanbanDb.getOrCreateGlobalBoard();
    const first = applyDeliveryGraph({ projectId, graph: generated.graph, boardId: board.board_id });
    assert.equal(first.created.length, 2);
    assert.equal(first.dependencies.length, 1);
    const second = applyDeliveryGraph({ projectId, graph: generated.graph, boardId: board.board_id });
    assert.equal(second.created.length, 0);
    assert.equal(second.reused.length, 2);
    assert.equal(kanbanDb.listTasksByBoard(board.board_id).length, 2);
  });
});

test('TaskMaster import provides a dry-run and preserves dependencies/subtasks', async () => {
  await withDatabase(async (root) => {
    const projectPath = path.join(root, 'project');
    await mkdir(path.join(projectPath, '.taskmaster', 'tasks'), { recursive: true });
    await writeFile(
      path.join(projectPath, '.taskmaster', 'tasks', 'tasks.json'),
      JSON.stringify({ master: { tasks: [
        { id: 1, title: 'Build API', status: 'done', dependencies: [], details: 'API details' },
        { id: 2, title: 'Build UI', status: 'pending', dependencies: [1], subtasks: [{ id: 1, title: 'Add form', status: 'pending' }] },
      ] } }),
    );
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    const board = kanbanDb.getOrCreateGlobalBoard();
    const preview = await importTaskMasterTasks({ projectId, boardId: board.board_id, dryRun: true });
    assert.equal(preview.total, 3);
    assert.equal(preview.wouldCreate, 3);
    assert.equal(kanbanDb.listTasksByBoard(board.board_id).length, 0);

    const imported = await importTaskMasterTasks({ projectId, boardId: board.board_id });
    assert.equal(imported.created.length, 3);
    assert.ok(imported.dependencies.some((dependency) => dependency.dependsOnSourceId === '1'));
    assert.equal(kanbanDb.listTasksByBoard(board.board_id).length, 3);
    const done = kanbanDb.listTasksByBoard(board.board_id).find((task) => task.title === 'Build API');
    assert.equal(done?.status, 'done');
  });
});
