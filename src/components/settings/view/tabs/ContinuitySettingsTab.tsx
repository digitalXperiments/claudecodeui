import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

import type { LLMProvider } from '../../../../types/app';
import {
  fetchContinuityDefaults,
  updateContinuityDefaults,
} from '../../../chat/api/continuityApi';
import type {
  ContinuityMode,
  ContinuityPolicySettings,
} from '../../../chat/types/continuity';
import {
  CONTINUITY_NUMBER_LIMITS,
  clampContinuityInteger,
  modeUsesFallback,
  moveFallbackProvider,
  normalizeContinuitySettings,
  toggleFallbackProvider,
} from '../../utils/continuitySettings';
import type { ContinuityNumericSetting } from '../../utils/continuitySettings';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

const PROVIDERS: Array<{ id: LLMProvider; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'grok', label: 'Grok' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'kilo', label: 'Kilo Code' },
  { id: 'cline', label: 'Cline' },
  { id: 'qwencode', label: 'Qwen Code' },
  { id: 'pi', label: 'Pi' },
  { id: 'omp', label: 'Oh My Pi' },
  { id: 'antigravity', label: 'Antigravity' },
];

const MODES: Array<{ id: ContinuityMode; label: string; description: string }> = [
  { id: 'off', label: 'Off', description: 'Stop when the current provider reaches its limit.' },
  { id: 'wait', label: 'Wait & resume', description: 'Resume with the same provider once usage shows remaining quota.' },
  { id: 'smart', label: 'Smart continue', description: 'Wait for short resets, otherwise use the fallback order.' },
  { id: 'switch', label: 'Switch immediately', description: 'Hand off as soon as a provider limit is detected.' },
  { id: 'ask', label: 'Ask me', description: 'Pause and surface recovery actions for you to choose.' },
];

const inputClass = 'h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring';

type ContinuitySettingsViewProps = {
  defaults: ContinuityPolicySettings | null;
  loading: boolean;
  saving: boolean;
  message: string | null;
  error: string | null;
  onPatch: (value: Partial<ContinuityPolicySettings>) => void;
  onSave: () => void;
};

function providerLabel(provider: LLMProvider): string {
  return PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider;
}

export function ContinuitySettingsView({
  defaults,
  loading,
  saving,
  message,
  error,
  onPatch,
  onSave,
}: ContinuitySettingsViewProps) {
  if (loading) {
    return <div role="status" className="flex min-h-48 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading continuity defaults…</div>;
  }

  if (!defaults) {
    return <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error ?? 'Continuity defaults are unavailable.'}</div>;
  }

  const patchNumber = (setting: ContinuityNumericSetting, value: number) => {
    const limits = CONTINUITY_NUMBER_LIMITS[setting];
    onPatch({
      [setting]: clampContinuityInteger(value, defaults[setting], limits.min, limits.max),
    });
  };

  const usesFallback = modeUsesFallback(defaults.mode);
  const missingRequiredFallback = (
    defaults.mode === 'smart' || defaults.mode === 'switch'
  ) && defaults.fallbackProviders.length === 0;

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Continuity"
        description="Choose how new and policy-less chats recover when a provider reaches a usage limit. A chat-specific choice still takes precedence."
      >
        <SettingsCard className="p-2">
          <div className="grid gap-1 lg:grid-cols-5">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                disabled={saving}
                aria-pressed={defaults.mode === mode.id}
                onClick={() => onPatch({ mode: mode.id })}
                className={`flex min-h-24 items-start gap-2 rounded-lg p-3 text-left transition-colors ${defaults.mode === mode.id ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-muted/70'}`}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{defaults.mode === mode.id && <Check className="h-4 w-4 text-primary" />}</span>
                <span><span className="block text-sm font-medium">{mode.label}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{mode.description}</span></span>
              </button>
            ))}
          </div>
        </SettingsCard>
      </SettingsSection>

      {usesFallback && (
        <SettingsSection
          title="Fallback order"
          description="Select providers CloudCLI may hand work to. Selected providers are tried from top to bottom."
        >
          <SettingsCard className="grid gap-4 p-4 lg:grid-cols-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PROVIDERS.map((provider) => {
                const selected = defaults.fallbackProviders.includes(provider.id);
                return (
                  <button
                    key={provider.id}
                    type="button"
                    disabled={saving}
                    aria-pressed={selected}
                    onClick={() => onPatch({
                      fallbackProviders: toggleFallbackProvider(defaults.fallbackProviders, provider.id),
                    })}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${selected ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`}
                  >
                    {provider.label}
                  </button>
                );
              })}
            </div>
            <div className="space-y-1 rounded-lg bg-muted/30 p-2">
              {defaults.fallbackProviders.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No fallback providers selected.</p>
              ) : defaults.fallbackProviders.map((provider, index) => (
                <div key={provider} className="flex items-center gap-2 rounded-md bg-background px-3 py-2 text-sm">
                  <span className="w-5 text-xs text-muted-foreground">{index + 1}</span>
                  <span className="flex-1 font-medium">{providerLabel(provider)}</span>
                  <button type="button" disabled={saving || index === 0} onClick={() => onPatch({ fallbackProviders: moveFallbackProvider(defaults.fallbackProviders, index, -1) })} aria-label={`Move ${providerLabel(provider)} up`} className="rounded p-1 hover:bg-muted disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                  <button type="button" disabled={saving || index === defaults.fallbackProviders.length - 1} onClick={() => onPatch({ fallbackProviders: moveFallbackProvider(defaults.fallbackProviders, index, 1) })} aria-label={`Move ${providerLabel(provider)} down`} className="rounded p-1 hover:bg-muted disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {defaults.mode !== 'off' && (
        <SettingsSection title="Recovery behavior" description="Fine-tune handoff fidelity, retry limits, and reset timing.">
          <SettingsCard className="grid gap-4 p-4 sm:grid-cols-2">
          {usesFallback && <label className="space-y-1.5 text-sm font-medium">Handoff context
            <select className={inputClass} value={defaults.handoffMode} disabled={saving} onChange={(event) => onPatch({ handoffMode: event.target.value as ContinuityPolicySettings['handoffMode'] })}>
              <option value="summary">Summary + transcript backup</option>
              <option value="full">Full transcript</option>
            </select>
          </label>}
          <label className="space-y-1.5 text-sm font-medium">Maximum attempts
            <input className={inputClass} type="number" min={1} max={10} step={1} value={defaults.maxAttempts} disabled={saving} onChange={(event) => patchNumber('maxAttempts', Number(event.target.value))} />
            <span className="block text-xs font-normal text-muted-foreground">Between 1 and 10 recovery attempts.</span>
          </label>
          {(defaults.mode === 'wait' || defaults.mode === 'smart') && <label className="space-y-1.5 text-sm font-medium">
            {defaults.mode === 'smart' ? 'Maximum smart wait (seconds)' : 'Maximum wait (seconds)'}
            <input className={inputClass} type="number" min={0} max={604800} step={60} value={defaults.maxWaitSeconds} disabled={saving} onChange={(event) => patchNumber('maxWaitSeconds', Number(event.target.value))} />
            <span className="block text-xs font-normal text-muted-foreground">
              {defaults.mode === 'smart'
                ? 'Smart mode switches instead when the known reset is farther away. Live usage (Claude, Codex, Grok, Kimi) also uses this as a safety cap while quota is polled.'
                : 'Safety cap while CloudCLI polls remaining quota. Resume happens as soon as usage shows capacity, not when this timer elapses.'}
            </span>
          </label>}
          {(defaults.mode === 'wait' || defaults.mode === 'smart') && <label className="space-y-1.5 text-sm font-medium">No-meter retry delay (seconds)
            <input className={inputClass} type="number" min={30} max={86400} step={30} value={defaults.unknownResetDelaySeconds} disabled={saving} onChange={(event) => patchNumber('unknownResetDelaySeconds', Number(event.target.value))} />
            <span className="block text-xs font-normal text-muted-foreground">Used only for providers without a usage meter. Claude, Codex, Grok, and Kimi poll quota instead of waiting this long.</span>
          </label>}
          </SettingsCard>
        </SettingsSection>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-5">
        {error && <p role="alert" className="mr-auto text-sm text-destructive">{error}</p>}
        {missingRequiredFallback && <p role="alert" className="mr-auto text-sm text-destructive">Choose at least one fallback provider for this mode.</p>}
        {message && <p role="status" className="mr-auto text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}
        <button type="button" disabled={saving || missingRequiredFallback} aria-busy={saving} onClick={onSave} className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background disabled:opacity-50">
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save defaults'}
        </button>
      </div>
    </div>
  );
}

export default function ContinuitySettingsTab() {
  const [defaults, setDefaults] = useState<ContinuityPolicySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchContinuityDefaults()
      .then((value) => {
        if (!active) return;
        setDefaults(normalizeContinuitySettings(value));
        setError(null);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load continuity defaults.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const patch = (value: Partial<ContinuityPolicySettings>) => {
    setDefaults((current) => current ? { ...current, ...value } : current);
    setMessage(null);
  };

  const save = async () => {
    if (!defaults) return;
    const normalized = normalizeContinuitySettings(defaults);
    setDefaults(normalized);
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      setDefaults(normalizeContinuitySettings(await updateContinuityDefaults(normalized)));
      setMessage('Continuity defaults saved. Sessions without an override use these settings.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save continuity defaults.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ContinuitySettingsView
      defaults={defaults}
      loading={loading}
      saving={saving}
      message={message}
      error={error}
      onPatch={patch}
      onSave={() => void save()}
    />
  );
}
