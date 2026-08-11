import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Coins,
  Cpu,
  DollarSign,
  Lightbulb,
  Loader2,
  MessageSquare,
  PieChart,
  RefreshCw,
  Sparkles,
  Timer,
  TrendingUp,
  Trophy,
  X,
} from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { statsApi, type GlobalRunStats } from '../api/statsApi';
import {
  describeStatsRange,
  fillDailyGaps,
  resolveStatsRange,
  type ResolvedStatsRange,
  type StatsRangeKey,
} from '../utils/dateRange';
import {
  formatCost,
  formatDurationMs,
  formatPercent,
  formatTokens,
  formatTokensExact,
} from '../utils/format';
import { deriveStatsInsights, type StatInsight } from '../utils/insights';

import BreakdownList, { type BreakdownRow } from './subcomponents/BreakdownList';
import DateRangeControl from './subcomponents/DateRangeControl';
import HourOfDayChart from './subcomponents/HourOfDayChart';
import KpiCard from './subcomponents/KpiCard';
import UsageOverTimeChart from './subcomponents/UsageOverTimeChart';

type StatsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
};

const SOURCE_LABELS: Record<string, string> = {
  chat: 'Chat',
  kanban: 'Kanban',
  mission_control: 'Mission Control',
  webhook: 'Webhook',
  automation: 'Automation',
  swarm: 'Agent swarm',
  ship: 'Ship',
  system: 'System',
};

const INSIGHT_ICONS: Record<string, typeof Sparkles> = {
  'peak-day': CalendarDays,
  'top-provider': Trophy,
  'top-model': Cpu,
  'peak-hour': Clock3,
  'output-share': PieChart,
  'busiest-weekday': CalendarDays,
  'avg-duration': Timer,
  'success-rate': CheckCircle2,
  'cost-coverage': DollarSign,
};

function InsightIcon({ id }: { id: string }) {
  const Icon = INSIGHT_ICONS[id] ?? Sparkles;
  return <Icon className="h-3.5 w-3.5" />;
}

function emptyDay(day: string) {
  return {
    day,
    runs: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    conversations: 0,
  };
}

export default function StatsPanel({ isOpen, onClose }: StatsPanelProps) {
  const [rangeKey, setRangeKey] = useState<StatsRangeKey>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [appliedRange, setAppliedRange] = useState<ResolvedStatsRange>(() =>
    resolveStatsRange('30d'),
  );
  const [stats, setStats] = useState<GlobalRunStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (range: ResolvedStatsRange) => {
    setLoading(true);
    setError(null);
    try {
      const result = await statsApi.global(range);
      setStats(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load whenever the panel opens.
  useEffect(() => {
    if (!isOpen) return;
    const range =
      rangeKey === 'custom'
        ? resolveStatsRange('custom', customFrom, customTo)
        : resolveStatsRange(rangeKey);
    setAppliedRange(range);
    void load(range);
    // Only react to the open transition; range changes apply via the control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const applyRange = useCallback(
    (key: StatsRangeKey, from: string, to: string) => {
      const range = resolveStatsRange(key, from, to);
      setAppliedRange(range);
      void load(range);
    },
    [load],
  );

  const handleRangeKeyChange = (key: StatsRangeKey) => {
    setRangeKey(key);
    // Custom waits for Apply; presets apply immediately.
    if (key !== 'custom') {
      applyRange(key, customFrom, customTo);
    }
  };

  const denseDays = useMemo(
    () => (stats ? fillDailyGaps(stats.daily, appliedRange, emptyDay) : []),
    [stats, appliedRange],
  );

  const insights = useMemo(() => (stats ? deriveStatsInsights(stats) : []), [stats]);

  const providerRows: BreakdownRow[] = useMemo(
    () =>
      (stats?.providers ?? []).map((row) => ({
        key: row.provider ?? '__unknown__',
        label: row.provider ?? 'Unknown provider',
        tokens: row.tokens,
        runs: row.runs,
        costUsd: row.costUsd,
        conversations: row.conversations,
        isUnknown: row.provider == null,
      })),
    [stats],
  );

  const modelRows: BreakdownRow[] = useMemo(
    () =>
      (stats?.models ?? []).map((row) => ({
        key: `${row.provider ?? '__unknown__'}::${row.model ?? '__unknown__'}`,
        label: row.model ?? 'Unknown model',
        sublabel: row.provider ?? undefined,
        tokens: row.tokens,
        runs: row.runs,
        costUsd: row.costUsd,
        isUnknown: row.model == null,
      })),
    [stats],
  );

  const sourceRows: BreakdownRow[] = useMemo(
    () =>
      (stats?.sources ?? []).map((row) => ({
        key: row.source,
        label: SOURCE_LABELS[row.source] ?? row.source,
        tokens: row.tokens,
        runs: row.runs,
      })),
    [stats],
  );

  if (!isOpen) return null;

  const overview = stats?.overview ?? null;
  const isEmpty = stats != null && overview != null && overview.totalRuns === 0 && overview.conversationCount === 0;
  const rangeLabel = describeStatsRange(rangeKey, appliedRange);
  const costCoverage =
    overview && overview.totalRuns > 0 ? overview.runsWithCost / overview.totalRuns : 0;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[9999] flex items-stretch justify-center bg-background md:items-center md:bg-background/80 md:p-4 md:backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative flex h-dvh max-h-dvh w-full flex-col overflow-hidden border-0 bg-background shadow-none md:h-[92vh] md:max-h-[92vh] md:max-w-6xl md:rounded-xl md:border md:border-border md:shadow-2xl">
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] md:px-5 md:py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <BarChart3 className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-foreground">Usage Stats</h2>
              <p className="truncate text-[11px] text-muted-foreground">
                {rangeLabel}
                {stats ? ` · updated ${new Date(stats.generatedAt).toLocaleTimeString()}` : ''}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load(appliedRange)}
              disabled={loading}
              className="h-10 w-10 touch-manipulation p-0 md:h-9 md:w-9"
              title="Refresh"
            >
              <RefreshCw className={cn('h-4 w-4', loading ? 'animate-spin' : '')} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-10 w-10 touch-manipulation p-0 md:h-9 md:w-9"
              aria-label="Close stats"
            >
              <X className="h-5 w-5 md:h-4 md:w-4" />
            </Button>
          </div>
        </div>

        {/* Date range control */}
        <div className="flex-shrink-0 border-b border-border px-3 py-2 md:px-5">
          <DateRangeControl
            rangeKey={rangeKey}
            onRangeKeyChange={handleRangeKeyChange}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFromChange={setCustomFrom}
            onCustomToChange={setCustomTo}
            onApplyCustom={() => applyRange('custom', customFrom, customTo)}
            disabled={loading}
          />
        </div>

        {error ? (
          <div className="flex flex-shrink-0 items-start gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200 md:px-5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              className="shrink-0 touch-manipulation text-xs underline"
              onClick={() => void load(appliedRange)}
            >
              Retry
            </button>
            <button
              type="button"
              className="shrink-0 touch-manipulation text-xs underline"
              onClick={() => setError(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:p-5">
          {loading && !stats ? (
            <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading stats…
            </div>
          ) : null}

          {!loading && !stats && !error ? (
            <div className="flex flex-col items-center justify-center gap-2 px-2 py-24 text-center">
              <BarChart3 className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No stats loaded yet.</p>
            </div>
          ) : null}

          {stats && overview && isEmpty ? (
            <div className="flex flex-col items-center justify-center gap-3 px-2 py-24 text-center">
              <BarChart3 className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-foreground">No activity in this range</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                No runs or conversations were recorded between {rangeLabel.toLowerCase()}. Try a
                wider range to see your usage.
              </p>
              {rangeKey !== 'all' ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => handleRangeKeyChange('all')}
                >
                  View all time
                </Button>
              ) : null}
            </div>
          ) : null}

          {stats && overview && !isEmpty ? (
            <div className="flex flex-col gap-4 md:gap-5">
              {/* KPI cards */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:gap-3 xl:grid-cols-6">
                <KpiCard
                  icon={<Coins className="h-3 w-3" />}
                  label="Total tokens"
                  value={formatTokens(overview.totalTokens)}
                  title={`${formatTokensExact(overview.totalTokens)} tokens (reported by ${overview.runsWithTokens} of ${overview.totalRuns} runs)`}
                  sub={`${formatTokens(overview.inputTokens)} in · ${formatTokens(overview.outputTokens)} out`}
                />
                <KpiCard
                  icon={<DollarSign className="h-3 w-3" />}
                  label="Est. cost"
                  value={overview.totalCostUsd != null ? formatCost(overview.totalCostUsd) : '—'}
                  title={
                    overview.totalCostUsd != null
                      ? `Sum of provider cost estimates across ${overview.runsWithCost} runs`
                      : 'No cost estimates recorded in this range'
                  }
                  sub={
                    overview.totalCostUsd != null
                      ? costCoverage >= 1
                        ? 'all runs covered'
                        : `covers ${formatPercent(costCoverage)} of runs`
                      : 'not recorded'
                  }
                />
                <KpiCard
                  icon={<Clock3 className="h-3 w-3" />}
                  label="Run time"
                  value={formatDurationMs(overview.totalDurationMs)}
                  title="Total wall-clock run time (concurrent runs add up)"
                  sub={overview.avgDurationMs != null ? `avg ${formatDurationMs(overview.avgDurationMs)} / run` : undefined}
                />
                <KpiCard
                  icon={<MessageSquare className="h-3 w-3" />}
                  label="Conversations"
                  value={overview.conversationCount.toLocaleString()}
                  title="Conversations started in this range"
                  sub={`${overview.activeConversations} with runs in range`}
                />
                <KpiCard
                  icon={<Activity className="h-3 w-3" />}
                  label="Runs"
                  value={overview.totalRuns.toLocaleString()}
                  sub={overview.successRate != null ? `${formatPercent(overview.successRate)} succeeded` : 'no finished runs'}
                />
                <KpiCard
                  icon={<TrendingUp className="h-3 w-3" />}
                  label="Avg tokens / conv"
                  value={
                    overview.avgTokensPerConversation != null
                      ? formatTokens(overview.avgTokensPerConversation)
                      : '—'
                  }
                  title="Total tokens divided by conversations with runs in range"
                  sub={
                    overview.avgTokensPerRun != null
                      ? `${formatTokens(overview.avgTokensPerRun)} / run`
                      : undefined
                  }
                />
              </div>

              {/* Usage over time */}
              <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
                <UsageOverTimeChart days={denseDays} />
              </div>

              {/* Provider + model breakdowns */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5">
                <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
                  <BreakdownList
                    title="By provider"
                    rows={providerRows}
                    totalTokens={overview.totalTokens}
                    emptyText="No provider data in this range."
                  />
                </div>
                <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
                  <BreakdownList
                    title="By model"
                    rows={modelRows}
                    totalTokens={overview.totalTokens}
                    emptyText="No model data in this range."
                  />
                </div>
              </div>

              {/* Hour of day + sources */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5">
                <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
                  <HourOfDayChart hours={stats.byHourUtc} />
                </div>
                <div className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
                  <BreakdownList
                    title="By source"
                    rows={sourceRows}
                    totalTokens={overview.totalTokens}
                    emptyText="No source data in this range."
                  />
                </div>
              </div>

              {/* Insights */}
              {insights.length > 0 ? (
                <section className="flex flex-col gap-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <Lightbulb className="h-3.5 w-3.5 text-primary" />
                    Consumption patterns
                  </h3>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                    {insights.map((insight: StatInsight) => (
                      <div
                        key={insight.id}
                        className="flex min-w-0 items-start gap-2.5 rounded-xl border border-border bg-card p-3 shadow-sm"
                      >
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <InsightIcon id={insight.id} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {insight.label}
                          </div>
                          <div className="truncate text-sm font-semibold text-foreground">
                            {insight.value}
                          </div>
                          {insight.detail ? (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {insight.detail}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {/* Methodology / data caveats */}
              <footer className="flex flex-col gap-1 border-t border-border/60 pt-3 text-[10px] leading-relaxed text-muted-foreground/80">
                <p>
                  Run time is wall-clock per run (concurrent runs add up). Days and hours are UTC.
                  {stats.firstRunAt
                    ? ` First run recorded ${new Date(stats.firstRunAt).toLocaleDateString()}.`
                    : ''}
                </p>
                {overview.runsWithTokens < overview.totalRuns ? (
                  <p>
                    Token usage was reported by {overview.runsWithTokens} of {overview.totalRuns}{' '}
                    runs in this range; totals reflect reported usage only.
                  </p>
                ) : null}
                <p>
                  Cached-token detail is not stored per run; totals include cache tokens where the
                  provider folds them into its reported total. Costs are provider estimates and may
                  be missing for some runs.
                </p>
              </footer>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
