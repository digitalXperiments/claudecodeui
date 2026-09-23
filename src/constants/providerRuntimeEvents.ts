/**
 * Window event dispatched when a provider-native Agent CLI (Shell tab) changed
 * its runtime settings — read by the server from the provider's own session
 * files. Chatbar mirrors them without re-dispatching its outbound change
 * events (which would relaunch the CLI in a loop). Codex and Grok keep their
 * dedicated events; this one carries every other provider.
 */
export const PROVIDER_RUNTIME_STATE_EVENT = 'cloudcli:provider-runtime-state';

export type ProviderRuntimeStateDetail = {
  provider: string;
  sessionId?: string | null;
  model?: string;
  effort?: string;
  permissionMode?: string;
};
