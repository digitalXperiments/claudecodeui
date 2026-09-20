import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  agentRunProfilesDb,
  closeConnection,
  compilePermissionIntent,
  getConnection,
  initializeDatabase,
  projectsDb,
  systemNotificationsDb,
  type SwarmProfileLevel,
  type SwarmProfileRole,
} from '@/modules/database/index.js';
import { makeScratchDir } from '@/shared/scratch.js';
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
    const board = kanbanDb.createBoard({ name: 'Board' });

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

test('profiles can be disabled and enabledOnly listing excludes them', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'agent-profiles-enabled-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const kept = agentRunProfilesDb.create({
      name: 'Kept Explorer',
      provider: 'claude',
    });
    const benched = agentRunProfilesDb.create({
      name: 'Benched Deepseek Explorer',
      provider: 'opencode',
      model: 'opencode/deepseek-v4-flash-free',
    });

    // New profiles default to enabled.
    assert.equal(kept.enabled, true);
    assert.equal(benched.enabled, true);

    const disabled = agentRunProfilesDb.update(benched.profile_id, { enabled: false });
    assert.equal(disabled?.enabled, false);

    // Disabled profiles still exist for explicit use…
    const allIds = agentRunProfilesDb.list().map((profile) => profile.profile_id);
    assert.ok(allIds.includes(benched.profile_id));
    // …but are excluded from enabled-only listings.
    const autoIds = agentRunProfilesDb
      .list({ enabledOnly: true })
      .map((profile) => profile.profile_id);
    assert.ok(autoIds.includes(kept.profile_id));
    assert.ok(!autoIds.includes(benched.profile_id));

    // Unrelated updates keep the disabled state; re-enabling round-trips.
    assert.equal(
      agentRunProfilesDb.update(benched.profile_id, { description: 'still benched' })?.enabled,
      false,
    );
    assert.equal(agentRunProfilesDb.update(benched.profile_id, { enabled: true })?.enabled, true);
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
