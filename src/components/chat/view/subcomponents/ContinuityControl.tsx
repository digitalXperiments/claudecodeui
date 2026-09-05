import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  Clock3,
  RefreshCw,
  RotateCcw,
  Route,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';

import { useWebSocket } from '../../../../contexts/WebSocketContext';
import type { LLMProvider } from '../../../../types/app';
import {
  CONTINUITY_DEFAULTS_UPDATED_EVENT,
  actOnContinuityRecovery,
  checkContinuityBoomerang,
  executeContinuityBoomerang,
  fetchContinuityState,
  updateContinuityPolicy,
} from '../../api/continuityApi';
import type {
  ContinuityBoomerangStatus,
  ContinuityMode,
  ContinuityPolicy,
  ContinuityRecovery,
} from '../../types/continuity';
import { buildContinuityModePatch, formatContinuityWaitingLabel } from '../../utils/continuityUi';

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

const MODE_OPTIONS: Array<{ mode: ContinuityMode; label: string; description: string }> = [
  { mode: 'off', label: 'Off', description: 'Stop when this provider reaches its limit.' },
  { mode: 'wait', label: 'Wait & resume', description: 'Resume this provider once remaining quota is available.' },
  { mode: 'smart', label: 'Smart continue', description: 'Wait for short resets; otherwise use your fallback.' },
  { mode: 'switch', label: 'Switch immediately', description: 'Hand off to your fallback as soon as a limit is detected.' },
  { mode: 'ask', label: 'Ask me', description: 'Pause and create a Needs You alert with recovery controls.' },
];

function providerLabel(provider: LLMProvider | null): string {
  return PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider ?? 'fallback';
}

function modeLabel(mode: ContinuityMode): string {
  return MODE_OPTIONS.find((option) => option.mode === mode)?.label ?? 'Continuity';
}

function activeRecovery(recovery: ContinuityRecovery | null): boolean {
  return Boolean(recovery && ['waiting', 'running', 'needs_attention', 'failed'].includes(recovery.status));
}

type ContinuityControlProps = {
  sessionId: string | null;
  currentProvider: LLMProvider;
  onNavigateToSession?: (sessionId: string) => void;
};

export default function ContinuityControl({
  sessionId,
  currentProvider,
  onNavigateToSession,
}: ContinuityControlProps) {
  const { subscribe } = useWebSocket();
  const [policy, setPolicy] = useState<ContinuityPolicy | null>(null);
  const [recovery, setRecovery] = useState<ContinuityRecovery | null>(null);
  const [boomerang, setBoomerang] = useState<ContinuityBoomerangStatus | null>(null);
  const [boomerangBusy, setBoomerangBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const stateRequestRef = useRef(0);
  const busyRequestRef = useRef(0);
  const previousSessionIdRef = useRef(sessionId);
  const sessionIdRef = useRef(sessionId);
  const [panelPosition, setPanelPosition] = useState({ left: 12, bottom: 64 });

  sessionIdRef.current = sessionId;

  const refreshBoomerang = useCallback(async () => {
    if (!sessionId) {
      setBoomerang(null);
      return;
    }
    try {
      const status = await checkContinuityBoomerang(sessionId);
      setBoomerang(status);
    } catch {
      setBoomerang(null);
    }
  }, [sessionId]);

  const refresh = useCallback(async () => {
    const requestedSessionId = sessionId;
    const requestId = ++stateRequestRef.current;
    if (!sessionId) {
      setPolicy(null);
      setRecovery(null);
      setBoomerang(null);
      setError(null);
      return;
    }
    try {
      const state = await fetchContinuityState(sessionId);
      if (requestId !== stateRequestRef.current || sessionIdRef.current !== requestedSessionId) return;
      setPolicy(state.policy);
      setRecovery(state.recovery);
      setError(null);
      void refreshBoomerang();
    } catch (caught) {
      if (requestId !== stateRequestRef.current || sessionIdRef.current !== requestedSessionId) return;
      setError(caught instanceof Error ? caught.message : 'Could not load Continuity.');
    }
  }, [refreshBoomerang, sessionId]);

  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    stateRequestRef.current += 1;
    busyRequestRef.current += 1;
    setPolicy(null);
    setRecovery(null);
    setBoomerang(null);
    setBusy(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const refreshDefaults = () => { void refresh(); };
    window.addEventListener(CONTINUITY_DEFAULTS_UPDATED_EVENT, refreshDefaults);
    return () => window.removeEventListener(CONTINUITY_DEFAULTS_UPDATED_EVENT, refreshDefaults);
  }, [refresh]);

  useEffect(() => subscribe((event) => {
    if (event.kind !== 'continuity_updated' || event.sessionId !== sessionId) return;
    if (event.recovery && typeof event.recovery === 'object') {
      stateRequestRef.current += 1;
      setRecovery(event.recovery as ContinuityRecovery);
    } else {
      void refresh();
    }
  }), [refresh, sessionId, subscribe]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(380, window.innerWidth - 24);
    setPanelPosition({
      left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
      bottom: Math.max(12, window.innerHeight - rect.top + 8),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const fallback = useMemo(() => {
    const configured = policy?.fallbackProviders.find((provider) => provider !== currentProvider);
    return configured ?? PROVIDERS.find((provider) => provider.id !== currentProvider)?.id ?? null;
  }, [currentProvider, policy?.fallbackProviders]);

  const save = useCallback(async (patch: Partial<ContinuityPolicy>) => {
    if (!sessionId) return;
    const requestedSessionId = sessionId;
    const requestId = ++stateRequestRef.current;
    const busyRequestId = ++busyRequestRef.current;
    setBusy(true);
    setError(null);
    try {
      const state = await updateContinuityPolicy(sessionId, patch);
      if (requestId !== stateRequestRef.current || sessionIdRef.current !== requestedSessionId) return;
      setPolicy(state.policy);
      setRecovery(state.recovery);
    } catch (caught) {
      if (requestId !== stateRequestRef.current || sessionIdRef.current !== requestedSessionId) return;
      setError(caught instanceof Error ? caught.message : 'Could not save Continuity.');
    } finally {
      if (busyRequestId === busyRequestRef.current && sessionIdRef.current === requestedSessionId) {
        setBusy(false);
      }
    }
  }, [sessionId]);

  const selectMode = (mode: ContinuityMode) => {
    void save(buildContinuityModePatch(
      mode,
      policy?.fallbackProviders ?? [],
      currentProvider,
      fallback,
    ));
  };

  const executeBoomerangReturn = async () => {
    if (!sessionId) return;
    setBoomerangBusy(true);
    setError(null);
    try {
      await executeContinuityBoomerang(sessionId);
      await refresh();
      setBoomerang(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Boomerang return failed');
    } finally {
      setBoomerangBusy(false);
    }
  };

  const act = async (action: 'resume_now' | 'switch_now' | 'cancel') => {
    if (!recovery) return;
    const requestedSessionId = sessionId;
    const requestId = ++stateRequestRef.current;
    const busyRequestId = ++busyRequestRef.current;
    setBusy(true);
    setError(null);
    try {
      const result = await actOnContinuityRecovery(
        recovery.recoveryId,
        action,
        action === 'switch_now' ? fallback ?? undefined : undefined,
      );
      if (requestId !== stateRequestRef.current || sessionIdRef.current !== requestedSessionId) return;
      setRecovery(result.recovery);
    } catch (caught) {
      if (requestId !== stateRequestRef.current || sessionIdRef.current !== requestedSessionId) return;
      setError(caught instanceof Error ? caught.message : 'Recovery action failed.');
    } finally {
      if (busyRequestId === busyRequestRef.current && sessionIdRef.current === requestedSessionId) {
        setBusy(false);
      }
    }
  };

  const countdown = formatContinuityWaitingLabel(recovery, now);
  const isActive = activeRecovery(recovery);
  const buttonText = recovery?.status === 'waiting'
    ? countdown ? `Resume ${countdown}` : 'Waiting'
    : recovery?.status === 'running'
      ? recovery.action === 'handoff' ? `Switching` : 'Resuming'
      : recovery?.status === 'needs_attention' || recovery?.status === 'failed'
        ? 'Needs you'
        : boomerang?.ready
          ? 'Boomerang ready'
          : policy?.mode && policy.mode !== 'off'
            ? modeLabel(policy.mode)
            : 'Continuity';
  const statusLabel = recovery?.status === 'waiting'
    ? countdown ?? 'Waiting'
    : recovery?.status === 'running'
      ? recovery.action === 'handoff' ? 'Switching' : 'Resuming'
      : recovery?.status === 'needs_attention' || recovery?.status === 'failed'
        ? 'Needs you'
        : boomerang?.ready
          ? 'Boomerang'
          : null;

  const activeClass = recovery?.status === 'needs_attention' || recovery?.status === 'failed'
    ? 'border-red-400/50 bg-red-500/10 text-red-600 dark:text-red-300'
    : recovery?.status === 'waiting'
      ? 'border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : recovery?.status === 'running'
        ? 'border-sky-400/50 bg-sky-500/10 text-sky-700 dark:text-sky-300'
        : boomerang?.ready
          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 animate-pulse'
          : policy?.mode && policy.mode !== 'off'
            ? 'border-emerald-400/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={!sessionId}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={sessionId ? `${buttonText}. Choose how CloudCLI handles provider limits` : 'Start the session before enabling Continuity'}
        title={sessionId ? `${buttonText} · Choose how CloudCLI handles provider limits` : 'Start the session before enabling Continuity'}
        className={`flex h-8 shrink-0 items-center justify-center rounded-lg border text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${statusLabel ? 'gap-1.5 px-2' : 'w-8'} ${activeClass}`}
      >
        {recovery?.status === 'waiting' ? (
          <Clock3 className="h-3.5 w-3.5" />
        ) : recovery?.status === 'running' ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        ) : recovery?.status === 'needs_attention' || recovery?.status === 'failed' ? (
          <AlertTriangle className="h-3.5 w-3.5" />
        ) : boomerang?.ready ? (
          <RotateCcw className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5" />
        )}
        {statusLabel && <span aria-live="polite" className="max-w-24 truncate">{statusLabel}</span>}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Continuity settings"
          className="fixed z-[120] max-h-[calc(100dvh-24px)] w-[min(380px,calc(100vw-24px))] overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-3 text-foreground shadow-2xl"
          style={{ left: panelPosition.left, bottom: panelPosition.bottom }}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                Continuity
                {policy?.inPlaceHandoff && (
                  <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    <Sparkles className="h-2.5 w-2.5" /> In-Place
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                CloudCLI can wait, resume, or hand work to another provider when limits are reached.
              </p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Boomerang Auto-Return Banner */}
          {boomerang?.ready && boomerang.originalProvider && (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-700 dark:text-emerald-300">
              <div className="flex items-center gap-2">
                <RotateCcw className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span className="text-[11px]">
                  Quota recovered on <strong>{providerLabel(boomerang.originalProvider)}</strong>!
                </span>
              </div>
              <button
                type="button"
                disabled={boomerangBusy}
                onClick={() => void executeBoomerangReturn()}
                className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {boomerangBusy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                Return
              </button>
            </div>
          )}

          {isActive && recovery && (
            <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-500/10 p-2.5">
              <div className="flex items-center gap-2 text-xs font-semibold">
                {recovery.status === 'running' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Clock3 className="h-3.5 w-3.5" />}
                {recovery.status === 'waiting'
                  ? `${recovery.action === 'handoff' ? 'Switch' : 'Resume'} ${countdown ?? 'when ready'}`
                  : recovery.status === 'running'
                    ? recovery.action === 'handoff' ? `Handing off to ${providerLabel(recovery.fallbackProvider)}` : 'Resuming the session'
                    : 'Your decision is needed'}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{recovery.lastError || recovery.detectedReason}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" disabled={busy || recovery.status === 'running'} onClick={() => void act('resume_now')} className="rounded-md bg-foreground px-2 py-1 text-[11px] text-background disabled:opacity-50">Resume now</button>
                {fallback && <button type="button" disabled={busy || recovery.status === 'running'} onClick={() => void act('switch_now')} className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50"><Route className="mr-1 inline h-3 w-3" />Switch now</button>}
                <button type="button" disabled={busy || recovery.status === 'running'} onClick={() => void act('cancel')} className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50">Cancel</button>
              </div>
            </div>
          )}

          <div className="space-y-1">
            {MODE_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                disabled={busy}
                onClick={() => selectMode(option.mode)}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors ${policy?.mode === option.mode ? 'bg-primary/10' : 'hover:bg-muted/70'}`}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{policy?.mode === option.mode && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                <span><span className="block text-xs font-medium">{option.label}</span><span className="block text-[10px] leading-snug text-muted-foreground">{option.description}</span></span>
              </button>
            ))}
          </div>

          {policy?.mode && ['switch', 'smart', 'ask'].includes(policy.mode) && (
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/60 pt-3">
              <label className="text-[10px] font-medium text-muted-foreground">Fallback
                <select
                  value={fallback ?? ''}
                  disabled={busy}
                  onChange={(event) => void save({ fallbackProviders: [event.target.value as LLMProvider] })}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                >
                  {PROVIDERS.filter((candidate) => candidate.id !== currentProvider).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                </select>
              </label>
              <label className="text-[10px] font-medium text-muted-foreground">Handoff context
                <select
                  value={policy.handoffMode}
                  disabled={busy}
                  onChange={(event) => void save({ handoffMode: event.target.value as 'summary' | 'full' })}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                >
                  <option value="summary">Summary + backup</option>
                  <option value="full">Full transcript file</option>
                </select>
              </label>
            </div>
          )}

          {/* Quick Session Toggles */}
          {policy && (
            <div className="mt-3 space-y-1.5 border-t border-border/60 pt-2.5 text-xs">
              <label className="flex items-center justify-between py-1 text-[11px] text-muted-foreground cursor-pointer">
                <span>In-Place Chat Handoff</span>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={policy.inPlaceHandoff ?? false}
                  onChange={(e) => void save({ inPlaceHandoff: e.target.checked })}
                  className="rounded border-border text-primary focus:ring-primary h-3.5 w-3.5"
                />
              </label>
            </div>
          )}

          {recovery?.resumedSessionId && recovery.resumedSessionId !== sessionId && onNavigateToSession && (
            <button type="button" onClick={() => onNavigateToSession(recovery.resumedSessionId!)} className="mt-3 w-full rounded-md border border-border px-2 py-1.5 text-xs font-medium hover:bg-muted">Open continued session</button>
          )}
          {error && <p className="mt-2 text-[11px] text-red-500">{error}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}
