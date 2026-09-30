import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { mcpCatalogService } from '@/modules/providers/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import type { LLMProvider } from '@/shared/types.js';

import type { GatewayCallToolResult, GatewayToolDescriptor } from './gateway.types.js';

/** Connection details for one upstream MCP server (structurally a catalog `ResolvedMcpServerConnection`). */
export interface UpstreamConnection {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** The slice of the MCP SDK `Client` the pool uses; tests connect a real Client to an in-memory fake server. */
export type UpstreamClient = Pick<Client, 'listTools' | 'callTool' | 'close'>;

export type UpstreamConnector = (connection: UpstreamConnection) => Promise<UpstreamClient>;
export type UpstreamResolver = (provider: string, server: string) => Promise<UpstreamConnection | null>;

export interface UpstreamPoolOptions {
  connector?: UpstreamConnector;
  resolver?: UpstreamResolver;
  toolTtlMs?: number;
  idleMs?: number;
  callTimeoutMs?: number;
}

const DEFAULT_TOOL_TTL_MS = 5 * 60_000;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Resolve a bot's upstream server. The catalog binding for the bot's provider is honoured
 * first; when that is absent (the normal case once the gateway replaces the provider's own
 * MCP config) the raw catalog definition is used. Provider-cloud connectors (claude.ai ...)
 * never live in the catalog and cannot be proxied.
 */
export const defaultUpstreamResolver: UpstreamResolver = async (provider, server) => {
  const bound = await mcpCatalogService.resolveForProvider(provider as LLMProvider, [server]);
  if (bound[0]) return bound[0];
  const raw = await mcpCatalogService.getRaw(server);
  if (!raw) return null;
  if (raw.transport === 'stdio') {
    if (!raw.command?.trim()) return null;
    return {
      name: raw.name,
      transport: 'stdio',
      command: raw.command,
      args: raw.args ?? [],
      env: secretsService.resolveInObject(raw.env ?? {}, { provider: provider as LLMProvider }),
      cwd: raw.cwd,
    };
  }
  if (!raw.url?.trim()) return null;
  return {
    name: raw.name,
    transport: raw.transport,
    url: raw.url,
    headers: secretsService.resolveInObject(raw.headers ?? {}, { provider: provider as LLMProvider }),
  };
};

async function connectWithTransport(transport: Transport): Promise<Client> {
  const client = new Client({ name: 'cloudcli-tool-gateway', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return client;
}

export const defaultUpstreamConnector: UpstreamConnector = async (connection) => {
  if (connection.transport === 'stdio') {
    return connectWithTransport(new StdioClientTransport({
      command: connection.command as string,
      args: connection.args ?? [],
      env: { ...getDefaultEnvironment(), ...(connection.env ?? {}) },
      cwd: connection.cwd,
      stderr: 'ignore',
    }));
  }
  const url = new URL(connection.url as string);
  const requestInit = connection.headers && Object.keys(connection.headers).length > 0
    ? { headers: connection.headers }
    : undefined;
  if (connection.transport === 'sse') {
    return connectWithTransport(new SSEClientTransport(url, { requestInit }));
  }
  try {
    return await connectWithTransport(new StreamableHTTPClientTransport(url, { requestInit }));
  } catch {
    // Older servers only speak the legacy SSE transport.
    return connectWithTransport(new SSEClientTransport(url, { requestInit }));
  }
};

interface PoolEntry {
  client: Promise<UpstreamClient>;
  tools?: { at: number; list: GatewayToolDescriptor[] };
  idleTimer?: NodeJS.Timeout;
}

export interface UpstreamPool {
  /** `botId` isolates connections per bot (env/secrets are resolved per provider+server, not shared across bots). */
  listTools(provider: string, server: string, botId?: string): Promise<GatewayToolDescriptor[]>;
  callTool(provider: string, server: string, tool: string, args: Record<string, unknown>, botId?: string): Promise<GatewayCallToolResult>;
  closeAll(): Promise<void>;
  /** Number of live upstream connections (diagnostics and tests). */
  size(): number;
}

export function createUpstreamPool(options: UpstreamPoolOptions = {}): UpstreamPool {
  const connector = options.connector ?? defaultUpstreamConnector;
  const resolver = options.resolver ?? defaultUpstreamResolver;
  const toolTtlMs = options.toolTtlMs ?? DEFAULT_TOOL_TTL_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const entries = new Map<string, PoolEntry>();

  async function drop(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const client = await entry.client.catch(() => null);
    await client?.close().catch(() => undefined);
  }

  function touch(key: string, entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => void drop(key), idleMs);
    entry.idleTimer.unref?.();
  }

  async function acquire(provider: string, server: string, botId = ''): Promise<{ key: string; entry: PoolEntry; client: UpstreamClient }> {
    const key = `${botId}\u0000${provider}\u0000${server}`;
    let entry = entries.get(key);
    if (!entry) {
      const created: PoolEntry = {
        client: (async () => {
          const connection = await resolver(provider, server);
          if (!connection) {
            throw new Error(`MCP server "${server}" is not available through the gateway (not in the catalog, or a provider-hosted connector that cannot be proxied).`);
          }
          return connector(connection);
        })(),
      };
      entries.set(key, created);
      entry = created;
    }
    try {
      const client = await entry.client;
      touch(key, entry);
      return { key, entry, client };
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
  }

  return {
    async listTools(provider, server, botId) {
      const { entry, client, key } = await acquire(provider, server, botId);
      if (entry.tools && Date.now() - entry.tools.at < toolTtlMs) return entry.tools.list;
      try {
        const list: GatewayToolDescriptor[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: callTimeoutMs });
          for (const tool of page.tools) {
            list.push({
              name: tool.name,
              description: tool.description,
              inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
              annotations: tool.annotations as Record<string, unknown> | undefined,
            });
          }
          cursor = page.nextCursor;
        } while (cursor);
        entry.tools = { at: Date.now(), list };
        return list;
      } catch (error) {
        await drop(key);
        throw error;
      }
    },

    async callTool(provider, server, tool, args, botId) {
      const { client, key } = await acquire(provider, server, botId);
      try {
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: callTimeoutMs });
        return result as GatewayCallToolResult;
      } catch (error) {
        // A timed-out or broken connection is discarded so the next call reconnects.
        await drop(key);
        throw error;
      }
    },

    async closeAll() {
      await Promise.all([...entries.keys()].map((key) => drop(key)));
    },

    size: () => entries.size,
  };
}

export const gatewayUpstreamPool: UpstreamPool = createUpstreamPool();
