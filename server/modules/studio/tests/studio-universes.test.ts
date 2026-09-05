import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { agentRelayService, configureAgentRelayRuntimes } from '@/modules/agent-relay/index.js';
import { appConfigDb, closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { reconcilePreviewState } from '@/modules/studio/studio-universes.preview.js';
import { studioUniversesService } from '@/modules/studio/studio-universes.service.js';
import { STOPPED_PREVIEW } from '@/modules/studio/studio-universes.types.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function initGitProject(projectPath: string): void {
  runGit(projectPath, ['init']);
  runGit(projectPath, ['config', 'user.email', 'test@cloudcli.dev']);
  runGit(projectPath, ['config', 'user.name', 'CloudCLI Test']);
  runGit(projectPath, ['add', '-A']);
  runGit(projectPath, ['commit', '-m', 'initial']);
}

const FAKE_MODELS = {
  models: {
    DEFAULT: 'claude-test-model',
    OPTIONS: [
      { value: 'claude-test-model', label: 'Claude Test Model', resolvedModel: 'claude-test-model' },
    ],
  },
  cache: { updatedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), source: 'fresh' as const },
};

async function withHarness(fn: (ctx: { projectId: string; projectPath: string; root: string }) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('studio-universes-');
  const projectPath = path.join(root, 'project');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(projectPath, 'README.md'), 'original\n', 'utf8');
  initGitProject(projectPath);

  const created = projectsDb.createProjectPath(projectPath);
  const projectId = created.project!.project_id;

  appConfigDb.set('agent_relay.settings', JSON.stringify({
    enabled: true,
    leadProviders: ['claude'],
    workerProviders: ['claude'],
    maxConcurrency: 4,
    defaultTimeoutMs: 60_000,
    defaultMode: 'read_only',
    installSkill: false,
  }));

  const originalGetProviderModels = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async () => FAKE_MODELS;

  try {
    await fn({ projectId, projectPath, root });
  } finally {
    providerModelsService.getProviderModels = originalGetProviderModels;
    configureAgentRelayRuntimes({}, {});
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }
}

/** Each fake worker writes a distinct marker into README.md so variants are distinguishable. */
function installFakeClaudeWorker(): void {
  let callCount = 0;
  configureAgentRelayRuntimes({
    claude: async (_command, options, writer) => {
      callCount += 1;
      const n = callCount;
      const relayWriter = writer as { setSessionId: (id: string) => void; send: (message: unknown) => void };
      relayWriter.setSessionId(`relay-universe-${n}`);
      const cwd = (options as { cwd?: string }).cwd;
      if (cwd) {
        await writeFile(path.join(cwd, 'README.md'), `variant-${n} implementation\n`, 'utf8');
      }
      relayWriter.send({
        kind: 'text',
        provider: 'claude',
        content: `<agent_relay_result>{"status":"completed","summary":"Implemented variant ${n}","evidence":[],"filesTouched":["README.md"],"testsRun":["node -e 1"],"openQuestions":[]}</agent_relay_result>`,
      });
      relayWriter.send({ kind: 'complete', provider: 'claude', exitCode: 0, success: true });
    },
  }, {});
}

test('Studio Universes: launches two isolated variants, diffs, applies, and previews them', async () => {
  await withHarness(async ({ projectId, projectPath }) => {
    installFakeClaudeWorker();

    const universe = await studioUniversesService.create({
      projectId,
      goal: 'Add a login form to the app.',
      approaches: [
        { label: 'Optimistic UI', approach: 'Update UI immediately, reconcile with the server after.', provider: 'claude', model: 'claude-test-model' },
        { label: 'Server-validated', approach: 'Block submission until the server confirms.', provider: 'claude', model: 'claude-test-model' },
      ],
    });
    assert.equal(universe.variants.length, 2);
    assert.equal(universe.variants[0]?.label, 'Optimistic UI');
    assert.equal(universe.variants[1]?.label, 'Server-validated');
    assert.ok(universe.variants[0]?.relayId);
    assert.ok(universe.variants[1]?.relayId);

    const relayIds = universe.variants.map((variant) => variant.relayId!);
    const waited = await agentRelayService.wait(relayIds, { returnWhen: 'all', timeoutMs: 10_000 });
    assert.equal(waited.timedOut, false);
    assert.ok(waited.jobs.every((job) => job.status === 'completed'));

    const refreshed = await studioUniversesService.get(projectId, universe.id);
    assert.equal(refreshed.status, 'ready');
    for (const variant of refreshed.variants) {
      assert.equal(variant.status, 'completed');
      assert.ok(variant.workspaceId, 'variant should have a workspace once its job runs');
      assert.ok(variant.branch?.startsWith('relay/'), `expected a relay feature branch, got ${variant.branch}`);
      assert.equal(variant.result?.summary.startsWith('Implemented variant'), true);
    }

    const [variantA, variantB] = refreshed.variants;
    const diffA = await studioUniversesService.diffVariant(projectId, universe.id, variantA.id);
    assert.equal(diffA.files.some((file) => file.path === 'README.md'), true);
    const diffB = await studioUniversesService.diffVariant(projectId, universe.id, variantB.id);
    assert.equal(diffB.files.some((file) => file.path === 'README.md'), true);

    // Deliberate apply: no auto-merge, file-copy only, uncommitted by default.
    const applied = await studioUniversesService.applyVariant(projectId, universe.id, variantA.id, { commit: false });
    const appliedVariant = applied.variants.find((variant) => variant.id === variantA.id)!;
    assert.ok(appliedVariant.applied);
    assert.equal(appliedVariant.applied?.applied.includes('README.md'), true);
    const primaryReadme = await readFile(path.join(projectPath, 'README.md'), 'utf8');
    assert.match(primaryReadme, /variant-\d+ implementation/);

    // Local preview lifecycle: start a trivial HTTP server in the variant's
    // isolated workspace, confirm it comes up on an allocated port, then stop it.
    const withPreview = await studioUniversesService.startPreview(projectId, universe.id, variantB.id, {
      command: `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(process.env.PORT)"`,
    });
    const previewVariant = withPreview.variants.find((variant) => variant.id === variantB.id)!;
    assert.ok(previewVariant.preview.port);
    assert.ok(['starting', 'running'].includes(previewVariant.preview.status));

    // Poll get() until the readiness probe flips it to running (bounded wait).
    let ready = withPreview;
    for (let i = 0; i < 20; i += 1) {
      ready = await studioUniversesService.get(projectId, universe.id);
      const current = ready.variants.find((variant) => variant.id === variantB.id)!;
      if (current.preview.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const runningVariant = ready.variants.find((variant) => variant.id === variantB.id)!;
    assert.equal(runningVariant.preview.status, 'running');
    assert.match(runningVariant.preview.url ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);

    const stopped = await studioUniversesService.stopPreview(projectId, universe.id, variantB.id);
    const stoppedVariant = stopped.variants.find((variant) => variant.id === variantB.id)!;
    assert.equal(stoppedVariant.preview.status, 'stopped');

    await studioUniversesService.remove(projectId, universe.id);
    await assert.rejects(() => studioUniversesService.get(projectId, universe.id), /not found/i);
  });
});

test('Studio Universes: rejects a request that is missing a provider/model or has the wrong approach count', async () => {
  await withHarness(async ({ projectId }) => {
    installFakeClaudeWorker();

    await assert.rejects(
      () => studioUniversesService.create({
        projectId,
        goal: 'Add search',
        approaches: [
          { label: 'A', approach: 'Client-side filtering', provider: 'claude', model: 'claude-test-model' },
        ] as never,
      }),
      /exactly two/i,
    );

    await assert.rejects(
      () => studioUniversesService.create({
        projectId,
        goal: 'Add search',
        approaches: [
          { label: 'A', approach: 'Client-side filtering', provider: 'claude', model: '' },
          { label: 'B', approach: 'Server-side search', provider: 'claude', model: 'claude-test-model' },
        ],
      }),
      /model/i,
    );

    const relayCount = getConnection().prepare('SELECT COUNT(*) AS count FROM agent_relay_jobs').get() as { count: number };
    assert.equal(relayCount.count, 0);
  });
});

test('Studio Universes: falls back to a sandbox_copy workspace for a non-git project', async () => {
  await withHarness(async ({ root }) => {
    installFakeClaudeWorker();

    const plainProjectPath = path.join(root, 'plain-project');
    await mkdir(plainProjectPath, { recursive: true });
    await writeFile(path.join(plainProjectPath, 'README.md'), 'original\n', 'utf8');
    const created = projectsDb.createProjectPath(plainProjectPath);
    const plainProjectId = created.project!.project_id;

    const universe = await studioUniversesService.create({
      projectId: plainProjectId,
      goal: 'Add a config file.',
      approaches: [
        { label: 'A', approach: 'Use JSON.', provider: 'claude', model: 'claude-test-model' },
        { label: 'B', approach: 'Use YAML.', provider: 'claude', model: 'claude-test-model' },
      ],
    });
    const relayIds = universe.variants.map((variant) => variant.relayId!);
    await agentRelayService.wait(relayIds, { returnWhen: 'all', timeoutMs: 10_000 });

    const refreshed = await studioUniversesService.get(plainProjectId, universe.id);
    for (const variant of refreshed.variants) {
      assert.equal(variant.status, 'completed');
      assert.ok(variant.workspaceId);
      const workspace = workspaceService.get(variant.workspaceId!);
      assert.equal(workspace?.mode, 'sandbox_copy');
    }
  });
});

test('Studio Universes: reports a preview as stopped (not silently still-owned) after a server restart', () => {
  const persisted = { ...STOPPED_PREVIEW, status: 'running' as const, pid: 12345, port: 4123 };
  const reconciled = reconcilePreviewState('uv_does_not_exist_in_registry', persisted);
  assert.equal(reconciled.status, 'stopped');
  assert.match(reconciled.error ?? '', /restarted/i);
});
