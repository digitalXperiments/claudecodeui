import { spawn, type ChildProcess } from 'node:child_process';

import { AGENT_RELAY_MCP_SERVER_NAME, AGENT_RELAY_MCP_TOOLS } from '@/shared/agent-relay-mcp-tools.js';
import { secretsService } from '@/modules/secrets/index.js';
import { mcpCatalogService } from '@/modules/providers/services/mcp-catalog.service.js';

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

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;

const cache = new Map<string, { expiresAt: number; result: McpToolsResult }>();

const isToolList = (value: unknown): value is McpToolInfo[] => (
  Array.isArray(value) && value.every((entry) => entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string')
);

/**
 * Speak just enough MCP stdio JSON-RPC to list tools: initialize, then
 * tools/list, then kill the child. Not a general-purpose MCP client.
 */
async function probeStdio(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  cwd: string | undefined,
): Promise<McpToolInfo[]> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...(env ?? {}) },
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Failed to spawn MCP server.'));
      return;
    }

    let settled = false;
    let buffer = '';

    const timer = setTimeout(() => {
      settle(() => reject(new Error('Timed out waiting for the MCP server to respond to tools/list.')));
    }, PROBE_TIMEOUT_MS);

    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      run();
    };

    child.on('error', (error) => settle(() => reject(error)));
    child.on('exit', () => settle(() => reject(new Error('MCP server exited before responding to tools/list.'))));

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!raw) continue;
        let message: { id?: number; result?: { tools?: unknown }; error?: { message?: string } };
        try {
          message = JSON.parse(raw);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        if (message.error) {
          settle(() => reject(new Error(message.error?.message || 'tools/list failed.')));
        } else {
          const listedTools = message.result?.tools;
          settle(() => resolve(isToolList(listedTools) ? listedTools : []));
        }
      }
    });

    const write = (payload: Record<string, unknown>) => {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
    };
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cloudcli-mcp-tools-explorer', version: '1.0.0' },
      },
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

/** Streamable-HTTP MCP transport: JSON-RPC over POST, JSON or SSE response. */
async function probeHttp(url: string, headers: Record<string, string> | undefined): Promise<McpToolInfo[]> {
  const post = async (body: Record<string, unknown>): Promise<{ result?: unknown; error?: { message?: string } }> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP server responded with ${response.status}.`);
    }
    const dataLine = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .find(Boolean) ?? text.trim();
    if (!dataLine) return {};
    return JSON.parse(dataLine) as { result?: unknown; error?: { message?: string } };
  };

  await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cloudcli-mcp-tools-explorer', version: '1.0.0' },
    },
  });
  const listResponse = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  if (listResponse.error) {
    throw new Error(listResponse.error.message || 'tools/list failed.');
  }
  const listedTools = (listResponse.result as { tools?: unknown } | undefined)?.tools;
  return isToolList(listedTools) ? listedTools : [];
}

export const mcpToolsProbeService = {
  clearCache(name?: string): void {
    if (name) cache.delete(name);
    else cache.clear();
  },

  /**
   * List a catalog server's tools. `cloudcli-agent-relay` is answered from
   * the in-process tool catalog (never spawned). Everything else is probed
   * live (spawn/connect + tools/list) and cached for ~60s, including
   * failures, so a flaky server does not get re-probed on every render.
   */
  async listTools(name: string): Promise<McpToolsResult> {
    const trimmed = name.trim();
    if (!trimmed) {
      return { tools: [], error: 'Server name is required.' };
    }

    if (trimmed === AGENT_RELAY_MCP_SERVER_NAME) {
      return { tools: AGENT_RELAY_MCP_TOOLS };
    }

    const cached = cache.get(trimmed);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true };
    }

    const def = await mcpCatalogService.getRaw(trimmed);
    if (!def) {
      const result: McpToolsResult = { tools: [], error: 'Server not found in the CloudCLI MCP catalog.' };
      cache.set(trimmed, { expiresAt: Date.now() + CACHE_TTL_MS, result });
      return result;
    }
    if (def.kind === 'agent-relay') {
      return { tools: AGENT_RELAY_MCP_TOOLS };
    }

    let result: McpToolsResult;
    try {
      let tools: McpToolInfo[];
      if (def.transport === 'stdio') {
        if (!def.command?.trim()) throw new Error('This server has no command configured.');
        tools = await probeStdio(
          def.command,
          def.args ?? [],
          secretsService.resolveInObject(def.env ?? {}),
          def.cwd,
        );
      } else {
        if (!def.url?.trim()) throw new Error('This server has no URL configured.');
        tools = await probeHttp(def.url, secretsService.resolveInObject(def.headers ?? {}));
      }
      result = { tools };
    } catch (error) {
      result = { tools: [], error: error instanceof Error ? error.message : 'Failed to list tools.' };
    }
    cache.set(trimmed, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    return result;
  },
};
