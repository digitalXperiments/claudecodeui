#!/usr/bin/env node
import './load-env.js';
import { apiErrorMessage } from './shared/api-error-message.js';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

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

const taskSchema = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Bounded assignment with scope, constraints, and requested evidence.' },
    label: { type: 'string', description: 'Short display name (max 80 chars) used in status listings, session titles, and dependency references. Always set one — it keeps fleet views readable.' },
    provider: { type: 'string', description: 'Optional worker provider. Omit for round-robin routing across allowed workers.' },
    model: { type: 'string', description: 'Optional provider model id from relay_capabilities (Settings may allowlist a subset). Omit to use the allowlisted default, or the provider default when unrestricted.' },
    effort: { type: 'string', description: 'Optional model-supported effort/reasoning level from relay_capabilities.' },
    mode: { type: 'string', enum: ['read_only', 'isolated_write'], description: 'read_only inspects the project; isolated_write gets a separate worktree.' },
    approvalPolicy: { type: 'string', enum: ['auto', 'manual'], description: 'auto (default) never parks the lead: in-envelope actions run, everything else is denied and the worker reports the blocker. manual is the only policy that asks the lead before isolated-worktree writes or risky actions. Prefer auto.' },
    timeoutMs: { type: 'number', description: 'Optional per-worker timeout in milliseconds.' },
    mcpServers: { type: 'array', items: { type: 'string' }, description: 'Optional CloudCLI MCP catalog server names for the worker. Only providers reporting honorsMcpGrants in relay_capabilities apply these.' },
    outputSchema: { type: 'object', description: 'Optional JSON Schema (subset: type/properties/required/items/enum/anyOf) the worker\'s structured "data" output must satisfy. Validated server-side; one automatic repair turn is sent on violation, and the verdict is reported as result.outputValidation.' },
    dependsOn: { type: 'array', items: { type: 'number' }, description: 'Zero-based indices of earlier tasks in this same batch. The task stays queued until they complete, and their summaries plus structured outputs are injected into its prompt — a one-call pipeline. If a dependency fails, this task fails fast.' },
    retries: { type: 'number', description: 'Automatic re-dispatches (0-2, default 0) after an infrastructure failure that produced no output. A fresh worker session is used per retry.' },
  },
  required: ['task'],
};

const tools: ToolDefinition[] = [
  {
    name: 'relay_delegate',
    description: 'Lead orchestrator only: launch up to 20 worker tasks (optional dependsOn pipelines) instead of doing the work yourself. Returns immediately with durable relay ids. Do not grep, edit, test, or implement in the lead session — dispatch a worker. Delegated workers must not call this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Absolute project path. Defaults to the MCP process working directory.' },
        tasks: { type: 'array', minItems: 1, maxItems: 20, items: taskSchema },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'relay_status',
    description: 'Read compact status summaries (label, provider, requested/selected/resolved model identity, effort, status, result summary, token usage, pending approvals) for this chat\'s relay jobs. Omit ids to list every relay this chat owns. Fetch one job\'s full raw output with relay_result.',
    inputSchema: {
      type: 'object',
      properties: {
        relayId: { type: 'string' },
        relayIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'relay_wait',
    description: 'Wait up to 60 seconds for any or all requested relay jobs; returns compact summaries. Harvest incrementally: pass only unfinished ids with returnWhen "any". Returns immediately if a worker is blocked on a permission request you must answer with relay_approve or relay_deny.',
    inputSchema: {
      type: 'object',
      properties: {
        relayIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        returnWhen: { type: 'string', enum: ['any', 'all'], default: 'any' },
        timeoutMs: { type: 'number', maximum: 60000, default: 30000 },
      },
      required: ['relayIds'],
    },
  },
  {
    name: 'relay_result',
    description: 'Fetch one finished job\'s complete result with provider, requested/selected/resolved model identity, effort, full summary, evidence, validated structured output, and the worker\'s raw final output (can be large — pull one job at a time, not the whole fleet).',
    inputSchema: {
      type: 'object',
      properties: {
        relayId: { type: 'string' },
        includeOutput: { type: 'boolean', default: true, description: 'Set false to omit the raw output text and keep only the structured fields.' },
      },
      required: ['relayId'],
    },
  },
  {
    name: 'relay_follow_up',
    description: 'Send the delegate additional instructions — works both mid-session (running, queued, or parked on an approval; delivered into its live turn or, failing that, as the prompt for its very next turn, without waiting for it to finish) and after it has finished (resumes the session for another attempt). The worker keeps its context; the declared outputSchema still applies.',
    inputSchema: {
      type: 'object',
      properties: { relayId: { type: 'string' }, prompt: { type: 'string' }, timeoutMs: { type: 'number' } },
      required: ['relayId', 'prompt'],
    },
  },
  {
    name: 'relay_cancel',
    description: 'Cancel a queued or running relay job. Partial findings are preserved as a blocked result when the worker had produced output.',
    inputSchema: { type: 'object', properties: { relayId: { type: 'string' } }, required: ['relayId'] },
  },
  {
    name: 'relay_diff',
    description: 'Inspect the changed files and optional bounded patches from an isolated-write relay job. This never merges changes.',
    inputSchema: {
      type: 'object',
      properties: { relayId: { type: 'string' }, includePatch: { type: 'boolean', default: false } },
      required: ['relayId'],
    },
  },
  {
    name: 'relay_peek',
    description: 'See what a running worker is actually doing right now: elapsed time, idle time, tool-call trail, a live tail of its streamed prose (recentOutput), and any pending approval. Use this instead of waiting blindly on a long job.',
    inputSchema: {
      type: 'object',
      properties: {
        relayId: { type: 'string' },
        limit: { type: 'number', description: 'How many recent activity entries to return (default 20, max 100).' },
      },
      required: ['relayId'],
    },
  },
  {
    name: 'relay_pending_approvals',
    description: 'List worker permission requests that fell outside the task\'s declared envelope and are waiting on your decision. A blocked worker stays parked until you answer or the approval budget expires.',
    inputSchema: {
      type: 'object',
      properties: { relayId: { type: 'string', description: 'Optional: only this job\'s pending requests.' } },
    },
  },
  {
    name: 'relay_approve',
    description: 'Approve one pending worker permission request. Only jobs dispatched with approvalPolicy "manual" park; auto jobs never wait on you. Approve only what the assignment genuinely needs.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string' },
        reason: { type: 'string', description: 'Short justification recorded in the audit trail.' },
      },
      required: ['approvalId'],
    },
  },
  {
    name: 'relay_deny',
    description: 'Deny one pending worker permission request. The worker resumes with the denial reason and can report the blocker instead of stalling.',
    inputSchema: {
      type: 'object',
      properties: {
        approvalId: { type: 'string' },
        reason: { type: 'string', description: 'Short explanation handed to the worker.' },
      },
      required: ['approvalId'],
    },
  },
  {
    name: 'relay_capabilities',
    description: 'Call this before any repo work. Lists allowed worker providers, model catalogs, defaults, effort levels, seats (readOnlyPlanSeat, honorsMcpGrants), and hard limits. The lead is an orchestrator: after this call, dispatch with relay_delegate rather than searching or editing locally.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callApi(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  if (!apiToken) throw new Error('CLOUDCLI_AGENT_RELAY_MCP_TOKEN is not configured. Enable Agent Relay in CloudCLI Settings.');
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
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
    return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cloudcli-agent-relay', version: '1.0.0' } };
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
      sourceSessionId: leadSessionId || undefined,
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
