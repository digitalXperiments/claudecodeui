import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Ban,
  Bell,
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
import type { AgentRelayApproval, AgentRelayDeliveryStage, AgentRelayJob, AgentRelayUnlandedWorkspace } from '../../../agent-relay/types';
import { formatCost, formatTokens } from '../../../stats/utils/format';
import { useWebSocket } from '../../../../contexts/WebSocketContext';
import AgentRelayResultDetails from './AgentRelayResultDetails';
import { dependencyWaitReason, retryLabel, summarizeRelayUsage } from './agentRelayActivityUtils';

const ACTIVE = new Set(['queued', 'running', 'waiting_approval']);

function formatUsageSummary(summary: ReturnType<typeof summarizeRelayUsage>): string {
  const cost = summary.jobsWithCost > 0 ? formatCost(summary.costUsd) : 'cost unknown';
  const tokens = summary.jobsWithTokens > 0 ? `${formatTokens(summary.tokens)} tokens` : 'tokens unknown';
  const costCoverage = summary.jobsWithCost < summary.jobCount ? ` · ${summary.jobsWithCost}/${summary.jobCount} costs known` : '';
  const tokenCoverage = summary.jobsWithTokens < summary.jobCount ? ` · ${summary.jobsWithTokens}/${summary.jobCount} token reports` : '';
  return `${cost} · ${tokens}${costCoverage}${tokenCoverage}`;
}

function approvalCountdown(createdAt: string, timeoutMs: number, now: number): string {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 'expiry unknown';
  const remainingMs = Math.max(0, timeoutMs - (now - created));
  if (remainingMs === 0) return 'expires now';
  const seconds = Math.ceil(remainingMs / 1_000);
  return `expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusIcon(job: AgentRelayJob) {
  if (job.status === 'waiting_approval') return <ShieldQuestion className="h-3.5 w-3.5 text-amber-500" aria-label="Waiting on approval" />;
  if (job.status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-label="Running" />;
  if (job.status === 'queued') return <Clock3 className="h-3.5 w-3.5 text-amber-500" aria-label="Queued" />;
  if (job.status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-label="Completed" />;
  if (job.status === 'blocked') return <CircleAlert className="h-3.5 w-3.5 text-amber-500" aria-label="Blocked" />;
  return <CircleAlert className="h-3.5 w-3.5 text-red-500" aria-label={job.status.replace('_', ' ')} />;
}

const TERMINAL = new Set(['completed', 'blocked', 'failed', 'cancelled', 'timed_out']);

const DELIVERY_LABEL: Record<AgentRelayDeliveryStage, string> = {
  pending: 'checks pending',
  verified: 'checks passed',
  verify_failed: 'checks failed',
  ready_to_land: 'ready to land',
  rehearsal_failed: 'rehearsal failed',
  landed: 'landed',
  discarded: 'discarded',
};

function deliveryTone(stage: AgentRelayDeliveryStage): string {
  if (stage === 'ready_to_land' || stage === 'landed') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (stage === 'verify_failed' || stage === 'rehearsal_failed') return 'bg-red-500/10 text-red-600 dark:text-red-300';
  return 'bg-muted text-muted-foreground';
}

function isDeliverable(job: AgentRelayJob): boolean {
  return job.mode === 'isolated_write' && Boolean(job.workspace_id) && job.status === 'completed' && job.result?.status === 'completed';
}

function notify(title: string, body: string, tag: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  new Notification(title, { body, tag });
}

type AgentRelayActivityControlProps = {
  projectId: string | null;
  /**
   * The lead chat this panel belongs to. Relays are scoped to it by default so
   * one chat never shows the workers another chat dispatched.
   */
  sessionId: string | null;
  /** Explicitly select the project-wide operator view without inventing a session id. */
  scope?: 'session' | 'project';
  /** Changes when the user explicitly starts a fresh chat draft. */
  newSessionTrigger?: number;
  /** Render the activity view directly inside the secondary sidebar. */
  embedded?: boolean;
  /** Supplies the mounted operator header with counts while this view is collapsed. */
  onSummaryChange?: (summary: AgentRelaySummary) => void;
};

export type AgentRelaySummary = {
  activeCount: number;
  approvalCount: number;
  jobCount: number;
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

export default function AgentRelayActivityControl({ projectId, sessionId, scope = 'session', newSessionTrigger, embedded = false, onSummaryChange }: AgentRelayActivityControlProps) {
  const { subscribe } = useWebSocket();
  const location = useLocation();
  const navigate = useNavigate();
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(() => embedded || Boolean((location.state as RelayNavigationState | null)?.openAgentRelay));
  const [jobs, setJobs] = useState<AgentRelayJob[]>([]);
  const [approvals, setApprovals] = useState<AgentRelayApproval[]>([]);
  const [showAllSessions, setShowAllSessions] = useState(scope === 'project');
  const [projectJobCount, setProjectJobCount] = useState(0);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [activityExpandedById, setActivityExpandedById] = useState<Record<string, boolean>>({});
  const [diffExpandedById, setDiffExpandedById] = useState<Record<string, boolean>>({});
  const [peekById, setPeekById] = useState<Record<string, { idleMs: number | null; elapsedMs: number | null; toolCallCount?: number; recentOutput?: string | null; recentActivity: Array<{ type: string; tool: string | null; detail: string | null }> }>>({});
  const [followUpById, setFollowUpById] = useState<Record<string, string>>({});
  const [busyFollowUpId, setBusyFollowUpId] = useState<string | null>(null);
  const [busyCancelId, setBusyCancelId] = useState<string | null>(null);
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(() => new Set());
  const [busyRehearsalBatch, setBusyRehearsalBatch] = useState<string | null>(null);
  const [busyLandId, setBusyLandId] = useState<string | null>(null);
  const [busyDiscardId, setBusyDiscardId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [noticeById, setNoticeById] = useState<Record<string, string>>({});
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(
    () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission),
  );
  const [diffById, setDiffById] = useState<Record<string, { files: Array<{ path: string; status: string; patch?: string }>; summary: { additions: number; deletions: number }; branch?: string }>>({});
  const previousJobStateRef = useRef<Map<string, { status: string; stage: string | null }>>(new Map());
  const [unlanded, setUnlanded] = useState<AgentRelayUnlandedWorkspace[]>([]);
  const unlandedFetchedAtRef = useRef(0);
  const [approvalTimeoutMs, setApprovalTimeoutMs] = useState(5 * 60_000);
  const [now, setNow] = useState(() => Date.now());
  const approvalIdsRef = useRef<Set<string>>(new Set());
  const approvalHydratedRef = useRef(false);
  const approvalScopeRef = useRef<string | null>(null);
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
    if (scope === 'session') setShowAllSessions(false);
  }, [newSessionTrigger, scope]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    if (!projectId || (scope === 'session' && !sessionId)) {
      setJobs([]);
      setApprovals([]);
      setProjectJobCount(0);
      return;
    }
    const scopeToSession = scope === 'session' && !showAllSessions;
    const sessionFilter = scopeToSession ? sessionId : undefined;
    const [activeJobs, recentJobs, projectJobs] = await Promise.all([
      agentRelayApi.listJobs({
        projectId,
        sessionId: sessionFilter ?? undefined,
        active: true,
        limit: 50,
      }),
      agentRelayApi.listJobs({
        projectId,
        sessionId: sessionFilter ?? undefined,
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
    // Older writers fall out of the recent window; unlanded work must not.
    // It inspects every writer's git state, so refresh it at most once a minute.
    const unlandedDue = Date.now() - unlandedFetchedAtRef.current > 60_000;
    const [nextApprovals, nextUnlanded] = await Promise.all([
      agentRelayApi.listPendingApprovals({ sessionId: approvalSessionId ?? undefined }),
      unlandedDue ? agentRelayApi.listUnlanded(projectId).catch(() => null) : Promise.resolve(null),
    ]);
    if (requestId !== loadRequestRef.current) return;
    if (nextUnlanded) {
      unlandedFetchedAtRef.current = Date.now();
      const visibleIds = new Set(nextJobs.map((job) => job.relay_id));
      setUnlanded(nextUnlanded.filter((entry) => !visibleIds.has(entry.relay_id) && entry.changed_files !== 0));
    }
    setJobs(nextJobs);
    setApprovals(nextApprovals);
    setProjectJobCount(projectJobs.length);
    setLastUpdatedAt(Date.now());
    setRefreshError(null);
  }, [projectId, scope, sessionId, showAllSessions]);

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
          if (!cancelled) {
            setEnabled(settings.enabled);
            setApprovalTimeoutMs(settings.approvalTimeoutMs);
          }
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

  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.relay_id, job])), [jobs]);
  const jobsByBatch = useMemo(() => {
    const groups = new Map<string, AgentRelayJob[]>();
    for (const job of jobs) {
      const batch = groups.get(job.batch_id) ?? [];
      batch.push(job);
      groups.set(job.batch_id, batch);
    }
    return [...groups.entries()];
  }, [jobs]);
  const usageSummary = useMemo(() => summarizeRelayUsage(jobs), [jobs]);

  useEffect(() => {
    onSummaryChange?.({ activeCount, approvalCount: visibleApprovals.length, jobCount: jobs.length });
  }, [activeCount, jobs.length, onSummaryChange, visibleApprovals.length]);

  useEffect(() => {
    if (visibleApprovals.length === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [visibleApprovals.length]);

  useEffect(() => {
    const scopeKey = `${projectId ?? ''}:${scope}:${sessionId ?? ''}`;
    if (scopeKey !== approvalScopeRef.current) {
      approvalIdsRef.current = new Set();
      approvalHydratedRef.current = false;
      approvalScopeRef.current = scopeKey;
    }
  }, [projectId, scope, sessionId]);

  useEffect(() => {
    const currentIds = new Set(visibleApprovals.map((approval) => approval.approval_id));
    if (!approvalHydratedRef.current) {
      approvalIdsRef.current = currentIds;
      approvalHydratedRef.current = true;
      return;
    }
    const newlyPending = visibleApprovals.filter((approval) => !approvalIdsRef.current.has(approval.approval_id));
    approvalIdsRef.current = new Set([...approvalIdsRef.current, ...currentIds]);
    if (newlyPending.length === 0 || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
    const count = newlyPending.length;
    new Notification('Agent Relay approval needed', {
      body: `${count} worker${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} waiting for permission.`,
      tag: `agent-relay-approvals-${projectId ?? 'project'}`,
    });
  }, [projectId, visibleApprovals]);

  // Tell the operator when workers finish or a batch is ready to land, not
  // only when an approval is pending. Seeded silently on first load.
  useEffect(() => {
    const previous = previousJobStateRef.current;
    const seeded = previous.size > 0;
    const finished: AgentRelayJob[] = [];
    const ready: AgentRelayJob[] = [];
    for (const job of jobs) {
      const before = previous.get(job.relay_id);
      const stage = job.delivery?.stage ?? null;
      if (seeded && before && !TERMINAL.has(before.status) && TERMINAL.has(job.status)) finished.push(job);
      if (seeded && before && before.stage !== 'ready_to_land' && stage === 'ready_to_land') ready.push(job);
      previous.set(job.relay_id, { status: job.status, stage });
    }
    if (finished.length > 0) {
      const needsAttention = finished.filter((job) => job.status !== 'completed');
      notify(
        needsAttention.length > 0 ? 'Agent Relay worker needs attention' : 'Agent Relay worker finished',
        finished.map((job) => `${job.label || job.relay_id}: ${job.status}`).join('\n'),
        `agent-relay-finished-${projectId ?? 'project'}`,
      );
    }
    if (ready.length > 0) {
      notify('Agent Relay work ready to land', ready.map((job) => job.label || job.relay_id).join(', '), `agent-relay-ready-${projectId ?? 'project'}`);
    }
  }, [jobs, projectId]);

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
  }, [projectId, scope, sessionId]);

  // Clear the previous scope immediately. The request guard above prevents a
  // slower response for the old session from putting those jobs back.
  useEffect(() => {
    loadRequestRef.current += 1;
    setJobs([]);
    setApprovals([]);
    setProjectJobCount(0);
    setActivityExpandedById({});
    setDiffExpandedById({});
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

  useEffect(() => {
    // Live re-peeking only makes sense for a job that is still doing things.
    const activeExpandedIds = Object.entries(activityExpandedById)
      .filter(([relayId, expanded]) => expanded && jobs.some((job) => job.relay_id === relayId && ACTIVE.has(job.status)))
      .map(([relayId]) => relayId);
    if (!open || !enabled || activeExpandedIds.length === 0) return undefined;
    const timer = window.setInterval(() => {
      for (const relayId of activeExpandedIds) {
        void agentRelayApi.peek(relayId)
          .then((peek) => {
            setPeekError(null);
            setPeekById((current) => ({ ...current, [relayId]: peek }));
          })
          .catch((caught) => {
            setPeekError(caught instanceof Error ? caught.message : 'Could not refresh worker activity.');
          });
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activityExpandedById, enabled, jobs, open]);

  if (!enabled || !projectId) {
    if (!embedded) return null;
    return (
      <div className="flex min-h-24 flex-1 items-center justify-center px-5 py-4 text-center text-xs text-muted-foreground">
        {!projectId
          ? 'Select a project to view its Relay activity.'
          : 'Agent Relay is disabled. Enable it from Agent Relay settings.'}
      </div>
    );
  }

  const toggleActivity = async (relayId: string) => {
    const opening = !activityExpandedById[relayId];
    setActivityExpandedById((current) => ({ ...current, [relayId]: opening }));
    if (!opening || peekById[relayId]) return;
    setError(null);
    setPeekError(null);
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

  const setJobError = (relayId: string, message: string | null) => {
    setErrorById((current) => {
      const next = { ...current };
      if (message) next[relayId] = message;
      else delete next[relayId];
      return next;
    });
  };

  const setJobNotice = (relayId: string, message: string | null) => {
    setNoticeById((current) => {
      const next = { ...current };
      if (message) next[relayId] = message;
      else delete next[relayId];
      return next;
    });
  };

  const loadDiff = async (relayId: string) => {
    const diff = await agentRelayApi.diff(relayId, true);
    setDiffById((current) => ({
      ...current,
      [relayId]: { files: diff.files, summary: diff.summary, branch: diff.workspace?.feature_branch },
    }));
  };

  const toggleDiff = async (relayId: string) => {
    const opening = !diffExpandedById[relayId];
    setDiffExpandedById((current) => ({ ...current, [relayId]: opening }));
    if (!opening) return;
    setJobError(relayId, null);
    try {
      // Always refetch on open: a follow-up may have changed the worktree.
      await loadDiff(relayId);
    } catch (caught) {
      setJobError(relayId, caught instanceof Error ? caught.message : 'Could not load the worker diff.');
    }
  };

  const verifyWriter = async (relayId: string) => {
    setJobError(relayId, null);
    setVerifyingIds((current) => new Set(current).add(relayId));
    try {
      const { verification, passed } = await agentRelayApi.verify(relayId);
      if (!passed) {
        const failed = verification.evidence.find((item) => !item.passed);
        setJobError(relayId, failed ? `${failed.command} failed${failed.exitCode != null ? ` (exit ${failed.exitCode})` : ''}` : verification.message || 'Host checks did not pass.');
      } else {
        setJobNotice(relayId, verification.unavailable ? 'No project checks are configured; nothing to run.' : 'Host checks passed.');
      }
      await load();
    } catch (caught) {
      setJobError(relayId, caught instanceof Error ? caught.message : 'Could not verify the writer workspace.');
    } finally {
      setVerifyingIds((current) => { const next = new Set(current); next.delete(relayId); return next; });
    }
  };

  const rehearseBatch = async (batchId: string, writerJobs: AgentRelayJob[]) => {
    if (!projectId || writerJobs.length === 0) return;
    setError(null);
    setBusyRehearsalBatch(batchId);
    try {
      const builtOn = new Set(writerJobs.flatMap((job) => job.depends_on));
      const leaves = writerJobs.filter((job) => !builtOn.has(job.relay_id));
      const result = await agentRelayApi.rehearse(projectId, leaves.map((job) => job.relay_id));
      if (!result.passed) {
        const detail = result.conflicts.length > 0
          ? `conflicts in ${result.conflicts.map((item) => item.path).slice(0, 5).join(', ')}`
          : result.checks?.evidence.find((item) => !item.passed)?.command ?? result.outcome;
        setError(`The combined rehearsal did not pass: ${detail}.`);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not rehearse the writer batch.');
    } finally {
      setBusyRehearsalBatch(null);
    }
  };

  const describeLanding = (entry: { commitSha?: string | null; leftUncommitted?: string[]; conflicts?: Array<{ path: string }>; skipped?: string }) => {
    if (entry.skipped) return entry.skipped;
    const parts = [entry.commitSha ? `committed ${entry.commitSha.slice(0, 8)}` : 'nothing committed'];
    if (entry.leftUncommitted?.length) parts.push(`${entry.leftUncommitted.length} file(s) merged with your edits, left uncommitted`);
    if (entry.conflicts?.length) parts.push(`conflicts: ${entry.conflicts.map((item) => item.path).slice(0, 4).join(', ')}`);
    return `Landed · ${parts.join(' · ')}`;
  };

  const landBatch = async (batchId: string, rehearsalId: string) => {
    setError(null);
    setBusyRehearsalBatch(batchId);
    try {
      const result = await agentRelayApi.landRehearsal(rehearsalId);
      for (const entry of result.landed) setJobNotice(entry.relayId, describeLanding(entry));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not land the rehearsal.');
    } finally {
      setBusyRehearsalBatch(null);
    }
  };

  const landWriter = async (job: AgentRelayJob, rehearsalId: string) => {
    setJobError(job.relay_id, null);
    setBusyLandId(job.relay_id);
    try {
      const result = await agentRelayApi.land(job.relay_id, { rehearsalId });
      const entry = result.landed.find((item) => item.relayId === job.relay_id);
      if (entry) setJobNotice(job.relay_id, describeLanding(entry));
      await load();
    } catch (caught) {
      setJobError(job.relay_id, caught instanceof Error ? caught.message : 'Could not land the writer workspace.');
    } finally {
      setBusyLandId(null);
    }
  };

  const discardWriter = async (job: AgentRelayJob) => {
    if (!window.confirm(`Discard ${job.label || job.relay_id}? Its worktree and branch are deleted without landing.`)) return;
    setJobError(job.relay_id, null);
    setBusyDiscardId(job.relay_id);
    try {
      await agentRelayApi.discard(job.relay_id);
      setJobNotice(job.relay_id, 'Worktree and branch discarded.');
      await load();
    } catch (caught) {
      setJobError(job.relay_id, caught instanceof Error ? caught.message : 'Could not discard the worktree.');
    } finally {
      setBusyDiscardId(null);
    }
  };

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    setNotificationPermission(await Notification.requestPermission());
  };

  const cancel = async (relayId: string) => {
    setError(null);
    setBusyCancelId(relayId);
    try {
      await agentRelayApi.cancel(relayId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel delegate.');
    } finally {
      setBusyCancelId(null);
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
    <div className={embedded ? 'flex min-h-0 flex-1 flex-col' : 'relative'}>
      {!embedded ? <button
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
      </button> : null}

      {open ? (
        <div className={embedded
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden bg-card/20'
          : 'absolute bottom-full left-0 z-40 mb-1 w-[min(28rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-popover shadow-xl'}>
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-foreground">Agent Relay</div>
              <div className="text-[10px] text-muted-foreground">
                {activeCount > 0 ? `${activeCount} worker${activeCount === 1 ? '' : 's'} active` : 'No active workers'}
                {scope === 'project' || showAllSessions ? ' · project' : ' · this session'}
                {jobs.length > 0 ? ` · ${jobs.filter((job) => !ACTIVE.has(job.status)).length}/${jobs.length} finished` : ''}
                {jobs.some((job) => job.status === 'queued') ? ` · ${jobs.filter((job) => job.status === 'queued').length} queued` : ''}
                {jobs.length > 0 ? ` · ${formatUsageSummary(usageSummary)}` : ''}
                {visibleApprovals.length > 0 ? ` · ${visibleApprovals.length} approval${visibleApprovals.length === 1 ? '' : 's'} waiting` : ''}
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
              {scope === 'session' && sessionId ? (
                <button
                  type="button"
                  onClick={() => setShowAllSessions((value) => !value)}
                  className="text-[10px] font-medium text-muted-foreground hover:text-foreground"
                  title={showAllSessions ? 'Show only this session\'s relays' : 'Show every relay in this project'}
                >
                  {showAllSessions ? 'This session' : 'All sessions'}
                </button>
              ) : null}
              {notificationPermission === 'default' ? (
                <button
                  type="button"
                  onClick={() => void enableNotifications()}
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                  title="Notify me when workers finish, need approval, or are ready to land"
                >
                  <Bell className="h-3 w-3" aria-hidden="true" />
                  Notify me
                </button>
              ) : null}
              <button type="button" onClick={refresh} className="text-[10px] font-medium text-muted-foreground hover:text-foreground">Refresh</button>
              {!embedded ? <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Close Agent Relay"
                aria-label="Close Agent Relay"
              >
                <X className="h-3.5 w-3.5" />
              </button> : null}
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
              {visibleApprovals.map((approval) => {
                const approvalJob = jobsById.get(approval.relay_id);
                return (
                  <div key={approval.approval_id} className="mb-1.5 rounded-lg border border-amber-500/40 bg-background p-2.5 last:mb-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 text-xs font-medium leading-4 text-foreground">
                        {approval.tool_name || 'Tool use'} needs approval
                        {approvalJob?.label ? <div className="truncate text-[10px] font-normal text-muted-foreground">{approvalJob.label}</div> : null}
                      </div>
                      <span className="shrink-0 text-[10px] font-medium text-amber-700 dark:text-amber-300">{approvalCountdown(approval.created_at, approvalTimeoutMs, now)}</span>
                    </div>
                    {approvalJob ? <div className="mt-1 text-[10px] text-muted-foreground">provider: {approvalJob.provider}</div> : null}
                    <details className="mt-1.5 rounded bg-muted/40 px-1.5 py-1">
                      <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">Request details</summary>
                      <div className="mt-1 space-y-1 text-[10px] text-muted-foreground">
                        {approval.command ? <code className="block break-all rounded bg-muted px-1.5 py-1" title={approval.command}>{approval.command}</code> : <div>command: none supplied</div>}
                        {approval.cwd ? <div className="break-all">cwd: {approval.cwd}</div> : null}
                        <div className="break-all">paths: {approval.paths.length > 0 ? `${approval.paths.slice(0, 5).join(', ')}${approval.paths.length > 5 ? ` · +${approval.paths.length - 5} more` : ''}` : 'none supplied'}</div>
                        <p className="leading-4">{approval.reason}</p>
                      </div>
                    </details>
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
                );
              })}
            </div>
          ) : null}

          {unlanded.length > 0 ? (
            <details className="border-b border-border px-3 py-2 text-[10px] text-muted-foreground">
              <summary className="cursor-pointer font-semibold uppercase tracking-wide">
                Unlanded work from earlier batches ({unlanded.length})
              </summary>
              <ul className="mt-1.5 space-y-1">
                {unlanded.map((entry) => (
                  <li key={entry.workspace_id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={entry.branch}>
                      <span className="font-medium text-foreground">{entry.label || entry.relay_id}</span>
                      {' · '}{entry.changed_files < 0 ? 'changes unknown' : `${entry.changed_files} file${entry.changed_files === 1 ? '' : 's'}`}
                      {entry.delivery && entry.delivery.stage !== 'pending' ? ` · ${DELIVERY_LABEL[entry.delivery.stage]}` : ''}
                    </span>
                    {entry.delivery?.stage === 'ready_to_land' && entry.delivery.rehearsalId ? (
                      <button
                        type="button"
                        onClick={() => void agentRelayApi.land(entry.relay_id, { rehearsalId: entry.delivery!.rehearsalId! }).then(() => load()).catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not land.'))}
                        className="rounded-md bg-primary px-1.5 py-0.5 font-medium text-primary-foreground"
                        aria-label={`Land ${entry.label || entry.relay_id}`}
                      >
                        Land
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm(`Discard ${entry.label || entry.relay_id}? Its worktree and branch are deleted without landing.`)) return;
                        void agentRelayApi.discard(entry.relay_id).then(() => load()).catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not discard.'));
                      }}
                      className="rounded-md border border-border px-1.5 py-0.5 hover:text-red-500"
                      aria-label={`Discard ${entry.label || entry.relay_id}`}
                    >
                      Discard
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className={embedded ? 'min-h-0 flex-1 overflow-y-auto p-2' : 'max-h-80 overflow-y-auto p-2'}>
            {jobs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
                {scope === 'project' || showAllSessions || !sessionId ? (
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
            ) : jobsByBatch.map(([batchId, batchJobs]) => {
              const writerJobs = batchJobs.filter((job) => isDeliverable(job) && job.delivery?.stage !== 'landed' && job.delivery?.stage !== 'discarded');
              const allVerified = writerJobs.length > 0 && writerJobs.every((job) => job.delivery?.verifyPassed);
              const readyRehearsalId = writerJobs.find((job) => job.delivery?.stage === 'ready_to_land' && job.delivery.rehearsalId)?.delivery?.rehearsalId ?? null;
              const batchBusy = batchJobs.some((job) => ACTIVE.has(job.status));
              return (
              <section key={batchId} className="mb-2 last:mb-0">
                <div className="mb-1 flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1 rounded-md bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground">Batch {batchId.slice(0, 8)}</span>
                  <span className="min-w-0 break-words">{batchJobs.length} worker{batchJobs.length === 1 ? '' : 's'} · {formatUsageSummary(summarizeRelayUsage(batchJobs))}</span>
                  {writerJobs.length > 0 ? (
                    <span className="flex gap-1">
                      {readyRehearsalId ? (
                        <button
                          type="button"
                          disabled={busyRehearsalBatch === batchId}
                          onClick={() => void landBatch(batchId, readyRehearsalId)}
                          className="rounded-md bg-primary px-1.5 py-0.5 font-medium text-primary-foreground disabled:opacity-50"
                          title="Apply the rehearsed writers onto your checkout. Clean files are committed; files you also edited are merged and left uncommitted."
                          aria-label={`Land batch ${batchId.slice(0, 8)}`}
                        >
                          {busyRehearsalBatch === batchId ? 'Working…' : 'Land batch'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={!allVerified || batchBusy || busyRehearsalBatch === batchId}
                        onClick={() => void rehearseBatch(batchId, writerJobs)}
                        className="rounded-md border border-border px-1.5 py-0.5 font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        title={batchBusy
                          ? 'The server rehearses automatically once every worker in the batch has finished.'
                          : !allVerified ? 'Every finished writer needs passing host checks first.' : 'Apply these writers onto a copy of your current checkout and run the project checks.'}
                        aria-label={`Rehearse batch ${batchId.slice(0, 8)}`}
                      >
                        {busyRehearsalBatch === batchId ? 'Working…' : readyRehearsalId ? 'Rehearse again' : 'Rehearse'}
                      </button>
                    </span>
                  ) : null}
                </div>
                {batchJobs.map((job) => (
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
                          {job.usage?.totalTokens != null ? <><span>·</span><span title={`${job.usage.totalTokens.toLocaleString()} tokens`}>{formatTokens(job.usage.totalTokens)} tokens</span></> : null}
                          {job.usage?.costUsd != null ? <><span>·</span><span>{formatCost(job.usage.costUsd)}</span></> : null}
                        </>
                      ) : (
                        <>
                          <span>·</span>
                          <span title={job.usage?.totalTokens != null ? `${job.usage.totalTokens.toLocaleString()} tokens` : 'Usage not recorded'}>
                            {job.usage?.totalTokens != null ? `${formatTokens(job.usage.totalTokens)} tokens` : 'unknown tokens'}
                          </span>
                          <span>·</span>
                          <span>{job.usage?.costUsd != null ? formatCost(job.usage.costUsd) : 'unknown cost'}</span>
                        </>
                      )}
                    </div>
                    {dependencyWaitReason(job, jobsById) ? <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">{dependencyWaitReason(job, jobsById)}</p> : null}
                    {retryLabel(job) ? <p className="mt-1 text-[10px] text-muted-foreground">{retryLabel(job)}</p> : null}
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
                    {job.failovers?.length ? (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Failed over {job.failovers.map((entry) => `${entry.fromProvider} → ${entry.toProvider} (${entry.failure.replace('_', ' ')})`).join(', ')}
                      </p>
                    ) : null}
                  </button>
                  {ACTIVE.has(job.status) ? (
                    <button
                      type="button"
                      disabled={busyCancelId === job.relay_id}
                      onClick={() => void cancel(job.relay_id)}
                      title="Cancel delegate"
                      aria-label={`Cancel ${job.label || 'relay worker'}`}
                      className="rounded-md p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-500 disabled:cursor-wait disabled:opacity-50"
                    >
                      {busyCancelId === job.relay_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Ban className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                  ) : null}
                </div>
                {job.result ? <AgentRelayResultDetails result={job.result} /> : null}
                {job.denied_actions?.length ? (
                  <details className="mt-1.5 ml-6 rounded bg-amber-500/10 px-1.5 py-1 text-[10px] text-amber-800 dark:text-amber-200">
                    <summary className="cursor-pointer font-medium">
                      {job.denied_actions.length} action{job.denied_actions.length === 1 ? '' : 's'} blocked at the sandbox boundary
                    </summary>
                    <ul className="mt-1 space-y-0.5">
                      {job.denied_actions.slice(-8).map((action, index) => (
                        <li key={`${action.at}-${index}`} className="break-all">
                          <code>{action.command || action.tool || 'tool use'}</code> — {action.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <div className="mt-1.5 flex flex-wrap gap-1.5 pl-6">
                  {ACTIVE.has(job.status) ? (
                    <button type="button" onClick={() => void toggleActivity(job.relay_id)} aria-expanded={Boolean(activityExpandedById[job.relay_id])} className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                      {activityExpandedById[job.relay_id] ? 'Hide activity' : 'Peek'}
                    </button>
                  ) : (
                    <button type="button" onClick={() => void toggleActivity(job.relay_id)} aria-expanded={Boolean(activityExpandedById[job.relay_id])} className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                      {activityExpandedById[job.relay_id] ? 'Hide activity' : 'Activity'}
                    </button>
                  )}
                  {job.mode === 'isolated_write' ? (
                    <button type="button" onClick={() => void toggleDiff(job.relay_id)} aria-expanded={Boolean(diffExpandedById[job.relay_id])} className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
                      {diffExpandedById[job.relay_id] ? 'Hide diff' : 'Diff'}
                    </button>
                  ) : null}
                  {job.delivery && job.delivery.stage !== 'pending' ? (
                    <span className={`self-center rounded px-1.5 py-0.5 text-[10px] font-medium ${deliveryTone(job.delivery.stage)}`}>
                      {DELIVERY_LABEL[job.delivery.stage]}
                    </span>
                  ) : null}
                  {isDeliverable(job) && job.delivery?.stage !== 'landed' && job.delivery?.stage !== 'discarded' ? (
                    <>
                      <button
                        type="button"
                        disabled={verifyingIds.has(job.relay_id)}
                        onClick={() => void verifyWriter(job.relay_id)}
                        aria-label={`Run host checks for ${job.label || job.relay_id}`}
                        className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        {verifyingIds.has(job.relay_id) ? 'Checking…' : job.delivery?.verifyPassed ? 'Check again' : 'Verify'}
                      </button>
                      {job.delivery?.stage === 'ready_to_land' && job.delivery.rehearsalId ? (
                        <button
                          type="button"
                          disabled={busyLandId === job.relay_id}
                          onClick={() => void landWriter(job, job.delivery!.rehearsalId!)}
                          aria-label={`Land ${job.label || job.relay_id}`}
                          className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground disabled:opacity-50"
                        >
                          {busyLandId === job.relay_id ? 'Landing…' : 'Land'}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                  {job.mode === 'isolated_write' && job.workspace_id && TERMINAL.has(job.status) && job.delivery?.stage !== 'landed' && job.delivery?.stage !== 'discarded' ? (
                    <button
                      type="button"
                      disabled={busyDiscardId === job.relay_id}
                      onClick={() => void discardWriter(job)}
                      aria-label={`Discard ${job.label || job.relay_id}`}
                      className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-red-500/40 hover:text-red-500 disabled:opacity-50"
                    >
                      {busyDiscardId === job.relay_id ? 'Discarding…' : 'Discard'}
                    </button>
                  ) : null}
                </div>
                {errorById[job.relay_id] ? <p role="alert" className="mt-1 pl-6 text-[10px] text-red-600 dark:text-red-300">{errorById[job.relay_id]}</p> : null}
                {noticeById[job.relay_id] ? <p className="mt-1 pl-6 text-[10px] text-emerald-700 dark:text-emerald-300">{noticeById[job.relay_id]}</p> : null}
                {activityExpandedById[job.relay_id] && peekById[job.relay_id] ? (
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
                {diffExpandedById[job.relay_id] && diffById[job.relay_id] ? (
                  <div className="mt-1.5 rounded-md bg-muted/40 px-2 py-1.5 text-[10px] text-muted-foreground">
                    {diffById[job.relay_id]?.branch ? `${diffById[job.relay_id]?.branch} · ` : ''}
                    +{diffById[job.relay_id]?.summary.additions} / -{diffById[job.relay_id]?.summary.deletions}
                    <ul className="mt-1 space-y-0.5">
                      {(diffById[job.relay_id]?.files ?? []).map((file) => (
                        <li key={file.path}>
                          {file.patch ? (
                            <details>
                              <summary className="cursor-pointer truncate">{file.status} {file.path}</summary>
                              <pre className="mt-1 max-h-64 overflow-auto rounded bg-background p-1.5 font-mono text-[10px] leading-4 text-foreground">
                                {file.patch.split('\n').slice(0, 400).map((line, index) => (
                                  <span
                                    key={index}
                                    className={line.startsWith('+') && !line.startsWith('+++')
                                      ? 'block text-emerald-700 dark:text-emerald-300'
                                      : line.startsWith('-') && !line.startsWith('---')
                                        ? 'block text-red-600 dark:text-red-300'
                                        : 'block'}
                                  >
                                    {line || ' '}
                                  </span>
                                ))}
                              </pre>
                            </details>
                          ) : (
                            <span className="block truncate">{file.status} {file.path}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {(diffById[job.relay_id]?.files.length ?? 0) > 0 ? <div className="mt-1 text-[9px]">Showing all {(diffById[job.relay_id]?.files.length ?? 0)} changed file{(diffById[job.relay_id]?.files.length ?? 0) === 1 ? '' : 's'}.</div> : <div className="mt-1">No changed files recorded.</div>}
                  </div>
                ) : null}
                <div className="mt-1.5 flex gap-1 pl-6">
                    <input
                      aria-label={`Follow-up for ${job.label || job.relay_id}`}
                      value={followUpById[job.relay_id] ?? ''}
                      onChange={(event) => setFollowUpById((current) => ({ ...current, [job.relay_id]: event.target.value }))}
                      placeholder={ACTIVE.has(job.status) ? 'Send guidance while it runs…' : 'Follow up with this worker…'}
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
              </div>
                ))}
              </section>
            );})}
          </div>
        </div>
      ) : null}
    </div>
  );
}
