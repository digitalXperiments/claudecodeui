import { useCallback, useEffect, useRef, useState } from 'react';

import { errorText } from './useAsyncAction';

/**
 * Loads one value on mount and whenever `key` changes; `reload` refetches and `setData` applies a
 * local change. A slower, older request never overwrites a newer one.
 */
export function useRemote<T>(load: () => Promise<T>, key: string, options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const next = await loadRef.current();
      if (seq.current !== id) return;
      setData(next);
      setError(null);
    } catch (caught) {
      if (seq.current === id) setError(errorText(caught, 'Request failed'));
    } finally {
      if (seq.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    setData(null);
    void reload();
    return () => { seq.current += 1; };
  }, [key, enabled, reload]);

  return { data, error, loading, reload, setData };
}
