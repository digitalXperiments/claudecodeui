import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Pencil, Plus, ScrollText, Trash2 } from 'lucide-react';

import { Button, Input } from '../../../../shared/view/ui';
import { hooksApi, type CloudcliHook, type CloudcliHookInput } from '../../api/hooksApi';
import { AGENT_NAMES, AGENT_PROVIDERS } from '../../constants/constants';
import SettingsToggle from '../SettingsToggle';

const labelClass = 'text-xs font-medium text-muted-foreground';
const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[140px]';

type Draft = {
  name: string;
  instruction: string;
  enabled: boolean;
  provider: string;
};

const emptyDraft = (): Draft => ({
  name: '',
  instruction: '',
  enabled: true,
  provider: 'all',
});

function hookToDraft(hook: CloudcliHook): Draft {
  return {
    name: hook.name,
    instruction: hook.instruction,
    enabled: hook.enabled,
    provider: hook.provider || 'all',
  };
}

function draftToInput(draft: Draft): CloudcliHookInput {
  return {
    name: draft.name.trim(),
    instruction: draft.instruction,
    enabled: draft.enabled,
    event: 'session_start',
    provider: draft.provider || 'all',
  };
}

function providerLabel(provider: string): string {
  if (provider === 'all' || !provider) return 'All agents';
  return AGENT_NAMES[provider as keyof typeof AGENT_NAMES] ?? provider;
}

export default function HooksSettingsTab() {
  const { t } = useTranslation('settings');
  const [hooks, setHooks] = useState<CloudcliHook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHooks(await hooksApi.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setShowForm(true);
  };

  const openEdit = (hook: CloudcliHook) => {
    setEditingId(hook.id);
    setDraft(hookToDraft(hook));
    setShowForm(true);
  };

  const handleSave = async () => {
    const input = draftToInput(draft);
    if (!input.name) {
      setError('Name is required');
      return;
    }
    if (!input.instruction.trim()) {
      setError('Instruction is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await hooksApi.update(editingId, input);
      } else {
        await hooksApi.create(input);
      }
      setShowForm(false);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (hook: CloudcliHook) => {
    if (!window.confirm(`Delete hook "${hook.name}"?`)) return;
    try {
      await hooksApi.remove(hook.id);
      if (editingId === hook.id) {
        setShowForm(false);
        setEditingId(null);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggle = async (hook: CloudcliHook) => {
    try {
      await hooksApi.update(hook.id, { enabled: !hook.enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 items-start gap-3">
        <ScrollText className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-500" />
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-medium text-foreground">{t('hooksTab.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('hooksTab.description')}</p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {hooks.length} hook{hooks.length === 1 ? '' : 's'}
        </p>
        <Button type="button" size="sm" onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" />
          Add hook
        </Button>
      </div>

      {showForm && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className={labelClass}>Name</span>
              <Input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="House style"
              />
            </label>
            <label className="space-y-1">
              <span className={labelClass}>Agent filter</span>
              <select
                className={selectClass}
                value={draft.provider}
                onChange={(event) => setDraft((current) => ({ ...current, provider: event.target.value }))}
              >
                <option value="all">All agents</option>
                {AGENT_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {AGENT_NAMES[id]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block space-y-1">
            <span className={labelClass}>{t('hooksTab.instructionLabel')}</span>
            <textarea
              className={textareaClass}
              value={draft.instruction}
              onChange={(event) => setDraft((current) => ({ ...current, instruction: event.target.value }))}
              placeholder="Always prefer concise answers. Never invent file paths."
            />
          </label>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SettingsToggle
                checked={draft.enabled}
                onChange={(value) => setDraft((current) => ({ ...current, enabled: value }))}
                ariaLabel="Enable hook"
              />
              <span className="text-sm text-muted-foreground">{t('hooksTab.enabled')}</span>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                {editingId ? 'Save' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : hooks.length === 0 && !showForm ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center">
          <p className="text-sm font-medium text-foreground">{t('hooksTab.emptyTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('hooksTab.emptyBody')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/50">
          {hooks.map((hook) => (
            <li key={hook.id} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{hook.name}</span>
                  <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    /{hook.slug || t('hooksTab.slashBadge')}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{providerLabel(hook.provider)}</span>
                </div>
                <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {hook.instruction}
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <SettingsToggle
                  checked={hook.enabled}
                  onChange={() => void handleToggle(hook)}
                  ariaLabel={`Enable ${hook.name}`}
                />
                <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openEdit(hook)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-destructive"
                  onClick={() => void handleDelete(hook)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
