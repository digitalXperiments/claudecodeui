import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

export type WebhookSource = {
  source_id: string;
  source: string;
  name: string;
  description: string;
  enabled: boolean;
  provider: LLMProvider | string;
  model: string | null;
  prompt: string;
  permission_mode: string;
  mcp_tools: string[];
  skills: string[];
  profile_id: string | null;
  scope: 'global' | 'project';
  project_id: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookDelivery = {
  delivery_id: string;
  source_id: string;
  status: 'accepted' | 'running' | 'done' | 'failed' | string;
  request: Record<string, unknown>;
  app_session_id: string | null;
  error_message: string | null;
  result_preview: string | null;
  created_at: string;
  finished_at: string | null;
};

export type WebhookSourceInput = {
  source: string;
  name: string;
  description?: string;
  enabled?: boolean;
  provider?: string;
  model?: string | null;
  prompt?: string;
  permission_mode?: string;
  mcp_tools?: string[];
  skills?: string[];
  profile_id?: string | null;
  scope?: 'global' | 'project';
  project_id?: string | null;
};

const BASE = '/api/webhooks';

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

export const webhooksApi = {
  async list(): Promise<WebhookSource[]> {
    const res = await authenticatedFetch(BASE);
    const data = await parse<{ sources?: WebhookSource[] }>(res);
    return Array.isArray(data.sources) ? data.sources : [];
  },

  async create(input: WebhookSourceInput): Promise<WebhookSource> {
    const res = await authenticatedFetch(BASE, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parse<{ source: WebhookSource }>(res);
    return data.source;
  },

  async update(id: string, input: Partial<WebhookSourceInput>): Promise<WebhookSource> {
    const res = await authenticatedFetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    const data = await parse<{ source: WebhookSource }>(res);
    return data.source;
  },

  async remove(id: string): Promise<void> {
    const res = await authenticatedFetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await parse(res);
  },

  async listDeliveries(id: string, limit = 30): Promise<WebhookDelivery[]> {
    const res = await authenticatedFetch(
      `${BASE}/${encodeURIComponent(id)}/deliveries?limit=${limit}`,
    );
    const data = await parse<{ deliveries?: WebhookDelivery[] }>(res);
    return Array.isArray(data.deliveries) ? data.deliveries : [];
  },

  async test(
    id: string,
    body?: { text?: string; title?: string },
  ): Promise<{ deliveryId: string; appSessionId: string }> {
    const res = await authenticatedFetch(`${BASE}/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
    const data = await parse<{ deliveryId: string; appSessionId: string }>(res);
    return data;
  },
};
