import { authenticatedFetch } from '../../../utils/api';
import {
  missionControlApi,
  type CreateMcSectionInput,
  type McItem,
  type McSection,
} from '../../mission-control/api/missionControlApi';

export type BotRun = {
  run_id: string;
  status: string;
  trigger?: string;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  error_summary?: string | null;
  kind?: string;
  item_id?: string | null;
  tokens?: number | null;
  cost_usd?: number | null;
};

export type BotRunRecord = {
  run_id: string;
  source: string;
  source_ref?: string | null;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  permission_mode?: string | null;
  status: string;
  trigger?: string | null;
  title?: string | null;
  error_summary?: string | null;
  exit_code?: number | null;
  token_input?: number | null;
  token_output?: number | null;
  token_total?: number | null;
  cost_usd_estimate?: number | null;
  started_at?: string | null;
  first_token_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  meta?: Record<string, unknown>;
};

export type BotRunEvent = {
  event_id: string;
  run_id: string;
  ts: string;
  source: string;
  type: string;
  severity?: 'debug' | 'info' | 'warn' | 'error';
  payload: Record<string, unknown>;
  seq?: number;
};

export type BotRunTimeline = {
  run: BotRunRecord;
  events: BotRunEvent[];
};

export type BotTickSimulation = {
  mode: 'review' | 'fire_and_forget';
  status: 'ready' | 'disabled' | 'missing_prompt';
  message: string;
  counts: {
    candidates: number;
    invalid: number;
    filtered: number;
    wouldCreate: number;
    skipped: number;
  };
  drafts: Array<{
    title: string;
    summary: string;
    body: Record<string, unknown>;
    dedupeKey: string | null;
    confidence: number;
    outcome: 'would_create' | 'would_log' | 'already_seen' | 'repeated_in_output';
    nextStep: 'review' | 'auto_approve' | 'resolved' | null;
    reason?: string;
  }>;
};

export type BotVersionHistory = {
  unversionedRuns: number;
  versions: Array<{
    version: number;
    origin: 'created' | 'edited' | 'baseline';
    createdAt: string;
    config: Record<string, unknown>;
    scorecard: {
      ticks: number; succeeded: number; failed: number; aborted: number; active: number;
      successRate: number | null; totalTokens: number | null; runsWithTokens: number;
      totalCostUsd: number | null; runsWithCost: number; avgDurationMs: number | null;
      latestRunAt: string | null;
      recentRuns: Array<{ runId: string; status: string; createdAt: string; tokenTotal: number | null; costUsd: number | null }>;
    };
  }>;
};

export type BotMemory = {
  memoryId: string; sectionId: string; content: string; status: 'proposed' | 'approved' | 'rejected';
  sourceItemId: string | null; createdAt: string; updatedAt: string;
};

export type BotException = {
  id: string; kind: 'failed_tick' | 'failed_item' | 'stale_approval'; sectionId: string;
  botTitle: string; itemId: string | null; runId: string | null;
  title: string; detail: string; at: string;
};

export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; fromPolicy?: boolean };
export type McpToolsResult = McpTool[] & { error?: string };

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const record = payload as { error?: string | { message?: string }; message?: string };
    const error = typeof record.error === 'string' ? record.error : record.error?.message;
    throw new Error(error || record.message || `Request failed (${response.status})`);
  }
  return payload as T;
}

export const botStudioApi = {
  listSections: missionControlApi.listSections,
  summary: missionControlApi.summary,
  listItems: missionControlApi.listItems,
  async getItem(itemId: string): Promise<McItem> {
    const response = await authenticatedFetch(`/api/mission-control/items/${encodeURIComponent(itemId)}`);
    return (await readJson<{ item: McItem }>(response)).item;
  },
  createSection: missionControlApi.createSection,
  updateSection: missionControlApi.updateSection,
  deleteSection: missionControlApi.deleteSection,
  runSection: missionControlApi.runSection,
  applyAction: missionControlApi.applyAction,
  retryItem: missionControlApi.retryItem,
  previewItem: missionControlApi.previewItem,
  generateAssets: missionControlApi.generateAssets,
  workThis: missionControlApi.workThis,
  workMatches: missionControlApi.workMatches,
  importFromLegacy: missionControlApi.importFromLegacy,
  importDefaultPath: missionControlApi.importDefaultPath,
  bulkUpdate: missionControlApi.bulkUpdate,
  listRuns: async (sectionId: string, limit = 30): Promise<BotRun[]> => {
    const result = await missionControlApi.listRuns(sectionId, limit);
    return result.runs ?? [];
  },
  async cancelRun(runId: string): Promise<{ success: boolean }> {
    const response = await authenticatedFetch(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' });
    return readJson(response);
  },
  async getRunTimeline(runId: string): Promise<BotRunTimeline> {
    const encoded = encodeURIComponent(runId);
    const [runResponse, eventsResponse] = await Promise.all([
      authenticatedFetch('/api/runs/' + encoded),
      authenticatedFetch('/api/runs/' + encoded + '/events?limit=500'),
    ]);
    const [runPayload, eventsPayload] = await Promise.all([
      readJson<{ success?: boolean; run: BotRunRecord }>(runResponse),
      readJson<{ success?: boolean; events: BotRunEvent[] }>(eventsResponse),
    ]);
    return {
      run: runPayload.run,
      events: Array.isArray(eventsPayload.events) ? eventsPayload.events : [],
    };
  },
  async simulateTick(sectionId: string, output: string): Promise<BotTickSimulation> {
    const response = await authenticatedFetch(
      `/api/mission-control/sections/${encodeURIComponent(sectionId)}/simulate`,
      { method: 'POST', body: JSON.stringify({ output }) },
    );
    return readJson<BotTickSimulation>(response);
  },
  async getVersionHistory(sectionId: string): Promise<BotVersionHistory> {
    const response = await authenticatedFetch(`/api/mission-control/sections/${encodeURIComponent(sectionId)}/versions`);
    return readJson<BotVersionHistory>(response);
  },
  async listMemories(sectionId: string): Promise<BotMemory[]> {
    const response = await authenticatedFetch(`/api/mission-control/sections/${encodeURIComponent(sectionId)}/memories`);
    return (await readJson<{ memories: BotMemory[] }>(response)).memories;
  },
  async proposeMemory(sectionId: string, content: string, sourceItemId?: string): Promise<BotMemory> {
    const response = await authenticatedFetch(`/api/mission-control/sections/${encodeURIComponent(sectionId)}/memories`, {
      method: 'POST', body: JSON.stringify({ content, sourceItemId }),
    });
    return (await readJson<{ memory: BotMemory }>(response)).memory;
  },
  async reviewMemory(sectionId: string, memoryId: string, status: BotMemory['status'], content?: string): Promise<BotMemory> {
    const response = await authenticatedFetch(`/api/mission-control/sections/${encodeURIComponent(sectionId)}/memories/${encodeURIComponent(memoryId)}`, {
      method: 'PATCH', body: JSON.stringify({ status, content }),
    });
    return (await readJson<{ memory: BotMemory }>(response)).memory;
  },
  async listExceptions(): Promise<BotException[]> {
    const response = await authenticatedFetch('/api/mission-control/exceptions');
    return (await readJson<{ exceptions: BotException[] }>(response)).exceptions;
  },
  async listMcpTools(name: string): Promise<McpToolsResult> {
    const response = await authenticatedFetch(`/api/providers/mcp/catalog/${encodeURIComponent(name)}/tools`);
    const payload = await readJson<{ success?: boolean; data?: { tools?: McpTool[]; error?: string } }>(response);
    if (payload.success === false) throw new Error('Failed to load MCP tools.');
    return Object.assign(
      Array.isArray(payload.data?.tools) ? payload.data.tools : [],
      { error: payload.data?.error },
    );
  },
  async listMcpInventory(): Promise<Array<{ name: string; displayName?: string; connected?: boolean; needsAuth?: boolean }>> {
    const response = await authenticatedFetch('/api/providers/mcp/inventory?phase=fast');
    const payload = await readJson<{ data?: { items?: Array<{ name: string; displayName?: string; connected?: boolean; needsAuth?: boolean }> }; items?: Array<{ name: string; displayName?: string; connected?: boolean; needsAuth?: boolean }> }>(response);
    return payload.data?.items ?? payload.items ?? [];
  },
};

export type { CreateMcSectionInput, McItem, McSection };
