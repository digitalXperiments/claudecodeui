#!/usr/bin/env node
import './load-env.js';
import { apiErrorMessage } from './shared/api-error-message.js';
import { AGENT_RELAY_MCP_SERVER_NAME, AGENT_RELAY_MCP_TOOLS } from './shared/agent-relay-mcp-tools.js';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

const apiUrl = (process.env.CLOUDCLI_AGENT_RELAY_API_URL || 'http://127.0.0.1:3001/api/agent-relay-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_AGENT_RELAY_MCP_TOKEN || '';

/**
 * The CloudCLI chat session that launched the provider run that launched this
 * MCP process. CloudCLI injects it into the provider's environment, and the
 * stdio child inherits it, so every call can be attributed to one lead chat.
 *
 * Without this, every relay job looks like it came from nowhere and every lead
 * sees every other lead's workers.
 */
const leadSessionId = (process.env.CLOUDCLI_LEAD_SESSION_ID || '').trim();
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_AGENT_RELAY_API_TIMEOUT_MS || '70000', 10);

const tools = AGENT_RELAY_MCP_TOOLS;

async function callApi(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  if (!apiToken) throw new Error('CLOUDCLI_AGENT_RELAY_MCP_TOKEN is not configured. Enable Agent Relay in CloudCLI Settings.');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
  if (leadSessionId) headers['X-CloudCLI-Lead-Session-Id'] = leadSessionId;
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const payload = await response.json() as { success?: boolean; data?: unknown; error?: unknown; message?: unknown };
  if (!response.ok || payload.success === false) {
    throw new Error(apiErrorMessage(payload, `Agent Relay API failed (${response.status}).`));
  }
  return payload.data;
}

async function handleMessage(message: JsonRpcRequest): Promise<unknown> {
  if (message.method === 'initialize') {
    return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: AGENT_RELAY_MCP_SERVER_NAME, version: '1.0.0' } };
  }
  if (message.method === 'tools/list') return { tools };
  if (message.method === 'tools/call') {
    const params = message.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    if (!name) throw new Error('Tool name is required.');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {};
    // Identity is ambient, never model-supplied: a lead cannot claim to be a
    // different session in order to reach another chat's workers.
    const data = await callApi(name, {
      ...args,
      projectPath: args.projectPath || process.cwd(),
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
  if (message.method.startsWith('notifications/')) return undefined;
  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const raw = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!raw) continue;
    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(raw) as JsonRpcRequest;
        const result = await handleMessage(request);
        if (request.id !== undefined) writeMessage({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        let id: string | number | null = null;
        try { id = (JSON.parse(raw) as JsonRpcRequest).id ?? null; } catch { /* malformed JSON */ }
        writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
      }
    })();
  }
});
