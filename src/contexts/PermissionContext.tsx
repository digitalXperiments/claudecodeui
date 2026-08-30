import { createContext, useContext } from 'react';

import type { PendingPermissionRequest } from '../components/chat/types/types';

export interface PermissionContextValue {
  /**
   * True for an Agent Relay worker transcript opened for observation only.
   * Consumers that render an approve/deny surface inline in the transcript
   * (e.g. PlanDisplay's Build/Revise footer) must not offer it — the decision
   * belongs to the lead session's relay panel.
   */
  readOnly?: boolean;
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;
