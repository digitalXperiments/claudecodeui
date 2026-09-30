import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotEpisode, BotRuntimeStatus } from '../../types/botRuntime';

import { STRIP_EPISODE_BOT_CAP, botsToSample, runningTitles, runtimeState, summarizeEpisodes } from './runtimeStripModel';

const NOW = new Date(2026, 9, 1, 15, 0, 0); // local time, 1 Oct 2026 15:00

function episode(overrides: Partial<BotEpisode>): BotEpisode {
  return {
    episode_id: 'e', bot_id: 'a', status: 'succeeded', trigger_kinds: '', event_ids: [], run_ids: [], plan_text: '', summary: '',
    outcome: {}, feedback: [], tainted: false, cost_usd: 0, bot_version: null,
    started_at: new Date(2026, 9, 1, 9, 0, 0).toISOString(), finished_at: null, ...overrides,
  };
}

const status = (overrides: Partial<BotRuntimeStatus> = {}): BotRuntimeStatus => ({ enabled: true, running: [], queuedWakes: 0, queuedEvents: 0, leases: [], ...overrides });

test('runtimeState covers running, idle, stopped, unknown and error', () => {
  assert.deepEqual(runtimeState(status({ running: ['a', 'b'] }), null), { state: 'running', label: 'Running', detail: '2 active', tone: 'success' });
  assert.equal(runtimeState(status(), null).detail, 'Idle');
  const stopped = runtimeState(status({ enabled: false }), null);
  assert.equal(stopped.state, 'stopped');
  assert.match(stopped.detail, /is off/, 'the server now reports forced-off explicitly, so flag-off is just "off"');
  assert.equal(runtimeState(null, null).label, 'Checking');
  assert.deepEqual([runtimeState(null, 'boom').state, runtimeState(null, 'boom').detail], ['unknown', 'boom']);
  // A stale status wins over a transient refresh error.
  assert.equal(runtimeState(status(), 'late error').state, 'running');
});

test('summarizeEpisodes counts tainted/failed in the last 24h and cost for the local day', () => {
  const summary = summarizeEpisodes({
    a: [
      episode({ tainted: true, cost_usd: 0.5 }),
      episode({ status: 'failed', cost_usd: 0.25 }),
      // Yesterday evening: inside 24h, outside today.
      episode({ tainted: true, started_at: new Date(2026, 8, 30, 20, 0, 0).toISOString(), cost_usd: 9 }),
      // Two days ago: outside both.
      episode({ tainted: true, started_at: new Date(2026, 8, 29, 9, 0, 0).toISOString(), cost_usd: 9 }),
      episode({ started_at: 'garbage', tainted: true, cost_usd: 9 }),
    ],
    b: [episode({ tainted: true, cost_usd: 1 })],
  }, NOW);
  assert.deepEqual(summary, { taintedLast24h: 3, failedLast24h: 1, costToday: 1.75 });
  assert.deepEqual(summarizeEpisodes({}, NOW), { taintedLast24h: 0, failedLast24h: 0, costToday: 0 });
});

test('runningTitles maps ids to titles', () => {
  assert.deepEqual(runningTitles(status({ running: ['a', 'x'] }), (id) => (id === 'a' ? 'Alpha' : id)), ['Alpha', 'x']);
  assert.deepEqual(runningTitles(null, (id) => id), []);
});

test('botsToSample caps the fan-out', () => {
  const many = Array.from({ length: STRIP_EPISODE_BOT_CAP + 10 }, (_, i) => ({ section_id: String(i) }));
  assert.equal(botsToSample(many).length, STRIP_EPISODE_BOT_CAP);
  assert.equal(botsToSample(many.slice(0, 3)).length, 3);
});

test('runtimeState reports forced-off and not-running instead of trusting the flag', () => {
  assert.equal(runtimeState(status({ runtime_running: false, forced_off: true }), null).label, 'Forced off');
  const stopped = runtimeState(status({ runtime_running: false }), null);
  assert.equal(stopped.state, 'stopped');
  assert.match(stopped.detail, /failed to start/);
  assert.equal(runtimeState(status({ runtime_running: true }), null).state, 'running');
  assert.equal(runtimeState(status(), null).state, 'running', 'older servers without runtime_running fall back to the flag');
});
