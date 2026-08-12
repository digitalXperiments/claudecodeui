/**
 * Run spine service (PRD §6.5).
 *
 * Thin orchestration layer over runsDb:
 *  - redacts event payloads before persistence (secrets never hit the DB)
 *  - emits lifecycle events (run.queued / run.status / terminal / token.usage /
 *    workspace.bound) so the timeline stays complete
 *  - maps run rows to the AgentRunSummary shape used by list + WS fan-out
 */

import { CLAUDE_MODEL_ALIASES } from '@/modules/providers/index.js';
import { estimateCostUsd } from '@/modules/runs/model-pricing.js';
import { runsDb } from '@/modules/runs/runs.repository.js';
import {
  mergeRunUsage,
  readTokenBudgetUsage,
  usageAccumulationMode,
} from '@/modules/runs/runs-usage.js';
import type {
  AgentRun,
  CreateRunInput,
  GlobalRunStats,
  GlobalStatsFilter,
  ProjectRunBudget,
  ProjectRunBudgetInput,
  ProjectRunStats,
  RunListFilter,
  TerminalResult,
  TokenUsage,
} from '@/modules/runs/runs.types.js';
import { DEFAULT_STUCK_MINUTES } from '@/modules/runs/runs.types.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import {
  CloudError,
  TERMINAL_RUN_STATUSES,
  type AgentRunSummary,
  type RunEventEnvelope,
  type RunStatus,
} from '@/shared/run-events.js';
import type { NormalizedMessage } from '@/shared/types.js';

export interface RunService {
  create(input: CreateRunInput): AgentRun;
  get(runId: string): AgentRun | null;
  list(filter: RunListFilter): { runs: AgentRunSummary[]; nextCursor?: string };
  updateStatus(
    runId: string,
    status: RunStatus,
    patch?: Partial<AgentRun>,
    options?: { allowTerminalTransition?: boolean },
  ): void;
  appendEvent(runId: string, event: Omit<RunEventEnvelope, 'event_id' | 'seq'>): RunEventEnvelope;
  recordMessage(runId: string, message: NormalizedMessage, source: RunEventEnvelope['source']): void;
  listEvents(runId: string, opts?: { afterSeq?: number; limit?: number }): RunEventEnvelope[];
  attachUsage(runId: string, usage: TokenUsage): void;
  linkSession(runId: string, appSessionId: string): void;
  linkWorkspace(runId: string, workspaceId: string): void;
  markTerminal(runId: string, result: TerminalResult): void;
  /** Reconcile: running runs with dead processes → failed/aborted */
  reconcileOrphans(): number;
  projectStats(projectId: string): ProjectRunStats;
  globalStats(filter: GlobalStatsFilter): GlobalRunStats;
  getBudget(projectId: string): ProjectRunBudget;
  putBudget(input: ProjectRunBudgetInput): ProjectRunBudget;
}

type SummaryExtras = {
  lastActivity?: string | null;
  stuckMinutes?: number;
  toolCallCount?: number | null;
};

/** Build a summary with last-activity + project stuck threshold. */
function summarizeRun(run: AgentRun): AgentRunSummary {
  const lastActivity = runsDb.lastActivityByRunIds([run.run_id]).get(run.run_id) ?? null;
  const stuckMinutes = run.project_id
    ? runsDb.getBudget(run.project_id).stuck_minutes
    : DEFAULT_STUCK_MINUTES;
  const toolCallCount = runsDb.toolCallCounts([run.run_id]).get(run.run_id) ?? 0;
  return toSummary(run, { lastActivity, stuckMinutes, toolCallCount });
}

// ---------------------------------------------------------------------------
// Payload redaction (PRD §0.3 / §6.5 — events never store secrets)
// ---------------------------------------------------------------------------

/** Keys stripped (case-insensitive) anywhere in an event payload. */
const SENSITIVE_KEY_PATTERN = /(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)/i;

/** Any persisted string value is capped at 4KB. */
const MAX_STRING_LENGTH = 4096;

/**
 * Recursively strip sensitive keys and cap string values at 4KB before a
 * payload is persisted. Returns a JSON-safe copy; input is not mutated.
 */
export function redactPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPayload(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      out[key] = redactPayload(entry);
    }
    return out;
  }
  return value;
}

/**
 * Persist the useful lifecycle/tool parts of a normalized provider message.
 * Streaming text is intentionally not copied into SQLite on every delta; the
 * provider transcript remains authoritative for chat history while the spine
 * stores milestones and operator-relevant activity.
 */
function normalizedMessageEvent(message: NormalizedMessage): {
  type: string;
  severity?: RunEventEnvelope['severity'];
  payload: Record<string, unknown>;
} | null {
  switch (message.kind) {
    case 'tool_use':
      return {
        type: 'tool.call',
        payload: {
          tool: message.toolName ?? null,
          tool_id: message.toolId ?? null,
          input: message.toolInput ?? message.input ?? null,
        },
      };
    case 'tool_result':
      return {
        type: 'tool.result',
        severity: message.isError ? 'error' : 'info',
        payload: {
          tool: message.toolName ?? null,
          tool_id: message.toolId ?? null,
          is_error: Boolean(message.isError || message.toolResult?.isError),
          content: message.toolResult?.content ?? message.content ?? null,
        },
      };
    case 'permission_request':
      return {
        type: 'permission.requested',
        severity: 'warn',
        payload: {
          request_id: message.requestId ?? null,
          tool: message.toolName ?? null,
          input: message.input ?? message.toolInput ?? null,
          reason: message.reason ?? null,
        },
      };
    case 'permission_cancelled':
      return {
        type: 'permission.resolved',
        payload: {
          request_id: message.requestId ?? null,
          resolved: false,
          reason: message.reason ?? null,
        },
      };
    case 'error':
      return {
        type: 'run.status',
        severity: 'error',
        payload: { kind: message.kind, content: message.content ?? message.text ?? null },
      };
    case 'status':
      return {
        type: 'run.status',
        payload: { status: message.status ?? null, summary: message.summary ?? message.content ?? null },
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function computeDurationMs(run: AgentRun): number | null {
  const start = parseMs(run.started_at) ?? parseMs(run.created_at);
  if (start == null) return null;
  const end = parseMs(run.finished_at) ?? Date.now();
  return Math.max(0, end - start);
}

function isRunStuck(
  run: AgentRun,
  lastActivity: string | null | undefined,
  stuckMinutes: number,
): boolean {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return false;
  const activityMs =
    parseMs(lastActivity) ?? parseMs(run.started_at) ?? parseMs(run.created_at);
  if (activityMs == null) return false;
  const thresholdMs = Math.max(1, stuckMinutes) * 60_000;
  return Date.now() - activityMs > thresholdMs;
}

function toSummary(run: AgentRun, extras: SummaryExtras = {}): AgentRunSummary {
  const stuckMinutes = extras.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
  const is_stuck = isRunStuck(run, extras.lastActivity, stuckMinutes);
  return {
    run_id: run.run_id,
    project_id: run.project_id,
    source: run.source,
    source_ref: run.source_ref,
    workspace_id: run.workspace_id,
    app_session_id: run.app_session_id,
    provider: run.provider,
    model: run.model,
    effort: run.effort,
    status: run.status,
    trigger: run.trigger,
    parent_run_id: run.parent_run_id,
    root_run_id: run.root_run_id,
    title: run.title,
    error_summary: run.error_summary,
    token_input: run.token_input,
    token_output: run.token_output,
    token_total: run.token_total,
    cost_usd_estimate: run.cost_usd_estimate,
    duration_ms: computeDurationMs(run),
    is_stuck,
    tool_call_count: extras.toolCallCount ?? null,
    started_at: run.started_at,
    finished_at: run.finished_at,
    created_at: run.created_at,
  };
}

const TERMINAL_EVENT_TYPE: Record<TerminalResult['status'], string> = {
  succeeded: 'run.completed',
  failed: 'run.failed',
  aborted: 'run.aborted',
  timed_out: 'run.failed',
};

function nowIso(): string {
  return new Date().toISOString();
}

function requireRun(runId: string): AgentRun {
  const run = runsDb.getById(runId);
  if (!run) {
    throw new CloudError('RUN_NOT_FOUND', `Run not found: ${runId}`);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Service singleton
// ---------------------------------------------------------------------------

export const runService: RunService = {
  create(input: CreateRunInput): AgentRun {
    const run = runsDb.create(input);
    this.appendEvent(run.run_id, {
      run_id: run.run_id,
      ts: nowIso(),
      source: (input.source || 'system') as RunEventEnvelope['source'],
      type: 'run.queued',
      payload: { status: run.status, trigger: run.trigger, title: run.title },
    });
    return run;
  },

  get(runId: string): AgentRun | null {
    return runsDb.getById(runId);
  },

  list(filter: RunListFilter): { runs: AgentRunSummary[]; nextCursor?: string } {
    const { runs, nextCursor } = runsDb.list(filter);
    const runIds = runs.map((r) => r.run_id);
    const lastActivity = runsDb.lastActivityByRunIds(runIds);
    const toolCounts = runsDb.toolCallCounts(runIds);

    // Cache stuck minutes per project for this page.
    const stuckByProject = new Map<string, number>();
    const stuckFor = (projectId: string | null): number => {
      if (!projectId) return DEFAULT_STUCK_MINUTES;
      let value = stuckByProject.get(projectId);
      if (value === undefined) {
        value = runsDb.getBudget(projectId).stuck_minutes;
        stuckByProject.set(projectId, value);
      }
      return value;
    };

    return {
      runs: runs.map((run) =>
        toSummary(run, {
          lastActivity: lastActivity.get(run.run_id) ?? null,
          stuckMinutes: stuckFor(run.project_id),
          toolCallCount: toolCounts.get(run.run_id) ?? 0,
        }),
      ),
      nextCursor,
    };
  },

  projectStats(projectId: string): ProjectRunStats {
    return runsDb.projectStats(projectId);
  },

  globalStats(filter: GlobalStatsFilter = {}): GlobalRunStats {
    return runsDb.globalStats(filter);
  },

  getBudget(projectId: string): ProjectRunBudget {
    return runsDb.getBudget(projectId);
  },

  putBudget(input: ProjectRunBudgetInput): ProjectRunBudget {
    return runsDb.putBudget(input);
  },

  updateStatus(
    runId: string,
    status: RunStatus,
    patch: Partial<AgentRun> = {},
    options: { allowTerminalTransition?: boolean } = {},
  ): void {
    const run = requireRun(runId);
    if (
      TERMINAL_RUN_STATUSES.has(run.status) &&
      run.status !== status &&
      options.allowTerminalTransition !== true
    ) {
      throw new CloudError(
        'RUN_ALREADY_TERMINAL',
        `Run ${runId} is already terminal (${run.status})`,
      );
    }
    const nextPatch = { ...patch };
    if (status === 'running' && !run.started_at && !nextPatch.started_at) {
      nextPatch.started_at = nowIso();
    }
    if (!runsDb.updateStatus(runId, status, nextPatch, options)) {
      const current = runsDb.getById(runId);
      throw new CloudError(
        'RUN_ALREADY_TERMINAL',
        `Run ${runId} is already terminal (${current?.status ?? 'unknown'})`,
      );
    }
    this.appendEvent(runId, {
      run_id: runId,
      ts: nowIso(),
      source: 'system',
      type: 'run.status',
      payload: { from: run.status, to: status },
    });
    const updated = this.get(runId);
    if (updated) {
      broadcastSystemEvent({ kind: 'run_updated', run: summarizeRun(updated) });
    }
  },

  appendEvent(
    runId: string,
    event: Omit<RunEventEnvelope, 'event_id' | 'seq'>,
  ): RunEventEnvelope {
    requireRun(runId);
    const stored = runsDb.appendEvent(runId, {
      ...event,
      payload: (redactPayload(event.payload ?? {}) ?? {}) as Record<string, unknown>,
    });
    broadcastSystemEvent({ kind: 'run_event', run_id: runId, event: stored });
    return stored;
  },

  recordMessage(runId: string, message: NormalizedMessage, source: RunEventEnvelope['source']): void {
    const run = requireRun(runId);
    if (message.kind === 'complete') {
      return;
    }

    if (
      (message.kind === 'text' || message.kind === 'stream_delta') &&
      !run.first_token_at &&
      (message.content || message.text)
    ) {
      const firstTokenAt = message.timestamp || nowIso();
      runsDb.updateStatus(runId, run.status, { first_token_at: firstTokenAt });
      this.appendEvent(runId, {
        run_id: runId,
        ts: firstTokenAt,
        source,
        type: 'run.first_token',
        payload: {},
      });
    }

    const event = normalizedMessageEvent(message);
    if (!event) return;
    this.appendEvent(runId, {
      run_id: runId,
      ts: message.timestamp || nowIso(),
      source,
      type: event.type,
      severity: event.severity,
      payload: event.payload,
    });
  },

  listEvents(runId: string, opts: { afterSeq?: number; limit?: number } = {}): RunEventEnvelope[] {
    requireRun(runId);
    return runsDb.listEvents(runId, opts);
  },

  attachUsage(runId: string, usage: TokenUsage): void {
    requireRun(runId);
    runsDb.attachUsage(runId, usage);
    this.appendEvent(runId, {
      run_id: runId,
      ts: nowIso(),
      source: 'system',
      type: 'token.usage',
      payload: {
        input: usage.input ?? null,
        output: usage.output ?? null,
        total: usage.total ?? null,
        cost_usd_estimate: usage.costUsdEstimate ?? null,
      },
    });
  },

  linkSession(runId: string, appSessionId: string): void {
    requireRun(runId);
    runsDb.linkSession(runId, appSessionId);
  },

  linkWorkspace(runId: string, workspaceId: string): void {
    requireRun(runId);
    runsDb.linkWorkspace(runId, workspaceId);
    this.appendEvent(runId, {
      run_id: runId,
      ts: nowIso(),
      source: 'system',
      type: 'workspace.bound',
      payload: { workspace_id: workspaceId },
    });
  },

  markTerminal(runId: string, result: TerminalResult): void {
    const run = requireRun(runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new CloudError(
        'RUN_ALREADY_TERMINAL',
        `Run ${runId} is already terminal (${run.status})`,
      );
    }
    if (!runsDb.markTerminal(runId, result)) {
      const current = runsDb.getById(runId);
      throw new CloudError(
        'RUN_ALREADY_TERMINAL',
        `Run ${runId} is already terminal (${current?.status ?? 'unknown'})`,
      );
    }
    this.appendEvent(runId, {
      run_id: runId,
      ts: nowIso(),
      source: 'system',
      type: TERMINAL_EVENT_TYPE[result.status],
      severity: result.status === 'succeeded' ? 'info' : 'error',
      payload: {
        status: result.status,
        error_summary: result.errorSummary ?? null,
        exit_code: result.exitCode ?? null,
      },
    });
    const updated = this.get(runId);
    if (updated) {
      broadcastSystemEvent({ kind: 'run_updated', run: summarizeRun(updated) });
    }
    // Automation kernel event trigger (PRD §12) — fire-and-forget.
    void import('@/modules/automation/index.js')
      .then(({ automationService }) => {
        void automationService.fire({
          type: 'run_completed',
          payload: {
            runId,
            status: result.status,
            source: run.source,
            projectId: run.project_id,
          },
          projectId: run.project_id,
        });
      })
      .catch(() => {
        // optional
      });
  },

  reconcileOrphans(): number {
    return runsDb.reconcileOrphans();
  },
};

/**
 * Persist a provider `token_budget` snapshot onto the run's usage columns.
 *
 * This is the only production writer of agent_runs.token_* — every run creator
 * funnels its provider stream through recordNormalizedRunEvent, so hooking it
 * here covers chat, swarm, mission-control, webhooks and failover at once.
 *
 * Writes go straight to runsDb (not runService.attachUsage) on purpose:
 * recordMessage has already appended a `run.status` event for this very
 * message, and a chatty provider emits one snapshot per assistant message, so
 * adding a second `token.usage` event per snapshot would double the timeline
 * volume for no extra information.
 */
function recordProviderUsage(runId: string, message: NormalizedMessage): void {
  if (message.kind !== 'status' || message.text !== 'token_budget') return;
  const snapshot = readTokenBudgetUsage(message.tokenBudget);
  const run = runService.get(runId);
  if (!run) return;
  // A request-time alias — Claude's `'default'`, but also generation-agnostic
  // aliases like `'sonnet'`/`'opus[1m]'` — gets resolved by the provider to a
  // concrete model id, reported in every token_budget event. Patch it in once
  // so the Stats "by model" breakdown groups these runs under their real
  // model instead of fragmenting into alias buckets alongside resolved-id
  // buckets for the same underlying model.
  const provider = run.provider ?? message.provider;
  const aliases = provider === 'claude' ? CLAUDE_MODEL_ALIASES : [];
  const tokenBudget = message.tokenBudget as { model?: unknown } | null | undefined;
  const resolvedModel = typeof tokenBudget?.model === 'string' ? tokenBudget.model.trim() : '';
  if (resolvedModel && !aliases.includes(resolvedModel) && resolvedModel !== 'default') {
    runsDb.resolveModel(runId, resolvedModel, aliases);
  }
  if (!snapshot) return;
  // Trust the run row's provider over the message's: the row is what the stats
  // breakdowns group by.
  const mode = usageAccumulationMode(run.provider ?? message.provider);
  const merged = mergeRunUsage(run, snapshot, mode);
  if (!merged) return;
  // Use whichever model is freshest: the one this very event just resolved,
  // or the run's already-resolved value from an earlier event.
  const effectiveModel = resolvedModel && !aliases.includes(resolvedModel) ? resolvedModel : run.model;
  // Price at the run's own start time, not wall-clock now — a long-running
  // run must keep the rate that was in effect when it started even if a
  // price change lands mid-session.
  const cost = estimateCostUsd(
    provider,
    effectiveModel,
    merged.input,
    merged.output,
    run.created_at,
    merged.cacheReadTokens,
    merged.cacheCreationTokens,
  );
  if (cost != null) merged.costUsdEstimate = cost;
  runsDb.attachUsage(runId, merged);
}

/** Bridge one provider-normalized event into a durable run and close it once. */
export function recordNormalizedRunEvent(
  runId: string,
  message: NormalizedMessage,
  source: RunEventEnvelope['source'],
): void {
  runService.recordMessage(runId, message, source);
  recordProviderUsage(runId, message);

  if (message.kind !== 'complete') {
    const current = runService.get(runId);
    if (current && message.kind === 'permission_request' && !TERMINAL_RUN_STATUSES.has(current.status)) {
      runService.updateStatus(runId, 'waiting_permission');
    } else if (current && current.status === 'waiting_permission') {
      runService.updateStatus(runId, 'running');
    }
    return;
  }

  const complete = message as NormalizedMessage & {
    exitCode?: number;
    success?: boolean;
    aborted?: boolean;
  };
  const status = complete.aborted
    ? 'aborted'
    : complete.success || complete.exitCode === 0
      ? 'succeeded'
      : 'failed';
  const current = runService.get(runId);
  if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
    runService.markTerminal(runId, {
      status,
      errorSummary: status === 'failed' ? message.content ?? 'Provider run failed' : null,
      exitCode: typeof complete.exitCode === 'number' ? complete.exitCode : null,
    });
  }
}
