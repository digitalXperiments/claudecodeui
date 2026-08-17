import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Code2,
  Eye,
  FileDown,
  Loader2,
  Network,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCog,
  XCircle,
} from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { Button } from '../../../shared/view/ui';
import type { Project, ProviderModelOption } from '../../../types/app';
import { agentProfilesApi } from '../../settings/api/agentProfilesApi';
import ImageAttachment from '../../chat/view/subcomponents/ImageAttachment';
import FileAttachmentChip from '../../chat/view/subcomponents/FileAttachmentChip';
import LiveSpendMeter from '../../chat/view/subcomponents/LiveSpendMeter';
import {
  clampEffort,
  clampPermissionMode,
  defaultRoster,
  effortOptionsForProvider,
  permissionModesForProvider,
  SWARM_KINDS,
  SWARM_PERMISSION_LABELS,
  SWARM_PROVIDERS,
  type SwarmAgentSpec,
  type SwarmAttachment,
  type SwarmGoalCard,
  type SwarmRun,
  type SwarmValidationSummary,
  type SwarmWorkspaceStatus,
} from '../types';

/** Max goal-context files per swarm (mirrors server cap). */
const MAX_SWARM_ATTACHMENTS = 10;
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

const IMAGE_ATTACHMENT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const DOCUMENT_ATTACHMENT_EXTENSIONS = [
  '.pdf', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml',
  '.html', '.htm', '.rtf', '.log', '.yaml', '.yml',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
];

function formatDurationMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

function getFileExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  return lastDot >= 0 ? name.slice(lastDot).toLowerCase() : '';
}

function isImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  return IMAGE_ATTACHMENT_EXTENSIONS.includes(getFileExtension(file.name || ''));
}

function isAllowedAttachment(file: File): boolean {
  if (isImageFile(file)) return true;
  if (file.type && !file.type.startsWith('image/')) {
    // Document mime types are validated server-side; accept known extensions client-side.
  }
  return DOCUMENT_ATTACHMENT_EXTENSIONS.includes(getFileExtension(file.name || ''));
}

function apiErrorMessage(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = apiErrorMessage(item);
      if (nested) return nested;
    }
    return null;
  }

  const value = payload as Record<string, unknown>;
  for (const key of ['message', 'detail', 'reason', 'title']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const key of ['error', 'errors', 'details', 'data', 'cause']) {
    const nested = apiErrorMessage(value[key]);
    if (nested) return nested;
  }
  return null;
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, options);
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload) || `Request failed (${response.status})`);
  }
  return (payload ?? {}) as T;
}

const POLLED_SWARM_STATUSES = new Set([
  'queued',
  'planning',
  'awaiting_plan_approval',
  'running',
  'handing_off',
  'awaiting_approval',
]);

const ABORTABLE_SWARM_STATUSES = new Set([
  'queued',
  'planning',
  'awaiting_plan_approval',
  'running',
  'handing_off',
  'awaiting_approval',
]);

const ARCHIVE_BLOCKING_SWARM_STATUSES = new Set([
  'queued',
  'planning',
  'awaiting_plan_approval',
  'running',
  'handing_off',
  'awaiting_approval',
]);

const isPolledStatus = (status: string) => POLLED_SWARM_STATUSES.has(status);
const isAbortableStatus = (status: string) => ABORTABLE_SWARM_STATUSES.has(status);

function allowsSwarmAction(swarm: SwarmRun, action: string): boolean {
  if (
    action === 'abort' &&
    Boolean(swarm.cancelRequestedAt ?? swarm.cancel_requested_at)
  ) {
    return false;
  }
  const advertised = swarm.allowedActions ?? swarm.allowed_actions;
  if (advertised) {
    const camelAction = action.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return advertised.includes(action) || advertised.includes(camelAction);
  }
  switch (action) {
    case 'approve-plan':
    case 'reject-plan':
      return swarm.status === 'awaiting_plan_approval';
    case 'approve':
    case 'reject':
      return swarm.status === 'awaiting_approval';
    case 'abort':
      return isAbortableStatus(swarm.status);
    case 'archive':
    case 'delete':
      return !ARCHIVE_BLOCKING_SWARM_STATUSES.has(swarm.status);
    case 'retry-step':
      return ['failed', 'awaiting_approval'].includes(swarm.status);
    case 'resume':
      return swarm.status === 'failed' && !swarm.archived_at;
    default:
      return false;
  }
}

function statusBadgeClass(status: string): string {
  if (status === 'succeeded') {
    return 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300';
  }
  if (status === 'failed' || status === 'aborted') {
    return 'bg-red-500/15 text-red-700 ring-red-500/25 dark:text-red-300';
  }
  // A reviewer/agent that ran fine and reported unmet acceptance criteria is
  // not a crash — give it the same amber "needs attention" tone as approval
  // gates instead of the red "something broke" tone.
  if (
    status === 'needs_changes'
    || status === 'awaiting_approval'
    || status === 'awaiting_plan_approval'
  ) {
    return 'bg-amber-500/15 text-amber-800 ring-amber-500/25 dark:text-amber-300';
  }
  if (['planning', 'running', 'handing_off', 'queued', 'supervising'].includes(status)) {
    return 'bg-sky-500/15 text-sky-700 ring-sky-500/25 dark:text-sky-300';
  }
  return 'bg-muted text-muted-foreground ring-border';
}

/** Human-readable label for a step/member/attempt status badge. */
function statusLabel(status: string): string {
  if (status === 'needs_changes') return 'Changes requested';
  if (status === 'supervising') return 'Supervising';
  return status;
}

/** Chip tone for a pre-PR validation check / overall verdict. */
function validationChipClass(status: string): string {
  switch (status) {
    case 'passed':
      return 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300';
    case 'failed':
      return 'bg-red-500/15 text-red-700 ring-red-500/25 dark:text-red-300';
    case 'degraded':
      return 'bg-amber-500/15 text-amber-800 ring-amber-500/25 dark:text-amber-300';
    case 'skipped':
    default:
      return 'bg-muted text-muted-foreground ring-border';
  }
}

/** Overall verdict for the validation summary (degraded passes stay visible). */
function validationOverallStatus(validation: SwarmValidationSummary): string {
  if (!validation.passed) return 'failed';
  return validation.degraded ? 'degraded' : 'passed';
}

function GoalCardPanel({ card, running }: { card: SwarmGoalCard; running: boolean }) {
  const supervising = card.mode === 'supervisor' && running;
  const lastDecision = card.decisions.at(-1);
  const blockers = card.lastReview?.blockers ?? [];
  return (
    <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
          {supervising ? 'Orchestrator supervising' : 'Goal card'}
        </div>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${statusBadgeClass(supervising ? 'supervising' : card.status)}`}>
          {supervising ? 'Supervising' : card.status}
        </span>
        <span className="text-[10px] text-muted-foreground">
          tick {card.ticksUsed}/{card.tickBudget}
          {card.fingerprint?.head ? ` · ${card.fingerprint.head.slice(0, 8)}` : ''}
          {card.fingerprint?.dirty ? ' · dirty' : ''}
        </span>
      </div>
      {lastDecision ? (
        <p className="text-[11px] text-foreground">
          {lastDecision.action === 'dispatch' && lastDecision.kind
            ? `Next: ${lastDecision.kind}${lastDecision.title ? ` — ${lastDecision.title}` : ''}. `
            : lastDecision.action === 'done'
              ? 'Goal accepted. '
              : lastDecision.action === 'blocked'
                ? 'Blocked. '
                : ''}
          {lastDecision.reason}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          The orchestrator will stay on shift after the first review or failed step.
        </p>
      )}
      {card.lastReview ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          Last review: {card.lastReview.verdict}
          {card.lastReview.seatLabel ? ` by ${card.lastReview.seatLabel}` : ''}
          {blockers.length ? ` · ${blockers.length} blocker${blockers.length === 1 ? '' : 's'}` : ''}
          {card.repeatBlockerCount > 1 ? ` · same blockers ×${card.repeatBlockerCount}` : ''}
        </p>
      ) : null}
      {blockers.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 text-[10px] text-muted-foreground">
          {blockers.slice(0, 5).map((packet, index) => (
            <li key={`${packet.ask}-${index}`}>
              <span className="font-medium text-foreground">[{packet.severity}]</span>
              {packet.file ? ` ${packet.file} —` : ''} {packet.ask}
            </li>
          ))}
        </ul>
      ) : null}
      {card.decisions.length > 0 ? (
        <ol className="mt-2 space-y-1 border-t border-sky-500/15 pt-1.5 text-[10px] text-muted-foreground">
          {card.decisions.slice(-6).map((decision) => (
            <li key={`${decision.tick}-${decision.at}`}>
              <span className="font-medium text-foreground">Tick {decision.tick}</span>
              {' · '}
              {decision.action}
              {decision.kind ? ` ${decision.kind}` : ''}
              {decision.coerced ? ' (policy)' : ''}
              {' — '}
              {decision.reason}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** True when a failed swarm died at the pre-PR validation gate. */
function isValidationFailure(swarm: SwarmRun): boolean {
  if (swarm.synthesis?.validation && !swarm.synthesis.validation.passed) return true;
  const lastError = swarm.last_error ?? '';
  return /pre-?pr validation|validation gate|validation failed/i.test(lastError);
}

type BlackboardBadge = {
  tone: 'success' | 'danger' | 'neutral';
  label: string;
  rest: string;
};

const BLACKBOARD_BADGE_TONE: Record<BlackboardBadge['tone'], string> = {
  success: 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
  danger: 'bg-red-500/15 text-red-700 ring-red-500/25 dark:text-red-300',
  neutral: 'bg-muted text-muted-foreground ring-border',
};

/**
 * Structured badge for audit-style blackboard system lines:
 *   "[permission] APPROVED|DENIED (policy|orchestrator) …" and "[policy] …".
 * Returns null for ordinary messages (rendered as before).
 */
function blackboardBadge(content: string): BlackboardBadge | null {
  const permission = content.match(
    /^\[permission\]\s*(APPROVED|DENIED)\s*(?:\((policy|orchestrator)\))?\s*/i,
  );
  if (permission) {
    const verdict = permission[1].toUpperCase();
    const source = permission[2]?.toLowerCase();
    return {
      tone: verdict === 'APPROVED' ? 'success' : 'danger',
      label: source ? `${verdict.toLowerCase()} · ${source}` : verdict.toLowerCase(),
      rest: content.slice(permission[0].length),
    };
  }
  const policy = content.match(/^\[policy\]\s*/i);
  if (policy) {
    return { tone: 'neutral', label: 'policy', rest: content.slice(policy[0].length) };
  }
  const supervisor = content.match(/^\[supervisor\]\s*/i);
  if (supervisor) {
    return { tone: 'neutral', label: 'supervisor', rest: content.slice(supervisor[0].length) };
  }
  return null;
}

/** Capability tier badges — the orchestrator staffs steps by these. */
const LEVEL_LABEL: Record<string, string> = {
  basic: 'L1 basic',
  medium: 'L2 medium',
  advanced: 'L3 advanced',
};

const LEVEL_CHIP: Record<string, string> = {
  basic: 'rounded-full border border-border bg-muted/60 px-1.5 text-[9px] font-medium text-muted-foreground',
  medium:
    'rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 text-[9px] font-medium text-sky-700 dark:text-sky-300',
  advanced:
    'rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 text-[9px] font-medium text-violet-700 dark:text-violet-300',
};

function kindIcon(kind: string) {
  switch (kind) {
    case 'orchestrator':
      return <Network className="h-3.5 w-3.5" />;
    case 'explorer':
      return <Compass className="h-3.5 w-3.5" />;
    case 'implementer':
      return <Code2 className="h-3.5 w-3.5" />;
    case 'reviewer':
      return <Eye className="h-3.5 w-3.5" />;
    default:
      return <UserCog className="h-3.5 w-3.5" />;
  }
}

function emptyAgent(kind: string = 'implementer'): SwarmAgentSpec {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  const provider = kind === 'explorer' ? 'grok' : 'claude';
  return {
    id: `${kind}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    label,
    provider,
    model: null,
    effort: kind === 'explorer' ? 'low' : kind === 'implementer' ? 'high' : 'medium',
    permissionMode: clampPermissionMode(
      provider,
      kind === 'implementer' ? 'acceptEdits' : 'default',
    ),
    skills: [],
    focus: '',
  };
}

/** Worker kinds only — orchestrator is fixed at one seat. */
const WORKER_KINDS = SWARM_KINDS.filter((k) => k.value !== 'orchestrator');

type ModelOption = ProviderModelOption;
type SkillOption = { directoryName: string; name: string; description: string };

type AgentSwarmViewProps = {
  selectedProject: Project | null;
  projects: Project[];
  isVisible: boolean;
};

export default function AgentSwarmView({
  selectedProject,
  projects,
  isVisible,
}: AgentSwarmViewProps) {
  const { subscribe } = useWebSocket();
  const [swarms, setSwarms] = useState<SwarmRun[]>([]);
  const [starting, setStarting] = useState(false);
  const [busyBySwarm, setBusyBySwarm] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Persisted workspace status is preferred; this is a graceful fallback for
  // older servers that do not expose it on either workspace or swarm DTOs.
  const [cleanedWorkspaces, setCleanedWorkspaces] = useState<string[]>([]);
  const [workspaceStateById, setWorkspaceStateById] = useState<
    Record<string, { status?: SwarmWorkspaceStatus; cleanedAt?: string | null }>
  >({});
  const [tab, setTab] = useState<'create' | 'history'>('history');
  const [historyFilter, setHistoryFilter] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');

  // Create form
  const [projectId, setProjectId] = useState(selectedProject?.projectId ?? '');
  const [goal, setGoal] = useState('');
  /** Local files staged for upload with the goal (PRDs, screenshots, …). */
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [roster, setRoster] = useState<SwarmAgentSpec[]>(() => defaultRoster());
  /**
   * 'auto' (default): goal + orchestrator only — the orchestrator staffs the
   * rest of the roster from swarm-tagged Agent Profiles (autoRoster: true).
   * 'advanced': today's full manual roster builder (autoRoster omitted).
   */
  const [rosterMode, setRosterMode] = useState<'auto' | 'advanced'>('auto');
  /** Pre-PR stability gate (static checks + smoke + PDF report). Default ON. */
  const [validateBeforePr, setValidateBeforePr] = useState(true);
  /** null until the profiles API answers; then whether any profile is swarm-tagged. */
  const [hasSwarmProfiles, setHasSwarmProfiles] = useState<boolean | null>(null);
  /** Auto mode is fully hands-off, so it defaults to no plan-approval gate. */
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);
  /**
   * Hard wall-clock ceiling per agent run. Generous on purpose: a stuck agent is
   * caught by the stall budget instead, so this only bounds runaway work.
   */
  const [stepTimeoutMs, setStepTimeoutMs] = useState(2_700_000);
  /** Silence budget — an agent that emits nothing for this long is reassigned. */
  const [stallTimeoutMs, setStallTimeoutMs] = useState(300_000);
  /** Attempts per task before the orchestrator replans it. */
  const [stepMaxAttempts, setStepMaxAttempts] = useState(3);
  /** Remediation rounds the orchestrator gets to turn a red gate green. */
  const [validationMaxAttempts, setValidationMaxAttempts] = useState(4);
  const [maxConcurrency, setMaxConcurrency] = useState(3);
  const [parallelWriters, setParallelWriters] = useState(false);
  /**
   * Long-horizon unattended mode: only a crashed/silent provider ends a step
   * — a reviewer/tester finding real issues just triggers another attempt.
   * Raises step-attempt and orchestrator-replan ceilings by an order of
   * magnitude (still finite, so a genuinely circular disagreement stops
   * eventually instead of running unattended forever).
   */
  const [autonomous, setAutonomous] = useState(false);
  /** provider → model options cache */
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelOption[]>>({});
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});
  /** provider → permission modes from capabilities API */
  const [permModesByProvider, setPermModesByProvider] = useState<Record<string, string[]> | null>(
    null,
  );
  const refreshSequence = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const modelControllers = useRef(new Map<string, AbortController>());
  const modelCache = useRef<Record<string, ModelOption[]>>({});
  const busySwarmIds = useRef(new Set<string>());
  const startingRef = useRef(false);
  const startAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const setSwarmBusy = useCallback((swarmId: string, action: string | null) => {
    if (action) busySwarmIds.current.add(swarmId);
    else busySwarmIds.current.delete(swarmId);
    setBusyBySwarm((previous) => {
      if (action) return { ...previous, [swarmId]: action };
      if (!(swarmId in previous)) return previous;
      const next = { ...previous };
      delete next[swarmId];
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectedProject?.projectId && !projectId) {
      setProjectId(selectedProject.projectId);
    }
  }, [selectedProject?.projectId, projectId]);

  // Load provider capability matrix once (permissions source of truth).
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    void authenticatedFetch('/api/providers/capabilities')
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as {
          data?: {
            providers?: Array<{ provider?: string; permissionModes?: string[] }>;
          };
        };
        const list = body?.data?.providers ?? [];
        const map: Record<string, string[]> = {};
        for (const p of list) {
          if (p.provider && Array.isArray(p.permissionModes) && p.permissionModes.length) {
            map[p.provider] = p.permissionModes;
          }
        }
        if (!cancelled && Object.keys(map).length) {
          setPermModesByProvider(map);
        }
      })
      .catch(() => {
        /* keep fallback matrix */
      });
    return () => {
      cancelled = true;
    };
  }, [isVisible]);

  // Probe Agent Profiles for swarm-role tags so the auto-roster form can hint
  // when the orchestrator would fall back to built-in defaults.
  useEffect(() => {
    if (!isVisible || tab !== 'create') return;
    let cancelled = false;
    agentProfilesApi
      .list()
      .then((profiles) => {
        if (cancelled) return;
        setHasSwarmProfiles(
          profiles.some(
            (p) => p.enabled !== false && Array.isArray(p.swarm_roles) && p.swarm_roles.length > 0,
          ),
        );
      })
      .catch(() => {
        // Availability unknown — suppress the hint rather than mislead.
        if (!cancelled) setHasSwarmProfiles(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isVisible, tab]);

  // Clamp roster permission modes when capabilities load.
  useEffect(() => {
    if (!permModesByProvider) return;
    setRoster((prev) =>
      prev.map((seat) => {
        const provider = seat.provider || 'claude';
        const next = clampPermissionMode(provider, seat.permissionMode, permModesByProvider);
        if (next === seat.permissionMode) return seat;
        return { ...seat, permissionMode: next };
      }),
    );
  }, [permModesByProvider]);

  const hasLive = useMemo(
    () => swarms.some((s) => isPolledStatus(s.status)),
    [swarms],
  );

  const refresh = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const sequence = ++refreshSequence.current;
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    if (!silent) {
      setRefreshing(true);
      setError(null);
    }
    try {
      const qs = new URLSearchParams({ limit: '50' });
      if (historyFilter === 'archived') qs.set('archivedOnly', 'true');
      const payload = await requestJson<{ swarms?: SwarmRun[] }>(`/api/swarm?${qs.toString()}`, {
        signal: controller.signal,
      });
      if (sequence !== refreshSequence.current) return;
      setSwarms(Array.isArray(payload.swarms) ? payload.swarms : []);
    } catch (caught) {
      if (controller.signal.aborted || sequence !== refreshSequence.current) return;
      if (!silent) {
        setError(caught instanceof Error ? caught.message : 'Could not load swarms.');
      }
    } finally {
      if (sequence === refreshSequence.current) {
        refreshController.current = null;
        setRefreshing(false);
      }
    }
  }, [historyFilter]);

  useEffect(() => {
    if (!isVisible) return;
    void refresh();
    return () => {
      refreshSequence.current += 1;
      refreshController.current?.abort();
      refreshController.current = null;
      setRefreshing(false);
    };
  }, [isVisible, refresh]);

  // Swarm writes fan out over the existing authenticated websocket. Polling is
  // retained only as a slow recovery fallback for missed frames/reconnects.
  useEffect(() => {
    if (!isVisible) return;
    return subscribe((event) => {
      if (event.kind !== 'swarm_updated') return;
      if (!refreshController.current) void refresh({ silent: true });
    });
  }, [isVisible, refresh, subscribe]);

  useEffect(() => {
    if (!isVisible || !hasLive || historyFilter === 'archived') return;
    const id = window.setInterval(() => {
      if (!refreshController.current) void refresh({ silent: true });
    }, 10_000);
    return () => window.clearInterval(id);
  }, [isVisible, hasLive, refresh, historyFilter]);

  // Load project skills for multi-select when project changes.
  useEffect(() => {
    if (!projectId) {
      setSkillOptions([]);
      setSelectedSkills([]);
      return;
    }
    const project = projects.find((p) => p.projectId === projectId);
    const workspacePath = project?.path;
    if (!workspacePath) {
      setSkillOptions([]);
      return;
    }
    let cancelled = false;
    setSkillsLoading(true);
    const params = new URLSearchParams({ workspacePath });
    void authenticatedFetch(`/api/project-skills?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('failed');
        const data = (await res.json()) as {
          data?: { skills?: Array<{ directoryName?: string; name?: string; description?: string }> };
          skills?: Array<{ directoryName?: string; name?: string; description?: string }>;
        };
        const skills = data?.data?.skills ?? data?.skills ?? [];
        const list = (Array.isArray(skills) ? skills : [])
          .map((s) => ({
            directoryName: String(s.directoryName ?? ''),
            name: String(s.name ?? s.directoryName ?? ''),
            description: String(s.description ?? ''),
          }))
          .filter((s) => s.directoryName);
        if (cancelled) return;
        setSkillOptions(list);
        setSelectedSkills(list.map((s) => s.directoryName));
      })
      .catch(() => {
        if (!cancelled) {
          setSkillOptions([]);
          setSelectedSkills([]);
        }
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, projects]);

  // Load models for every unique provider in the roster.
  useEffect(() => {
    if (!isVisible) return;
    const providers = [
      ...new Set(roster.map((s) => (s.provider || 'claude').trim()).filter(Boolean)),
    ];
    const controllers = modelControllers.current;
    const startedHere: Array<[string, AbortController]> = [];

    for (const provider of providers) {
      if (provider in modelCache.current || controllers.has(provider)) continue;
      const controller = new AbortController();
      controllers.set(provider, controller);
      startedHere.push([provider, controller]);
      setModelsLoading((prev) => ({ ...prev, [provider]: true }));
      void requestJson<{
        data?: {
          models?: {
            OPTIONS?: ProviderModelOption[];
            DEFAULT?: string;
          };
        };
      }>(`/api/providers/${encodeURIComponent(provider)}/models`, {
        signal: controller.signal,
      })
        .then((body) => {
          if (controller.signal.aborted) return;
          const options: ModelOption[] = Array.isArray(body.data?.models?.OPTIONS)
            ? body.data.models.OPTIONS.map((model) => ({
                value: model.value,
                label: model.label || model.value,
                effort: model.effort?.values?.length ? model.effort : undefined,
              }))
            : [];
          modelCache.current[provider] = options;
          setModelsByProvider((prev) => ({ ...prev, [provider]: options }));
          const configuredDefault = body.data?.models?.DEFAULT;
          const defaultModel =
            configuredDefault && options.some((option) => option.value === configuredDefault)
              ? configuredDefault
              : options[0]?.value ?? null;
          setRoster((prev) =>
            prev.map((seat) => {
              if ((seat.provider || 'claude') !== provider) return seat;
              const model =
                seat.model && options.some((option) => option.value === seat.model)
                  ? seat.model
                  : defaultModel ?? seat.model;
              // Model-specific effort metadata just arrived — re-clamp so a
              // value that looked valid while options were still loading
              // (or was valid for the old model) doesn't silently persist.
              const effort = clampEffort(provider, model, seat.effort, options);
              if (model === seat.model && effort === (seat.effort || 'default')) return seat;
              return { ...seat, model, effort };
            }),
          );
        })
        .catch((caught) => {
          if (controller.signal.aborted || (caught instanceof DOMException && caught.name === 'AbortError')) {
            return;
          }
          modelCache.current[provider] = [];
          setModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
        })
        .finally(() => {
          if (controllers.get(provider) !== controller) return;
          controllers.delete(provider);
          setModelsLoading((prev) => ({ ...prev, [provider]: false }));
        });
    }

    return () => {
      for (const [provider, controller] of startedHere) {
        controller.abort();
        if (controllers.get(provider) === controller) {
          controllers.delete(provider);
          setModelsLoading((prev) => ({ ...prev, [provider]: false }));
        }
      }
    };
    // The provider signature intentionally controls request lifetime. Model
    // responses update the cache without cancelling other provider requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, roster.map((s) => s.provider || 'claude').join('|')]);

  const projectName = useCallback(
    (id: string) => {
      const p = projects.find((proj) => proj.projectId === id);
      return p?.displayName || id.slice(0, 12);
    },
    [projects],
  );

  const filteredSwarms = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return swarms;
    return swarms.filter(
      (s) =>
        s.goal.toLowerCase().includes(q) ||
        s.status.toLowerCase().includes(q) ||
        projectName(s.project_id).toLowerCase().includes(q) ||
        (s.parent_run_id ?? '').toLowerCase().includes(q),
    );
  }, [swarms, search, projectName]);

  // Resolve persisted workspace lifecycle for the expanded swarm. Newer swarm
  // DTOs can provide it inline; older servers fall back to the workspace API.
  useEffect(() => {
    if (!isVisible || !expanded) return;
    const swarm = swarms.find((candidate) => candidate.swarm_id === expanded);
    const workspaceId = swarm?.workspace_id || swarm?.synthesis?.workspaceId || null;
    if (!swarm || !workspaceId) return;
    const inlineStatus = swarm.workspaceStatus ?? swarm.workspace_status;
    const inlineCleanedAt = swarm.workspaceCleanedAt ?? swarm.workspace_cleaned_at;
    if (inlineStatus || inlineCleanedAt) {
      setWorkspaceStateById((previous) => ({
        ...previous,
        [workspaceId]: {
          status: inlineStatus ?? previous[workspaceId]?.status,
          cleanedAt: inlineCleanedAt ?? previous[workspaceId]?.cleanedAt,
        },
      }));
      return;
    }

    const controller = new AbortController();
    void requestJson<{
      workspace?: { status?: SwarmWorkspaceStatus; cleaned_at?: string | null };
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted || !payload.workspace) return;
        setWorkspaceStateById((previous) => ({
          ...previous,
          [workspaceId]: {
            status: payload.workspace?.status,
            cleanedAt: payload.workspace?.cleaned_at ?? null,
          },
        }));
      })
      .catch(() => {
        // Workspace status is an enhancement; keep the older session fallback
        // when talking to a server that does not expose this endpoint/DTO.
      });
    return () => controller.abort();
  }, [expanded, isVisible, swarms]);

  const updateSeat = (index: number, patch: Partial<SwarmAgentSpec>) => {
    setRoster((prev) => {
      const current = prev[index];
      if (!current) return prev;

      if (current.kind === 'orchestrator' && patch.kind && patch.kind !== 'orchestrator') {
        return prev;
      }
      if (patch.kind === 'orchestrator' && current.kind !== 'orchestrator') {
        return prev;
      }

      let next = prev.map((a, i) => (i === index ? { ...a, ...patch } : a));

      // Clear model + clamp permissions/effort when provider changes.
      if (patch.provider && patch.provider !== current.provider) {
        next = next.map((a, i) => {
          if (i !== index) return a;
          return {
            ...a,
            model: null,
            permissionMode: clampPermissionMode(
              patch.provider!,
              a.permissionMode,
              permModesByProvider,
            ),
            effort: clampEffort(patch.provider!, null, a.effort, modelsByProvider[patch.provider!] ?? []),
          };
        });
      } else if (patch.model !== undefined && patch.model !== current.model) {
        // Model-specific effort options may be narrower than the provider default.
        next = next.map((a, i) => {
          if (i !== index) return a;
          return {
            ...a,
            effort: clampEffort(
              a.provider || 'claude',
              patch.model,
              a.effort,
              modelsByProvider[a.provider || 'claude'] ?? [],
            ),
          };
        });
      }

      if (patch.kind && patch.kind !== current.kind) {
        const oldDefault = current.kind.charAt(0).toUpperCase() + current.kind.slice(1);
        next = next.map((a, i) => {
          if (i !== index) return a;
          if (a.label === oldDefault || !a.label) {
            return {
              ...a,
              label: patch.kind!.charAt(0).toUpperCase() + patch.kind!.slice(1),
            };
          }
          return a;
        });
      }

      return next;
    });
  };

  const removeSeat = (index: number) => {
    setRoster((prev) => {
      const seat = prev[index];
      if (seat?.kind === 'orchestrator') return prev;
      const next = prev.filter((_, i) => i !== index);
      if (!next.some((a) => a.kind === 'orchestrator')) {
        return [emptyAgent('orchestrator'), ...next];
      }
      return next.length ? next : defaultRoster();
    });
  };

  const addWorker = (kind: string = 'implementer') => {
    setRoster((r) => {
      const base = emptyAgent(kind === 'orchestrator' ? 'implementer' : kind);
      const sameKind = r.filter((a) => a.kind === base.kind).length;
      if (sameKind > 0) {
        base.label = `${base.label} ${sameKind + 1}`;
        base.id = `${base.kind}-${sameKind + 1}-${Math.random().toString(36).slice(2, 5)}`;
      }
      return [...r, base];
    });
  };

  const toggleSkill = (directoryName: string) => {
    setSelectedSkills((prev) =>
      prev.includes(directoryName)
        ? prev.filter((s) => s !== directoryName)
        : [...prev, directoryName],
    );
  };

  const addAttachments = (fileList: FileList | File[] | null) => {
    if (!fileList) return;
    const incoming = Array.from(fileList);
    const rejected: string[] = [];
    const accepted: File[] = [];
    for (const file of incoming) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        rejected.push(`${file.name} (over 25MB)`);
        continue;
      }
      if (!isAllowedAttachment(file) && !(file.type && file.type.startsWith('image/'))) {
        rejected.push(`${file.name} (unsupported type)`);
        continue;
      }
      accepted.push(file);
    }
    if (rejected.length) {
      setError(`Skipped attachments: ${rejected.join('; ')}`);
    }
    if (accepted.length) {
      setAttachedFiles((prev) => [...prev, ...accepted].slice(0, MAX_SWARM_ATTACHMENTS));
    }
  };

  const removeAttachment = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const uploadAttachments = async (files: File[]): Promise<SwarmAttachment[]> => {
    if (files.length === 0) return [];
    const formData = new FormData();
    files.forEach((file) => formData.append('images', file));
    const response = await authenticatedFetch('/api/assets/images', {
      method: 'POST',
      headers: {},
      body: formData,
    });
    if (!response.ok) {
      let serverMessage = '';
      try {
        const errorBody = await response.json();
        if (errorBody && typeof errorBody.error === 'string') {
          serverMessage = errorBody.error;
        }
      } catch {
        /* non-JSON */
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error('Your session has expired — please log in again.');
      }
      throw new Error(serverMessage || `Attachment upload failed (HTTP ${response.status})`);
    }
    const result = (await response.json()) as { images?: SwarmAttachment[] };
    return Array.isArray(result.images) ? result.images : [];
  };

  const start = async () => {
    if (startingRef.current) return;
    if (!projectId.trim()) {
      setError('Select a project for this swarm.');
      return;
    }
    if (!goal.trim()) {
      setError('Enter a goal for the swarm.');
      return;
    }
    const orchCount = roster.filter((a) => a.kind === 'orchestrator').length;
    if (orchCount !== 1) {
      setError('Exactly one orchestrator is required.');
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const autoRoster = rosterMode === 'auto';
      const ordered = [
        ...roster.filter((a) => a.kind === 'orchestrator'),
        // Auto-roster sends the orchestrator seat only; the orchestrator
        // staffs workers from swarm-tagged Agent Profiles server-side.
        ...(autoRoster ? [] : roster.filter((a) => a.kind !== 'orchestrator')),
      ].map((seat) => ({
        ...seat,
        permissionMode: clampPermissionMode(
          seat.provider || 'claude',
          seat.permissionMode,
          permModesByProvider,
        ),
        effort: clampEffort(
          seat.provider || 'claude',
          seat.model,
          seat.effort,
          modelsByProvider[seat.provider || 'claude'] ?? [],
        ),
      }));

      // Upload staged files first so the swarm start payload only carries
      // server-validated asset paths (same store as chat attachments).
      let uploadedAttachments: SwarmAttachment[] = [];
      if (attachedFiles.length > 0) {
        uploadedAttachments = await uploadAttachments(attachedFiles);
      }

      const fingerprint = JSON.stringify({
        projectId,
        goal: goal.trim(),
        agents: ordered,
        skills: selectedSkills,
        attachments: uploadedAttachments.map((a) => a.path),
        requirePlanApproval,
        autoRoster,
        validateBeforePr,
        stepTimeoutMs,
        stallTimeoutMs,
        stepMaxAttempts,
        validationMaxAttempts,
        maxConcurrency,
        parallelWriters,
        autonomous,
      });
      if (!startAttempt.current || startAttempt.current.fingerprint !== fingerprint) {
        startAttempt.current = {
          fingerprint,
          key:
            globalThis.crypto?.randomUUID?.() ??
            `swarm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
      }
      const payload = await requestJson<{ swarm?: SwarmRun }>('/api/swarm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': startAttempt.current.key,
        },
        body: JSON.stringify({
          projectId,
          goal: goal.trim(),
          agents: ordered,
          skills: selectedSkills,
          attachments: uploadedAttachments,
          requireApproval: false,
          requirePlanApproval,
          // Only the simplified path opts in; advanced keeps today's manual
          // roster semantics (autoRoster omitted).
          ...(autoRoster ? { autoRoster: true } : {}),
          validateBeforePr,
          stepTimeoutMs: stepTimeoutMs > 0 ? stepTimeoutMs : undefined,
          stallTimeoutMs: stallTimeoutMs > 0 ? stallTimeoutMs : undefined,
          stepMaxAttempts: stepMaxAttempts > 0 ? stepMaxAttempts : undefined,
          validationMaxAttempts: validationMaxAttempts > 0 ? validationMaxAttempts : undefined,
          maxConcurrency: maxConcurrency > 0 ? maxConcurrency : undefined,
          parallelWriters,
          autonomous,
        }),
      });
      if (payload.swarm) {
        startAttempt.current = null;
        setExpanded(payload.swarm.swarm_id);
        setHistoryFilter('active');
        setTab('history');
        setGoal('');
        setAttachedFiles([]);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start swarm.');
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const act = async (
    swarmId: string,
    action: 'approve' | 'reject' | 'approve-plan' | 'reject-plan' | 'abort' | 'resume',
  ) => {
    const confirmation =
      action === 'abort'
        ? 'Abort this swarm? Running provider processes will be stopped and unfinished work may be lost.'
        : action === 'resume'
          ? 'Resume this swarm from its last durable failure checkpoint? Completed work and the existing workspace will be preserved.'
        : action === 'reject-plan'
          ? 'Reject this plan and end the swarm? Worker agents will not run.'
          : action === 'reject'
            ? 'Reject this handoff and mark the swarm as failed?'
            : null;
    if (confirmation && !window.confirm(confirmation)) return;
    if (busySwarmIds.current.has(swarmId)) return;
    setSwarmBusy(swarmId, action);
    setError(null);
    try {
      await requestJson(`/api/swarm/${encodeURIComponent(swarmId)}/${action}`, {
        method: 'POST',
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${action} swarm.`);
    } finally {
      setSwarmBusy(swarmId, null);
    }
  };

  const retryStep = async (swarmId: string, stepId: string) => {
    if (busySwarmIds.current.has(swarmId)) return;
    setSwarmBusy(swarmId, 'retry-step');
    setError(null);
    try {
      await requestJson(`/api/swarm/${encodeURIComponent(swarmId)}/retry-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId }),
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not retry step.');
    } finally {
      setSwarmBusy(swarmId, null);
    }
  };

  /**
   * Open the pre-PR validation report (PDF preferred, HTML fallback) in a new
   * tab. Fetched with auth headers and served as a blob URL — a bare anchor
   * would drop the Authorization header.
   */
  const downloadReport = async (swarmId: string) => {
    if (busySwarmIds.current.has(swarmId)) return;
    setSwarmBusy(swarmId, 'download-report');
    setError(null);
    let blobUrl: string | null = null;
    try {
      const response = await authenticatedFetch(
        `/api/swarm/${encodeURIComponent(swarmId)}/report`,
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          apiErrorMessage(payload) || `Validation report unavailable (${response.status})`,
        );
      }
      const blob = await response.blob();
      blobUrl = URL.createObjectURL(blob);
      const opened = window.open(blobUrl, '_blank', 'noopener');
      if (!opened) {
        // Pop-up blocked — fall back to a direct download.
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = `swarm-validation-${swarmId}.${
          blob.type.includes('pdf') ? 'pdf' : 'html'
        }`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not open the validation report.',
      );
    } finally {
      if (blobUrl) {
        const url = blobUrl;
        // Give the new tab time to load the blob before revoking it.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setSwarmBusy(swarmId, null);
    }
  };

  const archiveSwarm = async (swarmId: string, restore = false) => {
    if (busySwarmIds.current.has(swarmId)) return;
    setSwarmBusy(swarmId, restore ? 'restore' : 'archive');
    setError(null);
    try {
      await requestJson(`/api/swarm/${encodeURIComponent(swarmId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restore }),
      });
      if (expanded === swarmId) setExpanded(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update archive state.');
    } finally {
      setSwarmBusy(swarmId, null);
    }
  };

  /**
   * Remove the swarm's worktree once its PR has been dealt with on GitHub.
   *
   * The local branch is only deleted when the branch actually reached the
   * remote (i.e. a PR exists). If the push failed, the branch is the only copy
   * of the agent's work, so it is kept even though the worktree goes.
   */
  const cleanupWorkspace = async (
    swarmId: string,
    workspaceId: string,
    branch: string | null,
    pushed: boolean,
  ) => {
    if (busySwarmIds.current.has(swarmId)) return;
    const ok = window.confirm(
      pushed
        ? `Remove the worktree and local branch for this swarm?\n\n${branch ?? workspaceId}\n\n` +
            `The branch is already on the remote, so the PR is unaffected. ` +
            `Any uncommitted changes left in the worktree are lost.`
        : `Remove the worktree for this swarm?\n\n${branch ?? workspaceId}\n\n` +
            `This branch was never pushed, so the local branch will be KEPT — ` +
            `it is the only copy of the work. Uncommitted changes in the worktree are lost.`,
    );
    if (!ok) return;
    setSwarmBusy(swarmId, 'cleanup-workspace');
    setError(null);
    try {
      const payload = await requestJson<{
        workspace?: { status?: SwarmWorkspaceStatus; cleaned_at?: string | null };
      }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteBranch: pushed }),
      });
      setCleanedWorkspaces((previous) =>
        previous.includes(workspaceId) ? previous : [...previous, workspaceId],
      );
      setWorkspaceStateById((previous) => ({
        ...previous,
        [workspaceId]: {
          status: payload.workspace?.status ?? 'discarded',
          cleanedAt: payload.workspace?.cleaned_at ?? new Date().toISOString(),
        },
      }));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not clean up the workspace.');
    } finally {
      setSwarmBusy(swarmId, null);
    }
  };

  const deleteSwarm = async (swarmId: string, goalLabel: string) => {
    if (busySwarmIds.current.has(swarmId)) return;
    const ok = window.confirm(
      `Permanently delete this swarm?\n\n"${goalLabel.slice(0, 120)}${goalLabel.length > 120 ? '…' : ''}"\n\nThis cannot be undone.`,
    );
    if (!ok) return;
    setSwarmBusy(swarmId, 'delete');
    setError(null);
    try {
      await requestJson(`/api/swarm/${encodeURIComponent(swarmId)}`, {
        method: 'DELETE',
      });
      if (expanded === swarmId) setExpanded(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete swarm.');
    } finally {
      setSwarmBusy(swarmId, null);
    }
  };

  const fieldClass =
    'mt-1 w-full rounded-lg border border-border/80 bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/15';
  const seatFieldClass =
    'mt-0.5 w-full rounded-md border border-border/80 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-primary/40 focus:ring-1 focus:ring-primary/20';

  return (
    <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-background via-background to-muted/20">
      {/* Header */}
      <div className="border-b border-border/50 bg-background/80 px-5 py-4 pr-14 backdrop-blur-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              id="agent-swarm-title"
              className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
                <Network className="h-4 w-4" />
              </span>
              Agent Swarm
            </h2>
            <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
              One orchestrator plans and dispatches explorers, implementers, and reviewers — each with
              its own provider, model, and permissions — then hands off with an automatic PR.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setTab('create')}
              aria-pressed={tab === 'create'}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                tab === 'create'
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              New swarm
            </button>
            <button
              type="button"
              onClick={() => setTab('history')}
              aria-pressed={tab === 'history'}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                tab === 'history'
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              History
              {swarms.length > 0 && historyFilter === 'active' ? (
                <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
                  {swarms.length}
                </span>
              ) : null}
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          aria-live="assertive"
          className="mx-5 mt-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-300"
        >
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            className="text-red-600/70 hover:text-red-700 dark:text-red-400"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === 'create' ? (
          <div className="mx-auto max-w-3xl space-y-6">
            {/* Project + Goal card */}
            <section className="rounded-xl border border-border/60 bg-card/50 p-4 shadow-sm">
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="swarm-project"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Project
                  </label>
                  <select
                    id="swarm-project"
                    className={fieldClass}
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                  >
                    <option value="">Select project…</option>
                    {projects.map((p) => (
                      <option key={p.projectId} value={p.projectId}>
                        {p.displayName || p.projectId}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="swarm-goal"
                    className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Goal
                  </label>
                  <textarea
                    id="swarm-goal"
                    className={`${fieldClass} min-h-[96px] resize-y`}
                    placeholder="What should this swarm accomplish?"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Attachments
                      </span>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Optional PRD, design docs, screenshots, or other context (max{' '}
                        {MAX_SWARM_ATTACHMENTS}, 25MB each). Agents receive these with the goal.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted/50"
                      onClick={() => attachmentInputRef.current?.click()}
                      disabled={attachedFiles.length >= MAX_SWARM_ATTACHMENTS}
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                      Add files
                    </button>
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      className="hidden"
                      multiple
                      accept={[
                        ...IMAGE_ATTACHMENT_EXTENSIONS,
                        ...DOCUMENT_ATTACHMENT_EXTENSIONS,
                        'image/*',
                      ].join(',')}
                      onChange={(e) => {
                        addAttachments(e.target.files);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  {attachedFiles.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {attachedFiles.map((file, index) =>
                        isImageFile(file) ? (
                          <ImageAttachment
                            key={`${file.name}-${file.size}-${index}`}
                            file={file}
                            onRemove={() => removeAttachment(index)}
                          />
                        ) : (
                          <FileAttachmentChip
                            key={`${file.name}-${file.size}-${index}`}
                            file={file}
                            onRemove={() => removeAttachment(index)}
                          />
                        ),
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-4 text-xs text-muted-foreground transition hover:border-primary/40 hover:bg-muted/40 hover:text-foreground"
                      onClick={() => attachmentInputRef.current?.click()}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        addAttachments(e.dataTransfer.files);
                      }}
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                      Drop a PRD or images here, or click to browse
                    </button>
                  )}
                </div>
              </div>
            </section>

            {/* Skills */}
            <section className="rounded-xl border border-border/60 bg-card/50 p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Project skills
                  </h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Skills agents should prefer — loaded from the selected project.
                  </p>
                </div>
                {skillOptions.length > 0 ? (
                  <div className="flex gap-2 text-[11px]">
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => setSelectedSkills(skillOptions.map((s) => s.directoryName))}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:underline"
                      onClick={() => setSelectedSkills([])}
                    >
                      Clear
                    </button>
                  </div>
                ) : null}
              </div>
              {!projectId ? (
                <p className="mt-3 text-[11px] text-muted-foreground">Select a project to load skills.</p>
              ) : skillsLoading ? (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading project skills…
                </div>
              ) : skillOptions.length === 0 ? (
                <p className="mt-3 text-[11px] text-muted-foreground">
                  No managed project skills found for this workspace.
                </p>
              ) : (
                <div className="mt-3 grid max-h-44 gap-1.5 overflow-y-auto sm:grid-cols-2">
                  {skillOptions.map((skill) => {
                    const selected = selectedSkills.includes(skill.directoryName);
                    return (
                      <label
                        key={skill.directoryName}
                        className={`flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-xs transition ${
                          selected
                            ? 'bg-primary/8 border-primary/40 shadow-sm'
                            : 'border-border/60 hover:border-border hover:bg-muted/40'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-primary"
                          checked={selected}
                          onChange={() => toggleSkill(skill.directoryName)}
                        />
                        <span className="min-w-0">
                          <span className="font-medium text-foreground">
                            {skill.name || skill.directoryName}
                          </span>
                          {skill.description ? (
                            <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                              {skill.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Execution options */}
            <section className="rounded-xl border border-border/60 bg-card/50 p-4 shadow-sm">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Execution options
                </h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Auto-scale adds seats as waves demand parallel work.
                </p>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-xs transition hover:border-border hover:bg-muted/40">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={requirePlanApproval}
                      onChange={(e) => setRequirePlanApproval(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium text-foreground">Approve plan before running</span>
                      <span className="block text-[11px] text-muted-foreground">
                        The orchestrator plans first; you review cost &amp; steps, then approve
                        before any worker agent runs.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-xs transition hover:border-border hover:bg-muted/40">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={validateBeforePr}
                      onChange={(e) => setValidateBeforePr(e.target.checked)}
                    />
                    <span>
                      <span className="flex items-center gap-1 font-medium text-foreground">
                        <ShieldCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                        Pre-PR validation gate
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        Run static checks + smoke verification and attach a test report
                        (PDF) before the PR is opened. Recommended.
                      </span>
                    </span>
                  </label>
                </div>
                <div className="space-y-2">
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Stall timeout (ms — no output for this long = reassign)
                    <input
                      type="number"
                      min={0}
                      step={30000}
                      className={fieldClass}
                      value={stallTimeoutMs || ''}
                      placeholder="300000"
                      onChange={(e) => setStallTimeoutMs(Number(e.target.value) || 0)}
                    />
                  </label>
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Hard per-step ceiling (ms, 0 = none)
                    <input
                      type="number"
                      min={0}
                      step={60000}
                      className={fieldClass}
                      value={stepTimeoutMs || ''}
                      placeholder="0"
                      onChange={(e) => setStepTimeoutMs(Number(e.target.value) || 0)}
                    />
                  </label>
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Attempts per task (feedback + reassignment)
                    <input
                      type="number"
                      min={1}
                      max={5}
                      step={1}
                      className={fieldClass}
                      value={stepMaxAttempts || ''}
                      placeholder="3"
                      onChange={(e) => setStepMaxAttempts(Number(e.target.value) || 0)}
                    />
                  </label>
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Validation remediation rounds
                    <input
                      type="number"
                      min={1}
                      max={8}
                      step={1}
                      className={fieldClass}
                      value={validationMaxAttempts || ''}
                      placeholder="4"
                      onChange={(e) => setValidationMaxAttempts(Number(e.target.value) || 0)}
                    />
                  </label>
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Max concurrent workers (0 = roster size)
                    <input
                      type="number"
                      min={0}
                      step={1}
                      className={fieldClass}
                      value={maxConcurrency || ''}
                      placeholder="0"
                      onChange={(e) => setMaxConcurrency(Number(e.target.value) || 0)}
                    />
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-[11px] transition hover:border-border hover:bg-muted/40">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={parallelWriters}
                      onChange={(e) => setParallelWriters(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium text-foreground">Parallel isolated writers</span>
                      <span className="block text-[10px] text-muted-foreground">
                        Disjoint implementation steps use child worktrees and merge back safely.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-[11px] transition hover:border-border hover:bg-muted/40">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={autonomous}
                      onChange={(e) => setAutonomous(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium text-foreground">Autonomous (long-horizon)</span>
                      <span className="block text-[10px] text-muted-foreground">
                        Only a crashed or silent agent stops a step — a reviewer/tester finding
                        real issues just triggers another attempt. Raises attempt and replan
                        budgets so the swarm can keep working for hours unattended.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </section>

            {/* Roster */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Agent roster
                  </h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {rosterMode === 'auto'
                      ? 'Pick the orchestrator — it staffs the rest of the roster for you.'
                      : 'Exactly one orchestrator. Add workers — they run in parallel waves.'}
                  </p>
                </div>
                <div
                  role="group"
                  aria-label="Roster mode"
                  className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1 shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setRosterMode('auto');
                      setRequirePlanApproval(false);
                    }}
                    aria-pressed={rosterMode === 'auto'}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                      rosterMode === 'auto'
                        ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Auto
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRosterMode('advanced');
                      setRequirePlanApproval(true);
                    }}
                    aria-pressed={rosterMode === 'advanced'}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                      rosterMode === 'advanced'
                        ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    Advanced
                  </button>
                </div>
              </div>

              {rosterMode === 'auto' ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">Auto roster: </span>
                    the orchestrator selects explorer, implementer, and reviewer seats from
                    Agent Profiles tagged for swarm roles, then runs the goal end to end.
                    You only review the final report and merge the PR.
                  </div>
                  {hasSwarmProfiles === false ? (
                    <div
                      role="note"
                      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300"
                    >
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>
                        No Agent Profiles are tagged for swarm roles yet — the orchestrator
                        will fall back to built-in defaults.
                      </span>
                      <button
                        type="button"
                        className="font-medium text-amber-900 underline underline-offset-2 hover:no-underline dark:text-amber-200"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent('cloudcli:open-settings', {
                              detail: { tab: 'agent-profiles' },
                            }),
                          )
                        }
                      >
                        Tag profiles in Settings → Agent Profiles
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-wrap justify-end gap-1.5">
                  {(['explorer', 'implementer', 'reviewer', 'tester', 'security', 'docs'] as const).map((k) => (
                    <Button
                      key={k}
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-lg text-xs"
                      onClick={() => addWorker(k)}
                      title={`Add ${k}`}
                    >
                      <Plus className="mr-1 h-3 w-3" />
                      {k.charAt(0).toUpperCase() + k.slice(1)}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-lg text-xs"
                    onClick={() => addWorker('custom')}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Custom
                  </Button>
                </div>
              )}

              <div className="space-y-3">
                {roster.map((seat, index) => {
                  if (rosterMode === 'auto' && seat.kind !== 'orchestrator') return null;
                  const isOrch = seat.kind === 'orchestrator';
                  const provider = seat.provider || 'claude';
                  const modelOptions = modelsByProvider[provider] ?? [];
                  const loadingModels = Boolean(modelsLoading[provider]);
                  const permModes = permissionModesForProvider(provider, permModesByProvider);
                  const permValue = clampPermissionMode(
                    provider,
                    seat.permissionMode,
                    permModesByProvider,
                  );
                  const effortOptions = effortOptionsForProvider(provider, seat.model, modelOptions);
                  const effortValue = clampEffort(provider, seat.model, seat.effort, modelOptions);

                  return (
                    <div
                      key={seat.id || `${seat.label}-${index}`}
                      className={`overflow-hidden rounded-xl border shadow-sm transition ${
                        isOrch
                          ? 'from-primary/8 border-primary/35 bg-gradient-to-br via-primary/5 to-transparent'
                          : 'border-border/60 bg-card/60'
                      }`}
                    >
                      <div
                        className={`flex items-center justify-between gap-2 border-b px-3.5 py-2 ${
                          isOrch ? 'border-primary/15 bg-primary/5' : 'border-border/40 bg-muted/30'
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                              isOrch
                                ? 'bg-primary/15 text-primary'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {kindIcon(seat.kind)}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">
                              {seat.label || seat.kind}
                            </div>
                            {isOrch ? (
                              <div className="text-[10px] font-medium text-primary">
                                Required · plans & dispatches
                              </div>
                            ) : (
                              <div className="text-[10px] capitalize text-muted-foreground">
                                {seat.kind}
                              </div>
                            )}
                          </div>
                        </div>
                        {!isOrch ? (
                          <button
                            type="button"
                            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-red-500/10 hover:text-red-500"
                            onClick={() => removeSeat(index)}
                            aria-label={`Remove ${seat.label || seat.kind} agent`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>

                      <div className="grid gap-2.5 p-3.5 sm:grid-cols-2 lg:grid-cols-3">
                        <label className="text-[11px] font-medium text-muted-foreground">
                          Kind
                          {isOrch ? (
                            <input
                              className={`${seatFieldClass} bg-muted/50`}
                              value="Orchestrator"
                              disabled
                              readOnly
                            />
                          ) : (
                            <select
                              className={seatFieldClass}
                              value={seat.kind}
                              onChange={(e) => updateSeat(index, { kind: e.target.value })}
                            >
                              {WORKER_KINDS.map((k) => (
                                <option key={k.value} value={k.value}>
                                  {k.label}
                                </option>
                              ))}
                            </select>
                          )}
                        </label>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          Label
                          <input
                            className={seatFieldClass}
                            value={seat.label}
                            onChange={(e) => updateSeat(index, { label: e.target.value })}
                          />
                        </label>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          Provider
                          <select
                            className={seatFieldClass}
                            value={provider}
                            onChange={(e) => updateSeat(index, { provider: e.target.value })}
                          >
                            {SWARM_PROVIDERS.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          Model
                          <select
                            className={seatFieldClass}
                            value={seat.model || ''}
                            onChange={(e) => updateSeat(index, { model: e.target.value || null })}
                            disabled={loadingModels}
                          >
                            {loadingModels ? (
                              <option value="">Loading models…</option>
                            ) : modelOptions.length === 0 ? (
                              <option value="">Provider default</option>
                            ) : (
                              <>
                                <option value="">Provider default</option>
                                {modelOptions.map((m) => (
                                  <option key={m.value} value={m.value}>
                                    {m.label}
                                  </option>
                                ))}
                              </>
                            )}
                          </select>
                        </label>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          Effort
                          <select
                            className={seatFieldClass}
                            value={effortValue}
                            onChange={(e) => updateSeat(index, { effort: e.target.value })}
                          >
                            <option value="default">default</option>
                            {effortOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.value}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          Permissions
                          <span className="ml-1 font-normal text-muted-foreground/70">
                            ({provider})
                          </span>
                          <select
                            className={seatFieldClass}
                            value={permValue}
                            onChange={(e) =>
                              updateSeat(index, { permissionMode: e.target.value })
                            }
                          >
                            {permModes.map((m) => (
                              <option key={m} value={m}>
                                {SWARM_PERMISSION_LABELS[m] || m}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="border-t border-border/40 px-3.5 pb-3.5 pt-2">
                        <label className="block text-[11px] font-medium text-muted-foreground">
                          Focus
                          <input
                            className={seatFieldClass}
                            value={seat.focus || ''}
                            onChange={(e) => updateSeat(index, { focus: e.target.value })}
                            placeholder="Optional guidance for this seat"
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="sticky bottom-0 -mx-1 flex justify-end bg-gradient-to-t from-background via-background to-transparent pb-1 pt-4">
              <Button
                onClick={() => void start()}
                disabled={starting}
                className="h-10 rounded-lg px-5 shadow-md"
              >
                <Network className="mr-1.5 h-4 w-4" />
                {starting ? 'Starting…' : 'Deploy Agent Swarm'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {/* History toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/30 p-0.5">
                <button
                  type="button"
                  onClick={() => setHistoryFilter('active')}
                  aria-pressed={historyFilter === 'active'}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    historyFilter === 'active'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Active
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryFilter('archived')}
                  aria-pressed={historyFilter === 'archived'}
                  className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    historyFilter === 'archived'
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Archive className="h-3 w-3" />
                  Archived
                </button>
              </div>
              <div className="flex flex-1 items-center justify-end gap-2 sm:max-w-xs">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    aria-label="Search swarms"
                    className="h-8 w-full rounded-lg border border-border/60 bg-background pl-8 pr-2.5 text-xs outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
                    placeholder="Search swarms…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => void refresh()}
                  disabled={refreshing}
                  aria-label="Refresh swarms"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>

            {hasLive && historyFilter === 'active' ? (
              <div
                role="status"
                className="bg-sky-500/8 flex items-center gap-2 rounded-lg border border-sky-500/20 px-3 py-2 text-[11px] text-sky-800 dark:text-sky-200"
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
                </span>
                Live swarm in progress · parent runs appear in Observatory
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {historyFilter === 'archived'
                  ? 'Archived swarms are hidden from the active list. Restore or delete permanently.'
                  : 'Finished and in-progress swarms. Archive to declutter or delete permanently.'}
              </p>
            )}

            {filteredSwarms.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/20 px-6 py-14 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
                  {historyFilter === 'archived' ? (
                    <Archive className="h-5 w-5" />
                  ) : (
                    <Network className="h-5 w-5" />
                  )}
                </div>
                <p className="text-sm font-medium text-foreground">
                  {historyFilter === 'archived' ? 'No archived swarms' : 'No agent swarms yet'}
                </p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  {historyFilter === 'archived'
                    ? 'Archive completed swarms from the Active list to keep them here.'
                    : 'Create a swarm to orchestrate a goal across explorers, implementers, and reviewers.'}
                </p>
                {historyFilter === 'active' ? (
                  <Button
                    size="sm"
                    className="mt-4 rounded-lg"
                    onClick={() => setTab('create')}
                  >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    New swarm
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2.5">
                {filteredSwarms.map((swarm) => {
                  const open = expanded === swarm.swarm_id;
                  const live = isPolledStatus(swarm.status);
                  const executing = ['queued', 'planning', 'running', 'handing_off'].includes(
                    swarm.status,
                  );
                  const cancelRequested = Boolean(
                    swarm.cancelRequestedAt ?? swarm.cancel_requested_at,
                  );
                  const canAbort = allowsSwarmAction(swarm, 'abort');
                  const canResume = allowsSwarmAction(swarm, 'resume');
                  const canArchive = allowsSwarmAction(swarm, 'archive');
                  const canDelete = allowsSwarmAction(swarm, 'delete');
                  const swarmBusy = Boolean(busyBySwarm[swarm.swarm_id]);
                  const archived = Boolean(swarm.archived_at);
                  const workspaceId =
                    swarm.workspace_id || swarm.synthesis?.workspaceId || null;
                  const workspaceState = workspaceId
                    ? workspaceStateById[workspaceId]
                    : undefined;
                  const workspaceStatus =
                    swarm.workspaceStatus ?? swarm.workspace_status ?? workspaceState?.status;
                  const workspaceRemoved = Boolean(
                    workspaceId &&
                      (swarm.workspaceCleanedAt ||
                        swarm.workspace_cleaned_at ||
                        workspaceState?.cleanedAt ||
                        workspaceStatus === 'discarded' ||
                        workspaceStatus === 'orphan' ||
                        cleanedWorkspaces.includes(workspaceId)),
                  );

                  return (
                    <div
                      key={swarm.swarm_id}
                      aria-busy={swarmBusy}
                      className={`overflow-hidden rounded-xl border bg-card/70 shadow-sm transition ${
                        open
                          ? 'border-primary/30 ring-1 ring-primary/15'
                          : 'border-border/60 hover:border-border'
                      }`}
                    >
                      <div className="flex items-stretch gap-0">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={`swarm-details-${swarm.swarm_id}`}
                          className="min-w-0 flex-1 px-4 py-3 text-left transition hover:bg-muted/20"
                          onClick={() => setExpanded(open ? null : swarm.swarm_id)}
                        >
                          <div className="flex items-start gap-3">
                            <span className="mt-0.5 text-muted-foreground">
                              {open ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {swarm.goal}
                                </span>
                                <span
                                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${statusBadgeClass(
                                    swarm.status,
                                  )}`}
                                >
                                  {executing ? (
                                    <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                                  ) : null}
                                  {cancelRequested
                                    ? 'cancellation requested'
                                    : swarm.status.replace(/_/g, ' ')}
                                </span>
                                {archived ? (
                                  <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border">
                                    <Archive className="h-2.5 w-2.5" />
                                    Archived
                                  </span>
                                ) : null}
                              </div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                                <span>{projectName(swarm.project_id)}</span>
                                <span className="text-border">·</span>
                                <span>{new Date(swarm.created_at).toLocaleString()}</span>
                                {swarm.usage?.totalDurationMs != null ? (
                                  <>
                                    <span className="text-border">·</span>
                                    <span title="Wall-clock runtime">
                                      {formatDurationMs(swarm.usage.totalDurationMs)}
                                    </span>
                                  </>
                                ) : null}
                                {swarm.usage && swarm.usage.totalCostUsd > 0 ? (
                                  <>
                                    <span className="text-border">·</span>
                                    <span>${swarm.usage.totalCostUsd.toFixed(2)}</span>
                                  </>
                                ) : null}
                                {swarm.approval_status ? (
                                  <>
                                    <span className="text-border">·</span>
                                    <span>approval: {swarm.approval_status}</span>
                                  </>
                                ) : null}
                                {swarm.pr_url || swarm.synthesis?.prUrl ? (
                                  <>
                                    <span className="text-border">·</span>
                                    <span className="text-primary">PR ready</span>
                                  </>
                                ) : null}
                                {swarm.attachments && swarm.attachments.length > 0 ? (
                                  <>
                                    <span className="text-border">·</span>
                                    <span className="inline-flex items-center gap-0.5">
                                      <Paperclip className="h-2.5 w-2.5" />
                                      {swarm.attachments.length} file
                                      {swarm.attachments.length === 1 ? '' : 's'}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </button>

                        {/* Quick actions */}
                        <div className="flex shrink-0 items-center gap-0.5 border-l border-border/40 px-2">
                          {archived ? (
                            <button
                              type="button"
                              className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                              title="Restore from archive"
                              aria-label="Restore swarm from archive"
                              disabled={swarmBusy}
                              onClick={(e) => {
                                e.stopPropagation();
                                void archiveSwarm(swarm.swarm_id, true);
                              }}
                            >
                              <ArchiveRestore className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                              title={canArchive ? 'Archive' : 'Finish the swarm before archiving'}
                              aria-label={canArchive ? 'Archive swarm' : 'Archive unavailable while swarm runs'}
                              disabled={swarmBusy || !canArchive}
                              onClick={(e) => {
                                e.stopPropagation();
                                void archiveSwarm(swarm.swarm_id, false);
                              }}
                            >
                              <Archive className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            className="rounded-md p-2 text-muted-foreground transition hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
                            title={canDelete ? 'Delete permanently' : 'Finish the swarm before deleting'}
                            aria-label={canDelete ? 'Delete swarm permanently' : 'Delete unavailable while swarm runs'}
                            disabled={swarmBusy || !canDelete}
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteSwarm(swarm.swarm_id, swarm.goal);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>

                      {open ? (
                        <div
                          id={`swarm-details-${swarm.swarm_id}`}
                          className="space-y-4 border-t border-border/40 bg-muted/15 px-4 py-4 text-xs"
                        >
                          {/* Roster chips */}
                          <div>
                            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Roster
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(swarm.roles ?? []).map((r, i) => (
                                <span
                                  key={`${r.label}-${i}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] shadow-sm"
                                >
                                  <span className="text-muted-foreground">{kindIcon(r.kind)}</span>
                                  <span className="font-medium text-foreground">{r.label}</span>
                                  {r.kind !== 'orchestrator' ? (
                                    <span className={LEVEL_CHIP[r.level ?? 'medium']}>
                                      {LEVEL_LABEL[r.level ?? 'medium']}
                                    </span>
                                  ) : null}
                                  <span className="text-muted-foreground">
                                    {r.provider || '?'}
                                    {r.model ? ` · ${r.model}` : ''}
                                  </span>
                                </span>
                              ))}
                            </div>
                            {(swarm.skills ?? []).length > 0 ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {swarm.skills.map((s) => (
                                  <span
                                    key={s}
                                    className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                                  >
                                    {s}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>

                          {(swarm.attachments ?? []).length > 0 ? (
                            <div>
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Goal attachments
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {swarm.attachments!.map((attachment, index) => {
                                  const label =
                                    attachment.name ||
                                    attachment.path.split(/[\\/]/).pop() ||
                                    `file-${index + 1}`;
                                  return (
                                    <span
                                      key={`${attachment.path}-${index}`}
                                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 py-1 text-[10px] shadow-sm"
                                      title={
                                        attachment.workspacePath
                                          ? `${label} → ${attachment.workspacePath}`
                                          : attachment.path
                                      }
                                    >
                                      <Paperclip className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                                      <span className="truncate font-medium text-foreground">
                                        {label}
                                      </span>
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          ) : null}

                          {swarm.goalCard ? <GoalCardPanel card={swarm.goalCard} running={swarm.status === 'running'} /> : null}

                          {swarm.last_error ? (
                            <div
                              role="alert"
                              className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-700 dark:text-red-300"
                            >
                              {isValidationFailure(swarm) ? (
                                <div className="mb-1 flex items-center gap-1.5 font-semibold">
                                  <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                  {swarm.pr_url
                                    ? 'Validation still red — PR opened anyway with the report, ready for a follow-up swarm'
                                    : 'Pre-PR validation failed — no PR was opened'}
                                </div>
                              ) : null}
                              {swarm.last_error}
                            </div>
                          ) : null}

                          {/* Plan */}
                          {swarm.plan ? (
                            <div>
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Plan
                              </div>
                              <p className="text-muted-foreground">{swarm.plan.summary}</p>
                              {swarm.plan.strategy ? (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  Strategy: {swarm.plan.strategy}
                                </p>
                              ) : null}
                              {swarm.plan.costNotes ? (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  Cost: {swarm.plan.costNotes}
                                </p>
                              ) : null}
                              <ul className="mt-2 space-y-1.5">
                                {(swarm.plan.steps ?? []).map((step) => {
                                  const stepRuns = (swarm.usage?.memberRuns ?? []).filter(
                                    (run) => run.stepId === step.id,
                                  );
                                  const stepDuration = stepRuns.reduce(
                                    (sum, run) => sum + (run.durationMs ?? 0),
                                    0,
                                  );
                                  const stepCost = stepRuns.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
                                  const stepTokens = stepRuns.reduce((sum, run) => sum + (run.tokens ?? 0), 0);
                                  return (
                                  <li
                                    key={step.id}
                                    className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/80 px-2.5 py-1.5"
                                  >
                                    {step.status === 'succeeded' || step.status === 'recovered' ? (
                                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                                    ) : step.status === 'failed' ? (
                                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                                    ) : step.status === 'needs_changes' ? (
                                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                                    ) : step.status === 'running' ? (
                                      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-sky-500" />
                                    ) : (
                                      <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                                    )}
                                    <span className="flex-1">
                                      <span className="font-medium text-foreground">{step.title}</span>
                                      <span className="text-muted-foreground">
                                        {' '}
                                        · {step.assignTo || step.kind}
                                        {step.difficulty ? ` · ${step.difficulty}` : ''}
                                        {step.wave != null ? ` · wave ${step.wave}` : ''}
                                        {step.status ? ` · ${step.status}` : ''}
                                        {stepDuration > 0
                                          ? ` · ${formatDurationMs(stepDuration)}`
                                          : ''}
                                        {stepCost > 0
                                          ? ` · $${stepCost.toFixed(4)}`
                                          : stepTokens > 0
                                            ? ` · ${stepTokens.toLocaleString()} tok`
                                            : ''}
                                      </span>
                                    </span>
                                    {(step.status === 'failed' || step.status === 'needs_changes') &&
                                    allowsSwarmAction(swarm, 'retry-step') ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-6 shrink-0 rounded-md px-2 text-[10px]"
                                        disabled={swarmBusy}
                                        onClick={() => void retryStep(swarm.swarm_id, step.id)}
                                      >
                                        <RefreshCw className="mr-1 h-3 w-3" />
                                        Retry
                                      </Button>
                                    ) : null}
                                  </li>
                                  );
                                })}
                              </ul>
                            </div>
                          ) : swarm.status === 'planning' ? (
                            <div className="flex items-center gap-2 text-sky-600 dark:text-sky-400">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Orchestrator is planning…
                            </div>
                          ) : null}

                          {/* Members */}
                          {(swarm.members ?? []).length > 0 ? (
                            <div>
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Agents
                              </div>
                              <div className="space-y-2">
                                {(swarm.members ?? []).map((m) => (
                                  <div
                                    key={m.member_id}
                                    className="rounded-lg border border-border/40 bg-background/80 px-3 py-2"
                                  >
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium text-foreground">
                                        {m.label || m.role}
                                      </span>
                                      <span
                                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${statusBadgeClass(
                                          m.status,
                                        )}`}
                                      >
                                        {statusLabel(m.status)}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground">
                                        {m.provider}
                                        {m.model ? ` / ${m.model}` : ''}
                                        {m.effort ? ` · ${m.effort}` : ''}
                                      </span>
                                      {(() => {
                                        const run = swarm.usage?.memberRuns.find(
                                          (entry) => entry.memberId === m.member_id,
                                        );
                                        const duration =
                                          run?.durationMs
                                          ?? (m.created_at && m.finished_at
                                            ? new Date(m.finished_at).getTime()
                                              - new Date(m.created_at).getTime()
                                            : null);
                                        const bits = [
                                          duration != null && duration > 0
                                            ? formatDurationMs(duration)
                                            : null,
                                          run && run.costUsd > 0
                                            ? `$${run.costUsd.toFixed(4)}`
                                            : null,
                                        ].filter(Boolean);
                                        return bits.length > 0 ? (
                                          <span className="text-[10px] text-muted-foreground">
                                            {bits.join(' · ')}
                                          </span>
                                        ) : null;
                                      })()}
                                    </div>
                                    {m.findings_summary ? (
                                      <p className="mt-1.5 whitespace-pre-wrap text-muted-foreground">
                                        {m.findings_summary.slice(0, 600)}
                                        {m.findings_summary.length > 600 ? '…' : ''}
                                      </p>
                                    ) : null}
                                    {m.error ? (
                                      <p className="mt-1 text-red-600 dark:text-red-400">{m.error}</p>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {/* Usage / cost */}
                          {swarm.usage && swarm.usage.memberRuns.some((r) => r.tokens > 0 || r.costUsd > 0 || (r.durationMs ?? 0) > 0) ? (
                            <div>
                              <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Usage
                                <LiveSpendMeter spentUsd={swarm.usage.totalCostUsd} />
                              </div>
                              <div className="space-y-2 rounded-lg border border-border/40 bg-background/80 p-2.5">
                                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                                  <span className="text-muted-foreground">Runtime</span>
                                  <span className="font-medium text-foreground">
                                    {formatDurationMs(swarm.usage.totalDurationMs) ?? '—'}
                                  </span>
                                  <span className="text-muted-foreground">Work time</span>
                                  <span className="font-medium text-foreground">
                                    {formatDurationMs(swarm.usage.billedDurationMs) ?? '—'}
                                  </span>
                                  <span className="text-muted-foreground">Total tokens</span>
                                  <span className="font-medium text-foreground">
                                    {swarm.usage.totalTokens.toLocaleString()}
                                  </span>
                                  <span className="text-muted-foreground">Est. cost</span>
                                  <span className="font-medium text-foreground">
                                    ${swarm.usage.totalCostUsd.toFixed(4)}
                                  </span>
                                </div>
                                <div className="space-y-1 border-t border-border/40 pt-1.5">
                                  {swarm.usage.memberRuns
                                    .filter((r) => r.tokens > 0 || r.costUsd > 0)
                                    .map((r) => (
                                      <div
                                        key={r.memberId}
                                        className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground"
                                      >
                                        <span className="font-medium text-foreground">
                                          {r.label ?? r.memberId}
                                        </span>
                                        <span>
                                          {r.tokens.toLocaleString()} tokens · $
                                          {r.costUsd.toFixed(4)}
                                          {r.durationMs != null
                                            ? ` · ${(r.durationMs / 1000).toFixed(1)}s`
                                            : ''}
                                        </span>
                                      </div>
                                    ))}
                                </div>
                              </div>
                            </div>
                          ) : null}

                          {/* Blackboard */}
                          {(swarm.blackboard ?? []).length > 0 ? (
                            <div>
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Blackboard
                              </div>
                              <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border/40 bg-background/80 p-2.5">
                                {(swarm.blackboard ?? []).map((msg) => {
                                  const badge = blackboardBadge(msg.content);
                                  const body = badge ? badge.rest : msg.content;
                                  return (
                                    <div
                                      key={msg.id}
                                      className="text-[11px]"
                                      title={badge ? msg.content : undefined}
                                    >
                                      <span className="font-medium text-foreground">
                                        {msg.from}
                                      </span>
                                      <span className="text-muted-foreground"> · {msg.kind}</span>
                                      {badge ? (
                                        <span
                                          className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide ring-1 ring-inset ${
                                            BLACKBOARD_BADGE_TONE[badge.tone]
                                          }`}
                                        >
                                          {badge.label}
                                        </span>
                                      ) : null}
                                      <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                                        {body.slice(0, 400)}
                                        {body.length > 400 ? '…' : ''}
                                      </p>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : null}

                          {swarm.artifacts && swarm.artifacts.length > 0 ? (
                            <div>
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Evidence artifacts
                              </div>
                              <div className="space-y-1.5 rounded-lg border border-border/40 bg-background/80 p-2.5">
                                {swarm.artifacts.map((artifact) => (
                                  <div key={artifact.artifact_id} className="rounded-md border border-border/40 px-2 py-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="font-medium text-foreground">{artifact.label}</span>
                                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">{artifact.kind}</span>
                                    </div>
                                    {artifact.content ? (
                                      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">{artifact.content}</pre>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {/* Workspace + PR */}
                          {(swarm.workspace_id ||
                            swarm.feature_branch ||
                            swarm.pr_url ||
                            swarm.synthesis?.prUrl ||
                            swarm.synthesis?.prError) && (
                            <div className="rounded-lg border border-border/50 bg-background/80 p-3">
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Workspace & pull request
                              </div>
                              <dl className="space-y-1 text-[11px] text-muted-foreground">
                                {swarm.workspace_id || swarm.synthesis?.workspaceId ? (
                                  <div>
                                    <span className="font-medium text-foreground">Workspace: </span>
                                    {swarm.workspace_id || swarm.synthesis?.workspaceId}
                                  </div>
                                ) : null}
                                {workspaceStatus ? (
                                  <div>
                                    <span className="font-medium text-foreground">Status: </span>
                                    {workspaceStatus.replace(/_/g, ' ')}
                                  </div>
                                ) : null}
                                {swarm.feature_branch || swarm.synthesis?.featureBranch ? (
                                  <div>
                                    <span className="font-medium text-foreground">Branch: </span>
                                    <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                                      {swarm.feature_branch || swarm.synthesis?.featureBranch}
                                    </code>
                                  </div>
                                ) : null}
                                {swarm.pr_url || swarm.synthesis?.prUrl ? (
                                  <div>
                                    <span className="font-medium text-foreground">PR: </span>
                                    <a
                                      className="text-primary underline-offset-2 hover:underline"
                                      href={swarm.pr_url || swarm.synthesis?.prUrl || '#'}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {swarm.pr_url || swarm.synthesis?.prUrl}
                                    </a>
                                  </div>
                                ) : null}
                                {swarm.synthesis?.prError ? (
                                  <div className="text-amber-700 dark:text-amber-300">
                                    <span className="font-medium">PR note: </span>
                                    {swarm.synthesis.prError}
                                  </div>
                                ) : null}
                              </dl>

                              {/*
                                Swarms stop at the PR and leave the worktree in
                                place so it can be checked out and tested. Once
                                the PR is merged on GitHub, this removes it —
                                nothing else does.
                              */}
                              {(() => {
                                if (!workspaceId || live) return null;
                                if (workspaceRemoved) {
                                  return (
                                    <div className="mt-2.5 border-t border-border/50 pt-2.5 text-[11px] text-muted-foreground">
                                      Worktree removed.
                                    </div>
                                  );
                                }
                                const branch =
                                  swarm.feature_branch || swarm.synthesis?.featureBranch || null;
                                const pushed =
                                  swarm.synthesis?.pushed ??
                                  Boolean(swarm.pr_url || swarm.synthesis?.prUrl);
                                return (
                                  <div className="mt-2.5 flex items-center gap-2 border-t border-border/50 pt-2.5">
                                    <button
                                      type="button"
                                      disabled={swarmBusy}
                                      title={
                                        pushed
                                          ? 'Remove the worktree and local branch'
                                          : 'Remove the worktree (unpushed branch is kept)'
                                      }
                                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void cleanupWorkspace(
                                          swarm.swarm_id,
                                          workspaceId,
                                          branch,
                                          pushed,
                                        );
                                      }}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                      Clean up workspace
                                    </button>
                                    <span className="text-[10px] text-muted-foreground">
                                      {pushed
                                        ? 'Do this after the PR is merged.'
                                        : 'Branch was never pushed — it will be kept.'}
                                    </span>
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          {/* Pre-PR validation gate */}
                          {(() => {
                            const validation = swarm.synthesis?.validation;
                            if (!validation) return null;
                            const overall = validationOverallStatus(validation);
                            const hasReport = Boolean(
                              validation.reportPdfPath || validation.reportHtmlPath,
                            );
                            return (
                              <div
                                className={`rounded-lg border p-3 ${
                                  overall === 'failed'
                                    ? 'border-red-500/30 bg-red-500/5'
                                    : 'border-border/50 bg-background/80'
                                }`}
                              >
                                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                                  <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    {overall === 'failed' ? (
                                      <ShieldAlert className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
                                    ) : (
                                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                                    )}
                                    Pre-PR validation
                                  </div>
                                  <span
                                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${validationChipClass(
                                      overall,
                                    )}`}
                                  >
                                    {overall}
                                  </span>
                                  {validation.generatedAt ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      {new Date(validation.generatedAt).toLocaleString()}
                                    </span>
                                  ) : null}
                                </div>
                                {validation.summary ? (
                                  <p className="text-[11px] text-muted-foreground">
                                    {validation.summary}
                                  </p>
                                ) : null}
                                {validation.degraded ? (
                                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                                    Degraded run — smoke/PDF tooling was unavailable, so only
                                    static checks were performed.
                                  </p>
                                ) : null}
                                {validation.checks.length > 0 ? (
                                  <ul className="mt-2 space-y-1">
                                    {validation.checks.map((check) => (
                                      <li
                                        key={check.id}
                                        className="flex items-center justify-between gap-2 rounded-md border border-border/40 bg-background/80 px-2.5 py-1.5 text-[11px]"
                                      >
                                        <span className="min-w-0 truncate font-medium text-foreground">
                                          {check.label}
                                        </span>
                                        <span
                                          className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${validationChipClass(
                                            check.status,
                                          )}`}
                                        >
                                          {check.status}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                                {hasReport ? (
                                  <div className="mt-2.5 border-t border-border/50 pt-2.5">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 rounded-md text-[11px]"
                                      disabled={swarmBusy}
                                      title="Open the validation report in a new tab (PDF preferred, HTML fallback)"
                                      onClick={() => void downloadReport(swarm.swarm_id)}
                                    >
                                      <FileDown className="mr-1 h-3 w-3" />
                                      Download test report (PDF)
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })()}

                          {/* Handoff */}
                          {swarm.synthesis?.summary ? (
                            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                                Orchestrator handoff
                              </div>
                              <p className="whitespace-pre-wrap text-muted-foreground">
                                {swarm.synthesis.summary}
                              </p>
                              {swarm.synthesis.completed?.length ? (
                                <div className="mt-2">
                                  <div className="text-[11px] font-medium text-foreground">
                                    Completed
                                  </div>
                                  <ul className="list-inside list-disc text-muted-foreground">
                                    {swarm.synthesis.completed.map((item) => (
                                      <li key={item}>{item}</li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                              {swarm.synthesis.remaining?.length ? (
                                <div className="mt-2">
                                  <div className="text-[11px] font-medium text-foreground">
                                    Remaining
                                  </div>
                                  <ul className="list-inside list-disc text-muted-foreground">
                                    {swarm.synthesis.remaining.map((item) => (
                                      <li key={item}>{item}</li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                              {swarm.synthesis.risks?.length ? (
                                <div className="mt-2">
                                  <div className="text-[11px] font-medium text-foreground">Risks</div>
                                  <ul className="list-inside list-disc text-muted-foreground">
                                    {swarm.synthesis.risks.map((item) => (
                                      <li key={item}>{item}</li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                              {swarm.synthesis.recommendations?.length ? (
                                <div className="mt-2">
                                  <div className="text-[11px] font-medium text-foreground">
                                    Recommendations
                                  </div>
                                  <ul className="list-inside list-disc text-muted-foreground">
                                    {swarm.synthesis.recommendations.map((item) => (
                                      <li key={item}>{item}</li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {allowsSwarmAction(swarm, 'approve-plan') ||
                          allowsSwarmAction(swarm, 'reject-plan') ? (
                            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
                              <div className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">
                                Orchestrator plan is ready — review it below before any worker
                                agents run.
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {allowsSwarmAction(swarm, 'approve-plan') ? (
                                  <Button
                                    size="sm"
                                    className="rounded-lg"
                                    onClick={() => void act(swarm.swarm_id, 'approve-plan')}
                                    disabled={swarmBusy}
                                  >
                                    Approve plan & run
                                  </Button>
                                ) : null}
                                {allowsSwarmAction(swarm, 'reject-plan') ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="rounded-lg border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                                    onClick={() => void act(swarm.swarm_id, 'reject-plan')}
                                    disabled={swarmBusy}
                                  >
                                    Reject plan
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          ) : null}

                          {allowsSwarmAction(swarm, 'approve') ||
                          allowsSwarmAction(swarm, 'reject') ? (
                            <div className="flex flex-wrap gap-2">
                              {allowsSwarmAction(swarm, 'approve') ? (
                                <Button
                                  size="sm"
                                  className="rounded-lg"
                                  onClick={() => void act(swarm.swarm_id, 'approve')}
                                  disabled={swarmBusy}
                                >
                                  Acknowledge handoff
                                </Button>
                              ) : null}
                              {allowsSwarmAction(swarm, 'reject') ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="rounded-lg border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400"
                                  onClick={() => void act(swarm.swarm_id, 'reject')}
                                  disabled={swarmBusy}
                                >
                                  Reject
                                </Button>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Footer meta + actions */}
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3 text-[10px] text-muted-foreground">
                            <div className="font-mono">
                              {swarm.parent_run_id || swarm.swarm_id}
                              {swarm.feature_branch ? ` · ${swarm.feature_branch}` : ''}
                            </div>
                            {busyBySwarm[swarm.swarm_id] ? (
                              <span role="status" className="font-medium text-primary">
                                {busyBySwarm[swarm.swarm_id].replace(/-/g, ' ')}…
                              </span>
                            ) : null}
                            <div className="flex gap-1">
                              {canResume ? (
                                <Button
                                  size="sm"
                                  className="h-7 rounded-md text-[11px]"
                                  disabled={swarmBusy}
                                  onClick={() => void act(swarm.swarm_id, 'resume')}
                                >
                                  <RefreshCw className="mr-1 h-3 w-3" />
                                  Resume from failure
                                </Button>
                              ) : null}
                              {canAbort ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 rounded-md text-[11px] text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
                                  disabled={swarmBusy}
                                  onClick={() => void act(swarm.swarm_id, 'abort')}
                                >
                                  <XCircle className="mr-1 h-3 w-3" />
                                  Abort
                                </Button>
                              ) : null}
                              {archived ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 rounded-md text-[11px]"
                                  disabled={swarmBusy}
                                  onClick={() => void archiveSwarm(swarm.swarm_id, true)}
                                >
                                  <ArchiveRestore className="mr-1 h-3 w-3" />
                                  Restore
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 rounded-md text-[11px]"
                                  disabled={swarmBusy || !canArchive}
                                  onClick={() => void archiveSwarm(swarm.swarm_id, false)}
                                >
                                  <Archive className="mr-1 h-3 w-3" />
                                  Archive
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 rounded-md text-[11px] text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
                                disabled={swarmBusy || !canDelete}
                                onClick={() => void deleteSwarm(swarm.swarm_id, swarm.goal)}
                              >
                                <Trash2 className="mr-1 h-3 w-3" />
                                Delete
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
