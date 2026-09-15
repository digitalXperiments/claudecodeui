import { authenticatedFetch } from '../../../utils/api';

export type CloudcliHook = {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
  event: 'session_start';
  instruction: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
};

export type CloudcliHookInput = {
  name: string;
  instruction: string;
  enabled?: boolean;
  event?: 'session_start';
  provider?: string;
};

const BASE = '/api/hooks-catalog';

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorObj = (payload as { error?: unknown })?.error;
    const message =
      (errorObj &&
      typeof errorObj === 'object' &&
      typeof (errorObj as { message?: string }).message === 'string'
        ? (errorObj as { message: string }).message
        : typeof errorObj === 'string'
          ? errorObj
          : typeof (payload as { message?: string })?.message === 'string'
            ? (payload as { message: string }).message
            : null) || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

type Envelope<T> = { success: boolean; data: T };

export const hooksApi = {
  async list(): Promise<CloudcliHook[]> {
    const response = await authenticatedFetch(BASE);
    const payload = await parse<Envelope<{ hooks: CloudcliHook[] }>>(response);
    return payload.data?.hooks ?? [];
  },

  async create(input: CloudcliHookInput): Promise<CloudcliHook> {
    const response = await authenticatedFetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await parse<Envelope<{ hook: CloudcliHook }>>(response);
    return payload.data.hook;
  },

  async update(id: string, input: Partial<CloudcliHookInput>): Promise<CloudcliHook> {
    const response = await authenticatedFetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await parse<Envelope<{ hook: CloudcliHook }>>(response);
    return payload.data.hook;
  },

  async remove(id: string): Promise<void> {
    const response = await authenticatedFetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await parse<Envelope<{ ok: boolean }>>(response);
  },
};
