import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySupervisorPolicy,
  blockerHash,
  extractCritiquePackets,
  isVagueReview,
  parseSupervisorDecision,
  routeSupervisorPolicy,
  shouldRefuseReviewer,
  applySupervisorEvent,
  classifySupervisorEvent,
  emptyGoalCard,
  compileImplementerBrief,
} from '@/modules/swarm/swarm-supervisor.service.js';
import type { ParsedMemberFindings } from '@/modules/swarm/swarm-agent.service.js';
import type { SwarmWorktreeFingerprint } from '@/modules/swarm/swarm.types.js';

function findings(partial: Partial<ParsedMemberFindings>): ParsedMemberFindings {
  return {
    summary: '',
    findings: [],
    changedFiles: [],
    verification: [],
    acceptance: [],
    recommendations: [],
    risks: [],
    severity: 'info',
    rawText: '',
    ...partial,
  };
}

const cleanTree: SwarmWorktreeFingerprint = { head: 'abc1234', dirty: false, signature: 'abc1234|' };
const dirtyTree: SwarmWorktreeFingerprint = {
  head: 'abc1234',
  dirty: true,
  signature: 'abc1234|src/foo.ts',
};

test('extractCritiquePackets pulls file-level asks from findings and unmet acceptance', () => {
  const packets = extractCritiquePackets(
    findings({
      summary: 'Release blockers remain',
      findings: ['CRITICAL — Sources/CanonG3010Manager/Protocol/DebugOperations.swift:39 expose debug ops'],
      recommendations: ['Provide a release-readiness verdict'],
      acceptance: [
        { criterion: 'Audit concurrency', met: false, evidence: 'no test for cancellation' },
        { criterion: 'Build is green', met: true, evidence: '355/355' },
      ],
      severity: 'critical',
    }),
    'Acceptance evidence missing or unmet: Audit concurrency; lifecycle permissions',
  );
  assert.ok(packets.some((packet) => packet.file?.includes('DebugOperations.swift')));
  assert.ok(packets.some((packet) => /Audit concurrency/i.test(packet.ask)));
  assert.equal(isVagueReview(packets), false);
});

test('a review with no files is vague', () => {
  const packets = extractCritiquePackets(
    findings({ findings: ['Looks unfinished'], recommendations: ['Try harder'] }),
    null,
  );
  assert.equal(isVagueReview(packets), true);
});

test('policy: reviewer needs_changes on an unchanged tree forces an implementer', () => {
  let card = emptyGoalCard(8);
  const event = classifySupervisorEvent({
    stepKind: 'reviewer',
    stepId: 'review-1',
    seatLabel: 'Codex Sol Reviewer',
    output: null,
    error: 'Acceptance evidence missing or unmet: Audit concurrency',
    failed: true,
    needsChanges: true,
    packets: [
      {
        file: 'Sources/Foo.swift',
        severity: 'critical',
        ask: 'Audit concurrency',
        evidence: 'missing tests',
      },
    ],
    fingerprint: cleanTree,
  });
  card = applySupervisorEvent(card, event);
  const policy = routeSupervisorPolicy(card, event);
  assert.equal(policy.kind, 'implementer');
  assert.equal(policy.requiresChanges, true);
  assert.equal(policy.refuseReviewer, true);
  assert.equal(shouldRefuseReviewer(card, cleanTree), true);
  assert.equal(shouldRefuseReviewer(card, dirtyTree), false);

  const coerced = applySupervisorPolicy(
    policy,
    parseSupervisorDecision(JSON.stringify({
      action: 'dispatch',
      kind: 'reviewer',
      title: 'Review again',
      prompt: 'Look once more',
      reason: 'I want another review',
    })),
  );
  assert.equal(coerced.kind, 'implementer');
  assert.equal(coerced.action, 'dispatch');
});

test('policy: implementer landing a diff requests a reviewer', () => {
  const card = emptyGoalCard(8);
  const event = classifySupervisorEvent({
    stepKind: 'implementer',
    stepId: 'impl-1',
    seatLabel: 'Builder',
    output: 'fixed',
    error: null,
    failed: false,
    needsChanges: false,
    packets: [],
    fingerprint: dirtyTree,
  });
  const policy = routeSupervisorPolicy(applySupervisorEvent(card, event), event);
  assert.equal(policy.kind, 'reviewer');
  assert.equal(policy.refuseReviewer, false);
});

test('reviewer SHIP plus stale requiresChanges is treated as approved', () => {
  const event = classifySupervisorEvent({
    stepKind: 'reviewer',
    stepId: 'review-1',
    seatLabel: 'Codex Sol Reviewer',
    output: 'SHIP. I independently reviewed the dirty tree. Ready to merge.',
    error: 'Step required source changes but the agent left the workspace source tree unchanged',
    failed: true,
    needsChanges: false,
    packets: [],
    fingerprint: dirtyTree,
  });
  assert.equal(event.kind, 'reviewer_approved');
  const policy = routeSupervisorPolicy(emptyGoalCard(8), event);
  assert.equal(policy.action, 'done');
});

test('policy: reviewer approval ends the loop', () => {
  const card = emptyGoalCard(8);
  const event = classifySupervisorEvent({
    stepKind: 'reviewer',
    stepId: 'review-2',
    seatLabel: 'Reviewer',
    output: 'lgtm',
    error: null,
    failed: false,
    needsChanges: false,
    packets: [],
    fingerprint: dirtyTree,
  });
  const policy = routeSupervisorPolicy(applySupervisorEvent(card, event), event);
  assert.equal(policy.action, 'done');
});

test('policy refuses done while change requests are still open', () => {
  let card = emptyGoalCard(8);
  const event = classifySupervisorEvent({
    stepKind: 'reviewer',
    stepId: 'review-1',
    seatLabel: 'Reviewer',
    output: null,
    error: 'unmet',
    failed: true,
    needsChanges: true,
    packets: [{ file: 'a.ts', severity: 'critical', ask: 'fix the leak', evidence: 'line 12' }],
    fingerprint: cleanTree,
  });
  card = applySupervisorEvent(card, event);
  const policy = routeSupervisorPolicy(card, event);
  const applied = applySupervisorPolicy(
    policy,
    parseSupervisorDecision(JSON.stringify({ action: 'done', reason: 'close enough' })),
  );
  assert.equal(applied.action, 'dispatch');
  assert.equal(applied.kind, 'implementer');
});

test('compileImplementerBrief lists critique packets as the brief', () => {
  const brief = compileImplementerBrief({
    packets: [{ file: 'a.ts', severity: 'critical', ask: 'close the leak', evidence: 'line 12' }],
    orchestratorPrompt: 'Please fix it.',
    lastError: 'Acceptance evidence missing or unmet: close the leak',
  });
  assert.match(brief, /Implement the changes requested by the reviewer/);
  assert.match(brief, /a\.ts/);
  assert.match(brief, /Please fix it/);
});

test('same blocker hash is stable across wording noise', () => {
  const a = blockerHash([{ file: 'Foo.swift', severity: 'critical', ask: 'Audit concurrency!', evidence: '' }]);
  const b = blockerHash([{ file: 'foo.swift', severity: 'warning', ask: 'audit concurrency', evidence: 'x' }]);
  assert.equal(a, b);
});
