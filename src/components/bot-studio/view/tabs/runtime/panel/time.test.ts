import assert from 'node:assert/strict';
import test from 'node:test';

import { expiryCountdown, relativeTime, shortDateTime } from './time';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (ms: number): string => new Date(NOW + ms).toISOString();

test('relativeTime handles past, future, blank and invalid values', () => {
  assert.equal(relativeTime(null, NOW), 'never');
  assert.equal(relativeTime('nope', NOW), 'unknown');
  assert.equal(relativeTime(at(-20_000), NOW), 'just now');
  assert.equal(relativeTime(at(-5 * 60_000), NOW), '5m ago');
  assert.equal(relativeTime(at(-3 * 3_600_000), NOW), '3h ago');
  assert.equal(relativeTime(at(-2 * 86_400_000), NOW), '2d ago');
  assert.equal(relativeTime(at(10 * 60_000), NOW), 'in 10m');
});

test('expiryCountdown labels never, soon, later and expired rules', () => {
  assert.deepEqual(expiryCountdown(null, NOW), { expired: false, label: 'Never expires', soon: false });
  assert.deepEqual(expiryCountdown(at(-1), NOW), { expired: true, label: 'Expired', soon: false });
  assert.deepEqual(expiryCountdown(at(20 * 60_000), NOW), { expired: false, label: 'Expires in 20m', soon: true });
  assert.deepEqual(expiryCountdown(at(5 * 3_600_000 + 30 * 60_000), NOW), { expired: false, label: 'Expires in 5h 30m', soon: true });
  assert.deepEqual(expiryCountdown(at(3 * 86_400_000 + 2 * 3_600_000), NOW), { expired: false, label: 'Expires in 3d 2h', soon: false });
  assert.equal(expiryCountdown('bad', NOW).label, 'Unknown expiry');
});

test('shortDateTime tolerates blank input', () => {
  assert.equal(shortDateTime(null), '—');
  assert.equal(shortDateTime('garbage'), '—');
  assert.ok(shortDateTime('2026-10-01T12:00:00Z').length > 4);
});
