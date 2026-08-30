import { useMemo } from 'react';
import { useLocation, useParams } from 'react-router-dom';

import {
  resolveReadOnlyWorkerSession,
  type WorkerSessionLike,
  type WorkerSessionNavigationHint,
} from '../utils/workerSessionAccess';

/**
 * True when the currently viewed session is a read-only Agent Relay/internal
 * worker transcript. See `resolveReadOnlyWorkerSession` for the fail-closed
 * rules — `selectedSession.isInternal` is the actual source of truth; the
 * router's `location.state` only supplies a same-navigation hint.
 */
export function useWorkerSessionReadOnly(selectedSession: WorkerSessionLike | null): boolean {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const location = useLocation();

  return useMemo(
    () =>
      resolveReadOnlyWorkerSession({
        selectedSession,
        routeSessionId: routeSessionId ?? null,
        navigationHint: (location.state as WorkerSessionNavigationHint | null) ?? null,
      }),
    [selectedSession, routeSessionId, location.state],
  );
}
