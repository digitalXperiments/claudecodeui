import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';
import type {
  ApiResponse,
  McpCatalogEntry,
  McpFormState,
  McpInventoryItem,
  McpScope,
  McpTransport,
} from '../types';
import { createMcpPayloadFromForm, getErrorMessage } from '../utils/mcpFormatting';

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
};

export function useMcpCatalog() {
  const [items, setItems] = useState<McpInventoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await authenticatedFetch('/api/providers/mcp/inventory');
      const data = await toResponseJson<ApiResponse<{ items: McpInventoryItem[] }>>(response);
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to load MCP inventory'));
      }
      setItems(Array.isArray(data.data.items) ? data.data.items : []);
    } catch (error) {
      setItems([]);
      setLoadError(error instanceof Error ? error.message : 'Failed to load MCP inventory');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsertFromForm = useCallback(async (
    formData: McpFormState,
    providers: LLMProvider[],
  ): Promise<McpCatalogEntry> => {
    // Use claude as a transport-capability reference for the payload builder.
    const payload = createMcpPayloadFromForm('claude', formData, {
      supportedTransports: ['stdio', 'http', 'sse'],
      includeProviderSpecificFields: true,
    });
    const response = await authenticatedFetch('/api/providers/mcp/catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, providers }),
    });
    const data = await toResponseJson<ApiResponse<{ server: McpCatalogEntry }>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to save MCP server'));
    }
    setSaveStatus('success');
    await refresh();
    return data.data.server;
  }, [refresh]);

  const setBindings = useCallback(async (name: string, providers: LLMProvider[]) => {
    const response = await authenticatedFetch(
      `/api/providers/mcp/catalog/${encodeURIComponent(name)}/bindings`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      },
    );
    const data = await toResponseJson<ApiResponse<{ server: McpCatalogEntry }>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to update MCP bindings'));
    }
    const server = data.data.server;
    const failed = (server.syncResults ?? []).filter((r) => !r.ok);
    if (failed.length > 0) {
      const detail = failed.map((r) => `${r.provider}: ${r.error || 'failed'}`).join('; ');
      setSaveStatus('error');
      await refresh();
      throw new Error(`Bindings saved, but fan-out failed for: ${detail}`);
    }
    setSaveStatus('success');
    await refresh();
    return server;
  }, [refresh]);

  const remove = useCallback(async (name: string) => {
    const response = await authenticatedFetch(
      `/api/providers/mcp/catalog/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
    const data = await toResponseJson<ApiResponse<{ removed: boolean }>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to remove MCP server'));
    }
    setSaveStatus('success');
    await refresh();
  }, [refresh]);

  const adopt = useCallback(async (
    name: string,
    fromProvider: LLMProvider,
    providers: LLMProvider[],
    options?: { scope?: McpScope; workspacePath?: string },
  ) => {
    const response = await authenticatedFetch('/api/providers/mcp/catalog/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        fromProvider,
        providers,
        scope: options?.scope,
        workspacePath: options?.workspacePath,
      }),
    });
    const data = await toResponseJson<ApiResponse<{ server: McpCatalogEntry }>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to adopt MCP server'));
    }
    setSaveStatus('success');
    await refresh();
    return data.data.server;
  }, [refresh]);

  return {
    items,
    isLoading,
    loadError,
    saveStatus,
    refresh,
    upsertFromForm,
    setBindings,
    remove,
    adopt,
    getErrorMessage,
  };
}

export type { McpTransport };
