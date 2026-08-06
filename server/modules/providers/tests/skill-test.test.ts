import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import {
  configureSkillTestRuntimes,
  getSkillTestSpawnFn,
  testSkill,
} from '@/modules/providers/services/skill-test.service.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

const SKILL_MD = `---
name: test-skill
description: Keeps agent memory across sessions
---

# Test Skill

1. Read project memory.
2. Update it after each task.
`;

type Writer = {
  send: (event: AnyRecord) => void;
  sendComplete: (event: AnyRecord) => void;
};

const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

async function withIsolatedDatabase(runTest: (workspacePath: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'skill-test-'));
  const workspacePath = path.join(tempDirectory, 'workspace');
  await mkdir(workspacePath, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  getConnection().pragma('foreign_keys = ON');

  const restoreHomeDir = patchHomeDir(tempDirectory);
  try {
    await runTest(workspacePath);
  } finally {
    chatRunRegistry.clearAll();
    configureSkillTestRuntimes({});
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    restoreHomeDir();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('testSkill dry-runs a skill in a scratch tmp/cloudcli project and cleans up', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    configureSkillTestRuntimes({
      claude: async (_command: string, options: AnyRecord, writer: unknown) => {
        const w = writer as Writer;
        const cwd = options.cwd as string;
        assert.ok(typeof cwd === 'string' && cwd.length > 0, 'runtime cwd should be the scratch project');
        assert.match(cwd, /skill-test-/);
        // The draft must be materialized into the scratch project's skill folder
        // before the run starts, so the agent can actually load it.
        const materialized = path.join(cwd, '.claude', 'skills', 'test-skill', 'SKILL.md');
        assert.equal(
          await pathExists(materialized),
          true,
          'skill should be materialized into the scratch project before the run',
        );
        w.send({
          kind: 'text',
          provider: 'claude',
          content: 'Loaded skill test-skill. It instructs agents to keep memory. 3 sections.',
        });
        w.sendComplete({ exitCode: 0 });
      },
    } as Partial<Record<LLMProvider, (c: string, o: AnyRecord, w: unknown) => Promise<void>>>);

    const result = await testSkill({ provider: 'claude', content: SKILL_MD, workspacePath });

    assert.equal(result.success, true);
    assert.match(result.text, /Loaded skill test-skill/);
    assert.match(result.text, /keep memory/);
    assert.equal(result.errorMessage, undefined);
    assert.equal(result.cleanedUp, true);
    // The scratch project lives under <workspace>/tmp/cloudcli and is removed.
    assert.equal(path.dirname(result.scratchPath), path.join(workspacePath, 'tmp', 'cloudcli'));
    assert.equal(await pathExists(result.scratchPath), false);
  });
});

test('testSkill reports failure when the run exits with a non-zero code and still cleans up', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    configureSkillTestRuntimes({
      claude: async (_command: string, _options: AnyRecord, writer: unknown) => {
        const w = writer as Writer;
        w.send({
          kind: 'text',
          provider: 'claude',
          content: 'The CLI blew up before it could load the skill.',
        });
        w.sendComplete({ exitCode: 1 });
      },
    } as Partial<Record<LLMProvider, (c: string, o: AnyRecord, w: unknown) => Promise<void>>>);

    const result = await testSkill({ provider: 'claude', content: SKILL_MD, workspacePath });

    assert.equal(result.success, false);
    assert.match(result.text, /blew up/);
    assert.equal(result.cleanedUp, true);
    assert.equal(await pathExists(result.scratchPath), false);
    assert.equal(path.dirname(result.scratchPath), path.join(workspacePath, 'tmp', 'cloudcli'));
  });
});

test('testSkill reports unsupported providers without a runtime and still cleans up', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    // opencode has no project-scope skill target, so the run is never started —
    // no runtime configuration is required.
    configureSkillTestRuntimes({});

    const result = await testSkill({ provider: 'opencode', content: SKILL_MD, workspacePath });

    assert.equal(result.success, false);
    assert.match(result.errorMessage ?? '', /not supported/i);
    assert.match(result.errorMessage ?? '', /opencode/i);
    assert.equal(result.cleanedUp, true);
    assert.equal(await pathExists(result.scratchPath), false);
    assert.equal(path.dirname(result.scratchPath), path.join(workspacePath, 'tmp', 'cloudcli'));
  });
});

test('testSkill rejects an unconfigured provider runtime with a 503 AppError', async () => {
  await withIsolatedDatabase(async (workspacePath) => {
    configureSkillTestRuntimes({});

    assert.throws(
      () => getSkillTestSpawnFn('claude' as LLMProvider),
      (error: unknown) => (
        (error as { statusCode?: number }).statusCode === 503
        && (error as { message?: string }).message === 'Skill test runtime not configured'
      ),
    );

    await assert.rejects(
      () => testSkill({ provider: 'claude', content: SKILL_MD, workspacePath }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 503,
    );
  });
});
