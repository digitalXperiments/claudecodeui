import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseDispatchDecision,
  shouldUseSeedFirstWave,
  toPlanSteps,
  usesDynamicDispatchLoop,
} from '@/modules/swarm/swarm-dispatch.service.js';

test('parseDispatchDecision treats done as empty batch', () => {
  const decision = parseDispatchDecision('{"done": true, "reason": "goal met", "tasks": [{"title":"x"}]}');
  assert.equal(decision.done, true);
  assert.equal(decision.valid, true);
  assert.equal(decision.blocked, false);
  assert.equal(decision.tasks.length, 0);
  assert.match(decision.reason, /goal met/);
});

test('parseDispatchDecision extracts a worker batch', () => {
  const decision = parseDispatchDecision(`{
    "status": "dispatch",
    "reason": "explore then implement",
    "tasks": [
      { "title": "Map auth", "kind": "explorer", "difficulty": "basic", "prompt": "find auth files", "scope": ["src/auth"] },
      { "title": "Fix login", "kind": "implementer", "difficulty": "advanced", "prompt": "implement login", "verificationCommands": ["npm test -- login"] }
    ]
  }`);
  assert.equal(decision.done, false);
  assert.equal(decision.valid, true);
  assert.equal(decision.tasks.length, 2);
  assert.equal(decision.tasks[0].kind, 'explorer');
  assert.equal(decision.tasks[1].difficulty, 'advanced');
  assert.deepEqual(decision.tasks[1].verificationCommands, ['npm test -- login']);
});

test('malformed or empty dispatch output never masquerades as done', () => {
  const prose = parseDispatchDecision('I think the goal is probably complete.');
  assert.equal(prose.valid, false);
  assert.equal(prose.done, false);

  const empty = parseDispatchDecision('{"status":"dispatch","reason":"continue","tasks":[]}');
  assert.equal(empty.valid, false);
  assert.equal(empty.done, false);
});

test('blocked is explicit and distinct from goal completion', () => {
  const decision = parseDispatchDecision('{"status":"blocked","reason":"missing signing key"}');
  assert.equal(decision.valid, true);
  assert.equal(decision.blocked, true);
  assert.equal(decision.done, false);
});

test('toPlanSteps assigns unique ids and a new wave', () => {
  const steps = toPlanSteps(
    [{ title: 'A', kind: 'implementer', difficulty: 'medium', prompt: 'a', scope: [], acceptanceCriteria: [], verificationCommands: [], dependsOn: [] }],
    3,
    [{ id: 's1', title: 'seed', kind: 'explorer', prompt: 'p', wave: 1 }],
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].id, 'd3-1');
  assert.equal(steps[0].wave, 2);
});

test('dynamic dispatch skips the seed DAG except on a targeted retry', () => {
  assert.equal(usesDynamicDispatchLoop(true, null), true);
  assert.equal(usesDynamicDispatchLoop(true, undefined), true);
  assert.equal(usesDynamicDispatchLoop(false, null), false);
  assert.equal(usesDynamicDispatchLoop(true, 'step-1'), false);
});

test('empty first dispatch with unused seed falls back to the seed wave', () => {
  assert.equal(
    shouldUseSeedFirstWave({ done: true, taskCount: 0, findingsCount: 0, unusedSeedCount: 2 }),
    true,
  );
  assert.equal(
    shouldUseSeedFirstWave({ done: true, taskCount: 0, findingsCount: 1, unusedSeedCount: 2 }),
    false,
  );
  assert.equal(
    shouldUseSeedFirstWave({ done: false, taskCount: 2, findingsCount: 0, unusedSeedCount: 2 }),
    false,
  );
});
