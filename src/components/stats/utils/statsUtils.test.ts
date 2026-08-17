/**
 * Unit tests for the Stats dashboard pure logic: date-range resolution,
 * daily-series densification, formatting, and insight derivation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { GlobalRunStats } from '../api/statsApi';

import { describeStatsRange, fillDailyGaps, resolveStatsRange } from './dateRange';
import { formatCost, formatDurationMs, formatPercent, formatTokens } from './format';
import { deriveStatsInsights } from './insights';

const NOW = new Date('2026-08-11T12:00:00.000Z');

function makeStats(overrides: Partial<GlobalRunStats> = {}): GlobalRunStats {
  return {
    range: { from: null, to: null },
    generatedAt: NOW.toISOString(),
    firstRunAt: null,
    overview: {
      totalRuns: 0,
      runsWithTokens: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: null,
      runsWithCost: 0,
      totalDurationMs: 0,
      avgDurationMs: null,
      conversationCount: 0,
      activeConversations: 0,
      avgTokensPerConversation: null,
      avgTokensPerRun: null,
      successRate: null,
    },
    byStatus: [],
    daily: [],
    providers: [],
    models: [],
    sources: [],
    byHourUtc: Array.from({ length: 24 }, (_, hour) => ({ hour, runs: 0 })),
    ...overrides,
  };
}

test('resolveStatsRange: presets produce inclusive bounds ending at now', () => {
  const week = resolveStatsRange('7d', undefined, undefined, NOW);
  assert.equal(week.to, NOW.toISOString());
  // 7-day preset covers today plus the 6 previous UTC days.
  assert.equal(week.from, '2026-08-05T00:00:00.000Z');

  const month = resolveStatsRange('30d', undefined, undefined, NOW);
  assert.equal(month.from, '2026-07-13T00:00:00.000Z');

  const today = resolveStatsRange('today', undefined, undefined, NOW);
  assert.equal(today.from, '2026-08-11T00:00:00.000Z');
  assert.equal(today.to, '2026-08-11T23:59:59.999Z');

  const yesterday = resolveStatsRange('yesterday', undefined, undefined, NOW);
  assert.equal(yesterday.from, '2026-08-10T00:00:00.000Z');
  assert.equal(yesterday.to, '2026-08-10T23:59:59.999Z');

  assert.deepEqual(resolveStatsRange('all', undefined, undefined, NOW), {});
});

test('resolveStatsRange: custom range spans start-of-day to end-of-day UTC', () => {
  const range = resolveStatsRange('custom', '2026-07-01', '2026-07-02', NOW);
  assert.equal(range.from, '2026-07-01T00:00:00.000Z');
  assert.equal(range.to, '2026-07-02T23:59:59.999Z');

  // Partial custom ranges stay open-ended; garbage input is ignored.
  assert.deepEqual(resolveStatsRange('custom', '', 'not-a-day', NOW), {});
});

test('resolveStatsRange: reversed custom dates are normalized, not left impossible', () => {
  const reversed = resolveStatsRange('custom', '2026-07-02', '2026-07-01', NOW);
  assert.equal(reversed.from, '2026-07-01T00:00:00.000Z');
  assert.equal(reversed.to, '2026-07-02T23:59:59.999Z');
  // Same day in both slots still yields that one whole day.
  const sameDay = resolveStatsRange('custom', '2026-07-01', '2026-07-01', NOW);
  assert.equal(sameDay.from, '2026-07-01T00:00:00.000Z');
  assert.equal(sameDay.to, '2026-07-01T23:59:59.999Z');
});

test('describeStatsRange: all-time and bounded labels', () => {
  assert.equal(describeStatsRange('all', {}), 'All time');
  assert.equal(describeStatsRange('today', { from: '2026-08-11T00:00:00.000Z' }), 'Today (UTC)');
  assert.equal(describeStatsRange('yesterday', { from: '2026-08-10T00:00:00.000Z' }), 'Yesterday (UTC)');
  const label = describeStatsRange('7d', {
    from: '2026-08-05T00:00:00.000Z',
    to: '2026-08-11T12:00:00.000Z',
  });
  assert.ok(label.includes('–'), 'bounded range shows a from – to label');
});

test('fillDailyGaps: densifies sparse buckets across the applied range', () => {
  const sparse = [
    { day: '2026-08-06', tokens: 10 },
    { day: '2026-08-08', tokens: 30 },
  ];
  const dense = fillDailyGaps(
    sparse,
    { from: '2026-08-05T00:00:00.000Z', to: '2026-08-08T12:00:00.000Z' },
    (day) => ({ day, tokens: 0 }),
  );
  assert.deepEqual(
    dense.map((bucket) => [bucket.day, bucket.tokens]),
    [
      ['2026-08-05', 0],
      ['2026-08-06', 10],
      ['2026-08-07', 0],
      ['2026-08-08', 30],
    ],
  );
});

test('fillDailyGaps: unbounded range fills only between active days', () => {
  const sparse = [{ day: '2026-08-01', tokens: 5 }, { day: '2026-08-03', tokens: 7 }];
  const dense = fillDailyGaps(sparse, {}, (day) => ({ day, tokens: 0 }));
  assert.deepEqual(
    dense.map((bucket) => bucket.day),
    ['2026-08-01', '2026-08-02', '2026-08-03'],
  );
  assert.deepEqual(fillDailyGaps([], {}, (day) => ({ day, tokens: 0 })), []);
});

test('formatting helpers handle compact, exact, and null shapes', () => {
  assert.equal(formatTokens(1_204_500_000_000), '1.20T');
  assert.equal(formatTokens(1_000_000_000_000), '1.00T');
  assert.equal(formatTokens(1_371_758_310), '1.37B');
  assert.equal(formatTokens(1_000_000_000), '1.00B');
  assert.equal(formatTokens(1_250_000), '1.3M');
  assert.equal(formatTokens(34_500), '35k');
  assert.equal(formatTokens(812), '812');
  assert.equal(formatTokens(null), '—');

  assert.equal(formatCost(0.0042), '$0.0042');
  assert.equal(formatCost(12.5), '$12.50');
  assert.equal(formatCost(null), '—');

  assert.equal(formatDurationMs(45_000), '45s');
  assert.equal(formatDurationMs(3_840_000), '1h 4m');
  assert.equal(formatDurationMs(null), '—');

  assert.equal(formatPercent(0.684), '68%');
  assert.equal(formatPercent(null), '—');
});

test('deriveStatsInsights: empty stats yield no insights', () => {
  assert.deepEqual(deriveStatsInsights(makeStats()), []);
});

test('deriveStatsInsights: full payload yields pattern insights with real values', () => {
  const stats = makeStats({
    overview: {
      totalRuns: 10,
      runsWithTokens: 9,
      totalTokens: 100_000,
      inputTokens: 70_000,
      outputTokens: 30_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 5_000,
      totalCostUsd: 1.25,
      runsWithCost: 8,
      totalDurationMs: 600_000,
      avgDurationMs: 60_000,
      conversationCount: 4,
      activeConversations: 3,
      avgTokensPerConversation: 33_333,
      avgTokensPerRun: 10_000,
      successRate: 0.9,
    },
    daily: [
      {
        day: '2026-08-04',
        runs: 3,
        tokens: 20_000,
        inputTokens: 15_000,
        outputTokens: 5_000,
        costUsd: 0.5,
        durationMs: 100_000,
        conversations: 1,
      },
      {
        day: '2026-08-05',
        runs: 7,
        tokens: 80_000,
        inputTokens: 55_000,
        outputTokens: 25_000,
        costUsd: 0.75,
        durationMs: 500_000,
        conversations: 3,
      },
    ],
    providers: [
      {
        provider: 'claude',
        runs: 8,
        tokens: 90_000,
        inputTokens: 60_000,
        outputTokens: 30_000,
        costUsd: 1.25,
        durationMs: 550_000,
        conversations: 3,
      },
      {
        provider: null,
        runs: 2,
        tokens: 10_000,
        inputTokens: 10_000,
        outputTokens: 0,
        costUsd: null,
        durationMs: 50_000,
        conversations: 0,
      },
    ],
    models: [
      {
        provider: 'claude',
        model: 'opus',
        runs: 8,
        tokens: 90_000,
        inputTokens: 60_000,
        outputTokens: 30_000,
        costUsd: 1.25,
        durationMs: 550_000,
      },
    ],
    byHourUtc: Array.from({ length: 24 }, (_, hour) => ({ hour, runs: hour === 14 ? 5 : 0 })),
  });

  const insights = deriveStatsInsights(stats);
  const byId = Object.fromEntries(insights.map((insight) => [insight.id, insight]));

  assert.equal(byId['peak-day'].label, 'Peak usage day');
  assert.ok(byId['peak-day'].value.includes('Aug 5'), 'peak day is the 80k-token day');
  assert.equal(byId['top-provider'].value, 'claude');
  assert.equal(byId['top-provider'].detail, '90% of tokens · 8 runs');
  assert.equal(byId['top-model'].value, 'opus');
  assert.equal(byId['peak-hour'].value, '14:00 – 15:00 UTC');
  assert.equal(byId['output-share'].value, '30%');
  assert.equal(byId['avg-duration'].value, '1m');
  assert.equal(byId['success-rate'].value, '90%');
  assert.equal(byId['cost-coverage'].value, '80%');
  // Fewer than 7 daily buckets → no weekday insight.
  assert.equal(byId['busiest-weekday'], undefined);
});

test('deriveStatsInsights: no token data falls back to run-count peak day', () => {
  const stats = makeStats({
    overview: {
      ...makeStats().overview,
      totalRuns: 2,
    },
    daily: [
      {
        day: '2026-08-04',
        runs: 2,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: 10_000,
        conversations: 0,
      },
    ],
    providers: [
      {
        provider: 'agy',
        runs: 2,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        durationMs: 10_000,
        conversations: 0,
      },
    ],
  });

  const insights = deriveStatsInsights(stats);
  const byId = Object.fromEntries(insights.map((insight) => [insight.id, insight]));
  assert.equal(byId['peak-day'].label, 'Most active day');
  assert.equal(byId['output-share'], undefined, 'no tokens → no output-share insight');
  assert.equal(byId['top-provider'], undefined, 'no tokens → no provider-share insight');
  assert.equal(byId['cost-coverage'], undefined, 'no cost data → no coverage insight');
});
