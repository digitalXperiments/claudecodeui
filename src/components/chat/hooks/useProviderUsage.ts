import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchProviderUsage } from '../api/providerUsageApi';
import { PROVIDER_USAGE_AUTH_CHANGED_EVENT } from '../../../utils/providerUsagePreferences';
import { PROVIDER_USAGE_POLL_INTERVAL_MS } from '../utils/providerUsage';

import {
  createProviderUsageController,
  INITIAL_PROVIDER_USAGE_STATE,
  type ProviderUsageController,
  type ProviderUsageState,
} from './providerUsageController';

export type { ProviderUsageState } from './providerUsageController';

export type UseProviderUsageOptions = {
  enabled?: boolean;
  intervalMs?: number;
};

export function useProviderUsage({
  enabled = true,
  intervalMs = PROVIDER_USAGE_POLL_INTERVAL_MS,
}: UseProviderUsageOptions = {}) {
  const [state, setState] = useState<ProviderUsageState>(INITIAL_PROVIDER_USAGE_STATE);
  const controllerRef = useRef<ProviderUsageController | null>(null);

  useEffect(() => {
    if (!enabled) {
      controllerRef.current = null;
      return undefined;
    }

    const controller = createProviderUsageController({
      fetchUsage: fetchProviderUsage,
      intervalMs,
      onState: setState,
      getDocumentHidden: () => typeof document !== 'undefined' && document.hidden,
      addVisibilityListener: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      },
      addAuthChangeListener: (listener) => {
        window.addEventListener(PROVIDER_USAGE_AUTH_CHANGED_EVENT, listener);
        return () => window.removeEventListener(PROVIDER_USAGE_AUTH_CHANGED_EVENT, listener);
      },
    });
    controllerRef.current = controller;
    controller.start();

    return () => {
      controller.stop();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [enabled, intervalMs]);

  const refresh = useCallback(async () => (
    controllerRef.current?.refresh() ?? state.data
  ), [state.data]);

  return {
    ...state,
    refresh,
    refetch: (fresh = false) => controllerRef.current?.request(fresh ? 'manual' : 'poll') ?? Promise.resolve(state.data),
  };
}
