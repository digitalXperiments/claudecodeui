import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  agentRunProfilesDb,
  closeConnection,
  compilePermissionIntent,
  initializeDatabase,
  projectsDb,
  systemNotificationsDb,
} from '@/modules/database/index.js';
import {
  configureKanbanRuntimes,
  initKanbanAutomation,
  kanbanDb,
  kanbanRunner,
  stopKanbanAutomation,
} from '@/modules/kanban/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

test('compilePermissionIntent maps plain English to allow/deny rules', () => {
  const compiled = compilePermissionIntent(
    'Allow git and npm tests; read project files; deny rm and network',
  );
  assert.ok(compiled.allowedCommands.some((r) => r.includes('git')));
  assert.ok(compiled.allowedCommands.some((r) => r.includes('npm') || r === 'Read'));
  assert.ok(compiled.disallowedCommands.some((r) => r.includes('rm')));
  assert.ok(compiled.disallowedCommands.some((r) => r.includes('curl') || r === 'WebFetch'));
});

test('agent run profiles CRUD + seed + kanban run resolves model/effort', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'agent-profiles-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const seeded = agentRunProfilesDb.ensureSeedProfiles();
    assert.ok(seeded.length >= 3, 'should seed starter profiles');
    // Second call must not duplicate.
    assert.equal(agentRunProfilesDb.ensureSeedProfiles().length, seeded.length);

    const profile = agentRunProfilesDb.create({
      name: 'Grok Low Effort',
      provider: 'grok',
      model: 'grok-code-fast-1',
      effort: 'low',
      permissionMode: 'default',
      permissionIntent: 'Allow git; deny rm',
      tools: {
        allowedCommands: ['Bash(git*)'],
        disallowedCommands: ['Bash(rm*)'],
      },
    });
    assert.equal(profile.name, 'Grok Low Effort');
    assert.equal(profile.model, 'grok-code-fast-1');
    assert.equal(profile.effort, 'low');

    const updated = agentRunProfilesDb.update(profile.profile_id, {
      effort: 'high',
      name: 'Grok High Effort',
    });
    assert.equal(updated?.effort, 'high');
    assert.equal(updated?.name, 'Grok High Effort');

    const projectId = projectsDb.createProjectPath(tempDirectory).project!.project_id;
    const board = kanbanDb.createBoard({ projectId, name: 'Board' });

    let seenOptions: AnyRecord = {};
    let ran = false;
    configureKanbanRuntimes({
      grok: async (_content, options, writer) => {
        seenOptions = options;
        ran = true;
        (writer as { send: (m: AnyRecord) => void }).send({
          kind: 'complete',
          provider: 'grok' as LLMProvider,
          exitCode: 0,
          success: true,
        });
      },
    });
    chatRunRegistry.clearAll();
    const dispose = initKanbanAutomation();

    try {
      const task = kanbanDb.createTask({
        boardId: board.board_id,
        projectId,
        title: 'Profile run',
        prompt: 'do work',
        assigneeProvider: 'grok',
        implementProfileId: profile.profile_id,
        permissionMode: 'bypassPermissions', // task-level should be overridden by profile
      });

      await kanbanRunner.runTask(task.task_id, 'manual');
      assert.equal(ran, true, 'runtime should have been called');
      assert.equal(seenOptions.model, 'grok-code-fast-1');
      assert.equal(seenOptions.effort, 'high');
      assert.equal(seenOptions.permissionMode, 'default');
      const toolsSettings = seenOptions.toolsSettings as Record<string, unknown>;
      assert.deepEqual(toolsSettings.allowedCommands, ['Bash(git*)']);
      assert.deepEqual(toolsSettings.disallowedCommands, ['Bash(rm*)']);
    } finally {
      dispose();
      stopKanbanAutomation();
      chatRunRegistry.clearAll();
    }

    // Inbox notifications API surface
    const note = systemNotificationsDb.create({
      kind: 'run_failed',
      severity: 'error',
      title: 'Test fail',
      body: 'body',
      source: 'kanban',
      dedupeKey: 'test-1',
    });
    assert.equal(systemNotificationsDb.unreadCount(), 1);
    systemNotificationsDb.markRead(note.notification_id);
    assert.equal(systemNotificationsDb.unreadCount(), 0);

    assert.ok(agentRunProfilesDb.delete(profile.profile_id));
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
