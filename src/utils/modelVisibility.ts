import { useEffect, useMemo, useState } from 'react';

import type { LLMProvider, ProviderModelOption, ProviderModelsDefinition } from '../types/app';
import { ALL_AGENT_PROVIDERS } from '../hooks/useAgentVisibility';

import { isProviderModelMatch } from './providerModels';

/**
 * Per-agent "which models to show in the new-session picker" preference.
 *
 * Persisted per provider as a JSON array of hidden model values in
 * localStorage (`<provider>-hidden-models`), mirroring how the default model
 * (`<provider>-model`) is stored. Hidden models are still usable — they stay
 * reachable from the mid-session switcher — they are just filtered out of the
 * new-chat model picker.
 */

const MODEL_VISIBILITY_SYNC_EVENT = 'model-visibility:sync';

export const getHiddenModelsStorageKey = (provider: LLMProvider): string => `${provider}-hidden-models`;

export const readHiddenModels = (provider: LLMProvider): string[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = localStorage.getItem(getHiddenModelsStorageKey(provider));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
};

export const writeHiddenModels = (provider: LLMProvider, hidden: string[]): void => {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(getHiddenModelsStorageKey(provider), JSON.stringify(hidden));

  // Chat pickers mounted in the same window (e.g. behind the Settings modal)
  // update live, matching the `useAgentVisibility` sync pattern.
  window.dispatchEvent(new CustomEvent(MODEL_VISIBILITY_SYNC_EVENT, { detail: { provider } }));
};

/**
 * Filters a catalog's options down to the models a provider should display.
 * Matching uses alias OR resolved id so a hidden alias also hides the concrete
 * id the CLI resolved it to (and vice-versa).
 */
export const filterVisibleModels = (
  definition: ProviderModelsDefinition | undefined | null,
  hidden: string[],
): ProviderModelOption[] => {
  if (!definition) {
    return [];
  }

  if (hidden.length === 0) {
    return definition.OPTIONS;
  }

  return definition.OPTIONS.filter((option) => !hidden.some((id) => isProviderModelMatch(option, id)));
};

/**
 * Live snapshot of every provider's hidden-model list. Re-reads localStorage
 * on cross-tab `storage` events and on the same-window sync event dispatched by
 * `writeHiddenModels`, so the new-session picker reflects Settings changes
 * without a remount.
 */
export function useHiddenModels() {
  const [hiddenModels, setHiddenModels] = useState<Partial<Record<LLMProvider, string[]>>>(() =>
    ALL_AGENT_PROVIDERS.reduce<Partial<Record<LLMProvider, string[]>>>((acc, provider) => {
      const ids = readHiddenModels(provider);
      if (ids.length > 0) {
        acc[provider] = ids;
      }
      return acc;
    }, {}),
  );

  useEffect(() => {
    const sync = () => {
      setHiddenModels((previous) => {
        const next: Partial<Record<LLMProvider, string[]>> = {};
        let changed = false;

        for (const provider of ALL_AGENT_PROVIDERS) {
          const ids = readHiddenModels(provider);
          const before = previous[provider] ?? [];
          if (before.length !== ids.length || !ids.every((id) => before.includes(id))) {
            changed = true;
          }
          if (ids.length > 0) {
            next[provider] = ids;
          }
        }

        return changed ? next : previous;
      });
    };

    window.addEventListener('storage', sync);
    window.addEventListener(MODEL_VISIBILITY_SYNC_EVENT, sync);

    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(MODEL_VISIBILITY_SYNC_EVENT, sync);
    };
  }, []);

  return useMemo(() => ({ hiddenModels }), [hiddenModels]);
}
