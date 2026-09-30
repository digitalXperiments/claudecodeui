import test from 'node:test';
import assert from 'node:assert/strict';

import type { BotEpisode } from '../../../../types/botRuntime';

import {
  countEpisodesByStatus, episodeRunToBotRun, filterEpisodes, outcomeHasContent, parseEpisodeOutcome, prettyJson, redactForDisplay, summarizeArgs,
} from './episodes';

function episode(id: string, status: BotEpisode['status']): BotEpisode {
  return {
    episode_id: id, bot_id: 'b', status, trigger_kinds: 'manual', event_ids: [], run_ids: [], plan_text: '', summary: id, outcome: {},
    feedback: [], tainted: false, cost_usd: 0, bot_version: 1, started_at: '2026-10-01T10:00:00Z', finished_at: null,
  };
}

const EPISODES = [episode('a', 'running'), episode('b', 'failed'), episode('c', 'succeeded'), episode('d', 'failed')];

test('countEpisodesByStatus tallies each status', () => {
  assert.deepEqual(countEpisodesByStatus(EPISODES), { all: 4, running: 1, succeeded: 1, failed: 2, interrupted: 0 });
});

test('filterEpisodes by status without a search', () => {
  assert.deepEqual(filterEpisodes(EPISODES, 'failed', null).episodes.map((e) => e.episode_id), ['b', 'd']);
  assert.equal(filterEpisodes(EPISODES, 'all', null).episodes.length, 4);
});

test('filterEpisodes ranks by search hit order and surfaces unloaded hits', () => {
  const hits = [{ episode_id: 'd', summary: 'x', score: 2 }, { episode_id: 'zzz', summary: 'old', score: 1.5 }, { episode_id: 'a', summary: 'y', score: 1 }];
  const all = filterEpisodes(EPISODES, 'all', hits);
  assert.deepEqual(all.episodes.map((e) => e.episode_id), ['d', 'a']);
  assert.deepEqual(all.extra.map((h) => h.episode_id), ['zzz']);
  const failed = filterEpisodes(EPISODES, 'failed', hits);
  assert.deepEqual(failed.episodes.map((e) => e.episode_id), ['d']);
  assert.deepEqual(failed.extra, []);
  assert.deepEqual(filterEpisodes(EPISODES, 'all', []).episodes, []);
});

test('parseEpisodeOutcome reads the kernel outcome shape', () => {
  const view = parseEpisodeOutcome({
    created: 2, skipped: 1, item_ids: ['i1', 'i2', 7], commitments: 1, goal_updates: 3, notified: true, reply: 'Done.',
    goal_notes: ['g: status "achieved" ignored (tainted episode)'], commitment_errors: ['bad due date'],
  });
  assert.equal(view.created, 2);
  assert.equal(view.skipped, 1);
  assert.deepEqual(view.itemIds, ['i1', 'i2']);
  assert.equal(view.commitments, 1);
  assert.equal(view.goalUpdates, 3);
  assert.equal(view.reply, 'Done.');
  assert.equal(view.notified, true);
  assert.equal(view.notes.length, 2);
  assert.equal(outcomeHasContent(view), true);
});

test('parseEpisodeOutcome handles failure and skip outcomes', () => {
  assert.equal(parseEpisodeOutcome({ error: 'boom' }).error, 'boom');
  assert.deepEqual(parseEpisodeOutcome({ skipped: true, reason: 'budget' }).flags, ['skipped (budget)']);
  assert.deepEqual(parseEpisodeOutcome({ aborted: true, interrupted: true }).flags, ['aborted', 'interrupted']);
  const empty = parseEpisodeOutcome(null);
  assert.equal(outcomeHasContent(empty), false);
});

test('episodeRunToBotRun derives duration and keeps status', () => {
  const run = episodeRunToBotRun({ run_id: 'r1', status: 'succeeded', started_at: '2026-10-01T10:00:00Z', finished_at: '2026-10-01T10:00:30Z', cost_usd: 0.01 });
  assert.equal(run.run_id, 'r1');
  assert.equal(run.duration_ms, 30_000);
  assert.equal(run.cost_usd, 0.01);
  assert.equal(episodeRunToBotRun({ run_id: 'r2', status: 'running' }).duration_ms, null);
});

test('redactForDisplay masks credential-looking keys at any depth', () => {
  const safe = redactForDisplay({ to: 'a@b.c', api_key: 'sk-1', nested: { Authorization: 'Bearer x', list: [{ password: 'p', ok: 1 }] } }) as Record<string, unknown>;
  assert.equal(safe.to, 'a@b.c');
  assert.equal(safe.api_key, '[redacted]');
  const nested = safe.nested as Record<string, unknown>;
  assert.equal(nested.Authorization, '[redacted]');
  assert.deepEqual(nested.list, [{ password: '[redacted]', ok: 1 }]);
});

test('summarizeArgs is one line, redacted and truncated', () => {
  assert.equal(summarizeArgs({ to: 'a@b.c', token: 'abc' }), 'to=a@b.c token=[redacted]');
  assert.equal(summarizeArgs({ body: 'line1\nline2' }), 'body=line1 line2');
  assert.ok(summarizeArgs({ body: 'x'.repeat(500) }, 50).length <= 50);
  assert.equal(summarizeArgs(null), '');
  assert.ok(!prettyJson({ secret: 'shh' }).includes('shh'));
});
