import { proposeBotMemory } from '@/modules/mission-control/index.js';

import type { GatewayCallToolResult, GatewayToolRegistration } from './gateway.types.js';
import { FIRST_PARTY_PREFIX } from './tool-names.js';

const registry = new Map<string, GatewayToolRegistration>();

export const textResult = (text: string, isError = false): GatewayCallToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Register a first-party gateway tool. Names must start with `bot__`; they bypass the
 * upstream pool. Tools whose `risk` is more than `read`/`draft` still go through the gate.
 */
export function registerGatewayTool(name: string, registration: GatewayToolRegistration): void {
  if (!name.startsWith(FIRST_PARTY_PREFIX) || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`First-party gateway tools must be named "${FIRST_PARTY_PREFIX}<name>" using [a-zA-Z0-9_-] (got "${name}").`);
  }
  registry.set(name, registration);
}

export function unregisterGatewayTool(name: string): boolean {
  return registry.delete(name);
}

export function getGatewayTool(name: string): GatewayToolRegistration | undefined {
  return registry.get(name);
}

export function listGatewayTools(): Array<{ name: string } & GatewayToolRegistration> {
  return [...registry.entries()].map(([name, registration]) => ({ name, ...registration }));
}

registerGatewayTool('bot__remember', {
  description:
    'Propose a durable fact or preference for the operator to review (max 1000 characters). It is stored as a proposed memory and only used in future runs once the operator approves it.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact or preference to remember, one or two sentences.' },
    },
    required: ['content'],
  },
  risk: 'draft',
  handler: (ctx, args) => {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content.trim()) return textResult('content is required.', true);
    try {
      const memory = proposeBotMemory(ctx.botId, content, null);
      return textResult(JSON.stringify({ memoryId: memory.memoryId, status: memory.status }));
    } catch (error) {
      return textResult(error instanceof Error ? error.message : 'Could not save the memory proposal.', true);
    }
  },
});

// Stub: the channels wave replaces this handler via registerGatewayTool('bot__notify_operator', ...).
registerGatewayTool('bot__notify_operator', {
  description: 'Send the operator a notification through their configured channels.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      urgency: { type: 'number', description: '0 (low) to 1 (urgent).' },
    },
    required: ['title', 'body'],
  },
  risk: 'draft',
  handler: () => textResult('Operator notifications are not configured yet.', true),
});
