import { authenticatedFetch } from '../../../utils/api';
import type {
  StudioDesignTokens,
  StudioPrototype,
  StudioPrototypeDetail,
  StudioSeatProfile,
  StudioSelectedElement,
  StudioTokensPatch,
} from '../types';

export type { StudioSeatProfile };
export { STUDIO_POLL_INTERVAL_MS } from '../types';

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

function protoPath(projectId: string, id?: string): string {
  const base = `/api/studio/${encodeURIComponent(projectId)}/prototypes`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

export const studioApi = {
  async list(projectId: string): Promise<StudioPrototype[]> {
    const res = await authenticatedFetch(protoPath(projectId));
    const data = await parseJson<{ prototypes: StudioPrototype[] }>(res);
    return data.prototypes;
  },

  async get(projectId: string, id: string): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(protoPath(projectId, id));
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async create(
    projectId: string,
    input: { title?: string; brief: string; skills?: string[]; tokens?: StudioTokensPatch },
  ): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(protoPath(projectId), {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async update(
    projectId: string,
    id: string,
    patch: { title?: string; html?: string; notes?: string; handoff?: string; skills?: string[] },
  ): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(protoPath(projectId, id), {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async remove(projectId: string, id: string): Promise<void> {
    const res = await authenticatedFetch(protoPath(projectId, id), {
      method: 'DELETE',
    });
    await parseJson<{ success: boolean }>(res);
  },

  async appendTurn(
    projectId: string,
    id: string,
    input: { message: string; selectedElement?: StudioSelectedElement | null },
  ): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(`${protoPath(projectId, id)}/turns`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async generateVariants(
    projectId: string,
    id: string,
    input: { message?: string; count?: number; selectedElement?: StudioSelectedElement | null } = {},
  ): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(`${protoPath(projectId, id)}/variants`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async promoteVariant(
    projectId: string,
    id: string,
    variantId: string,
  ): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(
      `${protoPath(projectId, id)}/variants/${encodeURIComponent(variantId)}/promote`,
      { method: 'POST' },
    );
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async revertToVersion(
    projectId: string,
    id: string,
    versionId: string,
  ): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(
      `${protoPath(projectId, id)}/versions/${encodeURIComponent(versionId)}/revert`,
      { method: 'POST' },
    );
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async getTokens(projectId: string, id: string): Promise<StudioDesignTokens> {
    const res = await authenticatedFetch(`${protoPath(projectId, id)}/tokens`);
    const data = await parseJson<{ tokens: StudioDesignTokens }>(res);
    return data.tokens;
  },

  async updateTokens(
    projectId: string,
    id: string,
    input: { tokens: StudioTokensPatch; regenerate?: boolean },
  ): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(`${protoPath(projectId, id)}/tokens`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ prototype: StudioPrototypeDetail; tokens: StudioDesignTokens }>(res);
    return data.prototype;
  },

  async launchSwarm(projectId: string, id: string): Promise<{ swarmId: string; prototype: StudioPrototypeDetail }> {
    const res = await authenticatedFetch(`${protoPath(projectId, id)}/swarm`, {
      method: 'POST',
    });
    return parseJson<{ swarmId: string; prototype: StudioPrototypeDetail }>(res);
  },

  async ideatePrompt(projectId: string, id: string): Promise<{ prompt: string; prototype: StudioPrototypeDetail }> {
    const res = await authenticatedFetch(`${protoPath(projectId, id)}/ideate-prompt`);
    return parseJson<{ prompt: string; prototype: StudioPrototypeDetail }>(res);
  },

  async getSettings(): Promise<StudioSeatProfile[]> {
    const res = await authenticatedFetch('/api/studio/settings');
    const data = await parseJson<{ seats: StudioSeatProfile[] }>(res);
    return data.seats;
  },

  async saveSettings(seats: StudioSeatProfile[]): Promise<StudioSeatProfile[]> {
    const res = await authenticatedFetch('/api/studio/settings', {
      method: 'PUT',
      body: JSON.stringify({ seats }),
    });
    const data = await parseJson<{ seats: StudioSeatProfile[] }>(res);
    return data.seats;
  },
};

export type StudioApiClient = typeof studioApi;
