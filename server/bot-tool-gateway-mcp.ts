#!/usr/bin/env node
import './load-env.js';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

const apiUrl = (process.env.CLOUDCLI_BOT_GATEWAY_API_URL || 'http://127.0.0.1:3001/api/bot-gateway-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_BOT_GATEWAY_MCP_TOKEN || '';
// The app session this stdio child serves. CLOUDCLI_SESSION_ID is stamped on the provider
// CLI's spawn env (claude-sdk.js, grok-cli.js, ...); CLOUDCLI_LEAD_SESSION_ID is the
// per-server stamp some runtimes (OpenCode ACP, Claude mcpServers env) use instead.
const callerSessionId = (process.env.CLOUDCLI_SESSION_ID || process.env.CLOUDCLI_LEAD_SESSION_ID || '').trim();
// Must exceed the gateway's human-approval wait (10 minutes by default).
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_BOT_GATEWAY_API_TIMEOUT_MS || '660000', 10);

async function callGatewayApi(route: 'tools/list' | 'tools/call', body: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_BOT_GATEWAY_MCP_TOKEN is not configured.');
  }
  const response = await fetch(`${apiUrl}/${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      'x-bot-gateway-session-id': callerSessionId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Bot Tool Gateway request failed (${response.status})`);
  }
  return data.data;
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-tool-gateway', version: '1.0.0' },
    };
  }

  if (message.method === 'ping') {
    return {};
  }

  if (message.method === 'tools/list') {
    return callGatewayApi('tools/list', {});
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    if (typeof params.name !== 'string' || !params.name) {
      throw new Error('name is required.');
    }
    return callGatewayApi('tools/call', { name: params.name, arguments: params.arguments ?? {} });
  }

  if (message.method.startsWith('notifications/')) {
    return undefined;
  }

  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>) {
  // MCP stdio transport is newline-delimited JSON, not LSP Content-Length framing.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: string | number | null | undefined, result: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number | null | undefined, error: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const rawMessage = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!rawMessage) {
      continue;
    }

    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(rawMessage) as JsonRpcRequest;
      } catch (error) {
        sendError(null, error);
        return;
      }
      try {
        const result = await handleMessage(request);
        sendResult(request.id, result);
      } catch (error) {
        sendError(request.id, error);
      }
    })();
  }
});
