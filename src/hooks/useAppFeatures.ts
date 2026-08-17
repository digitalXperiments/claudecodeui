import { useCallback, useEffect, useState } from 'react';

import { appFeaturesApi, type AppFeatures } from '../components/settings/api/appFeaturesApi';

const DEFAULTS: AppFeatures = {
  kanbanEnabled: true,
  spendSoftCostUsd: 80,
  spendHardCostUsd: 250,
};

const SYNC_EVENT = 'app-features:sync';

export function useAppFeatures() {
  const [features, setFeatures] = useState<AppFeatures>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await appFeaturesApi.get();
      setFeatures(next);
      setLoaded(true);
      window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: next }));
    } catch {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<AppFeatures>).detail;
      if (detail) setFeatures(detail);
    };
    window.addEventListener(SYNC_EVENT, onSync);
    return () => window.removeEventListener(SYNC_EVENT, onSync);
  }, []);

  const update = useCallback(async (patch: Partial<AppFeatures>) => {
    const next = await appFeaturesApi.update(patch);
    setFeatures(next);
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: next }));
    return next;
  }, []);

  return { features, loaded, refresh, update };
}
