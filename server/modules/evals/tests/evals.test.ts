import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
} from '@/modules/database/index.js';
import {
  configureEvalRuntimes,
  evalsDb,
  evalsService,
  normalizeEvalSuiteDraft,
} from '@/modules/evals/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { makeScratchDir } from '@/shared/scratch.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

type TempDb = { directory: string; restore: () => Promise<void> };

async function useTempDatabase(): Promise<TempDb> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('evals-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  return {
    directory,
    restore: async () => {
      configureEvalRuntimes({});
      chatRunRegistry.clearAll();
      closeConnection();
      if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousDatabasePath;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const draftJson = {
  suite: {
    name: 'Swarm step quality',
    description: 'Protect worker outcomes.',
    objective: 'Workers should produce verified changes.',
    scope: 'swarm_step',
    trigger: 'after_step',
    tags: ['swarm', 'regression'],
    actionPolicy: {
      onPass: 'continue',
      onFailure: ['retry_with_feedback', 'reassign_stronger_profile', 'replan'],
      onLowConfidence: 'request_human',
      maxAutomaticAttempts: 3,
      minimumScore: 0.85,
    },
  },
  cases: [
    {
      name: 'Focused implementation',
      description: 'Makes a small correct patch.',
      prompt: 'Implement the requested change and run focused tests.',
      difficulty: 'medium',
      expectedOutcome: { acceptanceCriteria: ['Tests pass', 'No unrelated files changed'] },
      tags: ['implementation'],
      graders: [
        { name: 'Focused tests', type: 'command', required: true, weight: 2, config: { commands: ['npm test -- focused', 'rm -rf /'] } },
        { name: 'Scope', type: 'diff_scope', required: true, weight: 1, config: { allowed: ['src/**'] } },
      ],
    },
  ],
};

test('eval suite normalization bounds policy and removes unsafe generated commands', () => {
  const draft = normalizeEvalSuiteDraft(draftJson, {
    objective: 'fallback',
    scope: 'swarm_step',
  });
  assert.equal(draft.scope, 'swarm_step');
  assert.equal(draft.trigger, 'after_step');
  assert.equal(draft.actionPolicy.minimumScore, 0.85);
  assert.equal(draft.cases.length, 1);
  const command = draft.cases[0].graders.find((grader) => grader.type === 'command');
  assert.deepEqual(command?.config.commands, ['npm test -- focused']);
});

test('eval suite repository persists cases/graders and resolves active lifecycle definitions', async () => {
  const db = await useTempDatabase();
  try {
    const tables = new Set(
      (getConnection().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((row) => row.name),
    );
    assert.ok(tables.has('eval_suites'));
    assert.ok(tables.has('eval_trials'));

    const projectId = projectsDb.createProjectPath(db.directory).project!.project_id;
    const draft = normalizeEvalSuiteDraft(draftJson, { objective: 'fallback', scope: 'swarm_step' });
    const suite = evalsDb.create({ ...draft, projectId, status: 'draft', source: 'manual' });
    assert.ok(suite.suite_id.startsWith('esuite_'));
    assert.equal(suite.cases[0].graders.length, 2);
    assert.equal(evalsService.resolveActive({ projectId, scope: 'swarm_step', trigger: 'after_step' }).length, 0);

    const active = evalsDb.update(suite.suite_id, { status: 'active' });
    assert.equal(active?.version, 2);
    assert.equal(evalsService.resolveActive({ projectId, scope: 'swarm_step', trigger: 'after_step' }).length, 1);
    assert.equal(evalsDb.summary().activeSuites, 1);
    assert.equal(evalsDb.summary().totalGraders, 2);

    assert.equal(evalsDb.delete(suite.suite_id), true);
    assert.equal(evalsDb.summary().totalCases, 0);
  } finally {
    await db.restore();
  }
});

test('AI generation uses a configured provider, records a canonical eval run, and saves a draft', async () => {
  const db = await useTempDatabase();
  let runtimeCwd = '';
  let seenModel = '';
  let seenPermissionMode = '';
  let seenAllowedTools: unknown;
  try {
    const projectId = projectsDb.createProjectPath(db.directory).project!.project_id;
    configureEvalRuntimes({
      claude: async (_command, options, writer) => {
        runtimeCwd = String(options.cwd || '');
        seenModel = String(options.model || '');
        seenPermissionMode = String(options.permissionMode || '');
        seenAllowedTools = (options.toolsSettings as AnyRecord | undefined)?.allowedTools;
        const sink = writer as { send: (message: AnyRecord) => void };
        sink.send({ kind: 'text', role: 'assistant', provider: 'claude' as LLMProvider, content: JSON.stringify(draftJson) });
        sink.send({ kind: 'complete', provider: 'claude' as LLMProvider, exitCode: 0, success: true });
      },
    });

    const suite = await evalsService.generate({
      provider: 'claude',
      model: 'claude-test-model',
      projectId,
      objective: 'Verify swarm worker outcomes.',
      scope: 'swarm_step',
      trigger: 'after_step',
      caseCount: 3,
    });

    assert.equal(suite.status, 'draft');
    assert.equal(suite.source, 'ai');
    assert.equal(suite.generator_provider, 'claude');
    assert.equal(seenModel, 'claude-test-model');
    assert.equal(seenPermissionMode, 'plan');
    assert.deepEqual(seenAllowedTools, []);
    assert.ok(suite.generator_run_id?.startsWith('run_'));
    assert.equal(evalsDb.get(suite.suite_id)?.cases.length, 1);
    assert.match(runtimeCwd, /tmp[/\\]cloudcli[/\\]eval-generation/);
    await assert.rejects(access(runtimeCwd));
  } finally {
    await db.restore();
  }
});
