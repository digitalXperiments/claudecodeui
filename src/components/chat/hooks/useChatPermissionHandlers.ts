import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { LLMProvider } from '../../../types/app';
import type { PendingPermissionRequest } from '../types/types';
import { grantClaudeToolPermission } from '../utils/chatPermissions';

export type PermissionDecision = {
  allow?: boolean;
  message?: string;
  rememberEntry?: string | null;
  updatedInput?: unknown;
};

/**
 * Tool-permission handlers shared by the transcript (inline prompts via
 * PermissionContext) and the composer's permission banner. Lives in
 * ChatInterface rather than the composer state so the transcript does not
 * depend on the composer (which re-renders on every keystroke).
 */
export function useChatPermissionHandlers({
  provider,
  sendMessage,
  setPendingPermissionRequests,
}: {
  provider: LLMProvider;
  sendMessage: (message: unknown) => boolean;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}) {
  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (requestIds: string | string[], decision: PermissionDecision) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  return { handleGrantToolPermission, handlePermissionDecision };
}
