import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Loader2,
  ShieldQuestion,
  Waypoints,
  X,
} from 'lucide-react';

import { agentRelayApi } from '../../../agent-relay/api/agentRelayApi';
import { formatAgentRelayModelIdentity } from '../../../agent-relay/modelIdentity';
import type { AgentRelayApproval, AgentRelayJob } from '../../../agent-relay/types';
import { formatCost, formatTokens } from '../../../stats/utils/format';
import { useWebSocket } from '../../../../contexts/WebSocketContext';

const ACTIVE = new Set(['queued', 'running', 'waiting_approval']);

function statusIcon(job: AgentRelayJob) {
  if (job.status === 'waiting_approval') return <ShieldQuestion className="h-3.5 w-3.5 text-amber-500" />;
  if (job.status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (job.status === 'queued') return <Clock3 className="h-3.5 w-3.5 text-amber-500" />;
  if (job.status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
  return <CircleAlert className="h-3.5 w-3.5 text-red-500" />;
}

type AgentRelayActivityControlProps = {
  projectId: string | null;
  /**
   * The lead chat this panel belongs to. Relays are scoped to it by default so
   * one chat never shows the workers another chat dispatched.
   */
  sessionId: string | null;
  /** Changes when the user explicitly starts a fresh chat draft. */
  newSessionTrigger?: number;
};

type RelayNavigationState = {
  openAgentRelay?: boolean;
  /**
   * Worker sessions are always internal — this navigation already knows
   * that before the session itself has loaded, so the chat view can fail
   * the read-only gate closed instead of briefly rendering the composer
   * enabled. Paired with `workerSessionId` so the hint can never outlive
   * the session it describes; see `resolveReadOnlyWorkerSession`.
   */
  isInternal?: boolean;
  /** The worker session this hint was minted for. */
  workerSessionId?: string;
};

export default function AgentRelayActivityControl({ projectId, sessionId, newSessionTrigger }: AgentRelayActivityControlProps) {
  const { subscribe } = useWebSocket();
  const location = useLocation();
  const navigate = useNavigate();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(() => Boolean((location.state as RelayNavigationState | null)?.openAgentRelay));
  const [jobs, setJobs] = useState<AgentRelayJob[]>([]);
  const [approvals, setApprovals] = useState<AgentRelayApproval[]>([]);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [projectJobCount, setProjectJobCount] = useState(0);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [peekById, setPeekById] = useState<Record<string, { idleMs: number | null; elapsedMs: number | null; toolCallCount?: number; recentOutput?: string | null; recentActivity: Array<{ type: string; tool: string | null; detail: string | null }> }>>({});
  const [followUpById, setFollowUpById] = useState<Record<string, string>>({});
  const [busyFollowUpId, setBusyFollowUpId] = useState<string | null>(null);
  const [diffById, setDiffById] = useState<Record<string, { files: Array<{ path: string; status: string }>; summary: { additions: number; deletions: number }; branch?: string }>>({});
  const loadRequestRef = useRef(0);

  useEffect(() => {
    if ((location.state as RelayNavigationState | null)?.openAgentRelay) {
      setOpen(true);
    }
  }, [location.state]);

  // A new draft has no lead session yet. Do not let the previous session's
  // relay scope survive the one render between the route and chat state reset.
  useEffect(() => {
    if (newSessionTrigger === undefined) return;
    setShowAllSessions(false);
  }, [newSessionTrigger]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    // An absent session means a brand-new draft, not an operator request for
    // every relay in the project. The all-sessions view is available only
    // while looking at a concrete session.
    if (!projectId || !sessionId) {
      setJobs([]);
      setApprovals([]);
      setProjectJobCount(0);
      return;
    }
    const scopeToSession = !showAllSessions;
    const sessionFilter = scopeToSession ? sessionId : undefined;
    const [activeJobs, recentJobs, projectJobs] = await Promise.all([
      agentRelayApi.listJobs({
        projectId,
        sessionId: sessionFilter,
        active: true,
        limit: 50,
      }),
      agentRelayApi.listJobs({
        projectId,
        sessionId: sessionFilter,
        limit: 12,
      }),
      scopeToSession ? agentRelayApi.listJobs({ projectId, limit: 12 }) : Promise.resolve([]),
    ]);
    if (requestId !== loadRequestRef.current) return;
    const merged = new Map<string, AgentRelayJob>();
    for (const job of [...activeJobs, ...recentJobs]) merged.set(job.relay_id, job);
    const nextJobs = [...merged.values()].sort((left, right) => right.created_at.localeCompare(left.created_at));
    // Approvals are stored against the lead source session. A worker transcript
    // must query that lead id, not the worker's own app_session_id.
    const leadFromJobs = nextJobs.find((job) => job.app_session_id === sessionId)?.source_session_id;
    const approvalSessionId = scopeToSession ? (leadFromJobs || sessionId) : undefined;
    const nextApprovals = await agentRelayApi.listPendingApprovals({ sessionId: approvalSessionId });
    if (requestId !== loadRequestRef.current) return;
    setJobs(nextJobs);
    setApprovals(nextApprovals);
    setProjectJobCount(projectJobs.length);
    setLastUpdatedAt(Date.now());
    setRefreshError(null);
  }, [projectId, sessionId, showAllSessions]);

  const refresh = useCallback(() => {
    void load().catch((caught) => {
      setRefreshError(caught instanceof Error ? caught.message : 'Relay status could not be refreshed.');
    });
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const readSettings = () => {
      void agentRelayApi.getSettings()
        .then((settings) => {
          if (!cancelled) setEnabled(settings.enabled);
        })
        .catch(() => {
          if (!cancelled) setEnabled(false);
        });
    };
    readSettings();
    window.addEventListener('agentRelaySettingsChanged', readSettings);
    return () => {
      cancelled = true;
      window.removeEventListener('agentRelaySettingsChanged', readSettings);
    };
  }, []);

  const activeCount = useMemo(() => jobs.filter((job) => ACTIVE.has(job.status)).length, [jobs]);
  const visibleRelayIds = useMemo(() => new Set(jobs.map((job) => job.relay_id)), [jobs]);
  // Session-scoped approvals are already scoped server-side, so show them even
  // when their job falls outside the fetched window — a blocked worker must
  // never be invisible. The project-wide view is unscoped on the server, so it
  // keeps the intersection with this project's fetched jobs.
  const visibleApprovals = useMemo(
    () => (!showAllSessions && sessionId
      ? approvals
      : approvals.filter((approval) => visibleRelayIds.has(approval.relay_id))),
    [approvals, sessionId, showAllSessions, visibleRelayIds],
  );

  const workerJobForCurrentSession = useMemo(
    () => sessionId
      ? jobs.find((job) => job.app_session_id === sessionId && Boolean(job.source_session_id)) ?? null
      : null,
    [jobs, sessionId],
  );
  const leadSessionId = workerJobForCurrentSession?.source_session_id ?? null;

  // “All sessions” is an explicit view for the session the user is currently
  // inspecting; never carry that choice into a different conversation.
  useEffect(() => {
    setShowAllSessions(false);
  }, [projectId, sessionId]);

  // Clear the previous scope immediately. The request guard above prevents a
  // slower response for the old session from putting those jobs back.
  useEffect(() => {
    loadRequestRef.current += 1;
    setJobs([]);
    setApprovals([]);
    setProjectJobCount(0);
    setExpandedId(null);
    setError(null);
    setPeekError(null);
    setRefreshError(null);
  }, [projectId, sessionId, showAllSessions]);

  useEffect(() => {
    if (!enabled || !projectId) {
      setJobs([]);
      setApprovals([]);
      return undefined;
    }
    refresh();
    // A closed panel only needs the badge counts fresh; websocket pushes cover
    // real transitions, so the closed-state poll is a slow safety net.
    const intervalMs = !open ? 30_000 : activeCount > 0 ? 2_000 : 6_000;
    const interval = window.setInterval(refresh, intervalMs);
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'agent_relay_updated' || event.kind === 'agent_relay_approval_updated') {
        refresh();
      }
    });
    return () => {
      window.clearInterval(interval);
      unsubscribe?.();
    };
  }, [activeCount, enabled, open, projectId, refresh, subscribe]);

  const expandedJobActive = useMemo(
    () => Boolean(expandedId && jobs.some((job) => job.relay_id === expandedId && ACTIVE.has(job.status))),
    [expandedId, jobs],
  );

  useEffect(() => {
    // Live re-peeking only makes sense for a job that is still doing things.
    if (!expandedId || !open || !enabled || !expandedJobActive) return undefined;
    const timer = window.setInterval(() => {
      void agentRelayApi.peek(expandedId)
        .then((peek) => {
          setPeekError(null);
          setPeekById((current) => ({ ...current, [expandedId]: peek }));
        })
        .catch((caught) => {
          setPeekError(caught instanceof Error ? caught.message : 'Could not refresh worker activity.');
        });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [enabled, expandedId, expandedJobActive, open]);

  if (!enabled || !projectId) return null;

  const peekJob = async (relayId: string) => {
    setError(null);
    setPeekError(null);
    setExpandedId((current) => (current === relayId ? null : relayId));
    try {
      const peek = await agentRelayApi.peek(relayId);
      setPeekById((current) => ({ ...current, [relayId]: peek }));
    } catch (caught) {
      setPeekError(caught instanceof Error ? caught.message : 'Could not peek at that worker.');
    }
  };

  const sendFollowUp = async (relayId: string) => {
    const prompt = followUpById[relayId]?.trim();
    if (!prompt) return;
    setBusyFollowUpId(relayId);
    setError(null);
    try {
      await agentRelayApi.followUp(relayId, prompt);
      setFollowUpById((current) => ({ ...current, [relayId]: '' }));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send follow-up.');
    } finally {
      setBusyFollowUpId(null);
    }
  };

  const openDiff = async (relayId: string) => {
    setError(null);
    setExpandedId(relayId);
    try {
      const diff = await agentRelayApi.diff(relayId);
      setDiffById((current) => ({
        ...current,
        [relayId]: {
          files: diff.files,
          summary: diff.summary,
          branch: diff.workspace?.feature_branch,
        },
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the worker diff.');
    }
  };

  const cancel = async (relayId: string) => {
    setError(null);
    try {
      await agentRelayApi.cancel(relayId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel delegate.');
    }
  };

  const decide = async (approvalId: string, allow: boolean) => {
    setError(null);
    setBusyApprovalId(approvalId);
    try {
      await agentRelayApi.decideApproval(approvalId, allow, allow ? 'Approved from the Relay panel.' : 'Denied from the Relay panel.');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record that decision.');
    } finally {
      setBusyApprovalId(null);
    }
  };

  /** Relay workers run in real sessions, so their transcripts are openable. */
  const openWorkerSession = (job: AgentRelayJob) => {
    if (!job.app_session_id) return;
    setOpen(false);
    navigate(`/session/${job.app_session_id}`, {
      state: {
        openAgentRelay: true,
        isInternal: true,
        workerSessionId: job.app_session_id,
      } satisfies RelayNavigationState,
    });
  };

  const openLeadSession = () => {
    if (!leadSessionId) return;
    setOpen(false);
    navigate(`/session/${leadSessionId}`);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/70 hover:text-foreground"
        title="View Agent Relay workers"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Waypoints className="h-3 w-3" />
        Relay
        {activeCount > 0 ? <span className="rounded-full bg-primary px-1.5 text-[9px] font-semibold text-primary-foreground">{activeCount}</span> : null}
        {visibleApprovals.length > 0 ? (
          <span className="rounded-full bg-amber-500 px-1.5 text-[9px] font-semibold text-white" title="Workers waiting on a permission decision">
            {visibleApprovals.length}
          </span>
        ) : null}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open ? (
        <div className="absolute bottom-full left-0 z-40 mb-1 w-[min(28rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-foreground">Agent Relay</div>
              <div className="text-[10px] text-muted-foreground">
                {activeCount > 0 ? `${activeCount} worker${activeCount === 1 ? '' : 's'} active` : 'No active workers'}
                {showAllSessions ? ' · all sessions' : ' · this session'}
                {jobs.length > 0 ? ` · ${jobs.filter((job) => !ACTIVE.has(job.status)).length}/${jobs.length} finished` : ''}
                {jobs.some((job) => job.status === 'queued') ? ` · ${jobs.filter((job) => job.status === 'queued').length} queued` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {leadSessionId ? (
                <button
                  type="button"
                  onClick={openLeadSession}
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                  title="Return to the lead agent session"
                >
                  <ArrowLeft className="h-3 w-3" />
                  Back to lead
                </button>
              ) : null}
              {sessionId ? (
                <button
                  type="button"
                  onClick={() => setShowAllSessions((value) => !value)}
                  className="text-[10px] font-medium text-muted-foreground hover:text-foreground"
                  title={showAllSessions ? 'Show only this session\'s relays' : 'Show every relay in this project'}
                >
                  {showAllSessions ? 'This session' : 'All sessions'}
                </button>
              ) : null}
              <button type="button" onClick={refresh} className="text-[10px] font-medium text-muted-foreground hover:text-foreground">Refresh</button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Close Agent Relay"
                aria-label="Close Agent Relay"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {error ? <div className="border-b border-border bg-red-500/10 px-3 py-2 text-[10px] text-red-600 dark:text-red-300">{error}</div> : null}
          {peekError ? (
            <div className="border-b border-border bg-amber-500/10 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">{peekError}</div>
          ) : null}
          {refreshError ? (
            <div className="border-b border-border bg-amber-500/10 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-300">
              Showing the last known Relay state{lastUpdatedAt ? ` from ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ''}. {refreshError}
            </div>
          ) : null}

          {visibleApprovals.length > 0 ? (
            <div className="border-b border-border bg-amber-500/10 p-2">
              <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                Waiting on a decision
              </div>
              {visibleApprovals.map((approval) => (
                <div key={approval.approval_id} className="mb-1.5 rounded-lg border border-amber-500/40 bg-background p-2.5 last:mb-0">
                  <div className="text-xs font-medium leading-4 text-foreground">
                    {approval.tool_name || 'Tool use'} needs approval
                  </div>
                  {approval.command ? (
                    <code className="mt-1 block truncate rounded bg-muted px-1.5 py-1 text-[10px] text-muted-foreground" title={approval.command}>{approval.command}</code>
                  ) : null}
                  {approval.cwd ? (
                    <div className="mt-1 truncate text-[10px] text-muted-foreground" title={approval.cwd}>cwd: {approval.cwd}</div>
                  ) : null}
                  {approval.paths.length > 0 ? (
                    <div className="mt-1 line-clamp-2 break-all text-[10px] text-muted-foreground" title={approval.paths.join('\n')}>
                      paths: {approval.paths.join(', ')}
                    </div>
                  ) : null}
                  <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{approval.reason}</p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      type="button"
                      disabled={busyApprovalId === approval.approval_id}
                      onClick={() => void decide(approval.approval_id, true)}
                      className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyApprovalId === approval.approval_id}
                      onClick={() => void decide(approval.approval_id, false)}
                      className="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="max-h-80 overflow-y-auto p-2">
            {jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
                {showAllSessions || !sessionId ? (
                  'No lead agent has delegated work in this project yet.'
                ) : projectJobCount > 0 ? (
                  <>
                    <p>This session has no relays of its own.</p>
                    <p className="mt-1 text-[10px]">
                      {projectJobCount} relay{projectJobCount === 1 ? '' : 's'} exist elsewhere in this project.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowAllSessions(true)}
                      className="mt-2 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-foreground hover:bg-muted"
                    >
                      Show all sessions
                    </button>
                  </>
                ) : (
                  'This session has not delegated any work yet.'
                )}
              </div>
            ) : jobs.map((job) => (
              <div key={job.relay_id} className="mb-1.5 rounded-lg border border-border/70 bg-background p-2.5 last:mb-0">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5">{statusIcon(job)}</span>
                  <button
                    type="button"
                    disabled={!job.app_session_id}
                    onClick={() => openWorkerSession(job)}
                    title={job.app_session_id ? 'Open this worker\'s session' : 'This worker has not started a session yet'}
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                  >
                    <div className="flex items-start gap-1">
                      <div className="line-clamp-2 flex-1 text-xs font-medium leading-4 text-foreground" title={job.task}>{job.label || job.task}</div>
                      {job.app_session_id ? <ChevronRight className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" /> : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span>{job.provider}</span>
                      <span>·</span>
                      <span title={formatAgentRelayModelIdentity(job)}>{formatAgentRelayModelIdentity(job)}</span>
                      <span>·</span>
                      <span>{job.effort || 'default effort'}</span>
                      <span>·</span>
                      <span>{job.mode === 'isolated_write' ? 'isolated write' : 'read only'}</span>
                      <span>·</span>
                      <span>{job.approval_policy === 'manual' ? 'manual approval' : 'auto approval'}</span>
                      <span>·</span>
                      <span>{job.status.replace('_', ' ')}</span>
                      {job.status === 'queued' && job.queue_position ? <><span>·</span><span>queue #{job.queue_position}</span></> : null}
                      {ACTIVE.has(job.status) ? (
                        <>
                          {job.usage?.totalTokens ? <><span>·</span><span title={`${job.usage.totalTokens.toLocaleString()} tokens`}>{formatTokens(job.usage.totalTokens)} tokens</span></> : null}
                          {job.usage?.costUsd ? <><span>·</span><span>{formatCost(job.usage.costUsd)}</span></> : null}
                        </>
                      ) : (
                        <>
                          <span>·</span>
                          <span title={job.usage?.totalTokens ? `${job.usage.totalTokens.toLocaleString()} tokens` : 'Usage not recorded'}>
                            {job.usage?.totalTokens ? `${formatTokens(job.usage.totalTokens)} tokens` : 'n/a tokens'}
                          </span>
                          <span>·</span>
                          <span>{job.usage?.costUsd ? formatCost(job.usage.costUsd) : 'n/a'}</span>
                        </>
                      )}
                    </div>
                    {job.result?.summary ? <p className="mt-1.5 line-clamp-3 text-[10px] leading-4 text-muted-foreground">{job.result.summary}</p> : null}
                    {job.result?.outputValidation && !job.result.outputValidation.valid ? (
                      <p className="mt-1 line-clamp-2 text-[10px] text-amber-700 dark:text-amber-300">
                        Structured output failed validation: {job.result.outputValidation.errors[0] ?? 'schema mismatch'}
                      </p>
                    ) : null}
                    {job.result?.openQuestions?.length ? (
                      <p className="mt-1 line-clamp-2 text-[10px] text-amber-700 dark:text-amber-300">Open: {job.result.openQuestions[0]}</p>
                    ) : null}
                    {job.error ? <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-red-500">{job.error}</p> : null}
                  </button>
                  {ACTIVE.has(job.status) ? (
                    <button
                      type="button"
                      onClick={() => void cancel(job.relay_id)}
                      title="Cancel delegate"
                      className="rounded-md p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                    >
                      <Ban className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5 pl-6">
                  {ACTIVE.has(job.status) ? (
                    <button type="button" onClick={() => void peekJob(job.relay_id)} className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                      {expandedId === job.relay_id ? 'Hide activity' : 'Peek'}
                    </button>
                  ) : (
                    <button type="button" onClick={() => void peekJob(job.relay_id)} className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                      Activity
                    </button>
                  )}
                  {job.mode === 'isolated_write' ? (
                    <button type="button" onClick={() => void openDiff(job.relay_id)} className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                      Diff
                    </button>
                  ) : null}
                </div>
                {expandedId === job.relay_id && peekById[job.relay_id] ? (
                  <div className="mt-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-[10px] text-muted-foreground">
                    {typeof peekById[job.relay_id]?.elapsedMs === 'number' ? `${Math.round((peekById[job.relay_id]!.elapsedMs ?? 0) / 1000)}s elapsed` : 'Not started'}
                    {typeof peekById[job.relay_id]?.idleMs === 'number' ? ` · idle ${Math.round((peekById[job.relay_id]!.idleMs ?? 0) / 1000)}s` : ''}
                    {typeof peekById[job.relay_id]?.toolCallCount === 'number' ? ` · ${peekById[job.relay_id]!.toolCallCount} tools` : ''}
                    <ul className="mt-1 space-y-0.5">
                      {(peekById[job.relay_id]?.recentActivity ?? []).slice(-6).map((entry, index) => (
                        <li key={`${entry.type}-${index}`} className="truncate">{entry.tool || entry.type}{entry.detail ? `: ${entry.detail}` : ''}</li>
                      ))}
                    </ul>
                    {peekById[job.relay_id]?.recentOutput ? (
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap border-t border-border/50 pt-1 italic">
                        {peekById[job.relay_id]!.recentOutput!.slice(-500)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {expandedId === job.relay_id && diffById[job.relay_id] ? (
                  <div className="mt-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-[10px] text-muted-foreground">
                    {diffById[job.relay_id]?.branch ? `${diffById[job.relay_id]?.branch} · ` : ''}
                    +{diffById[job.relay_id]?.summary.additions} / -{diffById[job.relay_id]?.summary.deletions}
                    <ul className="mt-1 space-y-0.5">
                      {(diffById[job.relay_id]?.files ?? []).slice(0, 8).map((file) => (
                        <li key={file.path} className="truncate">{file.status} {file.path}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {!ACTIVE.has(job.status) ? (
                  <div className="mt-1.5 flex gap-1 pl-6">
                    <input
                      value={followUpById[job.relay_id] ?? ''}
                      onChange={(event) => setFollowUpById((current) => ({ ...current, [job.relay_id]: event.target.value }))}
                      placeholder="Follow up with this worker…"
                      className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[10px] text-foreground"
                    />
                    <button
                      type="button"
                      disabled={busyFollowUpId === job.relay_id || !(followUpById[job.relay_id] ?? '').trim()}
                      onClick={() => void sendFollowUp(job.relay_id)}
                      className="rounded-md bg-primary px-2 text-[10px] font-medium text-primary-foreground disabled:opacity-50"
                    >
                      Send
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
