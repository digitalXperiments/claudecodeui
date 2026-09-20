import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, Save, ShieldCheck, Zap } from 'lucide-react';

import { jevApi } from '../../../jev/api/jevApi';
import type {
  JevCapability,
  JevCapabilityMode,
  JevConnectionTest,
  JevKeyStatus,
  JevSettings,
} from '../../../jev/types';
import { Button } from '../../../../shared/view/ui';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

type CapabilityCard = {
  id: JevCapability;
  title: string;
  what: string;
  /** What changes the moment this capability is set to `enforcing`. */
  enforcingMeans: string;
  /** Rising risk order, used to sort and to colour the badge. */
  risk: 'none' | 'low' | 'high';
};

/**
 * One card per decision Jev may take part in. Ordered by blast radius, so the
 * safe ones are the first thing an operator turns on.
 */
const CAPABILITIES: CapabilityCard[] = [
  {
    id: 'browser_page_state',
    title: 'Answer "is the page ready?" during browser automation',
    what: 'After a click, navigation, or form submit, Jev reports whether the page is ready, still loading, blocked by a cookie dialog, an error, or needs a human — inside the same tool call.',
    enforcingMeans: 'The answer is attached to the browser tool result. It never decides what to do next; the agent still drives. Shadow and Enforcing behave the same here.',
    risk: 'none',
  },
  {
    id: 'relay_results',
    title: 'Grade finished worker reports',
    what: 'After a delegated Agent Relay worker finishes, Jev rates whether it actually did the job and whether the evidence backs that up.',
    enforcingMeans: 'Nothing. Result grading is advisory at every level — it can never retry, repair, or re-dispatch a job.',
    risk: 'none',
  },
  {
    id: 'relay_permissions',
    title: 'Adjudicate escalated permission requests',
    what: 'When a worker asks to do something CloudCLI cannot classify as clearly safe or clearly unsafe, Jev is asked before a human is interrupted.',
    enforcingMeans: 'Jev may deny the request outright. It still cannot approve anything unless you also turn on the switch below.',
    risk: 'high',
  },
];

const MODE_LABELS: Record<JevCapabilityMode, string> = {
  off: 'Off',
  shadow: 'Shadow',
  enforcing: 'Enforcing',
};

const MODE_HINTS: Record<JevCapabilityMode, string> = {
  off: 'No request is sent.',
  shadow: 'Jev is asked and the answer is recorded, but never acted on.',
  enforcing: 'The answer may be acted on, within the guardrails described above.',
};

const RISK_TONE: Record<CapabilityCard['risk'], string> = {
  none: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  low: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  high: 'border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400',
};

const RISK_LABELS: Record<CapabilityCard['risk'], string> = {
  none: 'Advisory only',
  low: 'Low risk',
  high: 'Can block work',
};

export default function JevSettingsTab() {
  const [settings, setSettings] = useState<JevSettings | null>(null);
  const [saved, setSaved] = useState<JevSettings | null>(null);
  const [keyStatus, setKeyStatus] = useState<JevKeyStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [test, setTest] = useState<JevConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await jevApi.get();
    setSettings(data.settings);
    setSaved(data.settings);
    setKeyStatus(data.key);
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh()
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not load Jev settings.'))
      .finally(() => setLoading(false));
  }, [refresh]);

  const dirty = Boolean(settings && saved && JSON.stringify(settings) !== JSON.stringify(saved));

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const next = await jevApi.update(settings);
      setSettings(next);
      setSaved(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save Jev settings.');
    } finally {
      setSaving(false);
    }
  };

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    setKeyBusy(true);
    setError(null);
    try {
      setKeyStatus(await jevApi.setKey(keyDraft.trim()));
      setKeyDraft('');
      setTest(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the TypeSafe key.');
    } finally {
      setKeyBusy(false);
    }
  };

  const removeKey = async () => {
    setKeyBusy(true);
    setError(null);
    try {
      setKeyStatus(await jevApi.clearKey());
      setTest(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not remove the TypeSafe key.');
    } finally {
      setKeyBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await jevApi.test());
    } catch (caught) {
      setTest({
        ok: false,
        latencyMs: 0,
        model: null,
        error: caught instanceof Error ? caught.message : 'The connection test failed.',
      });
    } finally {
      setTesting(false);
    }
  };

  const setMode = (capability: JevCapability, mode: JevCapabilityMode) => {
    setSettings((current) => {
      if (!current) return current;
      const capabilities = { ...current.capabilities, [capability]: mode };
      return {
        ...current,
        capabilities,
        // Approval authority is meaningless unless permission adjudication is
        // enforcing. Mirror the server so the form cannot show an armed switch
        // that the server would immediately collapse.
        relayMayApprovePermissions: capabilities.relay_permissions === 'enforcing'
          && current.relayMayApprovePermissions,
      };
    });
  };

  if (loading || !settings) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SettingsSection
        title="Jev"
        description="A fast classifier that answers the small yes/no and either/or questions CloudCLI would otherwise ask a full model — or a human — to decide."
      >
        {error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-2xl border border-border bg-card/50">
          <div className="border-b border-border bg-gradient-to-br from-primary/[0.12] via-transparent to-transparent p-5 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                  <Zap className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-foreground">TypeSafe decision layer</h3>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      dirty
                        ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        : saved?.enabled
                          ? RISK_TONE.none
                          : 'border-border bg-muted/40 text-muted-foreground'
                    }`}>
                      {dirty ? 'Unsaved' : saved?.enabled ? 'On' : 'Off'}
                    </span>
                  </div>
                  <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Jev never writes code, runs commands, or picks its own options. CloudCLI enumerates the legal
                    answers in code and Jev only chooses between them, with a confidence score attached.
                  </p>
                </div>
              </div>
              <SettingsToggle
                checked={settings.enabled}
                onChange={(enabled) => setSettings((current) => current ? { ...current, enabled } : current)}
                disabled={saving}
                ariaLabel="Enable Jev"
              />
            </div>
          </div>

          <div className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-foreground">TypeSafe API key</div>
              <div className="text-[11px] text-muted-foreground">
                {keyStatus?.configured
                  ? `Configured (${keyStatus.source === 'env' ? 'TYPESAFE_API_KEY env' : 'stored'}) · ${keyStatus.masked}`
                  : 'Not configured — every Jev path stays inactive.'}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                type="password"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                placeholder={keyStatus?.configured ? 'Replace the stored key' : 'Paste your TypeSafe API key'}
                disabled={keyBusy || saving}
                autoComplete="off"
                className="h-10 min-w-56 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-sm text-foreground"
              />
              <Button variant="outline" onClick={() => void saveKey()} disabled={keyBusy || saving || !keyDraft.trim()}>
                {keyBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save key
              </Button>
              <Button variant="outline" onClick={() => void runTest()} disabled={testing || keyBusy || !keyStatus?.configured}>
                {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Test
              </Button>
              {keyStatus?.source === 'stored' ? (
                <Button variant="outline" onClick={() => void removeKey()} disabled={keyBusy || saving}>
                  Remove
                </Button>
              ) : null}
            </div>
            {test ? (
              <div className={`mt-2 text-[11px] ${test.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                {test.ok ? `Reached ${test.model ?? 'TypeSafe'} in ${test.latencyMs}ms.` : test.error}
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h4 className="text-sm font-semibold text-foreground">Where Jev is used</h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Each decision is switched independently. Start every one in <strong>Shadow</strong> and compare its
            answers against your own before moving it to Enforcing.
          </p>

          <div className="mt-4 space-y-3">
            {CAPABILITIES.map((capability) => {
              const mode = settings.capabilities[capability.id] ?? 'off';
              return (
                <div key={capability.id} className="rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{capability.title}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${RISK_TONE[capability.risk]}`}>
                          {RISK_LABELS[capability.risk]}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{capability.what}</p>
                      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                        <span className="font-medium text-foreground/80">Enforcing means:</span> {capability.enforcingMeans}
                      </p>
                    </div>
                    <div className="flex shrink-0 overflow-hidden rounded-lg border border-border">
                      {(['off', 'shadow', 'enforcing'] as JevCapabilityMode[]).map((option) => (
                        <button
                          key={option}
                          type="button"
                          title={MODE_HINTS[option]}
                          onClick={() => setMode(capability.id, option)}
                          disabled={saving || !settings.enabled}
                          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                            mode === option
                              ? 'bg-foreground text-background'
                              : 'bg-background text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                          } disabled:opacity-50`}
                        >
                          {MODE_LABELS[option]}
                        </button>
                      ))}
                    </div>
                  </div>

                  {capability.id === 'relay_permissions' ? (
                    <label className={`mt-3 flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/[0.04] p-3 ${
                      mode === 'enforcing' ? '' : 'opacity-50'
                    }`}>
                      <input
                        type="checkbox"
                        checked={settings.relayMayApprovePermissions}
                        onChange={(event) => setSettings((current) => current
                          ? { ...current, relayMayApprovePermissions: event.target.checked }
                          : current)}
                        disabled={saving || mode !== 'enforcing'}
                        className="mt-0.5 h-4 w-4 accent-primary"
                      />
                      <span>
                        <span className="block text-xs font-medium text-foreground">
                          Let Jev approve escalations, not just deny them
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-5 text-muted-foreground">
                          The only setting here that widens what an agent may do. Turn it on last, after shadow mode
                          shows Jev agreeing with you. Even then it cannot approve anything it rates as destructive,
                          and CloudCLI&rsquo;s own hard denies still win.
                        </span>
                      </span>
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4">
          <h4 className="text-sm font-semibold text-foreground">Model and thresholds</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              Model
              <input
                type="text"
                value={settings.model}
                onChange={(event) => setSettings((current) => current ? { ...current, model: event.target.value } : current)}
                disabled={saving}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-sm text-foreground"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              API base URL
              <input
                type="text"
                value={settings.baseUrl}
                onChange={(event) => setSettings((current) => current ? { ...current, baseUrl: event.target.value } : current)}
                disabled={saving}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-sm text-foreground"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              <span title="Hard per-call bound. Call sites may lower it further — a permission consultation is paid for out of the worker's approval wait, never added to it.">
                Decision timeout (ms)
              </span>
              <input
                type="number"
                min={500}
                max={20000}
                step={250}
                value={settings.timeoutMs}
                onChange={(event) => setSettings((current) => current
                  ? { ...current, timeoutMs: Math.min(20_000, Math.max(500, Number(event.target.value) || 4_000)) }
                  : current)}
                disabled={saving}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
              <span className="text-[11px] font-normal">500ms to 20s. Clamped on save.</span>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              <span title="Answers below this confidence are ignored everywhere, in both directions.">
                Confidence threshold
              </span>
              <input
                type="number"
                min={0.5}
                max={0.999}
                step={0.01}
                value={settings.confidenceThreshold}
                onChange={(event) => setSettings((current) => current
                  ? { ...current, confidenceThreshold: Math.min(0.999, Math.max(0.5, Number(event.target.value) || 0.85)) }
                  : current)}
                disabled={saving}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              />
              <span className="text-[11px] font-normal">0.5 to 0.999. Clamped on save.</span>
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-muted/20 p-4">
          <div className="flex gap-2.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="text-xs leading-5 text-muted-foreground">
              <span className="font-medium text-foreground">What Jev can never do.</span> Override a deterministic
              deny, leave a worker&rsquo;s worktree, read secrets, widen a path or MCP grant, retry or re-dispatch a
              job, or keep a worker waiting longer than it already would. A timeout, outage, or unparseable answer
              always falls back to the behaviour you have today.
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {dirty
              ? <><CircleAlert className="h-4 w-4 text-amber-500" /> Save to apply these changes.</>
              : saved?.enabled
                ? <><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Jev is active for the capabilities above.</>
                : <><CircleAlert className="h-4 w-4" /> Jev is off. Nothing calls TypeSafe.</>}
          </div>
          <Button onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save Jev settings
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
