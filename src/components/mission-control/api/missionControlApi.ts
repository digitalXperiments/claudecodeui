import { authenticatedFetch } from '../../../utils/api';

export type McAction = {
  id: string;
  label: string;
  kind: string;
  style: 'primary' | 'secondary' | 'destructive';
  terminal?: boolean;
};

export type McSection = {
  section_id: string;
  title: string;
  icon: string;
  sort_order: number;
  enabled: boolean;
  scope: 'global' | 'project';
  project_id: string | null;
  mode: 'review' | 'fire_and_forget';
  schedule_cron: string | null;
  provider: string;
  model: string | null;
  permission_mode: string;
  dry_run: boolean;
  auto_approve: boolean;
  produce_prompt: string;
  produce_tools: string[];
  resolve_prompt: string;
  resolve_tools: string[];
  actions: McAction[];
  last_run_at: string | null;
  last_run_error: string | null;
  created_at: string;
  updated_at: string;
};

export type McItem = {
  item_id: string;
  section_id: string;
  status: 'pending' | 'resolving' | 'resolved' | 'dismissed' | 'failed' | 'expired';
  title: string;
  summary: string;
  body: Record<string, unknown>;
  source: Record<string, unknown>;
  actions: McAction[];
  confidence: number;
  provider: string;
  model: string;
  dedupe_key: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type McSectionInput = {
  title: string;
  icon?: string;
  sort_order?: number;
  enabled?: boolean;
  scope?: 'global' | 'project';
  project_id?: string | null;
  mode?: 'review' | 'fire_and_forget';
  schedule_cron?: string | null;
  provider?: string;
  model?: string | null;
  permission_mode?: string;
  dry_run?: boolean;
  auto_approve?: boolean;
  produce_prompt?: string;
  produce_tools?: string[];
  resolve_prompt?: string;
  resolve_tools?: string[];
  actions?: McAction[];
};

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (data as { error?: string; message?: string }).error ||
      (data as { message?: string }).message ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export const missionControlApi = {
  async summary(): Promise<{ pendingCount: number; sectionCount: number }> {
    const res = await authenticatedFetch('/api/mission-control/summary');
    return parseJson(res);
  },

  async listSections(): Promise<McSection[]> {
    const res = await authenticatedFetch('/api/mission-control/sections');
    const data = await parseJson<{ sections: McSection[] }>(res);
    return data.sections ?? [];
  },

  async createSection(input: McSectionInput): Promise<McSection> {
    const res = await authenticatedFetch('/api/mission-control/sections', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ section: McSection }>(res);
    return data.section;
  },

  async updateSection(id: string, input: Partial<McSectionInput>): Promise<McSection> {
    const res = await authenticatedFetch(`/api/mission-control/sections/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    const data = await parseJson<{ section: McSection }>(res);
    return data.section;
  },

  async deleteSection(id: string): Promise<void> {
    const res = await authenticatedFetch(`/api/mission-control/sections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await parseJson(res);
  },

  async runSection(id: string): Promise<{
    created: number;
    skipped?: number;
    items: McItem[];
    error?: string;
    message?: string;
  }> {
    const res = await authenticatedFetch(
      `/api/mission-control/sections/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    );
    return parseJson(res);
  },

  async listItems(params?: {
    sectionId?: string;
    status?: string;
    limit?: number;
  }): Promise<{ items: McItem[]; pendingCount: number }> {
    const q = new URLSearchParams();
    if (params?.sectionId) q.set('sectionId', params.sectionId);
    if (params?.status) q.set('status', params.status);
    if (params?.limit) q.set('limit', String(params.limit));
    const res = await authenticatedFetch(`/api/mission-control/items?${q.toString()}`);
    return parseJson(res);
  },

  async applyAction(
    itemId: string,
    actionId: string,
    body?: Record<string, unknown>,
  ): Promise<{ item: McItem; pendingCount: number }> {
    const res = await authenticatedFetch(
      `/api/mission-control/items/${encodeURIComponent(itemId)}/actions`,
      {
        method: 'POST',
        body: JSON.stringify({ actionId, body }),
      },
    );
    return parseJson(res);
  },

  async importFromLegacy(path?: string): Promise<{
    path: string;
    imported: number;
    skipped: number;
    sections: string[];
    errors: string[];
  }> {
    const res = await authenticatedFetch('/api/mission-control/import', {
      method: 'POST',
      body: JSON.stringify(path ? { path } : {}),
    });
    return parseJson(res);
  },

  async importDefaultPath(): Promise<{ path: string | null; found: boolean }> {
    const res = await authenticatedFetch('/api/mission-control/import/default-path');
    return parseJson(res);
  },
};
