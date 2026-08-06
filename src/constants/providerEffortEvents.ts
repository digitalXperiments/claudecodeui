/** Window event dispatched when a provider's default effort changes in Settings. */
export const PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT = 'cloudcli:provider-default-effort-changed';

export type ProviderDefaultEffortChangedDetail = {
  provider: string;
  effort: string;
};
