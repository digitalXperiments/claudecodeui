import { authenticatedFetch } from '../../../../utils/api';
import type { CreateUniverseApproachDraft, StudioUniverse, UniverseDiffResult } from '../types';

type ErrorBody = {
  error?: string | { code?: string; message?: string };
  message?: string;
};

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data as ErrorBody;
    const nested = body.error && typeof body.error === 'object' ? body.error.message : undefined;
    const message =
      nested
      || (typeof body.error === 'string' ? body.error : undefined)
      || body.message
      || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

function basePath(projectId: string, id?: string): string {
  const root = `/api/studio/${encodeURIComponent(projectId)}/universes`;
  return id ? `${root}/${encodeURIComponent(id)}` : root;
}

function variantPath(projectId: string, id: string, variantId: string, suffix: string): string {
  return `${basePath(projectId, id)}/variants/${encodeURIComponent(variantId)}/${suffix}`;
}

export const studioUniversesApi = {
  async list(projectId: string): Promise<StudioUniverse[]> {
    const res = await authenticatedFetch(basePath(projectId));
    const data = await parseJson<{ universes: StudioUniverse[] }>(res);
    return data.universes;
  },

  async get(projectId: string, id: string): Promise<StudioUniverse> {
    const res = await authenticatedFetch(basePath(projectId, id));
    const data = await parseJson<{ universe: StudioUniverse }>(res);
    return data.universe;
  },

  async create(
    projectId: string,
    input: { goal: string; approaches: [CreateUniverseApproachDraft, CreateUniverseApproachDraft]; timeoutMs?: number },
  ): Promise<StudioUniverse> {
    const res = await authenticatedFetch(basePath(projectId), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ universe: StudioUniverse }>(res);
    return data.universe;
  },

  async remove(projectId: string, id: string): Promise<void> {
    const res = await authenticatedFetch(basePath(projectId, id), { method: 'DELETE' });
    await parseJson<{ success: boolean }>(res);
  },

  async cancelVariant(projectId: string, id: string, variantId: string): Promise<StudioUniverse> {
    const res = await authenticatedFetch(variantPath(projectId, id, variantId, 'cancel'), { method: 'POST' });
    const data = await parseJson<{ universe: StudioUniverse }>(res);
    return data.universe;
  },

  async diffVariant(projectId: string, id: string, variantId: string): Promise<UniverseDiffResult> {
    const res = await authenticatedFetch(variantPath(projectId, id, variantId, 'diff'));
    const data = await parseJson<{ diff: UniverseDiffResult }>(res);
    return data.diff;
  },

  async applyVariant(
    projectId: string,
    id: string,
    variantId: string,
    input: { commit?: boolean; message?: string } = {},
  ): Promise<StudioUniverse> {
    const res = await authenticatedFetch(variantPath(projectId, id, variantId, 'apply'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ universe: StudioUniverse }>(res);
    return data.universe;
  },

  async startPreview(
    projectId: string,
    id: string,
    variantId: string,
    input: { command: string; port?: number },
  ): Promise<StudioUniverse> {
    const res = await authenticatedFetch(variantPath(projectId, id, variantId, 'preview/start'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ universe: StudioUniverse }>(res);
    return data.universe;
  },

  async stopPreview(projectId: string, id: string, variantId: string): Promise<StudioUniverse> {
    const res = await authenticatedFetch(variantPath(projectId, id, variantId, 'preview/stop'), { method: 'POST' });
    const data = await parseJson<{ universe: StudioUniverse }>(res);
    return data.universe;
  },
};

export type StudioUniversesApiClient = typeof studioUniversesApi;
