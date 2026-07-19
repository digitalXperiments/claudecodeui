import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { LLMProvider } from '../types/app';

/**
 * Tracks which CLI agents (providers) are enabled for chat. Disabled agents
 * are hidden from the model picker and skipped when loading models, but stay
 * visible in Settings so they can be re-enabled. Persisted as a JSON array of
 * disabled provider ids in localStorage and synced live across hook instances
 * via a custom event (same pattern as `useUiPreferences`).
 */

export const ALL_AGENT_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'grok', 'kimi', 'agy'];

const STORAGE_KEY = 'disabledAgents';
const SYNC_EVENT = 'agent-visibility:sync';

type SyncEventDetail = {
  sourceId: string;
  value: LLMProvider[];
};

const isLLMProvider = (value: unknown): value is LLMProvider => {
  return typeof value === 'string' && (ALL_AGENT_PROVIDERS as string[]).includes(value);
};

const readDisabledAgents = (): LLMProvider[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isLLMProvider);
  } catch {
    return [];
  }
};

export function useAgentVisibility() {
  const instanceIdRef = useRef(`agent-visibility-${Math.random().toString(36).slice(2)}`);
  const [disabledAgents, setDisabledAgents] = useState<LLMProvider[]>(readDisabledAgents);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(disabledAgents));

    window.dispatchEvent(
      new CustomEvent<SyncEventDetail>(SYNC_EVENT, {
        detail: {
          sourceId: instanceIdRef.current,
          value: disabledAgents,
        },
      })
    );
  }, [disabledAgents]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const applyExternalUpdate = (value: unknown) => {
      if (!Array.isArray(value)) {
        return;
      }

      const next = value.filter(isLLMProvider);
      setDisabledAgents((previous) => {
        if (previous.length === next.length && previous.every((p) => next.includes(p))) {
          return previous;
        }
        return next;
      });
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) {
        return;
      }

      try {
        applyExternalUpdate(JSON.parse(event.newValue));
      } catch {
        // Ignore malformed storage updates.
      }
    };

    const handleSyncEvent = (event: Event) => {
      const detail = (event as CustomEvent<SyncEventDetail>).detail;
      if (!detail || detail.sourceId === instanceIdRef.current) {
        return;
      }

      applyExternalUpdate(detail.value);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener(SYNC_EVENT, handleSyncEvent as EventListener);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(SYNC_EVENT, handleSyncEvent as EventListener);
    };
  }, []);

  const setAgentEnabled = useCallback((provider: LLMProvider, enabled: boolean) => {
    setDisabledAgents((previous) => {
      const isDisabled = previous.includes(provider);
      if (enabled && !isDisabled) {
        return previous;
      }
      if (!enabled && isDisabled) {
        return previous;
      }
      return enabled
        ? previous.filter((p) => p !== provider)
        : [...previous, provider];
    });
  }, []);

  // Never allow an empty enabled list: chat must always have at least one
  // provider to fall back to, even if localStorage was hand-edited.
  const enabledProviders = useMemo<LLMProvider[]>(() => {
    const enabled = ALL_AGENT_PROVIDERS.filter((p) => !disabledAgents.includes(p));
    return enabled.length > 0 ? enabled : ALL_AGENT_PROVIDERS;
  }, [disabledAgents]);

  const isAgentEnabled = useCallback(
    (provider: LLMProvider) => enabledProviders.includes(provider),
    [enabledProviders],
  );

  return {
    disabledAgents,
    enabledProviders,
    isAgentEnabled,
    setAgentEnabled,
  };
}
