import { useCallback, useEffect, useRef, useState } from 'react';

export function errorText(value: unknown, fallback = 'Request failed'): string {
  return value instanceof Error ? value.message : fallback;
}

/**
 * Load-on-mount (and on `key` change) helper with a stale-response guard. `load` must be stable
 * for a given `key`; pass `key: null` to stay idle.
 */
export function useLoad<T>(load: () => Promise<T>, key: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(key !== null);
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
      if (seq.current !== id) return;
      setError(errorText(caught));
    } finally {
      if (seq.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (key === null) {
      seq.current += 1;
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    void reload();
    return () => { seq.current += 1; };
  }, [key, reload]);

  return { data, setData, error, loading, reload };
}
