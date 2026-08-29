import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProgressTracker,
  digestDecisions,
  finishModeVerdict,
  isSlowFailure,
  needsDriftAudit,
  reviewHasEvidence,
  splitCanaryGroup,
  stepLineageDepth,
  MAX_PERSISTED_DECISIONS,
  MAX_REMEDIATION_LINEAGE,
} from '@/modules/swarm/swarm-guardrails.service.js';
import type { SwarmPlanStep, SwarmSupervisorDecision } from '@/modules/swarm/swarm.types.js';

function decision(tick: number): SwarmSupervisorDecision {
  return {
    tick,
    at: new Date().toISOString(),
    action: 'dispatch',
    kind: 'implementer',
    title: `t${tick}`,
    reason: `reason ${tick}`,
    policy: 'implementer_fix',
    coerced: false,
    stepId: null,
  };
}

function step(id: string, replacesStepId?: string): SwarmPlanStep {
  return {
    id,
    wave: 1,
    kind: 'implementer',
    title: id,
    prompt: '',
    ...(replacesStepId ? { replacesStepId } : {}),
  } as SwarmPlanStep;
}

// ——— P1 ———

test('digestDecisions keeps the log bounded and summarizes dropped ticks', () => {
  const decisions = Array.from({ length: MAX_PERSISTED_DECISIONS + 10 }, (_, i) => decision(i + 1));
  const { kept, digest } = digestDecisions(decisions);
  assert.equal(kept.length, MAX_PERSISTED_DECISIONS);
  assert.ok(digest);
  assert.match(digest!, /earlier ticks \(1–10\)/);
  assert.match(digest!, /10× dispatch:implementer/);
});

test('digestDecisions is a no-op under the cap', () => {
  const { kept, digest } = digestDecisions([decision(1)]);
  assert.equal(kept.length, 1);
  assert.equal(digest, null);
});

// ——— P2 ———

test('stepLineageDepth counts the replacement chain and stops at cycles', () => {
  const steps = [step('a'), step('b', 'a'), step('c', 'b'), step('d', 'c')];
  assert.equal(stepLineageDepth(steps[0], steps), 0);
  assert.equal(stepLineageDepth(steps[1], steps), 1);
  assert.equal(stepLineageDepth(steps[3], steps), 3);

  // A cycle must terminate; it may count nodes before revisiting.
  const cyclic = [step('x', 'y'), step('y', 'x')];
  assert.ok(stepLineageDepth(cyclic[0], cyclic) <= cyclic.length);
});

test(`lineage cap leaves room for exactly ${MAX_REMEDIATION_LINEAGE - 1} replacements`, () => {
  // After two replacements (depth 2), a third clone would be depth 3 — blocked.
  const steps = [step('a'), step('b', 'a'), step('c', 'b')];
  assert.equal(stepLineageDepth(steps[2], steps) + 1 >= MAX_REMEDIATION_LINEAGE, true);
});

test('ProgressTracker demands rethink only after two zero-progress cycles', () => {
  const tracker = new ProgressTracker();
  assert.equal(tracker.recordCycle(0), false, 'first empty cycle warns nothing');
  assert.equal(tracker.recordCycle(0), true, 'second empty cycle forces a rethink');
  assert.equal(tracker.recordCycle(2), false, 'progress resets the counter');
  assert.equal(tracker.recordCycle(0), false);
  assert.equal(tracker.recordCycle(0), true);
});

test('reviewHasEvidence requires cited specifics for changes-requested', () => {
  assert.equal(reviewHasEvidence([{ severity: 'high' }], null), true, 'packets are evidence');
  assert.equal(
    reviewHasEvidence([], 'src/api/auth.ts still calls the removed verifyToken helper; fix before merge'),
    true,
    'a concrete error text is evidence',
  );
  assert.equal(reviewHasEvidence([], 'needs changes'), false, 'bare verdicts carry no evidence');
  assert.equal(reviewHasEvidence([], ''), false);
});

// ——— P4 ———

test('splitCanaryGroup isolates one seat only when a canary is required', () => {
  const items = ['a', 'b', 'c'];
  const armed = splitCanaryGroup(items, true);
  assert.deepEqual(armed.canary, ['a']);
  assert.deepEqual(armed.rest, ['b', 'c']);
  assert.equal(armed.canaryUsed, true);

  const notArmed = splitCanaryGroup(items, false);
  assert.deepEqual(notArmed.canary, items);
  assert.deepEqual(notArmed.rest, []);
  assert.equal(notArmed.canaryUsed, false);

  const single = splitCanaryGroup(['only'], true);
  assert.deepEqual(single.canary, ['only']);
  assert.equal(single.canaryUsed, false);
});

// ——— P6 ———

test('drift audit fires every N stale ticks', () => {
  assert.equal(needsDriftAudit(0), false);
  assert.equal(needsDriftAudit(3), false);
  assert.equal(needsDriftAudit(4), true);
  assert.equal(needsDriftAudit(8), true);
});

// ——— P7 ———

test('finishModeVerdict arms inside the escape reserve only', () => {
  const soft = 100;
  assert.equal(finishModeVerdict(50, soft).finishMode, false);
  assert.equal(finishModeVerdict(84.9, soft).finishMode, false);
  const armed = finishModeVerdict(86, soft);
  assert.equal(armed.finishMode, true);
  assert.ok(armed.reason);
  assert.match(armed.reason!, /\$86\.00/);
  assert.equal(finishModeVerdict(50, null).finishMode, false, 'no cap — never finishes early');
  assert.equal(finishModeVerdict(50, 0).finishMode, false);
});

// ——— P8 ———

test('isSlowFailure needs both the multiplier and a time floor', () => {
  const median = 5 * 60 * 1000;
  assert.equal(isSlowFailure(median * 2 + 1, median), true, 'over 2× median');
  assert.equal(isSlowFailure(median * 2, median), false, 'exactly 2× is not slow yet');
  assert.equal(isSlowFailure(median * 3, median), false === isSlowFailure(30_000, median));
  assert.equal(isSlowFailure(90 * 60 * 1000, median), true);
  // Below the floor: even an absurd multiple does not preempt (fast roles).
  assert.equal(isSlowFailure(60_000, 10_000), false, 'under the 2-minute floor');
  assert.equal(isSlowFailure(90 * 60 * 1000, null), false, 'unmeasured role never preempts');
});
