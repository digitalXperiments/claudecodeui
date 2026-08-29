#!/usr/bin/env node
import './load-env.js';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const textResponse = (text: string) => ({
  content: [{ type: 'text', text }],
});

const jsonResponse = (value: unknown) => textResponse(JSON.stringify(value, null, 2));

const readString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const apiUrl = (process.env.CLOUDCLI_SESSION_MAILBOX_API_URL || 'http://127.0.0.1:3001/api/session-mailbox-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_SESSION_MAILBOX_MCP_TOKEN || '';
// The stable app session id this MCP server instance is running for. Set by
// whichever provider CLI spawned this process — see claude-sdk.js,
// grok-cli.js, and opencode-cli.js, which inject it into their own
// subprocess env so it is inherited by every MCP server they start.
const callerSessionId = process.env.CLOUDCLI_SESSION_ID || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_SESSION_MAILBOX_API_TIMEOUT_MS || '65000', 10);

async function callMailboxApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_SESSION_MAILBOX_MCP_TOKEN is not configured.');
  }
  if (!callerSessionId) {
    throw new Error(
      'CLOUDCLI_SESSION_ID is not set for this MCP server — the peer mailbox does not know which session is calling it.',
    );
  }

  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      'x-session-mailbox-session-id': callerSessionId,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Session Mailbox API request failed (${response.status})`);
  }
  return data.data;
}

const tools: ToolDefinition[] = [
  {
    name: 'list_peer_sessions',
    description: 'List other live CloudCLI chat sessions in this same project (excludes yourself and internal/automation sessions). Use this before send_peer_message to find a sessionId.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'send_peer_message',
    description: 'Send a message to another live session in this project. If the recipient is idle, this starts a new turn in its chat with your message. If it is busy, the message is either injected into its live run or queued to its inbox. Optionally wait up to 60s for a reply.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The recipient session id, from list_peer_sessions.' },
        message: { type: 'string', description: 'Message text, up to 8000 characters.' },
        waitMs: { type: 'number', description: 'Optional: wait up to this many milliseconds (max 60000) for a reply.' },
      },
      required: ['sessionId', 'message'],
    },
  },
  {
    name: 'check_peer_inbox',
    description: 'Check for peer messages that could not be delivered live (the recipient — you — was busy and no live inject was possible). Marks returned messages as read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reply_to_peer',
    description: 'Reply to a peer message by its messageId, threading the reply back to the session that sent it.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'The messageId being replied to.' },
        message: { type: 'string', description: 'Reply text, up to 8000 characters.' },
        waitMs: { type: 'number', description: 'Optional: wait up to this many milliseconds (max 60000) for a further reply.' },
      },
      required: ['messageId', 'message'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'list_peer_sessions':
      return jsonResponse(await callMailboxApi(name, {}));
    case 'send_peer_message':
      return jsonResponse(await callMailboxApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        message: readString(args.message, 'message'),
        waitMs: readNumber(args.waitMs),
      }));
    case 'check_peer_inbox':
      return jsonResponse(await callMailboxApi(name, {}));
    case 'reply_to_peer':
      return jsonResponse(await callMailboxApi(name, {
        messageId: readString(args.messageId, 'messageId'),
        message: readString(args.message, 'message'),
        waitMs: readNumber(args.waitMs),
      }));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-session-mailbox', version: '1.0.0' },
    };
  }

  if (message.method === 'tools/list') {
    return { tools };
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    const name = readString(params.name, 'name');
    const args = (params.arguments && typeof params.arguments === 'object'
      ? params.arguments
      : {}) as Record<string, unknown>;
    return callTool(name, args);
  }

  if (message.method.startsWith('notifications/')) {
    return undefined;
  }

  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>) {
  // MCP stdio transport uses newline-delimited JSON (one JSON-RPC message per line,
  // no embedded newlines). This is NOT the LSP Content-Length framing.
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
