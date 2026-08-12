import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Coins,
  Loader2,
  RefreshCw,
  Settings2,
  XCircle,
  Zap,
} from 'lucide-react';

import { Button, Input } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';

import { useRuns } from '../hooks/useRuns';
import type { AgentRunSummary, ProjectRunBudget, ProjectRunStats, RunEvent, RunStatus } from '../types';

type RunsViewProps = { selectedProject: Project | null };

const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'aborted', 'timed_out'];

const STATUS_PILLS: Array<{ value: RunStatus | ''; label: string }> = [
  { value: '', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'waiting_permission', label: 'Waiting' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'aborted', label: 'Aborted' },
];

const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'chat', label: 'Chat' },
  { value: 'kanban', label: 'Kanban' },
  { value: 'mission_control', label: 'Mission Control' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'automation', label: 'Automation' },
  { value: 'swarm', label: 'Agent swarm' },
  { value: 'ship', label: 'Ship' },
  { value: 'system', label: 'System' },
];

function statusIcon(status: RunStatus) {
  if (status === 'succeeded') return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (status === 'failed' || status === 'timed_out') return <XCircle className="h-4 w-4 text-red-400" />;
  if (status === 'aborted') return <Ban className="h-4 w-4 text-amber-400" />;
  if (status === 'running' || status === 'starting') return <Activity className="h-4 w-4 animate-pulse text-primary" />;
  if (status === 'waiting_permission' || status === 'waiting_approval') {
    return <AlertTriangle className="h-4 w-4 text-amber-400" />;
  }
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

function statusClass(status: RunStatus): string {
  if (status === 'succeeded') return 'text-emerald-400';
  if (status === 'failed' || status === 'timed_out') return 'text-red-400';
  if (status === 'aborted' || status.startsWith('waiting')) return 'text-amber-400';
  return 'text-primary';
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}

function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(2)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatCost(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function runTitle(run: AgentRunSummary): string {
  return run.title?.trim() || `${run.source} run`;
}

function strPayload(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** Human-friendly timeline labels — no raw JSON for users. */
function describeEvent(event: RunEvent): { label: string; detail: string | null; kv: Array<{ k: string; v: string }> } {
  const p = event.payload ?? {};
  const kv: Array<{ k: string; v: string }> = [];
  const add = (k: string, v: unknown) => {
    if (v == null || v === '') return;
    if (typeof v === 'object') return;
    kv.push({ k, v: String(v) });
  };

  switch (event.type) {
    case 'run.queued':
      return { label: 'Queued', detail: strPayload(p, 'title') || strPayload(p, 'trigger'), kv };
    case 'run.started':
      return { label: 'Started', detail: null, kv };
    case 'run.first_token':
      return { label: 'First response token', detail: null, kv };
    case 'run.status': {
      const from = strPayload(p, 'from');
      const to = strPayload(p, 'to');
      const status = strPayload(p, 'status');
      const summary = strPayload(p, 'summary') || strPayload(p, 'content');
      if (from && to) return { label: `Status: ${from} → ${to}`, detail: summary, kv };
      return { label: status ? `Status: ${status}` : 'Status update', detail: summary, kv };
    }
    case 'model.selected':
      add('provider', p.provider);
      add('model', p.model);
      return {
        label: 'Model selected',
        detail: [strPayload(p, 'provider'), strPayload(p, 'model')].filter(Boolean).join(' · ') || null,
        kv,
      };
    case 'workspace.bound':
      return { label: 'Workspace attached', detail: strPayload(p, 'workspace_id'), kv };
    case 'tool.call':
      return { label: `Tool: ${strPayload(p, 'tool') || 'call'}`, detail: strPayload(p, 'tool_id'), kv: flattenSimple(p, ['tool', 'tool_id', 'input']) };
    case 'tool.result':
      return {
        label: p.is_error ? `Tool failed: ${strPayload(p, 'tool') || 'tool'}` : `Tool finished: ${strPayload(p, 'tool') || 'tool'}`,
        detail: truncate(strPayload(p, 'content'), 160),
        kv: flattenSimple(p, ['tool', 'tool_id', 'is_error']),
      };
    case 'permission.requested':
      return { label: 'Permission requested', detail: strPayload(p, 'tool') || strPayload(p, 'reason'), kv: flattenSimple(p, ['tool', 'request_id', 'reason']) };
    case 'permission.resolved':
      return {
        label: p.resolved === false ? 'Permission denied' : 'Permission resolved',
        detail: strPayload(p, 'reason'),
        kv: flattenSimple(p, ['request_id', 'resolved', 'reason']),
      };
    case 'approval.requested':
      return { label: 'Approval requested', detail: strPayload(p, 'reason') || strPayload(p, 'summary'), kv: flattenSimple(p, ['reason']) };
    case 'approval.resolved':
      return { label: 'Approval resolved', detail: strPayload(p, 'decision') || strPayload(p, 'reason'), kv: flattenSimple(p, ['decision', 'reason']) };
    case 'token.usage':
      return {
        label: 'Token usage',
        detail: [
          strPayload(p, 'input') != null ? `in ${formatTokens(Number(p.input))}` : null,
          strPayload(p, 'output') != null ? `out ${formatTokens(Number(p.output))}` : null,
          strPayload(p, 'total') != null ? `total ${formatTokens(Number(p.total))}` : null,
          p.cost_usd_estimate != null ? formatCost(Number(p.cost_usd_estimate)) : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
        kv: flattenSimple(p, ['input', 'output', 'total', 'cost_usd_estimate']),
      };
    case 'git.commit':
      return { label: 'Git commit', detail: strPayload(p, 'message') || strPayload(p, 'sha'), kv: flattenSimple(p, ['sha', 'message', 'branch']) };
    case 'git.diff_summary':
      return { label: 'Diff summary', detail: strPayload(p, 'summary') || strPayload(p, 'files'), kv: flattenSimple(p, ['files', 'additions', 'deletions']) };
    case 'test.started':
      return { label: 'Tests started', detail: strPayload(p, 'suite') || strPayload(p, 'name'), kv };
    case 'test.finished':
      return {
        label: p.passed === false || p.failed ? 'Tests failed' : 'Tests finished',
        detail: strPayload(p, 'summary') || strPayload(p, 'suite'),
        kv: flattenSimple(p, ['passed', 'failed', 'suite']),
      };
    case 'run.completed':
      return { label: 'Completed', detail: null, kv };
    case 'run.failed':
      return { label: 'Failed', detail: strPayload(p, 'error_summary') || strPayload(p, 'status'), kv: flattenSimple(p, ['error_summary', 'exit_code']) };
    case 'run.aborted':
      return { label: 'Aborted', detail: strPayload(p, 'error_summary'), kv };
    case 'failover.triggered':
      return { label: 'Failover triggered', detail: strPayload(p, 'reason') || strPayload(p, 'to'), kv: flattenSimple(p, ['from', 'to', 'reason']) };
    case 'pack.attached':
      return { label: 'Context pack attached', detail: strPayload(p, 'pack_id') || strPayload(p, 'goal'), kv: flattenSimple(p, ['pack_id', 'goal']) };
    default:
      return {
        label: event.type.replace(/\./g, ' · '),
        detail: null,
        kv: flattenSimple(p, Object.keys(p).slice(0, 8)),
      };
  }
}

function truncate(value: string | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function flattenSimple(payload: Record<string, unknown>, keys: string[]): Array<{ k: string; v: string }> {
  const out: Array<{ k: string; v: string }> = [];
  for (const key of keys) {
    const value = payload[key];
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    out.push({ k: key.replace(/_/g, ' '), v: String(value) });
  }
  return out;
}

function meterPct(used: number, budget: number | null | undefined): number | null {
  if (budget == null || !Number.isFinite(budget) || budget <= 0) return null;
  return Math.min(100, Math.round((used / budget) * 100));
}

export default function RunsView({ selectedProject }: RunsViewProps) {
  const state = useRuns(selectedProject?.projectId ?? null);
  const [showBudget, setShowBudget] = useState(false);

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to inspect runs
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Run Observatory</h2>
          <p className="text-xs text-muted-foreground">
            One timeline for chat, Kanban, webhook, and automation work
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowBudget((v) => !v)}
            aria-label="Edit budgets"
            title="Budgets"
          >
            <Settings2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void state.refresh()}
            disabled={state.isLoading}
            aria-label="Refresh runs"
          >
            {state.isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
      </div>

      {state.stats && (
        <StatsHeader stats={state.stats} budget={state.budget} />
      )}

      {showBudget && state.budget && (
        <BudgetEditor
          budget={state.budget}
          isSaving={state.isSavingBudget}
          onSave={(update) => void state.saveBudget(update)}
          onClose={() => setShowBudget(false)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-4 py-2">
        <div className="flex flex-wrap gap-1">
          {STATUS_PILLS.map((pill) => (
            <button
              key={pill.label}
              type="button"
              onClick={() => state.setStatusFilter(pill.value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                state.statusFilter === pill.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted'
              }`}
            >
              {pill.label}
            </button>
          ))}
        </div>
        <select
          value={state.sourceFilter}
          onChange={(e) => state.setSourceFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
          aria-label="Filter by source"
        >
          {SOURCE_OPTIONS.map((opt) => (
            <option key={opt.value || 'all'} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <Input
          value={state.search}
          onChange={(e) => state.setSearch(e.target.value)}
          placeholder="Search title, model, id…"
          className="h-8 max-w-xs text-xs"
        />
      </div>

      {state.error && (
        <div className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {state.error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(280px,0.4fr)_minmax(0,0.6fr)]">
        <div className="min-h-0 overflow-y-auto border-b border-border/60 p-3 lg:border-b-0 lg:border-r">
          {state.runs.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
              No runs match these filters.
            </div>
          ) : (
            <div className="space-y-2">
              {state.runs.map((run) => (
                <button
                  key={run.run_id}
                  type="button"
                  onClick={() => state.select(run.run_id)}
                  className={`w-full rounded-md border p-3 text-left transition-colors ${
                    state.selectedId === run.run_id
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-border/60 hover:bg-accent/50'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {statusIcon(run.status)}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-medium text-foreground">{runTitle(run)}</div>
                        {run.is_stuck && (
                          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                            Stuck
                          </span>
                        )}
                      </div>
                      <div className="mt-1 truncate text-[11px] text-muted-foreground">
                        {[run.provider, run.model, run.effort].filter(Boolean).join(' · ') || 'provider pending'}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                        <span className={statusClass(run.status)}>{run.status.replace(/_/g, ' ')}</span>
                        <span className="text-muted-foreground">{run.source}</span>
                        <span className="text-muted-foreground">{formatDuration(run.duration_ms)}</span>
                        <span className="text-muted-foreground">{formatTokens(run.token_total)} tok</span>
                        <span className="text-muted-foreground">{formatCost(run.cost_usd_estimate)}</span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          {!state.selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Choose a run to inspect its timeline
            </div>
          ) : (
            <RunDetail
              run={state.selected}
              events={state.events}
              isLoading={state.isLoading}
              onAbort={() => void state.abort()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StatsHeader({ stats, budget }: { stats: ProjectRunStats; budget: ProjectRunBudget | null }) {
  const tokenPct = meterPct(stats.tokensMonth, budget?.monthly_token_budget);
  const costPct = meterPct(stats.costMonth, budget?.monthly_cost_usd_budget);

  return (
    <div className="flex flex-wrap gap-2 border-b border-border/40 px-4 py-2">
      <Chip icon={<Activity className="h-3.5 w-3.5" />} label="Active" value={String(stats.activeCount)} accent={stats.activeCount > 0 ? 'primary' : undefined} />
      <Chip
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        label="Stuck"
        value={String(stats.stuckCount)}
        accent={stats.stuckCount > 0 ? 'warn' : undefined}
      />
      <Chip icon={<Zap className="h-3.5 w-3.5" />} label="Tokens (mo)" value={formatTokens(stats.tokensMonth)} meter={tokenPct} />
      <Chip icon={<Coins className="h-3.5 w-3.5" />} label="Cost (mo)" value={formatCost(stats.costMonth)} meter={costPct} />
      <Chip icon={<Clock3 className="h-3.5 w-3.5" />} label="Avg duration" value={formatDuration(stats.avgDurationMs)} />
      <Chip label="Total" value={String(stats.total)} />
    </div>
  );
}

function Chip({
  label,
  value,
  icon,
  accent,
  meter,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  accent?: 'primary' | 'warn';
  meter?: number | null;
}) {
  const accentClass =
    accent === 'warn'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
      : accent === 'primary'
        ? 'border-primary/40 bg-primary/10 text-primary'
        : 'border-border/60 bg-muted/30 text-foreground';

  return (
    <div className={`min-w-[7.5rem] rounded-md border px-2.5 py-1.5 ${accentClass}`}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
      {meter != null && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-background/50">
          <div
            className={`h-full rounded-full ${meter >= 90 ? 'bg-red-400' : meter >= 70 ? 'bg-amber-400' : 'bg-primary'}`}
            style={{ width: `${meter}%` }}
          />
        </div>
      )}
    </div>
  );
}

function BudgetEditor({
  budget,
  isSaving,
  onSave,
  onClose,
}: {
  budget: ProjectRunBudget;
  isSaving: boolean;
  onSave: (update: {
    monthlyTokenBudget?: number | null;
    monthlyCostUsdBudget?: number | null;
    stuckMinutes?: number | null;
  }) => void;
  onClose: () => void;
}) {
  const [tokens, setTokens] = useState(
    budget.monthly_token_budget != null ? String(budget.monthly_token_budget) : '',
  );
  const [cost, setCost] = useState(
    budget.monthly_cost_usd_budget != null ? String(budget.monthly_cost_usd_budget) : '',
  );
  const [stuck, setStuck] = useState(String(budget.stuck_minutes ?? 15));

  useEffect(() => {
    setTokens(budget.monthly_token_budget != null ? String(budget.monthly_token_budget) : '');
    setCost(budget.monthly_cost_usd_budget != null ? String(budget.monthly_cost_usd_budget) : '');
    setStuck(String(budget.stuck_minutes ?? 15));
  }, [budget]);

  const parseOptional = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="border-b border-border/40 bg-muted/20 px-4 py-3">
      <div className="mb-2 text-xs font-semibold text-foreground">Monthly budgets</div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-[11px] text-muted-foreground">
          Token budget
          <Input
            type="number"
            min={0}
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
            placeholder="Unlimited"
            className="h-8 w-36 text-xs"
          />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          Cost budget (USD)
          <Input
            type="number"
            min={0}
            step="0.01"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="Unlimited"
            className="h-8 w-36 text-xs"
          />
        </label>
        <label className="space-y-1 text-[11px] text-muted-foreground">
          Stuck after (minutes)
          <Input
            type="number"
            min={1}
            value={stuck}
            onChange={(e) => setStuck(e.target.value)}
            className="h-8 w-28 text-xs"
          />
        </label>
        <Button
          size="sm"
          disabled={isSaving}
          onClick={() =>
            onSave({
              monthlyTokenBudget: parseOptional(tokens),
              monthlyCostUsdBudget: parseOptional(cost),
              stuckMinutes: parseOptional(stuck) ?? 15,
            })
          }
        >
          {isSaving ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function RunDetail({
  run,
  events,
  isLoading,
  onAbort,
}: {
  run: AgentRunSummary;
  events: RunEvent[];
  isLoading: boolean;
  onAbort: () => void;
}) {
  const isTerminal = TERMINAL.includes(run.status);
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {statusIcon(run.status)}
            <h3 className="text-sm font-semibold text-foreground">{runTitle(run)}</h3>
            {run.is_stuck && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
                Stuck
              </span>
            )}
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{run.run_id}</p>
        </div>
        {!isTerminal && (
          <Button size="sm" variant="destructive" onClick={onAbort} disabled={isLoading}>
            <Ban /> Abort
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
        <MetaCell label="Status" value={run.status.replace(/_/g, ' ')} className={statusClass(run.status)} />
        <MetaCell label="Provider" value={run.provider || '—'} />
        <MetaCell label="Model" value={run.model || '—'} />
        <MetaCell label="Effort" value={run.effort || '—'} />
        <MetaCell label="Duration" value={formatDuration(run.duration_ms)} />
        <MetaCell label="Tokens" value={formatTokens(run.token_total)} />
        <MetaCell label="Cost" value={formatCost(run.cost_usd_estimate)} />
        <MetaCell label="Tools" value={run.tool_call_count != null ? String(run.tool_call_count) : '—'} />
        <MetaCell label="Started" value={formatTime(run.started_at)} />
        <MetaCell label="Finished" value={formatTime(run.finished_at)} />
        <MetaCell label="Source" value={run.source} />
        <MetaCell label="In / Out" value={`${formatTokens(run.token_input)} / ${formatTokens(run.token_output)}`} />
      </div>

      {run.error_summary && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {run.error_summary}
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
          <Clock3 className="h-4 w-4" /> Timeline
        </div>
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No events recorded yet.</p>
        ) : (
          <div className="relative space-y-0 border-l border-border/60 pl-4">
            {events.map((event) => {
              const described = describeEvent(event);
              const isOpen = openDetails[event.event_id];
              const severityClass =
                event.severity === 'error'
                  ? 'text-red-400'
                  : event.severity === 'warn'
                    ? 'text-amber-400'
                    : 'text-foreground';
              return (
                <div key={event.event_id} className="relative pb-3">
                  <span className="absolute -left-[1.15rem] top-1.5 h-2 w-2 rounded-full bg-primary/70 ring-2 ring-background" />
                  <div className="rounded-md border border-border/50 bg-card/40 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <span className={`font-medium ${severityClass}`}>{described.label}</span>
                      <span className="text-muted-foreground">{formatTime(event.ts)}</span>
                    </div>
                    {described.detail && (
                      <p className="mt-1 text-[11px] text-muted-foreground">{described.detail}</p>
                    )}
                    {described.kv.length > 0 && (
                      <button
                        type="button"
                        className="mt-1 text-[10px] text-primary hover:underline"
                        onClick={() =>
                          setOpenDetails((prev) => ({ ...prev, [event.event_id]: !prev[event.event_id] }))
                        }
                      >
                        {isOpen ? 'Hide details' : 'Details'}
                      </button>
                    )}
                    {isOpen && described.kv.length > 0 && (
                      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
                        {described.kv.map((row) => (
                          <div key={row.k} className="contents">
                            <dt className="text-muted-foreground">{row.k}</dt>
                            <dd className="truncate text-foreground">{row.v}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaCell({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <span className="text-muted-foreground">{label}</span>
      <div className={`truncate text-foreground ${className || ''}`}>{value}</div>
    </div>
  );
}
