import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRelayRoutingPlan,
  classifyRelayFailure,
  decideRelayFallback,
  nextRelayProfile,
  relayCandidateKey,
  type RelayRoutingCandidate,
} from '@/modules/agent-relay/relay-routing-policy.js';

const candidate = (
  provider: RelayRoutingCandidate['provider'],
  model: string,
  overrides: Partial<RelayRoutingCandidate> = {},
): RelayRoutingCandidate => ({
  provider,
  catalog: {
    value: model,
    label: model,
    resolvedModel: `${model}-resolved`,
    effort: { default: 'medium', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
  },
  runtime: { installed: true, authenticated: true, available: true },
  seats: { readOnly: true, mcp: true },
  ...overrides,
});

const request = (candidates: readonly RelayRoutingCandidate[], extra = {}) => ({
  taskClass: 'implement' as const,
  optimize: 'quality' as const,
  mode: 'read_only' as const,
  candidates,
  ...extra,
});

test('routes only supplied runnable candidates and selects catalog model/effort fields', () => {
  const plan = buildRelayRoutingPlan(request([
    candidate('claude', 'opus'),
    candidate('codex', 'gpt', { runtime: { installed: true, authenticated: false, available: true } }),
    candidate('cursor', 'fast', { seats: { readOnly: false, mcp: true } }),
  ]));
  assert.equal(plan.selected.selected.provider, 'claude');
  assert.deepEqual(plan.selected.selected, {
    provider: 'claude', model: 'opus', resolvedModel: 'opus-resolved', effort: 'medium',
  });
  assert.equal(plan.rejected.length, 2);
  assert.match(plan.rejected[0]!.reasons.join('; '), /authenticated/);
  assert.match(plan.provenance.join('; '), /allowed catalog/);
});

test('explicit model and effort errors never silently fall back', () => {
  assert.throws(
    () => buildRelayRoutingPlan(request([candidate('claude', 'opus')], { selection: { provider: 'codex', model: 'missing' } })),
    (error: unknown) => error instanceof Error && error.name === 'RelayRoutingPolicyError'
      && 'INVALID_SELECTION' === (error as unknown as { code: string }).code,
  );
  assert.throws(
    () => buildRelayRoutingPlan(request([candidate('claude', 'opus')], { selection: { model: 'opus', effort: 'turbo' } })),
    /not advertised/,
  );
  assert.throws(
    () => buildRelayRoutingPlan(request([
      candidate('claude', 'opus', { runtime: { installed: true, authenticated: false, available: true } }),
    ], { selection: { provider: 'claude', model: 'opus' } })),
    (error: unknown) => error instanceof Error
      && (error as unknown as { code: string }).code === 'INVALID_SELECTION',
  );
});

test('required seats are hard eligibility constraints', () => {
  assert.throws(
    () => buildRelayRoutingPlan(request([candidate('claude', 'opus', { seats: { readOnly: false, mcp: true } })])),
    /No eligible|runnable|candidate/i,
  );
  assert.throws(
    () => buildRelayRoutingPlan({ ...request([candidate('claude', 'opus', { seats: { readOnly: true, mcp: false } })]), requiresMcp: true }),
    /candidate/i,
  );
});

test('measured outcomes rank ahead of cold-start guesses and unknown cost is positive', () => {
  const unknown = candidate('claude', 'unknown', { qualityScore: 0.9 });
  const measured = candidate('codex', 'measured', { qualityScore: 0.5 });
  const plan = buildRelayRoutingPlan({
    ...request([unknown, measured]),
    optimize: 'quality',
    outcomes: {
      [relayCandidateKey(measured)]: { attempts: 8, successes: 8, firstTrySuccessRate: 1, qualityScore: 0.99 },
    },
  });
  assert.equal(plan.selected.selected.model, 'measured');
  const costPlan = buildRelayRoutingPlan({ ...request([unknown]), optimize: 'cost' });
  assert.equal(costPlan.selected.estimatedCostUsd, 1);
  assert.equal(costPlan.selected.costKnown, false);
  assert.ok(costPlan.selected.estimatedCostUsd > 0);
});

test('failure classification covers infrastructure and provider classes', () => {
  assert.equal(classifyRelayFailure({ status: 429, message: 'throttled' }).kind, 'rate_limit');
  assert.equal(classifyRelayFailure({ code: 'insufficient_quota' }).kind, 'quota');
  assert.equal(classifyRelayFailure({ status: 401, message: 'expired token' }).kind, 'auth');
  assert.equal(classifyRelayFailure({ code: 'EACCES' }).kind, 'permission');
  assert.equal(classifyRelayFailure({ code: 'ENOENT', message: 'spawn failed' }).kind, 'spawn');
  assert.equal(classifyRelayFailure({ code: 'ETIMEDOUT' }).kind, 'timeout');
  assert.equal(classifyRelayFailure(new Error('worker returned invalid answer')).kind, 'task_failure');
});

test('fallback is bounded, avoids attempted candidates, and protects writes', () => {
  const first = candidate('claude', 'first');
  const second = candidate('codex', 'second');
  const plan = buildRelayRoutingPlan(request([first, second]));
  const context = {
    mode: 'read_only' as const,
    failure: 'timeout' as const,
    sideEffectsStarted: false,
    usableOutput: false,
    attemptedCandidates: [relayCandidateKey(first)],
  };
  const next = nextRelayProfile(plan, context);
  assert.equal(next.profile?.selected.model, 'second');
  assert.equal(next.decision.action, 'retry_next_candidate');
  assert.equal(nextRelayProfile(plan, { ...context, attemptedCandidates: [relayCandidateKey(first), relayCandidateKey(second)] }).profile, null);
  assert.equal(decideRelayFallback({ ...context, mode: 'read_only', usableOutput: true }).action, 'stop');
  assert.equal(decideRelayFallback({ ...context, mode: 'isolated_write', sideEffects: 'unknown' }).action, 'require_explicit_recovery');
  assert.equal(decideRelayFallback({ ...context, mode: 'isolated_write', sideEffects: 'started' }).action, 'require_explicit_recovery');
  assert.equal(decideRelayFallback({ ...context, mode: 'isolated_write', sideEffects: 'none', fallbackCount: 1 }).action, 'stop');
});
