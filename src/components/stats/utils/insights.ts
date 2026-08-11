/**
 * Pure derivation of consumption-pattern insights from the global stats
 * payload. Kept view-free so the logic is unit-testable; the panel maps
 * insights to icons. Every insight is computed from real aggregates — nothing
 * is estimated.
 */

import type { GlobalRunStats } from '../api/statsApi';

import {
  formatCost,
  formatDayLong,
  formatDurationMs,
  formatHourUtc,
  formatPercent,
  formatTokens,
} from './format';

export type StatInsight = {
  id: string;
  label: string;
  value: string;
  detail?: string;
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Derive the insight cards for the dashboard. Empty/sparse data yields fewer insights. */
export function deriveStatsInsights(stats: GlobalRunStats): StatInsight[] {
  const insights: StatInsight[] = [];
  const { overview } = stats;

  if (overview.totalRuns === 0) return insights;

  // Peak usage day by tokens (falls back to runs when no token data exists).
  if (stats.daily.length > 0) {
    const byTokens = stats.daily.reduce((best, day) => (day.tokens > best.tokens ? day : best));
    if (byTokens.tokens > 0) {
      insights.push({
        id: 'peak-day',
        label: 'Peak usage day',
        value: formatDayLong(byTokens.day),
        detail: `${formatTokens(byTokens.tokens)} tokens across ${byTokens.runs} run${byTokens.runs === 1 ? '' : 's'}`,
      });
    } else {
      const byRuns = stats.daily.reduce((best, day) => (day.runs > best.runs ? day : best));
      if (byRuns.runs > 0) {
        insights.push({
          id: 'peak-day',
          label: 'Most active day',
          value: formatDayLong(byRuns.day),
          detail: `${byRuns.runs} run${byRuns.runs === 1 ? '' : 's'}`,
        });
      }
    }
  }

  // Top provider / model by token share.
  const topProvider = stats.providers.find((row) => row.tokens > 0) ?? stats.providers[0];
  if (topProvider && overview.totalTokens > 0) {
    insights.push({
      id: 'top-provider',
      label: 'Top provider',
      value: topProvider.provider ?? 'Unknown provider',
      detail: `${formatPercent(topProvider.tokens / overview.totalTokens)} of tokens · ${topProvider.runs} runs`,
    });
  }

  const topModel = stats.models.find((row) => row.tokens > 0);
  if (topModel && overview.totalTokens > 0) {
    insights.push({
      id: 'top-model',
      label: 'Top model',
      value: topModel.model ?? 'Unknown model',
      detail: `${formatPercent(topModel.tokens / overview.totalTokens)} of tokens${topModel.provider ? ` · ${topModel.provider}` : ''}`,
    });
  }

  // Most active hour (UTC).
  const peakHour = stats.byHourUtc.reduce((best, bucket) => (bucket.runs > best.runs ? bucket : best), {
    hour: 0,
    runs: 0,
  });
  if (peakHour.runs > 0) {
    insights.push({
      id: 'peak-hour',
      label: 'Most active hour',
      value: `${formatHourUtc(peakHour.hour)} – ${formatHourUtc((peakHour.hour + 1) % 24)} UTC`,
      detail: `${peakHour.runs} run${peakHour.runs === 1 ? '' : 's'} started`,
    });
  }

  // Output token share.
  if (overview.totalTokens > 0 && overview.outputTokens > 0) {
    insights.push({
      id: 'output-share',
      label: 'Output share',
      value: formatPercent(overview.outputTokens / overview.totalTokens),
      detail: `${formatTokens(overview.outputTokens)} output of ${formatTokens(overview.totalTokens)} total tokens`,
    });
  }

  // Busiest weekday from the daily series (UTC).
  if (stats.daily.length >= 7) {
    const totals = new Array<number>(7).fill(0);
    for (const day of stats.daily) {
      const date = new Date(`${day.day}T00:00:00Z`);
      if (Number.isFinite(date.getTime())) totals[date.getUTCDay()] += day.tokens;
    }
    const busiest = totals.indexOf(Math.max(...totals));
    if (totals[busiest] > 0) {
      insights.push({
        id: 'busiest-weekday',
        label: 'Busiest weekday',
        value: WEEKDAY_NAMES[busiest],
        detail: `${formatTokens(totals[busiest])} tokens on ${WEEKDAY_NAMES[busiest]}s (UTC)`,
      });
    }
  }

  // Average run duration.
  if (overview.avgDurationMs != null && overview.avgDurationMs > 0) {
    insights.push({
      id: 'avg-duration',
      label: 'Avg run duration',
      value: formatDurationMs(overview.avgDurationMs),
      detail: `${formatDurationMs(overview.totalDurationMs)} total run time`,
    });
  }

  // Success rate.
  if (overview.successRate != null) {
    insights.push({
      id: 'success-rate',
      label: 'Success rate',
      value: formatPercent(overview.successRate),
      detail: 'Share of finished runs that succeeded',
    });
  }

  // Cost coverage — surfaces how complete the cost picture is.
  if (overview.totalCostUsd != null && overview.totalRuns > 0) {
    insights.push({
      id: 'cost-coverage',
      label: 'Cost coverage',
      value: formatPercent(overview.runsWithCost / overview.totalRuns),
      detail: `${formatCost(overview.totalCostUsd)} across ${overview.runsWithCost} of ${overview.totalRuns} runs`,
    });
  }

  return insights;
}
