import { authenticatedFetch } from '../../../utils/api';
import type { McpCatalogEntry } from '../../mcp/types';

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolsResult = {
  tools: McpToolInfo[];
  error?: string;
  cached?: boolean;
};

async function readData<T>(response: Response): Promise<T> {
  const body = await response.json() as { success?: boolean; data?: T; error?: { message?: string } | string };
  if (!response.ok || body.success === false) {
    const error = body.error;
    const message = typeof error === 'string' ? error : error?.message;
    throw new Error(message || 'Request failed.');
  }
  return body.data as T;
}

export const mcpToolsApi = {
  async listCatalog(): Promise<McpCatalogEntry[]> {
    const response = await authenticatedFetch('/api/providers/mcp/catalog');
    const data = await readData<{ servers: McpCatalogEntry[] }>(response);
    return data.servers;
  },
  async listTools(name: string): Promise<McpToolsResult> {
    const response = await authenticatedFetch(`/api/providers/mcp/catalog/${encodeURIComponent(name)}/tools`);
    return readData<McpToolsResult>(response);
  },
};
