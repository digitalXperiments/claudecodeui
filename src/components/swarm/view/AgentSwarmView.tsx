import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Code2,
  Eye,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  UserCog,
  XCircle,
} from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';
import { Button } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import {
  clampPermissionMode,
  defaultRoster,
  permissionModesForProvider,
  SWARM_EFFORTS,
  SWARM_KINDS,
  SWARM_PERMISSION_LABELS,
  SWARM_PROVIDERS,
  type SwarmAgentSpec,
  type SwarmRun,
} from '../types';

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, options);
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(
      (payload as { error?: string; message?: string }).error ||
        (payload as { message?: string }).message ||
        `Request failed (${response.status})`,
    );
  }
  return payload;
}

function statusBadgeClass(status: string): string {
  if (status === 'succeeded') {
    return 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300';
  }
  if (status === 'failed' || status === 'aborted') {
    return 'bg-red-500/15 text-red-700 ring-red-500/25 dark:text-red-300';
  }
  if (status === 'awaiting_approval') {
    return 'bg-amber-500/15 text-amber-800 ring-amber-500/25 dark:text-amber-300';
  }
  if (['planning', 'running', 'handing_off', 'queued'].includes(status)) {
    return 'bg-sky-500/15 text-sky-700 ring-sky-500/25 dark:text-sky-300';
  }
  return 'bg-muted text-muted-foreground ring-border';
}

function statusTone(status: string): string {
  if (status === 'succeeded') return 'text-emerald-600 dark:text-emerald-400';
  if (status === 'failed' || status === 'aborted') return 'text-red-600 dark:text-red-400';
  if (status === 'awaiting_approval') return 'text-amber-600 dark:text-amber-400';
  if (status === 'planning' || status === 'running' || status === 'handing_off') {
    return 'text-sky-600 dark:text-sky-400';
  }
  return 'text-muted-foreground';
}

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
      kind === 'implementer' ? 'acceptEdits' : 'bypassPermissions',
    ),
    skills: [],
    focus: '',
  };
}

/** Worker kinds only — orchestrator is fixed at one seat. */
const WORKER_KINDS = SWARM_KINDS.filter((k) => k.value !== 'orchestrator');

type ModelOption = { value: string; label: string };
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
  const [swarms, setSwarms] = useState<SwarmRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // The swarm record carries no workspace status, so remember which worktrees
  // this session already removed and hide their cleanup action.
  const [cleanedWorkspaces, setCleanedWorkspaces] = useState<string[]>([]);
  const [tab, setTab] = useState<'create' | 'history'>('history');
  const [historyFilter, setHistoryFilter] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');

  // Create form
  const [projectId, setProjectId] = useState(selectedProject?.projectId ?? '');
  const [goal, setGoal] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [roster, setRoster] = useState<SwarmAgentSpec[]>(() => defaultRoster());
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);
  const [stepTimeoutMs, setStepTimeoutMs] = useState(0);
  const [maxConcurrency, setMaxConcurrency] = useState(0);
  /** provider → model options cache */
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelOption[]>>({});
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});
  /** provider → permission modes from capabilities API */
  const [permModesByProvider, setPermModesByProvider] = useState<Record<string, string[]> | null>(
    null,
  );

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
    () =>
      swarms.some((s) =>
        ['queued', 'planning', 'running', 'handing_off', 'awaiting_approval'].includes(s.status),
      ),
    [swarms],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '50' });
      if (historyFilter === 'archived') qs.set('archivedOnly', 'true');
      const payload = await requestJson<{ swarms?: SwarmRun[] }>(`/api/swarm?${qs.toString()}`);
      setSwarms(Array.isArray(payload.swarms) ? payload.swarms : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load swarms.');
    } finally {
      setRefreshing(false);
    }
  }, [historyFilter]);

  useEffect(() => {
    if (!isVisible) return;
    void refresh();
  }, [isVisible, refresh]);

  useEffect(() => {
    if (!isVisible || !hasLive || historyFilter === 'archived') return;
    const id = window.setInterval(() => {
      void refresh();
    }, 2500);
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
    const providers = [
      ...new Set(roster.map((s) => (s.provider || 'claude').trim()).filter(Boolean)),
    ];
    let cancelled = false;

    for (const provider of providers) {
      if (modelsByProvider[provider] || modelsLoading[provider]) continue;
      setModelsLoading((prev) => ({ ...prev, [provider]: true }));
      void authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/models`)
        .then(async (res) => {
          const body = (await res.json()) as {
            success?: boolean;
            data?: {
              models?: {
                OPTIONS?: Array<{ value: string; label?: string }>;
                DEFAULT?: string;
              };
            };
          };
          const options = Array.isArray(body?.data?.models?.OPTIONS)
            ? body.data!.models!.OPTIONS!.map((m) => ({
                value: m.value,
                label: m.label || m.value,
              }))
            : [];
          if (cancelled) return;
          setModelsByProvider((prev) => ({ ...prev, [provider]: options }));
          const defaultModel =
            body?.data?.models?.DEFAULT &&
            options.some((o) => o.value === body.data!.models!.DEFAULT)
              ? body.data!.models!.DEFAULT!
              : options[0]?.value ?? null;
          if (defaultModel) {
            setRoster((prev) =>
              prev.map((seat) => {
                if ((seat.provider || 'claude') !== provider) return seat;
                if (seat.model && options.some((o) => o.value === seat.model)) return seat;
                return { ...seat, model: defaultModel };
              }),
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setModelsLoading((prev) => ({ ...prev, [provider]: false }));
          }
        });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster.map((s) => s.provider || 'claude').join('|')]);

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

      // Clear model + clamp permissions when provider changes.
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

  const start = async () => {
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
    setBusy(true);
    setError(null);
    try {
      const ordered = [
        ...roster.filter((a) => a.kind === 'orchestrator'),
        ...roster.filter((a) => a.kind !== 'orchestrator'),
      ].map((seat) => ({
        ...seat,
        permissionMode: clampPermissionMode(
          seat.provider || 'claude',
          seat.permissionMode,
          permModesByProvider,
        ),
      }));
      const payload = await requestJson<{ swarm?: SwarmRun }>('/api/swarm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          goal: goal.trim(),
          agents: ordered,
          skills: selectedSkills,
          requireApproval: false,
          requirePlanApproval,
          stepTimeoutMs: stepTimeoutMs > 0 ? stepTimeoutMs : undefined,
          maxConcurrency: maxConcurrency > 0 ? maxConcurrency : undefined,
        }),
      });
      if (payload.swarm) {
        setExpanded(payload.swarm.swarm_id);
        setHistoryFilter('active');
        setTab('history');
        setGoal('');
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start swarm.');
    } finally {
      setBusy(false);
    }
  };

  const act = async (
    swarmId: string,
    action: 'approve' | 'reject' | 'approve-plan' | 'reject-plan' | 'abort',
  ) => {
    setBusy(true);
    setError(null);
    try {
      await requestJson(`/api/swarm/${encodeURIComponent(swarmId)}/${action}`, {
        method: 'POST',
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${action} swarm.`);
    } finally {
      setBusy(false);
    }
  };

  const retryStep = async (swarmId: string, stepId: string) => {
    setBusy(true);
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
      setBusy(false);
    }
  };

  const archiveSwarm = async (swarmId: string, restore = false) => {
    setBusy(true);
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
      setBusy(false);
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
    workspaceId: string,
    branch: string | null,
    pushed: boolean,
  ) => {
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
    setBusy(true);
    setError(null);
    try {
      await requestJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteBranch: pushed }),
      });
      setCleanedWorkspaces((previous) =>
        previous.includes(workspaceId) ? previous : [...previous, workspaceId],
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not clean up the workspace.');
    } finally {
      setBusy(false);
    }
  };

  const deleteSwarm = async (swarmId: string, goalLabel: string) => {
    const ok = window.confirm(
      `Permanently delete this swarm?\n\n"${goalLabel.slice(0, 120)}${goalLabel.length > 120 ? '…' : ''}"\n\nThis cannot be undone.`,
    );
    if (!ok) return;
    setBusy(true);
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
      setBusy(false);
    }
  };

  const isLiveStatus = (status: string) =>
    ['queued', 'planning', 'awaiting_plan_approval', 'running', 'handing_off', 'awaiting_approval'].includes(status);

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
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
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
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-700 dark:text-red-300">
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
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Project
                  </label>
                  <select
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
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Goal
                  </label>
                  <textarea
                    className={`${fieldClass} min-h-[96px] resize-y`}
                    placeholder="What should this swarm accomplish?"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                  />
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
                            ? 'border-primary/40 bg-primary/8 shadow-sm'
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
                <div className="space-y-2">
                  <label className="block text-[11px] font-medium text-muted-foreground">
                    Per-step timeout (ms, 0 = none)
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      className={fieldClass}
                      value={stepTimeoutMs || ''}
                      placeholder="0"
                      onChange={(e) => setStepTimeoutMs(Number(e.target.value) || 0)}
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
                    Exactly one orchestrator. Add workers — they run in parallel waves.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(['explorer', 'implementer', 'reviewer'] as const).map((k) => (
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
              </div>

              <div className="space-y-3">
                {roster.map((seat, index) => {
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

                  return (
                    <div
                      key={seat.id || `${seat.label}-${index}`}
                      className={`overflow-hidden rounded-xl border shadow-sm transition ${
                        isOrch
                          ? 'border-primary/35 bg-gradient-to-br from-primary/8 via-primary/5 to-transparent'
                          : 'border-border/60 bg-card/60'
                      }`}
                    >
                      <div
                        className={`flex items-center justify-between gap-2 border-b px-3.5 py-2 ${
                          isOrch ? 'border-primary/15 bg-primary/5' : 'border-border/40 bg-muted/30'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
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
                            aria-label="Remove agent"
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
                            value={seat.effort || 'default'}
                            onChange={(e) => updateSeat(index, { effort: e.target.value })}
                          >
                            {SWARM_EFFORTS.map((e) => (
                              <option key={e} value={e}>
                                {e}
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
                disabled={busy}
                className="h-10 rounded-lg px-5 shadow-md"
              >
                <Network className="mr-1.5 h-4 w-4" />
                {busy ? 'Starting…' : 'Deploy Agent Swarm'}
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
              <div className="flex items-center gap-2 rounded-lg border border-sky-500/20 bg-sky-500/8 px-3 py-2 text-[11px] text-sky-800 dark:text-sky-200">
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
                  const live = isLiveStatus(swarm.status);
                  const archived = Boolean(swarm.archived_at);

                  return (
                    <div
                      key={swarm.swarm_id}
                      className={`overflow-hidden rounded-xl border bg-card/70 shadow-sm transition ${
                        open
                          ? 'border-primary/30 ring-1 ring-primary/15'
                          : 'border-border/60 hover:border-border'
                      }`}
                    >
                      <div className="flex items-stretch gap-0">
                        <button
                          type="button"
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
                                  {live ? (
                                    <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
                                  ) : null}
                                  {swarm.status.replace(/_/g, ' ')}
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
                              disabled={busy}
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
                              title={live ? 'Finish the swarm before archiving' : 'Archive'}
                              disabled={busy || live}
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
                            title={live ? 'Finish the swarm before deleting' : 'Delete permanently'}
                            disabled={busy || live}
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
                        <div className="space-y-4 border-t border-border/40 bg-muted/15 px-4 py-4 text-xs">
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
                                {(swarm.plan.steps ?? []).map((step) => (
                                  <li
                                    key={step.id}
                                    className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/80 px-2.5 py-1.5"
                                  >
                                    {step.status === 'succeeded' ? (
                                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                                    ) : step.status === 'failed' ? (
                                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                                    ) : ['running', 'planning', 'awaiting_plan_approval'].includes(
                                        swarm.status,
                                      ) ? (
                                      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-sky-500" />
                                    ) : (
                                      <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border border-border" />
                                    )}
                                    <span className="flex-1">
                                      <span className="font-medium text-foreground">{step.title}</span>
                                      <span className="text-muted-foreground">
                                        {' '}
                                        · {step.assignTo || step.kind}
                                        {step.wave != null ? ` · wave ${step.wave}` : ''}
                                        {step.status ? ` · ${step.status}` : ''}
                                      </span>
                                    </span>
                                    {step.status === 'failed' &&
                                    !isLiveStatus(swarm.status) ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-6 shrink-0 rounded-md px-2 text-[10px]"
                                        disabled={busy}
                                        onClick={() => void retryStep(swarm.swarm_id, step.id)}
                                      >
                                        <RefreshCw className="mr-1 h-3 w-3" />
                                        Retry
                                      </Button>
                                    ) : null}
                                  </li>
                                ))}
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
                                        {m.status}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground">
                                        {m.provider}
                                        {m.model ? ` / ${m.model}` : ''}
                                        {m.effort ? ` · ${m.effort}` : ''}
                                      </span>
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
                          {swarm.usage && swarm.usage.memberRuns.some((r) => r.tokens > 0 || r.costUsd > 0) ? (
                            <div>
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Usage
                              </div>
                              <div className="space-y-2 rounded-lg border border-border/40 bg-background/80 p-2.5">
                                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
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
                                {(swarm.blackboard ?? []).map((msg) => (
                                  <div key={msg.id} className="text-[11px]">
                                    <span className="font-medium text-foreground">{msg.from}</span>
                                    <span className="text-muted-foreground"> · {msg.kind}</span>
                                    <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                                      {msg.content.slice(0, 400)}
                                      {msg.content.length > 400 ? '…' : ''}
                                    </p>
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
                                const workspaceId =
                                  swarm.workspace_id || swarm.synthesis?.workspaceId || null;
                                if (!workspaceId || live) return null;
                                if (cleanedWorkspaces.includes(workspaceId)) {
                                  return (
                                    <div className="mt-2.5 border-t border-border/50 pt-2.5 text-[11px] text-muted-foreground">
                                      Worktree removed.
                                    </div>
                                  );
                                }
                                const branch =
                                  swarm.feature_branch || swarm.synthesis?.featureBranch || null;
                                const pushed = Boolean(swarm.pr_url || swarm.synthesis?.prUrl);
                                return (
                                  <div className="mt-2.5 flex items-center gap-2 border-t border-border/50 pt-2.5">
                                    <button
                                      type="button"
                                      disabled={busy}
                                      title={
                                        pushed
                                          ? 'Remove the worktree and local branch'
                                          : 'Remove the worktree (unpushed branch is kept)'
                                      }
                                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void cleanupWorkspace(workspaceId, branch, pushed);
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

                          {swarm.status === 'awaiting_plan_approval' ? (
                            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
                              <div className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">
                                Orchestrator plan is ready — review it below before any worker
                                agents run.
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  className="rounded-lg"
                                  onClick={() => void act(swarm.swarm_id, 'approve-plan')}
                                  disabled={busy}
                                >
                                  Approve plan & run
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="rounded-lg"
                                  onClick={() => void act(swarm.swarm_id, 'reject-plan')}
                                  disabled={busy}
                                >
                                  Reject plan
                                </Button>
                              </div>
                            </div>
                          ) : null}

                          {swarm.status === 'awaiting_approval' ? (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                className="rounded-lg"
                                onClick={() => void act(swarm.swarm_id, 'approve')}
                                disabled={busy}
                              >
                                Acknowledge handoff
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="rounded-lg"
                                onClick={() => void act(swarm.swarm_id, 'reject')}
                                disabled={busy}
                              >
                                Reject
                              </Button>
                            </div>
                          ) : null}

                          {/* Footer meta + actions */}
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3 text-[10px] text-muted-foreground">
                            <div className="font-mono">
                              {swarm.parent_run_id || swarm.swarm_id}
                              {swarm.feature_branch ? ` · ${swarm.feature_branch}` : ''}
                            </div>
                            <div className="flex gap-1">
                              {live ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 rounded-md text-[11px] text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
                                  disabled={busy}
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
                                  disabled={busy}
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
                                  disabled={busy || live}
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
                                disabled={busy || live}
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
