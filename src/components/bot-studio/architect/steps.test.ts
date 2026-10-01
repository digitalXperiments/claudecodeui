import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_ARCHITECT_STEPS, architectSteps, stepEyebrow, stepNumber } from './steps';

test('the classic wizard is exactly the original eight steps', () => {
  const steps = architectSteps(false);
  assert.deepEqual(steps.map((step) => step.title), ['Purpose', 'Agent', 'Brief', 'Tools', 'Triggers', 'Outputs & actions', 'Guardrails', 'Review']);
  assert.equal(steps.find((step) => step.id === 'triggers')?.hint, 'When a tick runs');
  assert.equal(steps.find((step) => step.id === 'guardrails')?.hint, 'Safety recap');
});

test('the runtime wizard adds Goals and Reach me and stays within ten steps', () => {
  const steps = architectSteps(true);
  assert.ok(steps.length <= MAX_ARCHITECT_STEPS);
  const ids = steps.map((step) => step.id);
  assert.deepEqual(ids, ['purpose', 'agent', 'brief', 'goals', 'tools', 'triggers', 'outputs', 'guardrails', 'reach', 'review']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'purpose');
  assert.equal(ids[ids.length - 1], 'review');
});

test('steps are found by id, so inserting one never re-points a jump', () => {
  assert.equal(stepNumber(architectSteps(false), 'triggers'), 5);
  assert.equal(stepNumber(architectSteps(true), 'triggers'), 6);
  assert.equal(stepNumber(architectSteps(true), 'reach'), 9);
  // A step this wizard does not have falls back to the first, never to a bogus index.
  assert.equal(stepNumber(architectSteps(false), 'goals'), 1);
});

test('eyebrows follow the live position', () => {
  assert.equal(stepEyebrow(architectSteps(false), 'purpose'), '01 · Purpose');
  assert.equal(stepEyebrow(architectSteps(false), 'outputs'), '06 · Outputs & actions');
  assert.equal(stepEyebrow(architectSteps(false), 'guardrails'), '07 · Guardrails');
  assert.equal(stepEyebrow(architectSteps(true), 'guardrails'), '08 · Guardrails');
  assert.equal(stepEyebrow(architectSteps(true), 'review'), '10 · Review');
});
