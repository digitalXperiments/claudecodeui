/** Window event used to keep desktop model controls in sync across surfaces. */
export const PROVIDER_MODEL_CHANGED_EVENT = 'cloudcli:provider-model-changed';

export type ProviderModelChangedDetail = {
  provider: string;
  model: string;
  sessionId?: string | null;
};
