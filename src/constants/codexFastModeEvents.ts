export const CODEX_FAST_MODE_STORAGE_KEY = 'codex-fast-mode';
export const CODEX_FAST_MODE_CHANGED_EVENT = 'cloudcli:codex-fast-mode-changed';

export type CodexFastModeChangedDetail = {
  enabled: boolean;
};
