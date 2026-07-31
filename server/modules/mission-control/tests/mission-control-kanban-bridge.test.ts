import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { applyItemAction } from '@/modules/mission-control/mission-control-runner.service.js';
import { kanbanDb, COLUMN_BACKLOG } from '@/modules/kanban/index.js';
import type { McSection } from '@/modules/mission-control/mission-control.types.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-kanban-bridge-'));
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

// A review section with no resolve prompt: Approve resolves immediately (no agent
// run), which is enough to exercise the kanban bridge.
function seedSection(overrides: Partial<McSection> = {}) {
  return missionControlDb.createSection({
    title: 'Jira drafts',
    mode: 'review',
    provider: 'claude',
    resolve_prompt: '',
    create_kanban_task: true,
    kanban_assignee_provider: 'claude',
    ...overrides,
  });
}

test('approve bridges an item to a global-board backlog card', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Fix checkout bug',
      summary: 'Users cannot pay',
      body: {
        steps: ['Reproduce payment failure', 'Fix null cart id'],
        acceptanceCriteria: ['Checkout completes with valid card'],
        severity: 'high',
      },
      dedupeKey: 'k1',
    });
    assert.ok(item);

    const resolved = await applyItemAction(item.item_id, 'approve');
    assert.ok(resolved);
    assert.equal(resolved.status, 'resolved');
    const taskId = resolved.result?.kanbanTaskId;
    assert.equal(typeof taskId, 'string');

    const board = kanbanDb.getOrCreateGlobalBoard();
    const tasks = kanbanDb.listTasksByBoard(board.board_id);
    assert.equal(tasks.length, 1);
    const card = tasks[0];
    assert.equal(card.task_id, taskId);
    assert.equal(card.title, 'Fix checkout bug');
    assert.equal(card.column_id, COLUMN_BACKLOG);
    assert.equal(card.assignee_provider, 'claude');
    // No project attached yet — the user picks one before moving to In Progress.
    assert.equal(card.project_id, '');

    // Description should be exhaustive: summary, body fields, metadata.
    assert.match(card.description, /## Summary/);
    assert.match(card.description, /Users cannot pay/);
    assert.match(card.description, /## Details/);
    assert.match(card.description, /Acceptance Criteria/);
    assert.match(card.description, /Checkout completes with valid card/);
    assert.match(card.description, /## Metadata/);
    assert.match(card.description, /Jira drafts/);

    // Prompt is generated at create time for the implementer agent.
    assert.ok(card.prompt.trim().length > 0);
    assert.match(card.prompt, /Fix checkout bug/);
    assert.match(card.prompt, /## Your job/);
    assert.match(card.prompt, /Requirements \/ context/);
  });
});

test('bridge uses explicit body.prompt when produce supplied one', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection();
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Add dark mode',
      summary: 'Theme toggle',
      body: {
        prompt: 'Implement a dark-mode toggle in settings and persist the preference.',
        notes: 'Use existing CSS variables.',
      },
      dedupeKey: 'k-prompt',
    });
    assert.ok(item);

    const resolved = await applyItemAction(item.item_id, 'approve');
    const taskId = resolved?.result?.kanbanTaskId as string;
    assert.ok(taskId);
    const card = kanbanDb.getTask(taskId);
    assert.ok(card);
    assert.match(card.prompt, /Implement a dark-mode toggle/);
    assert.match(card.prompt, /Add dark mode/);
    // Explicit prompt body field is not duplicated under Details.
    assert.doesNotMatch(card.description, /\*\*Prompt:\*\*/);
    assert.match(card.description, /Use existing CSS variables/);
  });
});

test('bridge attaches section kanban MCP tools to the card', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection({
      kanban_mcp_tools: ['leong_associates_mcp', 'Composio'],
    });
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'Platform work',
      summary: 'Needs client MCP',
      body: {},
      dedupeKey: 'k-mcp',
    });
    assert.ok(item);

    const resolved = await applyItemAction(item.item_id, 'approve');
    const taskId = resolved?.result?.kanbanTaskId as string;
    assert.ok(taskId);
    const card = kanbanDb.getTask(taskId);
    assert.ok(card);
    assert.deepEqual(card.tools.mcpServers, ['leong_associates_mcp', 'Composio']);
  });
});

test('approve does not create a card when the bridge is disabled', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedSection({ create_kanban_task: false });
    const item = missionControlDb.insertItemIfNew(section, {
      title: 'No bridge',
      summary: '',
      body: {},
      dedupeKey: 'k2',
    });
    assert.ok(item);

    const resolved = await applyItemAction(item.item_id, 'approve');
    assert.equal(resolved?.status, 'resolved');
    assert.equal(resolved?.result?.kanbanTaskId, undefined);

    const board = kanbanDb.getOrCreateGlobalBoard();
    assert.equal(kanbanDb.listTasksByBoard(board.board_id).length, 0);
  });
});
