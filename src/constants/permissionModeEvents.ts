/**
 * Window event dispatched whenever the chatbar permission mode changes.
 *
 * The Shell tab listens for this so an already-running interactive CLI can be
 * relaunched (resuming the same session) with the new mode's flags — the CLI
 * launch flags are the only way to change the mode of a TUI process, and they
 * are fixed at spawn time.
 */
export const PERMISSION_MODE_CHANGED_EVENT = 'cloudcli:permission-mode-changed';

export type PermissionModeChangedDetail = {
  provider: string;
  mode: string;
  /** App session id when the change is scoped to a session, otherwise null. */
  sessionId: string | null;
};
