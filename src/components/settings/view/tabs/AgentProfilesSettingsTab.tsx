import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Pencil, Plus, Power, Search, ShieldCheck, Trash2, Wand2 } from 'lucide-react';

import { Button, Input } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { FALLBACK_PROVIDER_EFFORT_VALUES } from '../../../chat/constants/providerEffort';
import {
  agentProfilesApi,
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

type ProfileFilter = 'all' | 'enabled' | 'swarm';

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

export default function AgentProfilesSettingsTab() {
  const [profiles, setProfiles] = useState<AgentRunProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProfileFilter>('all');
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
      setSelectedProfileId((current) =>
        current && list.some((profile) => profile.profile_id === current)
          ? current
          : list[0]?.profile_id ?? null,
      );
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
    setSelectedProfileId(null);
    setDraft(emptyDraft());
    setShowForm(true);
    setError(null);
    setCompileNote(null);
  };

  const openEdit = (profile: AgentRunProfile) => {
    setEditingId(profile.profile_id);
    setSelectedProfileId(profile.profile_id);
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
      const saved = editingId
        ? await agentProfilesApi.update(editingId, input)
        : await agentProfilesApi.create(input);
      setShowForm(false);
      setEditingId(null);
      setSelectedProfileId(saved.profile_id);
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

  const selectedProfile = profiles.find((profile) => profile.profile_id === selectedProfileId) ?? null;
  const filteredProfiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return profiles
      .filter((profile) => {
        if (filter === 'enabled' && !profile.enabled) return false;
        if (filter === 'swarm' && (profile.swarm_roles?.length ?? 0) === 0) return false;
        if (!normalizedQuery) return true;
        const searchable = [
          profile.name,
          profile.description,
          profile.provider,
          profile.model ?? '',
          ...(profile.swarm_roles ?? []),
        ].join(' ').toLowerCase();
        return searchable.includes(normalizedQuery);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filter, profiles, query]);

  const profileFilterLabel = (id: ProfileFilter) => {
    if (id === 'enabled') return `Enabled ${profiles.filter((profile) => profile.enabled).length}`;
    if (id === 'swarm') return `Swarm ${profiles.filter((profile) => (profile.swarm_roles?.length ?? 0) > 0).length}`;
    return `All ${profiles.length}`;
  };

  const renderProfileListItem = (profile: AgentRunProfile) => {
    const provider = profile.provider as LLMProvider;
    return (
      <button
        key={profile.profile_id}
        type="button"
        onClick={() => {
          setSelectedProfileId(profile.profile_id);
          setShowForm(false);
          setEditingId(null);
        }}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
          selectedProfileId === profile.profile_id && !showForm
            ? 'bg-muted text-foreground'
            : 'text-foreground hover:bg-muted/60',
          !profile.enabled && 'opacity-60',
        )}
        aria-current={selectedProfileId === profile.profile_id && !showForm ? 'true' : undefined}
      >
        <SessionProviderLogo provider={provider} className="h-4 w-4 flex-shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{profile.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {AGENT_NAMES[provider] ?? profile.provider} · {profile.model || 'Provider default'}
          </span>
        </span>
        <span
          className={cn(
            'h-1.5 w-1.5 flex-shrink-0 rounded-full',
            profile.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30',
          )}
          title={profile.enabled ? 'Enabled' : 'Disabled'}
        />
      </button>
    );
  };

  const renderProfileForm = () => (
    <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {editingId ? 'Edit profile' : 'Create profile'}
              </p>
              <h3 className="mt-0.5 text-lg font-semibold text-foreground">
                {draft.name || 'New agent profile'}
              </h3>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
                if (!selectedProfileId && profiles[0]) setSelectedProfileId(profiles[0].profile_id);
              }}
            >
              Cancel
            </Button>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">
              Save reusable provider, model, effort, permission, and swarm-routing settings in one place.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className={labelClass} htmlFor="profile-name">Name</label>
              <Input
                id="profile-name"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="e.g. Sonnet High Effort"
              />
            </div>

            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className={labelClass} htmlFor="profile-desc">Description</label>
              <Input
                id="profile-desc"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="Optional short description"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="profile-provider">Provider</label>
              <select
                id="profile-provider"
                className={selectClass}
                value={draft.provider}
                onChange={(e) => setDraft((d) => ({
                  ...d,
                  provider: e.target.value as LLMProvider,
                  model: '',
                  effort: 'default',
                }))}
              >
                {AGENT_PROVIDERS.map((provider) => (
                  <option key={provider} value={provider}>{AGENT_NAMES[provider]}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="profile-model">Model</label>
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
                    {modelOptions.map((model) => (
                      <option key={model.value} value={model.value}>{model.label}</option>
                    ))}
                  </>
                )}
              </select>
              {!modelsLoading && modelOptions.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Sign in to this provider or refresh models from chat if the list is empty.</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="profile-effort">Effort</label>
              <select
                id="profile-effort"
                className={selectClass}
                value={draft.effort}
                onChange={(e) => setDraft((d) => ({ ...d, effort: e.target.value }))}
                disabled={effortOptions.length === 0}
              >
                <option value="default">Default</option>
                {effortOptions.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className={labelClass} htmlFor="profile-perm-mode">Permission mode</label>
              <select
                id="profile-perm-mode"
                className={selectClass}
                value={draft.permissionMode}
                onChange={(e) => setDraft((d) => ({ ...d, permissionMode: e.target.value }))}
              >
                {PERMISSION_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1 sm:col-span-2">
              <span className={labelClass}>Swarm roles</span>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {SWARM_PROFILE_ROLES.map((role) => (
                  <label key={role} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input accent-primary"
                      checked={draft.swarmRoles.includes(role)}
                      onChange={(e) => setDraft((d) => ({
                        ...d,
                        swarmRoles: e.target.checked
                          ? [...d.swarmRoles, role]
                          : d.swarmRoles.filter((currentRole) => currentRole !== role),
                      }))}
                    />
                    {SWARM_ROLE_LABELS[role]}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">Leave all unchecked to keep this profile out of automatic swarms.</p>
            </div>

            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className={labelClass} htmlFor="profile-swarm-level">Capability level</label>
              <select
                id="profile-swarm-level"
                className={selectClass}
                value={draft.swarmLevel}
                onChange={(e) => setDraft((d) => ({ ...d, swarmLevel: e.target.value as SwarmProfileLevel }))}
              >
                {SWARM_LEVEL_OPTIONS.map((level) => <option key={level.value} value={level.value}>{level.label} — {level.hint}</option>)}
              </select>
              <p className="text-[11px] text-muted-foreground">The orchestrator only assigns work at this level or lower, and escalates on retries.</p>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <label className={labelClass} htmlFor="profile-intent">Permissions in plain English</label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleCompile()}
                disabled={compiling || !draft.permissionIntent.trim()}
              >
                {compiling ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wand2 className="mr-1 h-3.5 w-3.5" />}
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
            <p className="text-[11px] leading-relaxed text-muted-foreground">Claude returns allow/deny tool rules that you can review and edit below. If Claude is signed out, a keyword fallback is used.</p>
            {compileNote ? <p className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-foreground">{compileNote}</p> : null}
            <div className="grid gap-3 pt-1 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className={labelClass} htmlFor="profile-allowed">Allowed tools / commands</label>
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
                <label className={labelClass} htmlFor="profile-disallowed">Disallowed tools / commands</label>
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

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {editingId ? 'Save changes' : 'Create profile'}
            </Button>
          </div>
        </div>
  );

  const renderProfileOverview = (profile: AgentRunProfile) => {
    const provider = profile.provider as LLMProvider;
    const allowed = profile.tools?.allowedCommands ?? [];
    const disallowed = profile.tools?.disallowedCommands ?? [];
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-muted/40">
              <SessionProviderLogo provider={provider} className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-lg font-semibold text-foreground">{profile.name}</h3>
                <span className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  profile.enabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
                )}>{profile.enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{profile.description || 'No description added'}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-8 w-8 p-0', profile.enabled ? 'text-emerald-600 hover:text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}
              onClick={() => void handleToggleEnabled(profile)}
              aria-label={profile.enabled ? `Disable ${profile.name}` : `Enable ${profile.name}`}
              title={profile.enabled ? 'Disable profile' : 'Enable profile'}
            ><Power className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" onClick={() => openEdit(profile)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit profile
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
              onClick={() => void handleDelete(profile.profile_id)}
              aria-label={`Delete ${profile.name}`}
              title="Delete profile"
            ><Trash2 className="h-4 w-4" /></Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Runtime configuration</p>
            <p className="mt-2 text-sm font-medium text-foreground">{AGENT_NAMES[provider] ?? profile.provider}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{profile.model || 'Provider default'} · {profile.effort || 'default effort'}</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Permissions</p>
            <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-foreground"><ShieldCheck className="h-4 w-4 text-primary" />{PERMISSION_MODES.find((mode) => mode.value === profile.permission_mode)?.label ?? profile.permission_mode}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{allowed.length} allowed · {disallowed.length} blocked rules</p>
          </div>
        </div>

        <section className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2.5">
            <h4 className="text-sm font-medium text-foreground">Swarm routing</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">Where the orchestrator can use this profile automatically.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 p-3">
            {(profile.swarm_roles?.length ?? 0) > 0 ? profile.swarm_roles.map((role) => (
              <span key={role} className="rounded-full border border-border bg-muted/60 px-2 py-1 text-xs text-muted-foreground">{SWARM_ROLE_LABELS[role]}</span>
            )) : <span className="text-sm text-muted-foreground">Not assigned to automatic swarms</span>}
            {(profile.swarm_roles?.length ?? 0) > 0 ? (
              <span className={`rounded-full border px-2 py-1 text-xs font-medium ${SWARM_LEVEL_BADGE[profile.swarm_level ?? 'medium']}`}>{SWARM_LEVEL_SHORT[profile.swarm_level ?? 'medium']}</span>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2.5">
            <h4 className="text-sm font-medium text-foreground">Tool rules</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">Review the exact allow and deny lists saved with this profile.</p>
          </div>
          <div className="grid gap-3 p-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">Allowed</p>
              {allowed.length > 0 ? <ul className="space-y-1">{allowed.map((rule) => <li key={rule} className="flex gap-1.5 text-xs text-muted-foreground"><Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />{rule}</li>)}</ul> : <p className="text-xs text-muted-foreground">No explicit allow rules</p>}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-rose-700 dark:text-rose-300">Blocked</p>
              {disallowed.length > 0 ? <ul className="space-y-1">{disallowed.map((rule) => <li key={rule} className="flex gap-1.5 text-xs text-muted-foreground"><span className="mt-0.5 text-rose-500">×</span>{rule}</li>)}</ul> : <p className="text-xs text-muted-foreground">No explicit blocked rules</p>}
            </div>
          </div>
        </section>
      </div>
    );
  };

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[500px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2">
      <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-border px-3 py-3 md:px-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground">Agent profiles</h3>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Reusable provider, model, effort, and permission presets for Kanban and Agent Swarm runs.</p>
        </div>
        <Button size="sm" onClick={openCreate} className="shrink-0">
          <Plus className="mr-1 h-4 w-4" /> New profile
        </Button>
      </div>

      {error ? <div className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive md:mx-4">{error}</div> : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
        <aside className="flex max-h-64 flex-shrink-0 flex-col border-b border-border bg-muted/20 md:max-h-none md:w-56 md:border-b-0 md:border-r">
          <div className="flex-shrink-0 space-y-2 p-2 md:p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search profiles" aria-label="Search profiles" className="h-8 bg-background pl-8 text-sm shadow-none" />
            </div>
            <div className="flex flex-wrap gap-1">
              {(['all', 'enabled', 'swarm'] as ProfileFilter[]).map((id) => (
                <button key={id} type="button" onClick={() => setFilter(id)} className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors', filter === id ? 'border-foreground bg-foreground text-background' : 'border-border bg-background text-muted-foreground hover:text-foreground')}>
                  {profileFilterLabel(id)}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 md:px-2">
            {loading ? <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading profiles…</div> : filteredProfiles.length === 0 ? <p className="px-2 py-3 text-xs text-muted-foreground">{profiles.length === 0 ? 'No profiles yet.' : 'No profiles match this filter.'}</p> : filteredProfiles.map(renderProfileListItem)}
          </div>
        </aside>

        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-5">
          {showForm ? renderProfileForm() : selectedProfile ? renderProfileOverview(selectedProfile) : (
            <div className="flex min-h-[360px] flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted"><Plus className="h-5 w-5 text-muted-foreground" /></div>
              <h3 className="mt-3 text-sm font-semibold text-foreground">Create your first profile</h3>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">Save a named configuration once, then reuse it anywhere you assign an agent.</p>
              <Button size="sm" className="mt-4" onClick={openCreate}><Plus className="mr-1 h-4 w-4" />New profile</Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
