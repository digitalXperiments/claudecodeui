import React from 'react';
import { ChevronDown, ChevronUp, Gauge, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { LLMProvider } from '../../../../types/app';
import {
  readProviderUsageLegendCollapsed,
  writeProviderUsageLegendCollapsed,
} from '../../../../utils/providerUsagePreferences';
import type { ProviderUsage, ProviderUsageResponse, UsageWindow } from '../../types/providerUsage';
import {
  formatCountdown,
  formatRelativeUpdated,
  formatUsageNumber,
  getPrimaryUsageWindow,
  getRemainingRatio,
  getUsageTone,
  type UsageTone,
} from '../../utils/providerUsage';

export type ProviderUsageLegendUiState = {
  collapsed: boolean;
  expandedProvider: string | null;
};

export type ProviderUsageLegendUi = {
  getState: () => ProviderUsageLegendUiState;
  subscribe: (listener: (state: ProviderUsageLegendUiState) => void) => () => void;
  toggleCollapsed: () => ProviderUsageLegendUiState;
  toggleProvider: (providerId: string) => ProviderUsageLegendUiState;
  syncCollapsedFromStorage: () => ProviderUsageLegendUiState;
  activate: (key: string, action?: () => void) => boolean;
};

export const isProviderUsageLegendActivateKey = (key: string): boolean => (
  key === 'Enter' || key === ' '
);

export function createProviderUsageLegendUi(options: {
  readCollapsed?: () => boolean;
  writeCollapsed?: (collapsed: boolean) => void;
} = {}): ProviderUsageLegendUi {
  const readCollapsed = options.readCollapsed ?? readProviderUsageLegendCollapsed;
  const writeCollapsed = options.writeCollapsed ?? writeProviderUsageLegendCollapsed;
  let state: ProviderUsageLegendUiState = {
    collapsed: readCollapsed(),
    expandedProvider: 'claude',
  };
  const listeners = new Set<(next: ProviderUsageLegendUiState) => void>();

  const commit = (next: ProviderUsageLegendUiState): ProviderUsageLegendUiState => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
    return state;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toggleCollapsed: () => {
      const collapsed = !state.collapsed;
      writeCollapsed(collapsed);
      return commit({ ...state, collapsed });
    },
    toggleProvider: (providerId) => {
      const wasCollapsed = state.collapsed;
      if (wasCollapsed) {
        writeCollapsed(false);
      }
      return commit({
        collapsed: false,
        expandedProvider: wasCollapsed || state.expandedProvider !== providerId ? providerId : null,
      });
    },
    syncCollapsedFromStorage: () => commit({
      ...state,
      collapsed: readCollapsed(),
    }),
    activate: (key, action) => {
      if (!isProviderUsageLegendActivateKey(key)) {
        return false;
      }
      action?.();
      return true;
    },
  };
}

const toneClasses: Record<UsageTone, { bar: string; dot: string; text: string }> = {
  healthy: { bar: 'bg-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300' },
  warning: { bar: 'bg-amber-500', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300' },
  critical: { bar: 'bg-red-500', dot: 'bg-red-500', text: 'text-red-700 dark:text-red-300' },
  neutral: { bar: 'bg-muted-foreground/50', dot: 'bg-muted-foreground/60', text: 'text-muted-foreground' },
};

const providerIdForLogo = (providerId: string): LLMProvider => (
  ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'pi'].includes(providerId)
    ? providerId as LLMProvider
    : 'claude'
);

const formatPrimaryValue = (window: UsageWindow | null): string => {
  const ratio = getRemainingRatio(window);
  if (ratio !== null) return `${Math.round(ratio * 100)}% remaining`;
  if (window?.remaining !== null && window?.remaining !== undefined && window?.limit !== null && window?.limit !== undefined) {
    return `${formatUsageNumber(window.remaining)} / ${formatUsageNumber(window.limit)}`;
  }
  if (window?.remaining !== null && window?.remaining !== undefined) {
    return `${formatUsageNumber(window.remaining)} remaining`;
  }
  return 'usage unavailable';
};

export const formatExpandedWindowValue = (window: UsageWindow): string => {
  const ratio = getRemainingRatio(window);
  const percent = ratio !== null ? `${Math.round(ratio * 100)}% remaining` : null;
  const unitSuffix = window.unit === 'unknown' || window.unit === 'percent' ? '' : ` ${window.unit}`;
  const rawUsedLimit = window.used !== null && window.limit !== null && window.unit !== 'percent'
    ? `${formatUsageNumber(window.used)} / ${formatUsageNumber(window.limit)}${unitSuffix}`
    : null;
  if (percent && rawUsedLimit) return `${percent} · ${rawUsedLimit}`;
  if (percent) return percent;
  if (rawUsedLimit) return rawUsedLimit;
  if (window.remaining !== null && window.limit !== null) {
    return `${formatUsageNumber(window.remaining)} / ${formatUsageNumber(window.limit)}${unitSuffix}`;
  }
  if (window.remaining !== null) return `${formatUsageNumber(window.remaining)} remaining${unitSuffix}`;
  return 'usage unavailable';
};

function ProviderUsageRow({
  provider,
  expanded,
  now,
  onToggle,
}: {
  provider: ProviderUsage;
  expanded: boolean;
  now: number;
  onToggle: () => void;
}) {
  const primaryWindow = getPrimaryUsageWindow(provider);
  const ratio = getRemainingRatio(primaryWindow);
  const tone = getUsageTone(provider, primaryWindow);
  const colors = toneClasses[tone];
  const countdown = formatCountdown(primaryWindow?.resetsAt ?? null, now);
  const statusText = provider.status === 'stale'
    ? 'stale'
    : provider.status === 'error'
      ? 'error'
      : provider.status === 'unavailable'
        ? 'signed in'
        : null;

  return (
    <div className="border-t border-border/60 pt-2 first:border-t-0 first:pt-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-label={`${provider.displayName} usage details`}
        onClick={onToggle}
      >
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${colors.dot}`} aria-hidden="true" />
        <SessionProviderLogo provider={providerIdForLogo(provider.providerId)} className="h-4 w-4 flex-shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{provider.displayName}</span>
        <span className={`text-[11px] font-medium ${colors.text}`}>
          {ratio !== null ? `${Math.round(ratio * 100)}%` : 'N/A'}
        </span>
        {expanded
          ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
      </button>

      {!expanded && <div className="space-y-1 px-1 pb-1">
          {provider.planName && <div className="truncate text-[10px] text-muted-foreground">{provider.planName}</div>}
          {ratio !== null ? (
            <div className="space-y-1">
              <div
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={`${provider.displayName} remaining quota`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(ratio * 100)}
              >
                <div className={`h-full rounded-full ${colors.bar}`} style={{ width: `${ratio * 100}%` }} />
              </div>
              <div className={`text-[11px] font-medium ${colors.text}`}>{formatPrimaryValue(primaryWindow)}</div>
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground">{formatPrimaryValue(primaryWindow)}</div>
          )}
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="truncate">{primaryWindow?.label ?? 'Usage'}</span>
            {countdown && <span className="whitespace-nowrap">{countdown}</span>}
          </div>
          {provider.status === 'stale' && <div className="text-[10px] text-amber-700 dark:text-amber-300">last known · stale</div>}
          {statusText && provider.status !== 'stale' && (
            <div className={`text-[10px] ${provider.status === 'error' ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'}`}>{statusText}</div>
          )}
      </div>}

      {expanded && (
        <div className="mt-1 space-y-3 rounded-lg bg-muted/35 px-2 py-2">
          {provider.windows.length > 0 ? provider.windows.map((window) => (
            <UsageWindowBar key={window.id} provider={provider} window={window} now={now} />
          )) : <div>signed in · usage unavailable</div>}
          {provider.error && (
            <div className={`break-words text-[10px] ${provider.status === 'stale' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300'}`}>{provider.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

function UsageWindowBar({
  provider,
  window,
  now,
}: {
  provider: ProviderUsage;
  window: UsageWindow;
  now: number;
}) {
  const remainingRatio = getRemainingRatio(window);
  const usedRatio = remainingRatio === null ? null : 1 - remainingRatio;
  const usedPercent = usedRatio === null ? null : Math.round(usedRatio * 100);
  const colors = toneClasses[getUsageTone(provider, window)];
  // Stale rows carry cached windows whose reset time has often already passed;
  // there "resets now" would linger forever, so mark the reset as overdue instead.
  const resetsAtParsed = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const countdown = provider.status === 'stale' && Number.isFinite(resetsAtParsed) && resetsAtParsed <= now
    ? 'reset overdue'
    : formatCountdown(window.resetsAt, now);

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3 text-[11px]">
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{window.label}</div>
          {countdown && <div className="text-[10px] text-muted-foreground">{countdown}</div>}
        </div>
        <span className="whitespace-nowrap text-muted-foreground">
          {usedPercent === null ? formatExpandedWindowValue(window) : `${usedPercent}% used`}
        </span>
      </div>
      {usedPercent !== null && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${provider.displayName} ${window.label} used quota`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usedPercent}
        >
          <div className={`h-full rounded-full ${colors.bar}`} style={{ width: `${usedPercent}%` }} />
        </div>
      )}
    </div>
  );
}

export type ProviderUsageLegendContentProps = {
  data: ProviderUsageResponse | null;
  error?: string | null;
  refreshNotice?: string | null;
  refreshing?: boolean;
  collapsed: boolean;
  expandedProvider: string | null;
  now?: number;
  onRefresh?: () => void;
  onToggleCollapsed?: () => void;
  onToggleProvider?: (providerId: string) => void;
};

export function ProviderUsageLegendContent({
  data,
  error = null,
  refreshNotice = null,
  refreshing = false,
  collapsed,
  expandedProvider,
  now = Date.now(),
  onRefresh,
  onToggleCollapsed,
  onToggleProvider,
}: ProviderUsageLegendContentProps) {
  const { t } = useTranslation('chat');
  const providers = data?.providers.filter((provider) => provider.signedIn) ?? [];
  if (providers.length === 0) return null;

  const updatedLabel = refreshNotice || `Updated ${formatRelativeUpdated(data?.fetchedAt ?? null, now)}`;
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        title="Open provider usage"
        aria-label="Open provider usage"
        aria-expanded={false}
        aria-controls="provider-usage-card"
        className="fixed bottom-4 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-xl transition-transform hover:scale-105 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Gauge className="h-5 w-5" aria-hidden />
      </button>
    );
  }

  return (
    <aside
      id="provider-usage-card"
      data-testid="provider-usage-legend"
      data-collapsed="false"
      aria-label={t('providerUsage.title', { defaultValue: 'Provider usage' })}
      className="chat-provider-usage-card fixed bottom-4 right-4 z-30 flex max-h-[min(36rem,calc(100vh-2rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2.5">
          <span className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-foreground">
            {t('providerUsage.title', { defaultValue: 'Usage' })}
          </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title={t('providerUsage.refresh', { defaultValue: 'Refresh provider usage' })}
          aria-label={t('providerUsage.refresh', { defaultValue: 'Refresh provider usage' })}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden data-testid="provider-usage-refresh-spinner" />
            : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Close provider usage"
          aria-label="Close provider usage"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="text-[10px] text-muted-foreground" aria-live="polite">
          {updatedLabel}
          {error && <span className="ml-1 text-red-700 dark:text-red-300">· {error}</span>}
        </div>
        <div className="mt-2 space-y-2">
        {providers.map((provider) => (
          <ProviderUsageRow
            key={provider.providerId}
            provider={provider}
            expanded={expandedProvider === provider.providerId}
            now={now}
            onToggle={() => onToggleProvider?.(provider.providerId)}
          />
        ))}
        </div>
      </div>
    </aside>
  );
}
