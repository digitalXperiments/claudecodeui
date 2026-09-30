import React from 'react';
import { ChevronDown, ChevronUp, Gauge, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
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
  expandedProviders: string[];
  expandedProvider: string | null;
};

export type ProviderUsageLegendUi = {
  getState: () => ProviderUsageLegendUiState;
  subscribe: (listener: (state: ProviderUsageLegendUiState) => void) => () => void;
  toggleCollapsed: () => ProviderUsageLegendUiState;
  toggleProvider: (providerId: string) => ProviderUsageLegendUiState;
  toggleExpandAll: (allProviderIds?: string[]) => ProviderUsageLegendUiState;
  expandAll: (providerIds?: string[]) => ProviderUsageLegendUiState;
  collapseAll: () => ProviderUsageLegendUiState;
  syncCollapsedFromStorage: () => ProviderUsageLegendUiState;
  activate: (key: string, action?: () => void) => boolean;
};

export const isProviderUsageLegendActivateKey = (key: string): boolean => (
  key === 'Enter' || key === ' '
);

export function createProviderUsageLegendUi(options: {
  readCollapsed?: () => boolean;
  writeCollapsed?: (collapsed: boolean) => void;
  initialExpandedProviders?: string[];
} = {}): ProviderUsageLegendUi {
  const readCollapsed = options.readCollapsed ?? readProviderUsageLegendCollapsed;
  const writeCollapsed = options.writeCollapsed ?? writeProviderUsageLegendCollapsed;
  const initialExpandedProviders = options.initialExpandedProviders ?? [];
  let state: ProviderUsageLegendUiState = {
    collapsed: readCollapsed(),
    expandedProviders: initialExpandedProviders,
    expandedProvider: initialExpandedProviders[0] ?? null,
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
      let nextExpanded: string[];
      if (wasCollapsed) {
        nextExpanded = state.expandedProviders.includes(providerId)
          ? state.expandedProviders
          : [...state.expandedProviders, providerId];
      } else {
        const isExpanded = state.expandedProviders.includes(providerId);
        nextExpanded = isExpanded
          ? state.expandedProviders.filter((id) => id !== providerId)
          : [...state.expandedProviders, providerId];
      }
      return commit({
        collapsed: false,
        expandedProviders: nextExpanded,
        expandedProvider: nextExpanded.includes(providerId)
          ? providerId
          : (nextExpanded[0] ?? null),
      });
    },
    toggleExpandAll: (allProviderIds = []) => {
      const wasCollapsed = state.collapsed;
      if (wasCollapsed) {
        writeCollapsed(false);
      }
      const isAllExpanded = allProviderIds.length > 0 &&
        allProviderIds.every((id) => state.expandedProviders.includes(id));
      const nextExpanded = isAllExpanded ? [] : Array.from(new Set(allProviderIds));
      return commit({
        collapsed: false,
        expandedProviders: nextExpanded,
        expandedProvider: nextExpanded[0] ?? null,
      });
    },
    expandAll: (providerIds = []) => {
      const wasCollapsed = state.collapsed;
      if (wasCollapsed) {
        writeCollapsed(false);
      }
      const uniqueIds = Array.from(new Set(providerIds));
      return commit({
        collapsed: false,
        expandedProviders: uniqueIds,
        expandedProvider: uniqueIds[0] ?? null,
      });
    },
    collapseAll: () => {
      return commit({
        ...state,
        expandedProviders: [],
        expandedProvider: null,
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
  ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'pi', 'omp', 'antigravity'].includes(providerId)
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
  const rawRemainingLimit = window.remaining !== null && window.limit !== null && window.unit !== 'percent'
    ? `${formatUsageNumber(window.remaining)} / ${formatUsageNumber(window.limit)}${unitSuffix}`
    : null;
  if (percent && rawRemainingLimit) return `${percent} · ${rawRemainingLimit}`;
  if (percent) return percent;
  if (rawRemainingLimit) return rawRemainingLimit;
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

function getCompactWindows(provider: ProviderUsage): {
  session: UsageWindow | null;
  weekly: UsageWindow | null;
} {
  const primaryWindow = getPrimaryUsageWindow(provider);
  const weeklyWindow = provider.windows.find((window) => (
    /week/i.test(window.id) || /week/i.test(window.label)
  )) ?? null;
  const sessionWindow = primaryWindow && primaryWindow !== weeklyWindow
    ? primaryWindow
    : provider.windows.find((window) => window !== weeklyWindow) ?? null;
  return { session: sessionWindow, weekly: weeklyWindow };
}

function CompactMetricCell({ provider, label, window, now }: {
  provider: ProviderUsage;
  label: 'Session' | 'Weekly';
  window: UsageWindow | null;
  now: number;
}) {
  const ratio = getRemainingRatio(window);
  const percent = ratio === null ? null : Math.round(ratio * 100);
  const colors = toneClasses[getUsageTone(provider, window)];
  const rawCountdown = formatCountdown(window?.resetsAt ?? null, now);
  const parsedReset = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const resetLabel = provider.status === 'stale' && Number.isFinite(parsedReset) && parsedReset <= now
    ? 'overdue'
    : rawCountdown?.replace(/^resets in /, '').replace(/^resets /, '') ?? null;

  return (
    <div className="min-w-0 px-2 py-2.5 text-center" data-usage-window={label.toLowerCase()}>
      <div className={`text-lg font-semibold leading-none ${colors.text}`}>{percent === null ? '—' : `${percent}%`}</div>
      <div
        className="mx-auto mt-2 h-1.5 w-full max-w-16 overflow-hidden rounded-full bg-muted"
        role={percent === null ? undefined : 'progressbar'}
        aria-label={percent === null ? undefined : `${provider.displayName} ${label.toLowerCase()} remaining quota`}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
      >
        {percent !== null ? <div className={`h-full rounded-full ${colors.bar}`} style={{ width: `${percent}%` }} /> : null}
      </div>
      <div className="mt-1.5 min-h-3.5 truncate text-[10px] leading-3.5 text-muted-foreground" title={rawCountdown ?? undefined}>
        {resetLabel ?? ''}
      </div>
    </div>
  );
}

function CompactUsageMatrix({ providers, isExpanded, now, onToggleProvider }: {
  providers: ProviderUsage[];
  isExpanded: (providerId: string) => boolean;
  now: number;
  onToggleProvider?: (providerId: string) => void;
}) {
  const groups: ProviderUsage[][] = [];
  for (let index = 0; index < providers.length; index += 4) {
    groups.push(providers.slice(index, index + 4));
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.map((provider) => provider.providerId).join(':')} className="overflow-hidden rounded-xl border border-border/70 bg-background/75">
          <div
            className="grid items-center border-b border-border/60"
            style={{ gridTemplateColumns: `repeat(${group.length}, minmax(0, 1fr))` }}
          >
            {group.map((provider) => (
              <button
                key={provider.providerId}
                type="button"
                onClick={() => onToggleProvider?.(provider.providerId)}
                className={cn(
                  'flex h-11 items-center justify-center border-l border-border/50 first:border-l-0 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  isExpanded(provider.providerId) && 'bg-accent/60',
                )}
                aria-label={`${provider.displayName} usage details`}
                aria-expanded={isExpanded(provider.providerId)}
                title={provider.displayName}
              >
                <SessionProviderLogo provider={providerIdForLogo(provider.providerId)} className="h-5 w-5 object-contain" />
              </button>
            ))}
          </div>
          {(['Session', 'Weekly'] as const).map((label) => (
            <div
              key={label}
              className="grid items-center border-b border-border/50 last:border-b-0"
              style={{ gridTemplateColumns: `repeat(${group.length}, minmax(0, 1fr))` }}
            >
              {group.map((provider) => (
                <div key={provider.providerId} className="border-l border-border/50 first:border-l-0">
                  <CompactMetricCell provider={provider} label={label} window={getCompactWindows(provider)[label.toLowerCase() as 'session' | 'weekly']} now={now} />
                </div>
              ))}
            </div>
          ))}

          {group.filter((provider) => isExpanded(provider.providerId)).map((provider) => (
            <div key={provider.providerId} className="space-y-2 border-t border-border/60 bg-muted/20 px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[10px] font-medium text-foreground">
                <SessionProviderLogo provider={providerIdForLogo(provider.providerId)} className="h-3.5 w-3.5" />
                <span>{provider.displayName}</span>
              </div>
              {provider.windows.length > 0 ? provider.windows.map((window) => (
                <UsageWindowBar key={window.id} provider={provider} window={window} now={now} />
              )) : <div className="text-[10px] text-muted-foreground">Signed in · usage unavailable</div>}
              {provider.error ? (
                <div className={`break-words text-[10px] ${provider.status === 'stale' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300'}`}>
                  {provider.error}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
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
  const remainingPercent = remainingRatio === null ? null : Math.round(remainingRatio * 100);
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
          {remainingPercent === null ? formatExpandedWindowValue(window) : `${remainingPercent}% remaining`}
        </span>
      </div>
      {remainingPercent !== null && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`${provider.displayName} ${window.label} remaining quota`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remainingPercent}
        >
          <div className={`h-full rounded-full ${colors.bar}`} style={{ width: `${remainingPercent}%` }} />
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
  loading?: boolean;
  collapsed: boolean;
  expandedProvider?: string | null;
  expandedProviders?: string[];
  now?: number;
  onRefresh?: () => void;
  onToggleCollapsed?: () => void;
  onToggleProvider?: (providerId: string) => void;
  onToggleExpandAll?: () => void;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  /** Render inside a parent panel instead of as a floating chat card. */
  embedded?: boolean;
};

export function ProviderUsageLegendContent({
  data,
  error = null,
  refreshNotice = null,
  refreshing = false,
  loading = false,
  collapsed,
  expandedProvider,
  expandedProviders,
  now = Date.now(),
  onRefresh,
  onToggleCollapsed,
  onToggleProvider,
  onToggleExpandAll,
  onExpandAll,
  onCollapseAll,
  embedded = false,
}: ProviderUsageLegendContentProps) {
  const { t } = useTranslation('chat');
  const providers = data?.providers.filter((provider) => provider.signedIn) ?? [];

  const isExpanded = (providerId: string): boolean => {
    if (expandedProviders !== undefined) {
      return expandedProviders.includes(providerId);
    }
    if (expandedProvider !== undefined && expandedProvider !== null) {
      return expandedProvider === providerId;
    }
    return false;
  };

  const allExpanded = providers.length > 0 && providers.every((p) => isExpanded(p.providerId));

  const handleToggleExpandAll = () => {
    if (onToggleExpandAll) {
      onToggleExpandAll();
      return;
    }
    if (allExpanded) {
      if (onCollapseAll) {
        onCollapseAll();
      } else {
        providers.forEach((p) => {
          if (isExpanded(p.providerId)) {
            onToggleProvider?.(p.providerId);
          }
        });
      }
    } else {
      if (onExpandAll) {
        onExpandAll();
      } else {
        providers.forEach((p) => {
          if (!isExpanded(p.providerId)) {
            onToggleProvider?.(p.providerId);
          }
        });
      }
    }
  };

  const updatedLabel = refreshNotice || `Updated ${formatRelativeUpdated(data?.fetchedAt ?? null, now)}`;

  if (embedded) {
    return (
      <aside
        data-testid="provider-usage-legend"
        data-collapsed="false"
        aria-label={t('providerUsage.title', { defaultValue: 'Provider usage' })}
        className="min-h-0 overflow-y-auto bg-card/20 px-2.5 pb-2.5"
      >
        <div className="flex h-8 items-center gap-1.5 px-0.5 text-[10px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{data ? updatedLabel : loading ? 'Loading usage…' : 'Usage unavailable'}</span>
          {error ? <span className="truncate text-red-700 dark:text-red-300">{error}</span> : null}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || loading}
            aria-label={t('providerUsage.refresh', { defaultValue: 'Refresh provider usage' })}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            {refreshing || loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>

        {loading && !data ? (
          <div className="grid grid-cols-4 gap-1.5" aria-label="Loading provider usage">
            {[0, 1, 2, 3].map((item) => (
              <div key={item} className="h-[104px] animate-pulse rounded-xl border border-border/50 bg-muted/60" />
            ))}
          </div>
        ) : providers.length > 0 ? (
          <CompactUsageMatrix providers={providers} isExpanded={isExpanded} now={now} onToggleProvider={onToggleProvider} />
        ) : (
          <div className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
            No signed-in provider usage is available.
          </div>
        )}
      </aside>
    );
  }

  if (providers.length === 0) return null;

  if (collapsed && !embedded) {
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
      className={embedded
        ? 'flex min-h-0 flex-1 flex-col overflow-hidden bg-card/20'
        : 'chat-provider-usage-card fixed bottom-4 right-4 z-30 flex max-h-[min(36rem,calc(100vh-2rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/95 shadow-2xl backdrop-blur'}
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2.5">
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {embedded ? updatedLabel : t('providerUsage.title', { defaultValue: 'Usage' })}
        </span>
        <button
          type="button"
          onClick={handleToggleExpandAll}
          title={allExpanded
            ? t('providerUsage.collapseAll', { defaultValue: 'Collapse all details' })
            : t('providerUsage.expandAll', { defaultValue: 'Expand all details' })}
          aria-label={allExpanded
            ? t('providerUsage.collapseAll', { defaultValue: 'Collapse all details' })
            : t('providerUsage.expandAll', { defaultValue: 'Expand all details' })}
          aria-expanded={allExpanded}
          data-testid="provider-usage-expand-all"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {allExpanded
            ? <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
        </button>
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
        {!embedded ? <button
          type="button"
          onClick={onToggleCollapsed}
          title="Close provider usage"
          aria-label="Close provider usage"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden />
        </button> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="text-[10px] text-muted-foreground" aria-live="polite">
          {!embedded ? updatedLabel : null}
          {error && <span className="ml-1 text-red-700 dark:text-red-300">· {error}</span>}
        </div>
        <div className="mt-2 space-y-2">
        {providers.map((provider) => (
          <ProviderUsageRow
            key={provider.providerId}
            provider={provider}
            expanded={isExpanded(provider.providerId)}
            now={now}
            onToggle={() => onToggleProvider?.(provider.providerId)}
          />
        ))}
        </div>
      </div>
    </aside>
  );
}
