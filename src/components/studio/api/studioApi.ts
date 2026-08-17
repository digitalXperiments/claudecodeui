import { authenticatedFetch } from '../../../utils/api';
import type { StudioPrototype, StudioPrototypeDetail, StudioSeatProfile } from '../types';

export type { StudioSeatProfile };

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

export const studioApi = {
  async list(projectId: string): Promise<StudioPrototype[]> {
    const res = await authenticatedFetch(`/api/studio/${encodeURIComponent(projectId)}/prototypes`);
    const data = await parseJson<{ prototypes: StudioPrototype[] }>(res);
    return data.prototypes;
  },

  async get(projectId: string, id: string): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(`/api/studio/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(id)}`);
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async create(projectId: string, input: { title?: string; brief: string; skills?: string[] }): Promise<StudioPrototypeDetail> {
    const res = await authenticatedFetch(`/api/studio/${encodeURIComponent(projectId)}/prototypes`, {
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
    const res = await authenticatedFetch(`/api/studio/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    const data = await parseJson<{ prototype: StudioPrototypeDetail }>(res);
    return data.prototype;
  },

  async remove(projectId: string, id: string): Promise<void> {
    const res = await authenticatedFetch(`/api/studio/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await parseJson<{ success: boolean }>(res);
  },

  async launchSwarm(projectId: string, id: string): Promise<{ swarmId: string; prototype: StudioPrototypeDetail }> {
    const res = await authenticatedFetch(`/api/studio/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(id)}/swarm`, {
      method: 'POST',
    });
    return parseJson<{ swarmId: string; prototype: StudioPrototypeDetail }>(res);
  },

  async ideatePrompt(projectId: string, id: string): Promise<{ prompt: string; prototype: StudioPrototypeDetail }> {
    const res = await authenticatedFetch(`/api/studio/${encodeURIComponent(projectId)}/prototypes/${encodeURIComponent(id)}/ideate-prompt`);
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
