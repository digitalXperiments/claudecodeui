import assert from 'node:assert/strict';
import test from 'node:test';

import { formatContinuityCountdown, formatContinuityWaitingLabel } from '../../utils/continuityUi';

test('formatContinuityCountdown presents due, minute, and hour reset windows', () => {
  const now = Date.parse('2026-09-04T00:00:00.000Z');
  assert.equal(formatContinuityCountdown('2026-09-03T23:59:00.000Z', now), 'due now');
  assert.equal(formatContinuityCountdown('2026-09-04T00:12:00.000Z', now), '12m');
  assert.equal(formatContinuityCountdown('2026-09-04T02:15:00.000Z', now), '2h 15m');
  assert.equal(formatContinuityCountdown(null, now), null);
});

test('formatContinuityWaitingLabel shows usage polling instead of the safety-cap timer', () => {
  const now = Date.parse('2026-09-04T00:00:00.000Z');
  assert.equal(formatContinuityWaitingLabel({
    action: 'resume',
    retryAt: '2026-09-04T06:00:00.000Z',
    resetTimeSource: 'fallback',
    sourceProvider: 'claude',
  }, now), 'checking usage');
  assert.equal(formatContinuityWaitingLabel({
    action: 'resume',
    retryAt: '2026-09-04T00:12:00.000Z',
    resetTimeSource: 'message',
    sourceProvider: 'claude',
  }, now), '12m');
});
