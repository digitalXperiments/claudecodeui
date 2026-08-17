import { useCallback, useEffect, useRef, useState } from 'react';

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

type InventoryPayload = {
  items: McpInventoryItem[];
  phase?: 'fast' | 'full';
  partial?: boolean;
  warnings?: string[];
};

/**
 * Progressive MCP inventory:
 *  1. Fast path (catalog + on-disk configs) paints immediately.
 *  2. Full path enriches with claude.ai / grok.com account connectors.
 *  3. Stale rows stay visible while refreshing — never blank the panel.
 */
export function useMcpCatalog() {
  const [items, setItems] = useState<McpInventoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [phase, setPhase] = useState<'idle' | 'fast' | 'full'>('idle');
  const [warnings, setWarnings] = useState<string[]>([]);
  const generationRef = useRef(0);

  const fetchInventory = useCallback(async (
    nextPhase: 'fast' | 'full',
    options?: { refresh?: boolean },
  ): Promise<InventoryPayload> => {
    const params = new URLSearchParams({ phase: nextPhase });
    if (options?.refresh) params.set('refresh', '1');
    const response = await authenticatedFetch(`/api/providers/mcp/inventory?${params.toString()}`);
    const data = await toResponseJson<ApiResponse<InventoryPayload>>(response);
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to load MCP inventory'));
    }
    return {
      items: Array.isArray(data.data.items) ? data.data.items : [],
      phase: data.data.phase,
      partial: data.data.partial,
      warnings: Array.isArray(data.data.warnings) ? data.data.warnings : [],
    };
  }, []);

  const refresh = useCallback(async (options?: { full?: boolean; bypassCache?: boolean }) => {
    const gen = ++generationRef.current;
    const wantFull = options?.full !== false;
    setIsLoading(true);
    setLoadError(null);
    setWarnings([]);

    try {
      // Always paint the fast path first so catalog servers appear instantly.
      const fast = await fetchInventory('fast');
      if (gen !== generationRef.current) return;
      setItems(fast.items);
      setPhase('fast');
      setIsLoading(false);
      setWarnings(fast.warnings ?? []);

      if (!wantFull) return;

      setIsEnriching(true);
      try {
        const full = await fetchInventory('full', { refresh: options?.bypassCache });
        if (gen !== generationRef.current) return;
        const incomingCloud = full.items.filter((item) => item.source === 'provider_cloud');
        setItems((prev) => {
          if (incomingCloud.length === 0) {
            const prevCloud = prev.filter((item) => item.source === 'provider_cloud');
            if (prevCloud.length > 0) {
              return [
                ...full.items.filter((item) => item.source !== 'provider_cloud'),
                ...prevCloud,
              ];
            }
          }
          return full.items;
        });
        setPhase('full');
        setWarnings(full.warnings ?? []);
      } catch (error) {
        // Keep fast results; surface enrichment failure softly.
        if (gen !== generationRef.current) return;
        setLoadError(
          error instanceof Error
            ? `Local inventory loaded; account connectors failed: ${error.message}`
            : 'Local inventory loaded; account connectors failed',
        );
      } finally {
        if (gen === generationRef.current) {
          setIsEnriching(false);
        }
      }
    } catch (error) {
      if (gen !== generationRef.current) return;
      // Only clear items when we had nothing to show (avoid flash-to-empty).
      setItems((prev) => prev);
      setLoadError(error instanceof Error ? error.message : 'Failed to load MCP inventory');
      setIsLoading(false);
      setIsEnriching(false);
    }
  }, [fetchInventory]);

  useEffect(() => {
    void refresh({ full: true });
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
    // Mutations only need the fast path — bindings are catalog-owned.
    await refresh({ full: false });
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
      await refresh({ full: false });
      throw new Error(`Bindings saved, but fan-out failed for: ${detail}`);
    }
    setSaveStatus('success');
    await refresh({ full: false });
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
    await refresh({ full: false });
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
    await refresh({ full: false });
    return data.data.server;
  }, [refresh]);

  return {
    items,
    isLoading,
    isEnriching,
    loadError,
    saveStatus,
    phase,
    warnings,
    refresh,
    upsertFromForm,
    setBindings,
    remove,
    adopt,
    getErrorMessage,
  };
}

export type { McpTransport };
