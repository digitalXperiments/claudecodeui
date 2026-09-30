import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTrigger } from './runFormatting';

test('formatTrigger labels known run triggers', () => {
  assert.equal(formatTrigger('schedule'), 'Scheduled');
  assert.equal(formatTrigger('manual'), 'Manual');
  assert.equal(formatTrigger('replay'), 'Replay');
  assert.equal(formatTrigger('preview'), 'Preview');
  assert.equal(formatTrigger(null), 'Manual');
  assert.equal(formatTrigger('section-workshop'), 'Section workshop');
});
