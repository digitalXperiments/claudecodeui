import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentRelayJobSummary } from '@/modules/agent-relay/agent-relay.types.js';
import {
  aggregateRelayScorecard,
  instantiateRelayTemplate,
  listRelayTemplates,
} from '@/modules/agent-relay/relay-workflow-library.js';
import { validateJsonSchema } from '@/shared/json-schema-lite.js';

function summary(overrides: Partial<AgentRelayJobSummary> = {}): AgentRelayJobSummary {
  return {
    relayId: 'relay-1',
    batchId: 'batch-1',
    label: 'worker',
    provider: 'claude',
    model: 'claude-default',
    requestedModel: null,
    selectedModel: 'claude-default',
    modelLabel: 'Claude',
    catalogDefaultModel: null,
    catalogResolvedModel: null,
    runtimeResolvedModel: null,
    modelSelectionSource: null,
    effort: null,
    mode: 'read_only',
    approvalPolicy: 'auto',
    status: 'completed',
    queuePosition: null,
    task: 'task',
    dependsOn: [],
    error: null,
    createdAt: '2026-09-23T00:00:00.000Z',
    startedAt: '2026-09-23T00:00:00.000Z',
    finishedAt: '2026-09-23T00:00:10.000Z',
    timeoutMs: 60_000,
    attempt: 1,
    retryCount: 0,
    pendingApprovalCount: 0,
    usage: { totalTokens: 100, costUsd: null, runs: 1 },
    result: {
      status: 'completed',
      summary: 'done',
      evidence: [],
      filesTouched: [],
      testsRun: [],
      openQuestions: [],
      hasFullOutput: true,
    },
    ...overrides,
  };
}

test('built-in templates are versioned and instantiate supported task fields with a DAG', () => {
  const templates = listRelayTemplates();
  assert.deepEqual(templates.map((template) => template.id), ['investigate', 'implement-test-review', 'adversarial-review']);
  assert.ok(templates.every((template) => template.version === 1));

  const supported = new Set([
    'task', 'label', 'provider', 'model', 'effort', 'mode', 'approvalPolicy',
    'timeoutMs', 'mcpServers', 'outputSchema', 'dependsOn', 'retries',
  ]);
  for (const id of templates.map((template) => template.id)) {
    const tasks = instantiateRelayTemplate(id, {
      objective: 'Assess the relay workflow library.',
      acceptanceCriteria: ['Report concrete evidence.'],
      provider: 'codex',
      timeoutMs: 30_000,
      retries: 1,
    });
    assert.ok(tasks.length >= 2);
    for (const task of tasks) {
      assert.deepEqual(Object.keys(task).filter((key) => !supported.has(key)), []);
      assert.equal(typeof task.outputSchema, 'object');
      assert.match(task.task, /hostVerified:false/);
    }
    assert.deepEqual(tasks[0]!.dependsOn ?? [], []);
    for (const [index, task] of tasks.entries()) {
      for (const dependency of task.dependsOn ?? []) assert.ok(dependency >= 0 && dependency < index);
    }
  }

  const implementation = instantiateRelayTemplate('implement-test-review', { objective: 'Ship the change.' });
  assert.equal(implementation[0]!.mode, 'isolated_write');
  assert.deepEqual(implementation[1]!.dependsOn, [0]);
  assert.deepEqual(implementation[2]!.dependsOn, [1]);
});

test('template parameters are validated and schemas carry unverified evidence provenance', () => {
  assert.throws(() => instantiateRelayTemplate('investigate', { objective: ' ' }), /objective must be a non-empty string/);
  assert.throws(() => instantiateRelayTemplate('investigate', { objective: 'x', retries: 3 }), /retries must be an integer/);
  assert.throws(() => instantiateRelayTemplate('investigate', { objective: 'x', timeoutMs: 1 }), /timeoutMs must be an integer/);
  assert.throws(() => instantiateRelayTemplate('not-a-template', { objective: 'x' }), /unknown relay workflow template/);

  const task = instantiateRelayTemplate('investigate', { objective: 'x' })[0]!;
  const schema = task.outputSchema!;
  assert.equal(validateJsonSchema({
    outcome: 'success',
    summary: 'observed',
    evidence: [{ claim: 'worker saw a file', source: 'worker_report', hostVerified: false }],
  }, schema).valid, true);
  assert.equal(validateJsonSchema({
    outcome: 'success',
    summary: 'claimed host verification',
    evidence: [{ claim: 'verified', source: 'worker_report', hostVerified: true }],
  }, schema).valid, false);
});

test('scorecard classifies semantic outcomes, validation failures, retries, duration, and unknown cost', () => {
  const jobs = [
    summary({
      relayId: 'success',
      provider: 'claude',
      result: { ...summary().result!, outputValidation: { valid: true, errors: [] } },
      usage: { totalTokens: 100, costUsd: 0.25, runs: 1 },
      finishedAt: '2026-09-23T00:00:10.000Z',
    }),
    summary({
      relayId: 'blocked',
      provider: 'grok',
      status: 'waiting_approval',
      retryCount: 1,
      result: { ...summary().result!, status: 'blocked', outputValidation: { valid: false, errors: ['missing evidence'] } },
      usage: { totalTokens: null, costUsd: null, runs: 0 },
      startedAt: '2026-09-23T00:01:00.000Z',
      finishedAt: null,
    }),
    summary({
      relayId: 'failed',
      provider: 'grok',
      model: null,
      selectedModel: null,
      modelLabel: null,
      status: 'failed',
      result: { ...summary().result!, status: 'failed' },
      usage: { totalTokens: 20, costUsd: 0.10, runs: 1 },
      startedAt: '2026-09-23T00:02:00.000Z',
      finishedAt: '2026-09-23T00:02:20.000Z',
    }),
  ];
  const scorecard = aggregateRelayScorecard(jobs);
  assert.equal(scorecard.totalJobs, 3);
  assert.deepEqual(scorecard.outcomes, { success: 1, blocked: 1, failed: 1 });
  assert.equal(scorecard.validationFailures, 1);
  assert.deepEqual(scorecard.retries, { jobsRetried: 1, totalRetryCount: 1, totalSchemaRetryCount: 0 });
  assert.equal(scorecard.durationMs.median, 15_000);
  assert.deepEqual(scorecard.cost.coverage, { knownJobs: 2, unknownJobs: 1, ratio: 2 / 3 });
  assert.equal(scorecard.cost.knownTotalUsd, 0.35);
  assert.equal(scorecard.cost.costPerKnownCostSuccessUsd, 0.25);
  assert.equal(scorecard.providerBreakdown.grok!.knownCostTotalUsd, 0.10);
  assert.equal(scorecard.modelBreakdown.unknown, undefined);
  assert.equal(scorecard.evidence.workerClaimsHostVerified, false);
});
