import { useCallback, useEffect, useRef, useState } from 'react';

export const errorText = (value: unknown, fallback = 'Something went wrong'): string => (value instanceof Error ? value.message : fallback);

/**
 * Runs an async action with a keyed busy flag and a shared error message. `run` resolves true when
 * the action succeeded so callers can close a form or show a toast. State updates after unmount are skipped.
 */
export function useAsyncAction() {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const run = useCallback(async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusyKey(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      if (alive.current) setError(errorText(caught));
      return false;
    } finally {
      if (alive.current) setBusyKey((current) => (current === key ? null : current));
    }
  }, []);

  return { busyKey, busy: busyKey !== null, isBusy: (key: string) => busyKey === key, error, setError, run };
}

/** `copy(text)` writes to the clipboard; `copied` holds the last copied value for ~1.5s. */
export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }, []);
  return { copied, copy };
}
