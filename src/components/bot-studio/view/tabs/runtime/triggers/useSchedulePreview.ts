import { useEffect, useState } from 'react';

import { botRuntimeApi } from '../../../../api/botRuntimeApi';
import { errorText } from '../panel/useAsyncAction';

import { readCompiledSchedule, type SchedulePreview } from './triggerForm';

type PreviewState = { status: 'idle' } | { status: 'loading' } | { status: 'ok'; preview: SchedulePreview } | { status: 'error'; message: string };

const DEBOUNCE_MS = 350;

/** Debounced POST /triggers/compile-schedule for the text being typed; stale responses are dropped. */
export function useSchedulePreview(text: string, timezone: string): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setState({ status: 'idle' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      botRuntimeApi.triggers.compileSchedule(trimmed, timezone.trim() || undefined)
        .then((body) => {
          if (cancelled) return;
          const preview = readCompiledSchedule(body);
          setState(preview ? { status: 'ok', preview } : { status: 'error', message: 'The server did not return a schedule.' });
        })
        .catch((caught: unknown) => {
          if (!cancelled) setState({ status: 'error', message: errorText(caught, 'Could not compile that schedule.') });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, timezone]);
  return state;
}

