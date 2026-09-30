/** Runtime state reported by the provider-native Codex TUI. */
export const CODEX_RUNTIME_STATE_CHANGED_EVENT = 'cloudcli:codex-runtime-state-changed';

export type CodexRuntimeStateChangedDetail = {
  fastMode?: boolean;
  model?: string;
  effort?: string;
  permissionMode?: string;
  sessionId?: string | null;
};
