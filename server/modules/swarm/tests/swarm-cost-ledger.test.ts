import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { runsDb } from '@/modules/runs/index.js';
import {
  buildSwarmCostLedger,
  candidateValueScore,
  formatCostStats,
  MIN_LEDGER_SAMPLES,
} from '@/modules/swarm/swarm-cost-ledger.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withDatabase(callback: (projectId: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('swarm-ledger-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    const projectPath = path.join(root, 'project');
    const projectId = projectsDb.createProjectPath(projectPath).project!.project_id;
    await callback(projectId);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

/** Record a finished swarm step run the way executeStep does. */
function recordStepRun(input: {
  projectId: string;
  profileId: string;
  role: string;
  difficulty: string;
  attempt: number;
  status: 'succeeded' | 'failed' | 'timed_out';
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
}): void {
  const run = runsDb.create({
    source: 'swarm',
    projectId: input.projectId,
    provider: 'claude',
    profileId: input.profileId,
    status: 'running',
    title: 'step',
    trigger: 'swarm:test',
    meta: {
      swarmId: 'swarm-test',
      role: input.role,
      difficulty: input.difficulty,
      attempt: input.attempt,
      stepId: 's1',
    },
  });
  finishRun(run.run_id, input);
}

/**
 * Terminalize a run with exact timestamps. Written with SQL rather than the
 * repository API because the ledger's medians are timing-sensitive and the
 * public API stamps `finished_at` with the wall clock.
 */
function finishRun(
  runId: string,
  input: {
    status: 'succeeded' | 'failed' | 'timed_out';
    tokens?: number;
    costUsd?: number;
    durationMs?: number;
  },
): void {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const toSqlite = (ms: number): string =>
    new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  getConnection()
    .prepare(
      `UPDATE agent_runs
         SET status = ?, started_at = ?, finished_at = ?,
             token_total = ?, cost_usd_estimate = ?
       WHERE run_id = ?`,
    )
    .run(
      input.status,
      toSqlite(base),
      toSqlite(base + (input.durationMs ?? 60_000)),
      input.tokens ?? null,
      input.costUsd ?? null,
      runId,
    );
}

test('cost ledger is empty on cold start and every decision falls back', async () => {
  await withDatabase(async () => {
    const ledger = buildSwarmCostLedger();
    assert.equal(ledger.isEmpty, true);
    assert.equal(ledger.get('any-profile', 'implementer', 'medium'), null);
    // An unknown candidate gets a neutral prior, not a free pass: it must not
    // outrank a profile with a proven-good record (or nothing would ever build
    // one), but it must outrank a demonstrably flaky one.
    assert.ok(candidateValueScore(null) > 0, 'unknown must not score as perfect');
  });
});

test('cost ledger ignores buckets thinner than the sample floor', async () => {
  await withDatabase(async (projectId) => {
    // One observation only — not enough to steer an assignment.
    recordStepRun({
      projectId,
      profileId: 'p-thin',
      role: 'implementer',
      difficulty: 'medium',
      attempt: 1,
      status: 'succeeded',
      tokens: 10_000,
      costUsd: 0.1,
    });
    const ledger = buildSwarmCostLedger();
    assert.equal(ledger.isEmpty, false, 'history exists...');
    assert.equal(
      ledger.get('p-thin', 'implementer', 'medium'),
      null,
      `...but fewer than ${MIN_LEDGER_SAMPLES} samples must not be reported`,
    );
  });
});

test('cost ledger measures reliability, medians and cost per SUCCESSFUL step', async () => {
  await withDatabase(async (projectId) => {
    // Reliable but pricey: 3 first-try successes at $1.00 each.
    for (let index = 0; index < 3; index += 1) {
      recordStepRun({
        projectId,
        profileId: 'p-good',
        role: 'implementer',
        difficulty: 'medium',
        attempt: 1,
        status: 'succeeded',
        tokens: 20_000,
        costUsd: 1,
        durationMs: 120_000,
      });
    }

    // Cheap per run, but only one success in four — so NOT cheap per success.
    recordStepRun({ projectId, profileId: 'p-cheap', role: 'implementer', difficulty: 'medium', attempt: 1, status: 'succeeded', tokens: 5_000, costUsd: 0.25, durationMs: 60_000 });
    recordStepRun({ projectId, profileId: 'p-cheap', role: 'implementer', difficulty: 'medium', attempt: 1, status: 'failed', costUsd: 0.25 });
    recordStepRun({ projectId, profileId: 'p-cheap', role: 'implementer', difficulty: 'medium', attempt: 1, status: 'timed_out', costUsd: 0.25 });
    recordStepRun({ projectId, profileId: 'p-cheap', role: 'implementer', difficulty: 'medium', attempt: 2, status: 'failed', costUsd: 0.25 });

    const ledger = buildSwarmCostLedger();
    const good = ledger.get('p-good', 'implementer', 'medium')!;
    const cheap = ledger.get('p-cheap', 'implementer', 'medium')!;

    assert.equal(good.runs, 3);
    assert.equal(good.firstTrySuccessRate, 1);
    assert.equal(good.timeoutRate, 0);
    assert.equal(good.medianTokens, 20_000);
    assert.equal(good.medianDurationMs, 120_000);
    assert.equal(good.costPerSuccessUsd, 1, 'three successes, $3 total');

    assert.equal(cheap.runs, 4);
    assert.equal(cheap.successRate, 0.25);
    assert.equal(cheap.timeoutRate, 0.25);
    // $1 total spend across four runs, only ONE of which succeeded.
    assert.equal(cheap.costPerSuccessUsd, 1);
    // Failed runs must not contribute their (absent) tokens to the median.
    assert.equal(cheap.medianTokens, 5_000);

    // Same $/success, but reliability decides — the flaky agent is worse.
    assert.ok(
      candidateValueScore(good) < candidateValueScore(cheap),
      `expected the reliable profile to score better: ${candidateValueScore(good)} vs ${candidateValueScore(cheap)}`,
    );
    // And an untried profile sits between them: worth exploring, not preferred
    // over a proven-good one.
    assert.ok(
      candidateValueScore(good) < candidateValueScore(null),
      'a proven-reliable profile must beat an untried one',
    );
    assert.ok(
      candidateValueScore(null) < candidateValueScore(cheap),
      'an untried profile must beat a demonstrably flaky one',
    );

    const line = formatCostStats(good)!;
    assert.match(line, /100% first-try success/);
    assert.match(line, /\$1\.00\/successful step/);
  });
});

test('cost ledger pools across difficulties when the exact bucket is thin, and scopes by role', async () => {
  await withDatabase(async (projectId) => {
    // Three basic-difficulty runs, none at advanced.
    for (let index = 0; index < 3; index += 1) {
      recordStepRun({
        projectId,
        profileId: 'p-mixed',
        role: 'implementer',
        difficulty: 'basic',
        attempt: 1,
        status: 'succeeded',
        tokens: 8_000,
        costUsd: 0.5,
      });
    }
    const ledger = buildSwarmCostLedger();

    // Asking about advanced has no exact bucket, so the pooled record is used
    // and reports difficulty=null rather than pretending to be advanced data.
    const pooled = ledger.get('p-mixed', 'implementer', 'advanced')!;
    assert.equal(pooled.difficulty, null);
    assert.equal(pooled.runs, 3);

    // The exact bucket is returned when it is thick enough.
    assert.equal(ledger.get('p-mixed', 'implementer', 'basic')?.difficulty, 'basic');

    // Roles are separate ledgers: implementer history says nothing about review.
    assert.equal(ledger.get('p-mixed', 'reviewer', 'basic'), null);
  });
});

test('cost ledger excludes orchestrator phase runs (plan/handoff/adjudication)', async () => {
  await withDatabase(async (projectId) => {
    for (let index = 0; index < 4; index += 1) {
      const run = runsDb.create({
        source: 'swarm',
        projectId,
        provider: 'claude',
        profileId: 'p-orch',
        status: 'running',
        title: 'plan',
        trigger: 'swarm-plan:test',
        // Orchestrator overhead carries a `phase`; it is not step work and must
        // not pollute a profile's step economics.
        meta: { swarmId: 'swarm-test', role: 'orchestrator', phase: 'plan', attempt: 1 },
      });
      finishRun(run.run_id, { status: 'succeeded', tokens: 50_000, costUsd: 2 });
    }
    const ledger = buildSwarmCostLedger();
    assert.equal(ledger.isEmpty, true, 'phase runs must not register as step history');
    assert.equal(ledger.get('p-orch', 'orchestrator', null), null);
  });
});
