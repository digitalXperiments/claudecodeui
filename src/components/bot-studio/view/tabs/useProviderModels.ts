import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../../utils/api';

export type ModelOption = { value: string; label: string; effort?: { default?: string; values: Array<{ value: string }> } };

/** Installed models for a provider, from /api/providers/:provider/models. */
export function useProviderModels(provider: string, enabled = true) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  useEffect(() => {
    if (!enabled || !provider) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setModels([]);
    void authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/models${refreshNonce ? '?bypassCache=true' : ''}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load ${provider} models.`);
        return response.json() as Promise<{ data?: { models?: { OPTIONS?: ModelOption[] } } }>;
      }).then((body) => {
        if (!cancelled) setModels((body.data?.models?.OPTIONS ?? []).map((model) => ({ ...model, label: model.label || model.value })));
      }).catch((nextError: unknown) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, provider, refreshNonce]);
  return { models, loading, error, refresh: () => setRefreshNonce((value) => value + 1) };
}
