import type { ProviderUsageResponse } from '../types/providerUsage';
import {
  PROVIDER_USAGE_MANUAL_REFRESH_GUARD_MS,
  PROVIDER_USAGE_POLL_INTERVAL_MS,
} from '../utils/providerUsage';

export type ProviderUsageState = {
  data: ProviderUsageResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refreshNotice: string | null;
};

export type ProviderUsageRequestKind = 'poll' | 'manual' | 'auth-change';

export type ProviderUsageFetch = (options: {
  fresh?: boolean;
  authChange?: boolean;
}) => Promise<ProviderUsageResponse>;

export type ProviderUsageControllerOptions = {
  fetchUsage: ProviderUsageFetch;
  intervalMs?: number;
  now?: () => number;
  onState: (state: ProviderUsageState) => void;
  getDocumentHidden?: () => boolean;
  addVisibilityListener?: (listener: () => void) => () => void;
  addAuthChangeListener?: (listener: () => void) => () => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/** First observation per provider is not a membership flip. */
export const shouldNotifyProviderUsageAuthChanged = (
  previousObserved: boolean | undefined,
  nextAuthenticated: boolean,
): boolean => (
  previousObserved !== undefined && previousObserved !== nextAuthenticated
);

export const INITIAL_PROVIDER_USAGE_STATE: ProviderUsageState = {
  data: null,
  loading: false,
  refreshing: false,
  error: null,
  refreshNotice: null,
};

export type ProviderUsageController = {
  start: () => void;
  stop: () => void;
  refresh: () => Promise<ProviderUsageResponse | null>;
  request: (kind?: ProviderUsageRequestKind) => Promise<ProviderUsageResponse | null>;
  getState: () => ProviderUsageState;
};

export function createProviderUsageController(
  options: ProviderUsageControllerOptions,
): ProviderUsageController {
  const now = options.now ?? Date.now;
  const intervalMs = Math.max(
    options.intervalMs ?? PROVIDER_USAGE_POLL_INTERVAL_MS,
    PROVIDER_USAGE_POLL_INTERVAL_MS,
  );
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  let state: ProviderUsageState = INITIAL_PROVIDER_USAGE_STATE;
  let inFlight = false;
  let pendingAuthChange = false;
  let lastSuccessfulFetchAt: number | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopped = false;
  let removeVisibilityListener: (() => void) | null = null;
  let removeAuthChangeListener: (() => void) | null = null;

  const publish = (next: ProviderUsageState): void => {
    state = next;
    options.onState(state);
  };

  const clearNoticeTimer = (): void => {
    if (noticeTimer !== null) {
      clearTimeoutFn(noticeTimer);
      noticeTimer = null;
    }
  };

  const scheduleNoticeClear = (): void => {
    clearNoticeTimer();
    noticeTimer = setTimeoutFn(() => {
      noticeTimer = null;
      if (state.refreshNotice) {
        publish({ ...state, refreshNotice: null });
      }
    }, 2500);
  };

  const request = async (
    kind: ProviderUsageRequestKind = 'poll',
  ): Promise<ProviderUsageResponse | null> => {
    if (stopped) {
      return state.data;
    }
    if (inFlight) {
      if (kind === 'auth-change') {
        pendingAuthChange = true;
      }
      return state.data;
    }
    if (kind === 'poll' && options.getDocumentHidden?.()) {
      return state.data;
    }
    if (
      kind === 'manual'
      && lastSuccessfulFetchAt !== null
      && now() - lastSuccessfulFetchAt < PROVIDER_USAGE_MANUAL_REFRESH_GUARD_MS
    ) {
      publish({ ...state, refreshNotice: 'just updated' });
      scheduleNoticeClear();
      return state.data;
    }

    inFlight = true;
    publish({
      ...state,
      loading: state.data === null,
      refreshing: state.data !== null,
      error: null,
      refreshNotice: null,
    });

    try {
      const data = await options.fetchUsage({
        fresh: kind !== 'poll',
        authChange: kind === 'auth-change',
      });
      if (stopped) {
        return data;
      }

      const fetchedAt = data.fetchedAt ? Date.parse(data.fetchedAt) : Number.NaN;
      if (Number.isFinite(fetchedAt)) {
        lastSuccessfulFetchAt = fetchedAt;
      }

      publish({
        data,
        loading: false,
        refreshing: false,
        error: null,
        refreshNotice: data.refreshSuppressed ? 'just updated' : null,
      });
      if (data.refreshSuppressed) {
        scheduleNoticeClear();
      }
      return data;
    } catch (caughtError) {
      if (!stopped) {
        publish({
          ...state,
          loading: false,
          refreshing: false,
          error: caughtError instanceof Error ? caughtError.message : 'Failed to load provider usage',
        });
      }
      return null;
    } finally {
      inFlight = false;
      if (pendingAuthChange && !stopped) {
        pendingAuthChange = false;
        void request('auth-change');
      }
    }
  };

  const start = (): void => {
    if (started) {
      return;
    }
    started = true;
    stopped = false;
    void request('poll');
    pollTimer = setIntervalFn(() => {
      void request('poll');
    }, intervalMs);
    removeVisibilityListener = options.addVisibilityListener?.(() => {
      if (!options.getDocumentHidden?.()) {
        void request('poll');
      }
    }) ?? null;
    removeAuthChangeListener = options.addAuthChangeListener?.(() => {
      void request('auth-change');
    }) ?? null;
  };

  const stop = (): void => {
    stopped = true;
    started = false;
    if (pollTimer !== null) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
    clearNoticeTimer();
    removeVisibilityListener?.();
    removeAuthChangeListener?.();
    removeVisibilityListener = null;
    removeAuthChangeListener = null;
  };

  return {
    start,
    stop,
    refresh: () => request('manual'),
    request,
    getState: () => state,
  };
}
