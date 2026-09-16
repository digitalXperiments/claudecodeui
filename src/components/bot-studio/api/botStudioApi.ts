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
  createSection: missionControlApi.createSection,
  updateSection: missionControlApi.updateSection,
  deleteSection: missionControlApi.deleteSection,
  runSection: missionControlApi.runSection,
  applyAction: missionControlApi.applyAction,
  retryItem: missionControlApi.retryItem,
  previewItem: missionControlApi.previewItem,
  generateAssets: missionControlApi.generateAssets,
  workThis: missionControlApi.workThis,
  importFromLegacy: missionControlApi.importFromLegacy,
  importDefaultPath: missionControlApi.importDefaultPath,
  bulkUpdate: missionControlApi.bulkUpdate,
  listRuns: async (sectionId: string, limit = 30): Promise<BotRun[]> => {
    const result = await missionControlApi.listRuns(sectionId, limit);
    return result.runs ?? [];
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
