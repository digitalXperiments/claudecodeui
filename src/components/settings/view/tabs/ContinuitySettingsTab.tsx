import { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  History,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import type { LLMProvider } from '../../../../types/app';
import {
  fetchContinuityDefaults,
  fetchContinuityHealth,
  fetchContinuityHistory,
  simulateContinuityRecovery,
  updateContinuityDefaults,
} from '../../../chat/api/continuityApi';
import type {
  BoomerangMode,
  ContinuityHealthMatrix,
  ContinuityMode,
  ContinuityPolicySettings,
  ContinuityPreflightResult,
  ContinuityRecovery,
  ContinuitySimulationResult,
  PreflightGuardMode,
} from '../../../chat/types/continuity';
import {
  CONTINUITY_NUMBER_LIMITS,
  clampContinuityInteger,
  modeUsesFallback,
  moveFallbackProvider,
  normalizeContinuitySettings,
  summarizeContinuityHealth,
  toggleFallbackProvider,
} from '../../utils/continuitySettings';
import type { ContinuityNumericSetting } from '../../utils/continuitySettings';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';

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

const BOOMERANG_MODES: Array<{ id: BoomerangMode; label: string; description: string }> = [
  { id: 'off', label: 'Off', description: 'Remain on the fallback provider until manually switched.' },
  { id: 'prompt', label: 'Prompt me', description: 'Show a 1-click return banner in chat when original quota resets.' },
  { id: 'auto', label: 'Auto-return', description: 'Automatically hand back to primary as soon as its quota recovers.' },
];

const PREFLIGHT_MODES: Array<{ id: PreflightGuardMode; label: string; description: string }> = [
  { id: 'off', label: 'Off', description: 'Do not inspect quota before dispatching prompts.' },
  { id: 'warn', label: 'Warn', description: 'Show gentle alert if remaining quota is below threshold.' },
  { id: 'block', label: 'Block & suggest', description: 'Preemptively reroute to next fallback before turn fails.' },
];

const inputClass = 'h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring';

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
}: {
  defaults: ContinuityPolicySettings | null;
  loading: boolean;
  saving: boolean;
  message: string | null;
  error: string | null;
  onPatch: (value: Partial<ContinuityPolicySettings>) => void;
  onSave: () => void;
}) {
  // Live Provider Health Matrix state
  const [healthMatrix, setHealthMatrix] = useState<ContinuityHealthMatrix | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);

  // Recovery Simulation Sandbox state
  const [simProvider, setSimProvider] = useState<LLMProvider>('claude');
  const [simReason, setSimReason] = useState('Claude 3.5 Sonnet quota limit reached. Resets at 3:00 PM.');
  const [simResult, setSimResult] = useState<ContinuitySimulationResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  // Recent Recovery History state
  const [historyRecoveries, setHistoryRecoveries] = useState<ContinuityRecovery[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const loadHealth = useCallback(async () => {
    setLoadingHealth(true);
    try {
      const data = await fetchContinuityHealth();
      setHealthMatrix(data);
    } catch {
      // Non-blocking
    } finally {
      setLoadingHealth(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const data = await fetchContinuityHistory(10);
      setHistoryRecoveries(data.recoveries ?? []);
    } catch {
      // Non-blocking
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
    void loadHistory();
  }, [loadHealth, loadHistory]);

  const runSimulation = async () => {
    if (!defaults) return;
    setSimulating(true);
    setSimError(null);
    try {
      const res = await simulateContinuityRecovery({
        sessionId: 'sim-preview',
        sourceProvider: simProvider,
        detectedReason: simReason,
        policy: defaults,
      });
      setSimResult(res.simulation);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : 'Simulation failed');
    } finally {
      setSimulating(false);
    }
  };

  if (loading) {
    return (
      <div role="status" className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading continuity defaults…
      </div>
    );
  }

  if (!defaults) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {error ?? 'Continuity defaults are unavailable.'}
      </div>
    );
  }

  const patchNumber = (setting: ContinuityNumericSetting, value: number) => {
    const limits = CONTINUITY_NUMBER_LIMITS[setting];
    onPatch({
      [setting]: clampContinuityInteger(value, defaults[setting], limits.min, limits.max),
    });
  };

  // Derived here, not read off the response: the health endpoint returns the
  // raw provider list and leaves the roll-up to the caller.
  const healthProviders = Array.isArray(healthMatrix?.providers) ? healthMatrix.providers : null;
  const healthSummary = summarizeContinuityHealth(healthProviders);

  const usesFallback = modeUsesFallback(defaults.mode);
  const missingRequiredFallback = (
    defaults.mode === 'smart' || defaults.mode === 'switch'
  ) && defaults.fallbackProviders.length === 0;

  return (
    <div className="space-y-8">
      {/* 1. Live Provider Health & Quota Matrix */}
      <SettingsSection
        title="Live Provider Health & Quota Matrix"
        description="Real-time telemetry showing provider authentication, live quota capacities, and active waiting recoveries."
      >
        <SettingsCard className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Activity className="h-4 w-4" />
              </div>
              <div>
                <span className="text-sm font-semibold text-foreground">Provider Fleet Health</span>
                {healthSummary && (
                  <p className="text-xs text-muted-foreground">
                    {healthSummary.healthy} of {healthSummary.authenticated} authenticated providers ready · {healthSummary.recoveries24h} recoveries in 24h
                  </p>
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={loadingHealth}
              onClick={() => void loadHealth()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${loadingHealth ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {PROVIDERS.map((p) => {
              const h = healthProviders?.find((entry) => entry.provider === p.id);
              const isAuth = h?.authenticated;
              const status = h?.quota?.status ?? (isAuth ? 'available' : 'unauthenticated');
              const percent = h?.quota?.remainingRatio;

              const statusColor = !isAuth
                ? 'border-border/60 bg-muted/20 text-muted-foreground'
                : status === 'exhausted'
                ? 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
                : status === 'inconclusive'
                ? 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400'
                : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400';

              return (
                <div
                  key={p.id}
                  className={`rounded-lg border p-2.5 text-xs transition-colors ${statusColor}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground">{p.label}</span>
                    <span className="text-[10px] uppercase font-bold tracking-wider">
                      {!isAuth ? 'Not Configured' : status}
                    </span>
                  </div>

                  {typeof percent === 'number' && (
                    <div className="mt-2 space-y-1">
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>Capacity</span>
                        <span className="font-semibold text-foreground">{Math.round(percent * 100)}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-border/40 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            percent > 0.2
                              ? 'bg-emerald-500'
                              : percent > 0.05
                              ? 'bg-amber-500'
                              : 'bg-red-500'
                          }`}
                          style={{ width: `${Math.min(100, Math.max(0, percent * 100))}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {h?.recoveries24h ? (
                    <div className="mt-1.5 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                      <Clock3Icon className="h-3 w-3" />
                      <span>{h.recoveries24h} recoveries in 24h</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 2. Primary Continuity Strategy */}
      <SettingsSection
        title="Continuity Strategy"
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
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {defaults.mode === mode.id && <Check className="h-4 w-4 text-primary" />}
                </span>
                <span>
                  <span className="block text-sm font-medium">{mode.label}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{mode.description}</span>
                </span>
              </button>
            ))}
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Fallback Order (when enabled) */}
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
                  <button
                    type="button"
                    disabled={saving || index === 0}
                    onClick={() => onPatch({ fallbackProviders: moveFallbackProvider(defaults.fallbackProviders, index, -1) })}
                    aria-label={`Move ${providerLabel(provider)} up`}
                    className="rounded p-1 hover:bg-muted disabled:opacity-30"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={saving || index === defaults.fallbackProviders.length - 1}
                    onClick={() => onPatch({ fallbackProviders: moveFallbackProvider(defaults.fallbackProviders, index, 1) })}
                    aria-label={`Move ${providerLabel(provider)} down`}
                    className="rounded p-1 hover:bg-muted disabled:opacity-30"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 3. Feature Toggles & Capabilities */}
      <SettingsSection
        title="Advanced Continuity Capabilities"
        description="Individual toggles for seamless chat handoff, auto-return boomeranging, preflight quotas, capability matching, and checkpoint memory."
      >
        <SettingsCard divided className="p-0">
          {/* Feature 2: In-Place Chat Continuity */}
          <div className="flex items-center justify-between p-4">
            <div className="space-y-1 pr-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">Seamless In-Place Chat Continuity</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Keep the exact same chat thread open when switching providers instead of branching to a separate child session.
              </p>
            </div>
            <SettingsToggle
              checked={defaults.inPlaceHandoff ?? false}
              onChange={(val) => onPatch({ inPlaceHandoff: val })}
              ariaLabel="Toggle in-place handoff"
              disabled={saving}
            />
          </div>

          {/* Feature 3: The Boomerang */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <RotateCcw className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm font-semibold text-foreground">The Boomerang (Auto-Return)</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Automatically return to your primary provider as soon as their quota resets.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {BOOMERANG_MODES.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  disabled={saving}
                  onClick={() => onPatch({ boomerangMode: b.id })}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    defaults.boomerangMode === b.id
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <div className="flex items-center justify-between font-medium text-xs">
                    <span>{b.label}</span>
                    {defaults.boomerangMode === b.id && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{b.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Feature 4: Pre-Flight Quota Guard */}
          <div className="p-4 space-y-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold text-foreground">Pre-Flight Quota Guard</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Inspect provider quota before dispatching prompts to prevent wasted turns or mid-prompt rate limit errors.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {PREFLIGHT_MODES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={saving}
                  onClick={() => onPatch({ preflightQuotaGuard: p.id })}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    defaults.preflightQuotaGuard === p.id
                      ? 'border-primary/50 bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <div className="flex items-center justify-between font-medium text-xs">
                    <span>{p.label}</span>
                    {defaults.preflightQuotaGuard === p.id && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{p.description}</p>
                </button>
              ))}
            </div>
            {defaults.preflightQuotaGuard !== 'off' && (
              <div className="pt-2 flex items-center justify-between gap-4">
                <span className="text-xs text-muted-foreground">
                  Minimum Remaining Quota Threshold ({Math.round((defaults.preflightThresholdRatio ?? 0.05) * 100)}%):
                </span>
                <input
                  type="range"
                  min="0.01"
                  max="0.30"
                  step="0.01"
                  disabled={saving}
                  value={defaults.preflightThresholdRatio ?? 0.05}
                  onChange={(e) => onPatch({ preflightThresholdRatio: parseFloat(e.target.value) })}
                  className="w-48"
                />
              </div>
            )}
          </div>

          {/* Feature 5: Capability Tier Mapping */}
          <div className="flex items-center justify-between p-4">
            <div className="space-y-1 pr-4">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-indigo-500" />
                <span className="text-sm font-semibold text-foreground">Intelligent Capability Tier Mapping</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Match models by intelligence tier (Flagship, Reasoning, Fast, Lightweight) when switching providers so prompt quality remains consistent.
              </p>
            </div>
            <SettingsToggle
              checked={defaults.tierMappingEnabled ?? true}
              onChange={(val) => onPatch({ tierMappingEnabled: val })}
              ariaLabel="Toggle tier mapping"
              disabled={saving}
            />
          </div>

          {/* Feature 6: Tool State & Scratchpad Checkpointing */}
          <div className="flex items-center justify-between p-4">
            <div className="space-y-1 pr-4">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-purple-500" />
                <span className="text-sm font-semibold text-foreground">Tool State & Scratchpad Checkpointing</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Snapshot executed tools, modified files, and conversational scratchpad memory so fallback providers resume with full execution context.
              </p>
            </div>
            <SettingsToggle
              checked={defaults.checkpointToolsEnabled ?? true}
              onChange={(val) => onPatch({ checkpointToolsEnabled: val })}
              ariaLabel="Toggle tool checkpointing"
              disabled={saving}
            />
          </div>

          {/* Feature 7: Subagent & Relay Continuity */}
          <div className="flex items-center justify-between p-4">
            <div className="space-y-1 pr-4">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-sky-500" />
                <span className="text-sm font-semibold text-foreground">Subagent & Relay Continuity</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Propagate continuity failover policies and checkpoint lineage across subagents and agent relays.
              </p>
            </div>
            <SettingsToggle
              checked={defaults.subagentContinuityEnabled ?? true}
              onChange={(val) => onPatch({ subagentContinuityEnabled: val })}
              ariaLabel="Toggle subagent continuity"
              disabled={saving}
            />
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 4. Fine-Tuning Timers and Limits */}
      {defaults.mode !== 'off' && (
        <SettingsSection title="Recovery Timers & Limits" description="Fine-tune handoff context, maximum attempts, and timeout durations.">
          <SettingsCard className="grid gap-4 p-4 sm:grid-cols-2">
            {usesFallback && (
              <label className="space-y-1.5 text-sm font-medium">Handoff context
                <select className={inputClass} value={defaults.handoffMode} disabled={saving} onChange={(event) => onPatch({ handoffMode: event.target.value as ContinuityPolicySettings['handoffMode'] })}>
                  <option value="summary">Summary + transcript backup</option>
                  <option value="full">Full transcript</option>
                </select>
              </label>
            )}
            <label className="space-y-1.5 text-sm font-medium">Maximum attempts
              <input className={inputClass} type="number" min={1} max={10} step={1} value={defaults.maxAttempts} disabled={saving} onChange={(event) => patchNumber('maxAttempts', Number(event.target.value))} />
              <span className="block text-xs font-normal text-muted-foreground">Between 1 and 10 recovery attempts.</span>
            </label>
            {(defaults.mode === 'wait' || defaults.mode === 'smart') && (
              <label className="space-y-1.5 text-sm font-medium">
                {defaults.mode === 'smart' ? 'Maximum smart wait (seconds)' : 'Maximum wait (seconds)'}
                <input className={inputClass} type="number" min={0} max={604800} step={60} value={defaults.maxWaitSeconds} disabled={saving} onChange={(event) => patchNumber('maxWaitSeconds', Number(event.target.value))} />
                <span className="block text-xs font-normal text-muted-foreground">
                  {defaults.mode === 'smart'
                    ? 'Smart mode switches instead when the known reset is farther away. Live usage also uses this as a safety cap.'
                    : 'Safety cap while CloudCLI polls remaining quota. Resumes as soon as usage recovers.'}
                </span>
              </label>
            )}
            {(defaults.mode === 'wait' || defaults.mode === 'smart') && (
              <label className="space-y-1.5 text-sm font-medium">No-meter retry delay (seconds)
                <input className={inputClass} type="number" min={30} max={86400} step={30} value={defaults.unknownResetDelaySeconds} disabled={saving} onChange={(event) => patchNumber('unknownResetDelaySeconds', Number(event.target.value))} />
                <span className="block text-xs font-normal text-muted-foreground">Used only for providers without a live usage meter.</span>
              </label>
            )}
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 5. Interactive Recovery Simulator Sandbox */}
      <SettingsSection
        title="Interactive Recovery Simulator"
        description="Test how your current policy will respond to rate limit events without needing an actual provider quota failure."
      >
        <SettingsCard className="p-4 space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Simulated Source Provider</label>
              <select
                value={simProvider}
                onChange={(e) => setSimProvider(e.target.value as LLMProvider)}
                className={inputClass}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">Simulated Limit Message / Error</label>
              <input
                type="text"
                value={simReason}
                onChange={(e) => setSimReason(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={simulating}
              onClick={() => void runSimulation()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Play className={`h-3.5 w-3.5 ${simulating ? 'animate-spin' : ''}`} />
              {simulating ? 'Simulating…' : 'Run Simulation'}
            </button>
          </div>

          {simError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500">
              {simError}
            </div>
          )}

          {simResult && (
            <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground uppercase tracking-wider">
                  Simulated Outcome: {simResult.action}
                </span>
                <span className="rounded bg-primary/10 px-2 py-0.5 text-primary font-medium">
                  {simResult.inPlaceEligible ? 'In-Place Handoff' : 'Session Fork'}
                </span>
              </div>
              <p className="text-muted-foreground">{simResult.decisionReason}</p>
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/60">
                <div>
                  <span className="text-muted-foreground">Target Provider:</span>{' '}
                  <span className="font-medium text-foreground">{simResult.targetProvider ?? 'None'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Model & Tier:</span>{' '}
                  <span className="font-medium text-foreground">
                    {simResult.targetModel ?? 'default'} ({simResult.tierMatch ?? 'direct'})
                  </span>
                </div>
                {simResult.retryAt && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">Calculated Retry Time:</span>{' '}
                    <span className="font-medium text-foreground">{simResult.retryAt}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* 6. Recent Recovery History */}
      {historyRecoveries.length > 0 && (
        <SettingsSection
          title="Recent Recovery History"
          description="Log of recent automatic recoveries, handoffs, and provider resumptions."
        >
          <SettingsCard className="p-0 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Source Provider</th>
                  <th className="px-4 py-2.5 font-medium">Action & Fallback</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {historyRecoveries.map((rec) => (
                  <tr key={rec.recoveryId} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                      {new Date(rec.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2.5 font-medium text-foreground">
                      {providerLabel(rec.sourceProvider)}
                    </td>
                    <td className="px-4 py-2.5 text-foreground whitespace-nowrap">
                      <span className="capitalize">{rec.action}</span>
                      {rec.fallbackProvider && (
                        <span className="text-muted-foreground"> → {providerLabel(rec.fallbackProvider)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`inline-block rounded px-2 py-0.5 font-medium text-[10px] uppercase ${
                        rec.status === 'completed'
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : rec.status === 'waiting'
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          : rec.status === 'running'
                          ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
                          : 'bg-red-500/10 text-red-600 dark:text-red-400'
                      }`}>
                        {rec.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground max-w-xs truncate" title={rec.detectedReason}>
                      {rec.detectedReason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* Save Button Bar */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-5">
        {error && <p role="alert" className="mr-auto text-sm text-destructive">{error}</p>}
        {missingRequiredFallback && (
          <p role="alert" className="mr-auto text-sm text-destructive">
            Choose at least one fallback provider for this mode.
          </p>
        )}
        {message && <p role="status" className="mr-auto text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}
        <button
          type="button"
          disabled={saving || missingRequiredFallback}
          aria-busy={saving}
          onClick={onSave}
          className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background disabled:opacity-50"
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save defaults'}
        </button>
      </div>
    </div>
  );
}

function Clock3Icon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
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
