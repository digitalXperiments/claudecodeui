import test from 'node:test';
import assert from 'node:assert/strict';

import {
  channelLabel, episodeDurationMs, formatCostUsd, formatDue, formatRelativeTime, localInputToIso, toLocalInputValue, triggerKindLabels,
} from './runtimeFormat';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test('formatRelativeTime covers past, future, and the just-now window', () => {
  assert.equal(formatRelativeTime(at(-10_000), NOW), 'just now');
  assert.equal(formatRelativeTime(at(10_000), NOW), 'just now');
  assert.equal(formatRelativeTime(at(-5 * 60_000), NOW), '5m ago');
  assert.equal(formatRelativeTime(at(2 * 3_600_000), NOW), 'in 2h');
  assert.equal(formatRelativeTime(at(-3 * 86_400_000), NOW), '3d ago');
  assert.equal(formatRelativeTime(at(-45_000), NOW), '45s ago');
  assert.equal(formatRelativeTime(null, NOW), 'unknown time');
  assert.equal(formatRelativeTime('garbage', NOW), 'unknown time');
});

test('formatDue flags overdue and due-soon commitments', () => {
  assert.deepEqual(formatDue(at(3 * 3_600_000), NOW), { label: 'due in 3h', overdue: false, soon: true });
  assert.deepEqual(formatDue(at(2 * 86_400_000), NOW), { label: 'due in 2d', overdue: false, soon: false });
  assert.deepEqual(formatDue(at(-2 * 86_400_000), NOW), { label: 'overdue 2d', overdue: true, soon: false });
  assert.deepEqual(formatDue(at(5_000), NOW), { label: 'due now', overdue: false, soon: true });
  assert.deepEqual(formatDue('nope', NOW), { label: 'no due date', overdue: false, soon: false });
});

test('formatCostUsd keeps precision for sub-cent runs', () => {
  assert.equal(formatCostUsd(null), '—');
  assert.equal(formatCostUsd(0), '$0.00');
  assert.equal(formatCostUsd(0.00234), '$0.0023');
  assert.equal(formatCostUsd(1.5), '$1.50');
});

test('episodeDurationMs counts running episodes up to now', () => {
  assert.equal(episodeDurationMs({ started_at: at(-90_000), finished_at: at(-30_000) }, NOW), 60_000);
  assert.equal(episodeDurationMs({ started_at: at(-90_000), finished_at: null }, NOW), 90_000);
  assert.equal(episodeDurationMs({ started_at: 'bad', finished_at: null }, NOW), null);
});

test('triggerKindLabels splits, dedupes, and humanises', () => {
  assert.deepEqual(triggerKindLabels('cron, manual,cron'), ['Schedule', 'Manual wake']);
  assert.deepEqual(triggerKindLabels('operator_message'), ['Operator message']);
  assert.deepEqual(triggerKindLabels('some_new_kind'), ['Some new kind']);
  assert.deepEqual(triggerKindLabels(''), []);
  assert.deepEqual(triggerKindLabels(null), []);
});

test('channelLabel defaults to in-app', () => {
  assert.equal(channelLabel('telegram'), 'Telegram');
  assert.equal(channelLabel('slack'), 'Slack');
  assert.equal(channelLabel(''), 'In-app');
  assert.equal(channelLabel('inapp'), 'In-app');
  assert.equal(channelLabel('email'), 'Email');
});

test('datetime-local conversion round-trips and rejects empties', () => {
  assert.equal(localInputToIso(''), null);
  assert.equal(localInputToIso('not a date'), null);
  const local = toLocalInputValue(NOW);
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  const iso = localInputToIso(local);
  assert.ok(iso);
  assert.ok(Math.abs(Date.parse(iso) - NOW) < 60_000);
});
