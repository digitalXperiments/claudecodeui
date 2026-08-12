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

test('agent run profile swarm roles: column, CRUD round-trip, validation, filter, seed tags', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('agent-profiles-swarm-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');

  try {
    await initializeDatabase();
    const db = getConnection();

    // Column exists on a fresh install.
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(agent_run_profiles)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    assert.ok(columns.has('swarm_roles'), 'agent_run_profiles.swarm_roles should exist');

    // Seeds carry the expected swarm role tags.
    const seeded = agentRunProfilesDb.ensureSeedProfiles();
    const seedRoles = new Map(seeded.map((p) => [p.name, p.swarm_roles]));
    assert.deepEqual(seedRoles.get('Claude Balanced'), ['implementer']);
    assert.deepEqual(seedRoles.get('Claude High Effort'), ['implementer']);
    assert.deepEqual(seedRoles.get('Grok Low Effort'), ['explorer']);
    assert.deepEqual(seedRoles.get('Strict Review'), ['reviewer']);

    // Seeds carry a capability tier so the orchestrator can rank them.
    assert.ok(columns.has('swarm_level'), 'agent_run_profiles.swarm_level should exist');
    const seedLevels = new Map(seeded.map((p) => [p.name, p.swarm_level]));
    assert.equal(seedLevels.get('Grok Low Effort'), 'basic');
    assert.equal(seedLevels.get('Claude Balanced'), 'medium');
    assert.equal(seedLevels.get('Claude High Effort'), 'advanced');
    assert.equal(seedLevels.get('Strict Review'), 'advanced');

    // Create with roles round-trips (deduped) through get/list.
    const created = agentRunProfilesDb.create({
      name: 'Swarm Multi Role',
      provider: 'claude',
      swarmRoles: ['explorer', 'reviewer', 'explorer'] as SwarmProfileRole[],
    });
    assert.deepEqual(created.swarm_roles, ['explorer', 'reviewer']);
    assert.deepEqual(agentRunProfilesDb.get(created.profile_id)?.swarm_roles, [
      'explorer',
      'reviewer',
    ]);

    // Omitted roles default to empty (not available to swarms); NULL stored.
    const untagged = agentRunProfilesDb.create({ name: 'No Swarm', provider: 'claude' });
    assert.deepEqual(untagged.swarm_roles, []);
    const rawUntagged = db
      .prepare(`SELECT swarm_roles FROM agent_run_profiles WHERE profile_id = ?`)
      .get(untagged.profile_id) as { swarm_roles: string | null };
    assert.equal(rawUntagged.swarm_roles, null);

    // Update replaces roles; updating without swarmRoles preserves them.
    const updated = agentRunProfilesDb.update(created.profile_id, {
      swarmRoles: ['implementer'],
    });
    assert.deepEqual(updated?.swarm_roles, ['implementer']);
    const renamed = agentRunProfilesDb.update(created.profile_id, { name: 'Swarm Renamed' });
    assert.deepEqual(renamed?.swarm_roles, ['implementer']);
    // Clearing with an empty array removes swarm availability.
    const cleared = agentRunProfilesDb.update(created.profile_id, { swarmRoles: [] });
    assert.deepEqual(cleared?.swarm_roles, []);

    // Unknown role strings are rejected on create, update, and list filter.
    assert.throws(
      () =>
        agentRunProfilesDb.create({
          name: 'Bad Roles',
          provider: 'claude',
          swarmRoles: ['pilot' as SwarmProfileRole],
        }),
      /Invalid swarm role/,
    );
    assert.throws(
      () =>
        agentRunProfilesDb.update(created.profile_id, {
          swarmRoles: ['manager' as SwarmProfileRole],
        }),
      /Invalid swarm role/,
    );
    assert.throws(
      () => agentRunProfilesDb.list({ swarmRole: 'wizard' as SwarmProfileRole }),
      /Invalid swarm role/,
    );

    // Role filter returns only matching profiles.
    const explorers = agentRunProfilesDb.list({ swarmRole: 'explorer' });
    assert.ok(explorers.length >= 1);
    assert.ok(explorers.every((p) => p.swarm_roles.includes('explorer')));
    assert.ok(explorers.some((p) => p.name === 'Grok Low Effort'));
    const reviewers = agentRunProfilesDb.list({ swarmRole: 'reviewer' });
    assert.ok(reviewers.some((p) => p.name === 'Strict Review'));
    assert.ok(!reviewers.some((p) => p.name === 'No Swarm'));
    // Unfiltered list still returns everything.
    assert.ok(agentRunProfilesDb.list().some((p) => p.name === 'No Swarm'));

    // ——— Capability level ———
    // Omitted level defaults to medium and is stored explicitly.
    assert.equal(untagged.swarm_level, 'medium');
    // Level round-trips on create, is preserved by unrelated updates, and is patchable.
    const advanced = agentRunProfilesDb.create({
      name: 'Swarm Advanced',
      provider: 'claude',
      swarmRoles: ['implementer'],
      swarmLevel: 'advanced',
    });
    assert.equal(advanced.swarm_level, 'advanced');
    assert.equal(agentRunProfilesDb.get(advanced.profile_id)?.swarm_level, 'advanced');
    assert.equal(
      agentRunProfilesDb.update(advanced.profile_id, { name: 'Swarm Advanced 2' })?.swarm_level,
      'advanced',
    );
    assert.equal(
      agentRunProfilesDb.update(advanced.profile_id, { swarmLevel: 'basic' })?.swarm_level,
      'basic',
    );
    // Unknown tiers are rejected on create and update.
    assert.throws(
      () =>
        agentRunProfilesDb.create({
          name: 'Bad Level',
          provider: 'claude',
          swarmLevel: 'godlike' as SwarmProfileLevel,
        }),
      /Invalid swarm level/,
    );
    assert.throws(
      () =>
        agentRunProfilesDb.update(advanced.profile_id, {
          swarmLevel: 'legendary' as SwarmProfileLevel,
        }),
      /Invalid swarm level/,
    );
    assert.throws(
      () => agentRunProfilesDb.list({ minSwarmLevel: 'epic' as SwarmProfileLevel }),
      /Invalid swarm level/,
    );
    // minSwarmLevel is a floor, and composes with the role filter.
    const strongImplementers = agentRunProfilesDb.list({
      swarmRole: 'implementer',
      minSwarmLevel: 'advanced',
    });
    assert.ok(
      strongImplementers.every((p) => p.swarm_level === 'advanced'),
      'minSwarmLevel must exclude weaker tiers',
    );
    assert.ok(
      strongImplementers.some((p) => p.name === 'Claude High Effort'),
      'advanced seed implementer must survive the floor',
    );
    assert.ok(
      agentRunProfilesDb
        .list({ minSwarmLevel: 'basic' })
        .some((p) => p.name === 'Grok Low Effort'),
      'a basic floor keeps every tier',
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
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
      swarmRoles: ['explorer'],
    });
    const benched = agentRunProfilesDb.create({
      name: 'Benched Deepseek Explorer',
      provider: 'opencode',
      model: 'opencode/deepseek-v4-flash-free',
      swarmRoles: ['explorer'],
    });

    // New profiles default to enabled.
    assert.equal(kept.enabled, true);
    assert.equal(benched.enabled, true);

    const disabled = agentRunProfilesDb.update(benched.profile_id, { enabled: false });
    assert.equal(disabled?.enabled, false);

    // Disabled profiles still exist for explicit use…
    const allIds = agentRunProfilesDb.list().map((profile) => profile.profile_id);
    assert.ok(allIds.includes(benched.profile_id));
    // …but never reach automatic seat selection.
    const autoIds = agentRunProfilesDb
      .list({ swarmRole: 'explorer', enabledOnly: true })
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

test('upgraded databases receive the agent_run_profiles.swarm_roles column', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('agent-profiles-upgrade-');
  const databasePath = path.join(directory, 'auth.db');
  closeConnection();

  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE agent_run_profiles (
      profile_id         TEXT PRIMARY KEY NOT NULL,
      name               TEXT NOT NULL,
      description        TEXT DEFAULT '',
      provider           TEXT NOT NULL,
      model              TEXT,
      effort             TEXT,
      permission_mode    TEXT DEFAULT 'default',
      tools_json         TEXT DEFAULT '{}',
      permission_intent  TEXT DEFAULT '',
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacy
    .prepare(
      `INSERT INTO agent_run_profiles (profile_id, name, provider) VALUES (?, ?, ?)`,
    )
    .run('legacy-profile-1', 'Legacy Profile', 'claude');
  legacy.close();

  process.env.DATABASE_PATH = databasePath;
  try {
    await initializeDatabase();
    const db = getConnection();
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(agent_run_profiles)`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    assert.ok(columns.has('swarm_roles'), 'migration should add swarm_roles');
    assert.ok(columns.has('swarm_level'), 'migration should add swarm_level');
    assert.ok(columns.has('enabled'), 'migration should add enabled');
    // Pre-existing rows read back as enabled.
    assert.equal(agentRunProfilesDb.get('legacy-profile-1')?.enabled, true);

    // Pre-existing rows read back with no swarm availability and are updatable.
    const legacyProfile = agentRunProfilesDb.get('legacy-profile-1');
    assert.deepEqual(legacyProfile?.swarm_roles, []);
    // A NULL level on an upgraded row reads as the medium default.
    assert.equal(legacyProfile?.swarm_level, 'medium');
    const tagged = agentRunProfilesDb.update('legacy-profile-1', { swarmRoles: ['reviewer'] });
    assert.deepEqual(tagged?.swarm_roles, ['reviewer']);
    assert.equal(
      agentRunProfilesDb.update('legacy-profile-1', { swarmLevel: 'advanced' })?.swarm_level,
      'advanced',
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
