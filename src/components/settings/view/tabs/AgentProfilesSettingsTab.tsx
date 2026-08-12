import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2, Pencil, Plus, Power, Trash2, Wand2 } from 'lucide-react';

import { Button, Input } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../../../../types/app';
import { FALLBACK_PROVIDER_EFFORT_VALUES } from '../../../chat/constants/providerEffort';
import {
  agentProfilesApi,
  SWARM_PROFILE_LEVELS,
  SWARM_PROFILE_ROLES,
  type AgentRunProfile,
  type AgentRunProfileInput,
  type SwarmProfileLevel,
  type SwarmProfileRole,
} from '../../api/agentProfilesApi';
import { AGENT_NAMES, AGENT_PROVIDERS } from '../../constants/constants';

const PERMISSION_MODES = [
  { value: 'default', label: 'Default (guarded)' },
  { value: 'plan', label: 'Plan' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
];

const SWARM_ROLE_LABELS: Record<SwarmProfileRole, string> = {
  explorer: 'Explorer',
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  security: 'Security',
  docs: 'Docs',
};

/** What each capability tier means to the orchestrator when it assigns work. */
const SWARM_LEVEL_OPTIONS: Array<{ value: SwarmProfileLevel; label: string; hint: string }> = [
  { value: 'basic', label: 'Basic (1/3)', hint: 'Mechanical, well-specified, low-ambiguity work' },
  { value: 'medium', label: 'Medium (2/3)', hint: 'Ordinary feature work needing some judgement' },
  { value: 'advanced', label: 'Advanced (3/3)', hint: 'Architecture, subtle debugging, high-stakes review' },
];

const SWARM_LEVEL_SHORT: Record<SwarmProfileLevel, string> = {
  basic: 'Basic 1/3',
  medium: 'Medium 2/3',
  advanced: 'Advanced 3/3',
};

const SWARM_LEVEL_BADGE: Record<SwarmProfileLevel, string> = {
  basic: 'border-border bg-muted/60 text-muted-foreground',
  medium: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  advanced: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
};

const SWARM_LEVEL_HEADER_TEXT: Record<SwarmProfileLevel, string> = {
  basic: 'text-muted-foreground',
  medium: 'text-sky-700 dark:text-sky-300',
  advanced: 'text-violet-700 dark:text-violet-300',
};

// Strongest first: when scanning a role's roster, lead with what it can handle at its best.
const LEVEL_DISPLAY_ORDER: SwarmProfileLevel[] = ['advanced', 'medium', 'basic'];

const labelClass = 'text-xs font-medium text-muted-foreground';
const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

type Draft = {
  name: string;
  description: string;
  provider: LLMProvider;
  model: string;
  effort: string;
  permissionMode: string;
  permissionIntent: string;
  allowedText: string;
  disallowedText: string;
  swarmRoles: SwarmProfileRole[];
  swarmLevel: SwarmProfileLevel;
};

const emptyDraft = (provider: LLMProvider = 'claude'): Draft => ({
  name: '',
  description: '',
  provider,
  model: '',
  effort: 'default',
  permissionMode: 'acceptEdits',
  permissionIntent: '',
  allowedText: '',
  disallowedText: '',
  swarmRoles: [],
  swarmLevel: 'medium',
});

function profileToDraft(profile: AgentRunProfile): Draft {
  return {
    name: profile.name,
    description: profile.description ?? '',
    provider: (profile.provider as LLMProvider) || 'claude',
    model: profile.model ?? '',
    effort: profile.effort ?? 'default',
    permissionMode: profile.permission_mode || 'default',
    permissionIntent: profile.permission_intent ?? '',
    allowedText: (profile.tools?.allowedCommands ?? []).join('\n'),
    disallowedText: (profile.tools?.disallowedCommands ?? []).join('\n'),
    swarmRoles: profile.swarm_roles ?? [],
    swarmLevel: profile.swarm_level ?? 'medium',
  };
}

function linesToList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function draftToInput(draft: Draft): AgentRunProfileInput {
  const allowed = linesToList(draft.allowedText);
  const disallowed = linesToList(draft.disallowedText);
  return {
    name: draft.name.trim(),
    description: draft.description,
    provider: draft.provider,
    model: draft.model.trim() || null,
    effort: draft.effort === 'default' || !draft.effort ? null : draft.effort,
    permissionMode: draft.permissionMode,
    permissionIntent: draft.permissionIntent,
    tools: {
      allowedCommands: allowed,
      disallowedCommands: disallowed,
    },
    swarmRoles: draft.swarmRoles,
    swarmLevel: draft.swarmLevel,
  };
}

function profileSummary(profile: AgentRunProfile): string {
  const bits = [
    AGENT_NAMES[profile.provider as LLMProvider] || profile.provider,
    profile.model || 'default model',
    profile.effort || 'default effort',
    profile.permission_mode,
  ];
  return bits.join(' · ');
}

export default function AgentProfilesSettingsTab() {
  const [profiles, setProfiles] = useState<AgentRunProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [modelsByProvider, setModelsByProvider] = useState<
    Partial<Record<LLMProvider, ProviderModelOption[]>>
  >({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [compileNote, setCompileNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await agentProfilesApi.list();
      setProfiles(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Load models for the selected provider from the real catalog API.
  // Response shape: { success, data: { models: { OPTIONS, DEFAULT }, cache } }
  useEffect(() => {
    if (!showForm) return;
    const provider = draft.provider;
    let cancelled = false;
    setModelsLoading(true);
    (async () => {
      try {
        const res = await authenticatedFetch(`/api/providers/${provider}/models`);
        if (!res.ok) {
          if (!cancelled) setModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
          return;
        }
        const body = (await res.json()) as {
          success?: boolean;
          data?: { models?: ProviderModelsDefinition };
          models?: ProviderModelsDefinition;
        };
        const definition = body?.data?.models ?? body?.models;
        const options = Array.isArray(definition?.OPTIONS) ? definition.OPTIONS : [];
        if (!cancelled) {
          setModelsByProvider((prev) => ({ ...prev, [provider]: options }));
          // Auto-select catalog default when the draft has no model yet.
          setDraft((d) => {
            if (d.provider !== provider || d.model) return d;
            const defaultModel = definition?.DEFAULT ?? '';
            if (defaultModel && options.some((m) => m.value === defaultModel)) {
              return { ...d, model: defaultModel };
            }
            if (options[0]?.value) {
              return { ...d, model: options[0].value };
            }
            return d;
          });
        }
      } catch {
        if (!cancelled) setModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draft.provider, showForm]);

  const effortOptions = useMemo(() => {
    const fromModel = modelsByProvider[draft.provider]?.find((m) => m.value === draft.model)?.effort
      ?.values;
    if (fromModel && fromModel.length > 0) {
      return fromModel.map((v) => v.value);
    }
    return FALLBACK_PROVIDER_EFFORT_VALUES[draft.provider] ?? [];
  }, [draft.model, draft.provider, modelsByProvider]);

  const openCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setShowForm(true);
    setError(null);
    setCompileNote(null);
  };

  const openEdit = (profile: AgentRunProfile) => {
    setEditingId(profile.profile_id);
    setDraft(profileToDraft(profile));
    setShowForm(true);
    setError(null);
    setCompileNote(null);
  };

  const handleCompile = async () => {
    if (!draft.permissionIntent.trim()) return;
    setCompiling(true);
    setError(null);
    setCompileNote(null);
    try {
      const compiled = await agentProfilesApi.compilePermissions(draft.permissionIntent);
      setDraft((prev) => ({
        ...prev,
        allowedText: compiled.allowedCommands.join('\n'),
        disallowedText: compiled.disallowedCommands.join('\n'),
        permissionMode: compiled.suggestedMode || prev.permissionMode,
      }));
      const sourceLabel =
        compiled.source === 'claude'
          ? 'Claude'
          : compiled.source === 'fallback'
            ? 'Fallback'
            : 'Compiler';
      const note =
        compiled.note ||
        `${sourceLabel} → ${compiled.allowedCommands.length} allow, ${compiled.disallowedCommands.length} deny. Review before saving.`;
      setCompileNote(note);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compile permissions');
    } finally {
      setCompiling(false);
    }
  };

  const handleSave = async () => {
    if (!draft.name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = draftToInput(draft);
      if (editingId) {
        await agentProfilesApi.update(editingId, input);
      } else {
        await agentProfilesApi.create(input);
      }
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (profile: AgentRunProfile) => {
    setError(null);
    try {
      await agentProfilesApi.update(profile.profile_id, { enabled: !profile.enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    }
  };

  const handleDelete = async (profileId: string) => {
    if (!window.confirm('Delete this agent profile? Tasks using it will fall back to stored providers.')) {
      return;
    }
    setError(null);
    try {
      await agentProfilesApi.remove(profileId);
      if (editingId === profileId) {
        setShowForm(false);
        setEditingId(null);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
    }
  };

  const modelOptions = modelsByProvider[draft.provider] ?? [];

  const roleSections = useMemo(() => {
    return SWARM_PROFILE_ROLES.map((role) => {
      const roleProfiles = profiles.filter((p) => p.swarm_roles?.includes(role));
      const byLevel = LEVEL_DISPLAY_ORDER.map((level) => ({
        level,
        profiles: roleProfiles
          .filter((p) => (p.swarm_level ?? 'medium') === level)
          .sort((a, b) => a.name.localeCompare(b.name)),
      })).filter((group) => group.profiles.length > 0);
      return { role, count: roleProfiles.length, byLevel };
    }).filter((section) => section.count > 0);
  }, [profiles]);

  const unassignedProfiles = useMemo(
    () =>
      profiles
        .filter((p) => !p.swarm_roles || p.swarm_roles.length === 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [profiles],
  );

  const renderProfileItem = (profile: AgentRunProfile, groupKey: string) => (
    <li
      key={`${groupKey}-${profile.profile_id}`}
      className="flex items-start justify-between gap-3 px-3 py-3 hover:bg-accent/40"
    >
      <div className={`min-w-0 ${profile.enabled ? '' : 'opacity-50'}`}>
        <p className="truncate text-sm font-medium text-foreground">
          {profile.name}
          {!profile.enabled ? (
            <span className="ml-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              Disabled
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">{profileSummary(profile)}</p>
        {profile.description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/80">{profile.description}</p>
        ) : null}
        {(profile.swarm_roles?.length ?? 0) > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {profile.swarm_roles.map((role) => (
              <span
                key={role}
                className="rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                Swarm: {SWARM_ROLE_LABELS[role] ?? role}
              </span>
            ))}
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${SWARM_LEVEL_BADGE[profile.swarm_level ?? 'medium']}`}
            >
              {SWARM_LEVEL_SHORT[profile.swarm_level ?? 'medium']}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className={`h-8 w-8 p-0 ${profile.enabled ? 'text-emerald-600 hover:text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
          onClick={() => void handleToggleEnabled(profile)}
          aria-label={profile.enabled ? `Disable ${profile.name}` : `Enable ${profile.name}`}
          title={
            profile.enabled
              ? 'Enabled — click to exclude from swarm auto-selection'
              : 'Disabled — click to make available to swarms again'
          }
        >
          <Power className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => openEdit(profile)}
          aria-label={`Edit ${profile.name}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
          onClick={() => void handleDelete(profile.profile_id)}
          aria-label={`Delete ${profile.name}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Agent profiles</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Named run configs (provider, model, effort, permissions) you can assign to Kanban
            implement or review agents — e.g. “Claude High Effort” or “Grok Low Effort”.
          </p>
        </div>
        <Button size="sm" onClick={openCreate} className="shrink-0">
          <Plus className="mr-1 h-4 w-4" />
          New profile
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {showForm ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-foreground">
              {editingId ? 'Edit profile' : 'New profile'}
            </h4>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
              }}
            >
              Cancel
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className={labelClass} htmlFor="profile-name">
                Name
              </label>
              <Input
                id="profile-name"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="e.g. Sonnet High Effort"
              />
            </div>

            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className={labelClass} htmlFor="profile-desc">
                Description
              </label>
              <Input
                id="profile-desc"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="Optional short description"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="profile-provider">
                Provider
              </label>
              <select
                id="profile-provider"
                className={selectClass}
                value={draft.provider}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    provider: e.target.value as LLMProvider,
                    model: '',
                    effort: 'default',
                  }))
                }
              >
                {AGENT_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {AGENT_NAMES[p]}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="profile-model">
                Model
              </label>
              <select
                id="profile-model"
                className={selectClass}
                value={draft.model}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value, effort: 'default' }))}
                disabled={modelsLoading}
              >
                {modelsLoading ? (
                  <option value="">Loading models…</option>
                ) : modelOptions.length === 0 ? (
                  <option value="">No models available for this provider</option>
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
              {!modelsLoading && modelOptions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  Sign in to this provider or refresh models from chat if the list is empty.
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="profile-effort">
                Effort
              </label>
              <select
                id="profile-effort"
                className={selectClass}
                value={draft.effort}
                onChange={(e) => setDraft((d) => ({ ...d, effort: e.target.value }))}
                disabled={effortOptions.length === 0}
              >
                <option value="default">Default</option>
                {effortOptions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="profile-perm-mode">
                Permission mode
              </label>
              <select
                id="profile-perm-mode"
                className={selectClass}
                value={draft.permissionMode}
                onChange={(e) => setDraft((d) => ({ ...d, permissionMode: e.target.value }))}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1 sm:col-span-2">
              <span className={labelClass}>Swarm roles</span>
              <div className="flex flex-wrap gap-4">
                {SWARM_PROFILE_ROLES.map((role) => (
                  <label
                    key={role}
                    className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input accent-primary"
                      checked={draft.swarmRoles.includes(role)}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          swarmRoles: e.target.checked
                            ? [...d.swarmRoles, role]
                            : d.swarmRoles.filter((r) => r !== role),
                        }))
                      }
                    />
                    {SWARM_ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Roles this profile may serve when the Agent Swarm orchestrator auto-selects its
                roster. Leave all unchecked to keep it out of swarms.
              </p>
            </div>

            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className={labelClass} htmlFor="profile-swarm-level">
                Capability level
              </label>
              <select
                id="profile-swarm-level"
                className={selectClass}
                value={draft.swarmLevel}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, swarmLevel: e.target.value as SwarmProfileLevel }))
                }
              >
                {SWARM_LEVEL_OPTIONS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {level.label} — {level.hint}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                How capable this agent is. The orchestrator rates each task's difficulty and only
                assigns it to an agent at that level or higher — and escalates to a stronger agent
                when a task has to be retried.
              </p>
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-border/80 bg-background/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <label className={labelClass} htmlFor="profile-intent">
                Permissions in plain English
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleCompile()}
                disabled={compiling || !draft.permissionIntent.trim()}
              >
                {compiling ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wand2 className="mr-1 h-3.5 w-3.5" />
                )}
                {compiling ? 'Asking Claude…' : 'Compile with Claude'}
              </Button>
            </div>
            <textarea
              id="profile-intent"
              className={textareaClass}
              rows={2}
              value={draft.permissionIntent}
              onChange={(e) => {
                setCompileNote(null);
                setDraft((d) => ({ ...d, permissionIntent: e.target.value }));
              }}
              placeholder="e.g. Allow git and npm tests; read project files; deny rm and network"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <strong className="font-medium text-foreground/80">How it works:</strong> your intent
              is sent to <strong className="font-medium text-foreground/80">Claude (Haiku)</strong>{' '}
              using your existing Claude login. Claude returns allow/deny tool rules (and optionally
              a permission mode). Always review the lists below before saving — you can edit them by
              hand. If Claude is signed out or fails, a simple keyword fallback is used instead.
            </p>
            {compileNote ? (
              <p className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-foreground">
                {compileNote}
              </p>
            ) : null}

            <div className="grid gap-3 pt-1 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="profile-allowed">
                  Allowed tools / commands
                </label>
                <textarea
                  id="profile-allowed"
                  className={textareaClass}
                  rows={4}
                  value={draft.allowedText}
                  onChange={(e) => setDraft((d) => ({ ...d, allowedText: e.target.value }))}
                  placeholder="One per line, e.g. Bash(git*)"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="profile-disallowed">
                  Disallowed tools / commands
                </label>
                <textarea
                  id="profile-disallowed"
                  className={textareaClass}
                  rows={4}
                  value={draft.disallowedText}
                  onChange={(e) => setDraft((d) => ({ ...d, disallowedText: e.target.value }))}
                  placeholder="One per line, e.g. Bash(rm*)"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {editingId ? 'Save changes' : 'Create profile'}
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading profiles…
        </div>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No profiles yet. Create one to use it in Kanban implement/review.
        </p>
      ) : (
        <div className="space-y-3">
          {roleSections.map((section) => (
            <details key={section.role} open className="group rounded-lg border border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 select-none">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                  {SWARM_ROLE_LABELS[section.role]}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                  {section.count}
                </span>
              </summary>
              <div className="border-t border-border">
                {section.byLevel.map((levelGroup) => (
                  <div key={levelGroup.level}>
                    <p
                      className={`px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide ${SWARM_LEVEL_HEADER_TEXT[levelGroup.level]}`}
                    >
                      {SWARM_LEVEL_SHORT[levelGroup.level]} · {levelGroup.profiles.length}
                    </p>
                    <ul className="divide-y divide-border">
                      {levelGroup.profiles.map((profile) => renderProfileItem(profile, section.role))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          ))}

          {unassignedProfiles.length > 0 ? (
            <details className="group rounded-lg border border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 select-none">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                  No swarm role assigned
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                  {unassignedProfiles.length}
                </span>
              </summary>
              <ul className="divide-y divide-border border-t border-border">
                {unassignedProfiles.map((profile) => renderProfileItem(profile, 'unassigned'))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
