import { authenticatedFetch } from '../../../utils/api';

export type AppFeatures = {
  kanbanEnabled: boolean;
  spendSoftCostUsd: number | null;
  spendHardCostUsd: number | null;
};

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (data as { error?: string; message?: string }).error
      || (data as { message?: string }).message
      || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export const appFeaturesApi = {
  async get(): Promise<AppFeatures> {
    const res = await authenticatedFetch('/api/features');
    const data = await parseJson<{ features: AppFeatures }>(res);
    return data.features;
  },
  async update(patch: Partial<AppFeatures>): Promise<AppFeatures> {
    const res = await authenticatedFetch('/api/features', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    const data = await parseJson<{ features: AppFeatures }>(res);
    return data.features;
  },
};
