import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentRelayJob } from '../../../agent-relay/types';
import { dependencyWaitReason, summarizeRelayUsage } from './agentRelayActivityUtils';

const job = (patch: Partial<AgentRelayJob> = {}) => ({
  relay_id: 'relay-1',
  batch_id: 'batch-1',
  project_id: 'project-1',
  project_path: '/tmp/project',
  source_session_id: 'session-1',
  app_session_id: null,
  run_id: null,
  workspace_id: null,
  provider: 'claude',
  model: null,
  requested_model: null,
  model_label: null,
  catalog_default_model: null,
  catalog_resolved_model: null,
  runtime_resolved_model: null,
  model_selection_source: null,
  effort: null,
  mode: 'read_only',
  approval_policy: 'auto',
  status: 'queued',
  queue_position: null,
  label: null,
  task: 'worker task',
  depends_on: [],
  retries: 0,
  retry_count: 0,
  result: null,
  error: null,
  timeout_ms: 1_000,
  attempt: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  started_at: null,
  finished_at: null,
  updated_at: '2026-01-01T00:00:00.000Z',
  ...patch,
} as AgentRelayJob);

test('summarizeRelayUsage preserves known zeroes and unknown coverage', () => {
  const summary = summarizeRelayUsage([
    job({ usage: { totalTokens: 0, costUsd: 0, runs: 1 } }),
    job({ relay_id: 'relay-2', usage: { totalTokens: null, costUsd: null, runs: 1 } }),
  ]);

  assert.equal(summary.tokens, 0);
  assert.equal(summary.costUsd, 0);
  assert.equal(summary.jobsWithTokens, 1);
  assert.equal(summary.jobsWithCost, 1);
  assert.equal(summary.jobCount, 2);
});

test('dependencyWaitReason explains dependency and queue states', () => {
  const dependency = job({ relay_id: 'relay-dependency', label: 'Build API', status: 'running' });
  const waiting = job({ depends_on: [dependency.relay_id] });
  assert.equal(dependencyWaitReason(waiting, new Map([[dependency.relay_id, dependency]])), 'Waiting for Build API.');

  const blockedDependency = job({ relay_id: 'relay-failed', label: 'Compile', status: 'failed' });
  assert.equal(
    dependencyWaitReason({ ...waiting, depends_on: [blockedDependency.relay_id] }, new Map([[blockedDependency.relay_id, blockedDependency]])),
    'Blocked by Compile.',
  );
});
