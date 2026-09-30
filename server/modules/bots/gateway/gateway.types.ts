/** Mirrors the Action Gate contract (docs/prd/bot-runtime/IMPLEMENTATION.md, gate/). */
export type GatewayRisk =
  | 'read'
  | 'draft'
  | 'send'
  | 'publish'
  | 'delete'
  | 'purchase'
  | 'credential'
  | 'prod_change'
  | 'unknown';

export interface GatewayGateContext {
  botId: string;
  episodeId?: string;
  runId?: string;
  tainted: boolean;
  operatorInstructions: string;
  goals: string[];
}

export interface GatewayGateRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  description?: string;
}

export interface GatewayGateVerdict {
  decision: 'allow' | 'ask' | 'deny';
  decidedBy: string;
  reason: string;
  risk: GatewayRisk;
  decisionId: string;
}

export interface GatewayCallOutcome {
  ok: boolean;
  error?: string;
  durationMs?: number;
  /** Short, already-truncated description of what came back (never the raw payload). */
  summary?: string;
}

/**
 * The slice of `actionGate` the gateway depends on. The lead wires the real gate with
 * `setGatewayGate(actionGate)`; until then every call is denied (fail closed).
 */
export interface GatewayGate {
  evaluate(ctx: GatewayGateContext, req: GatewayGateRequest): Promise<GatewayGateVerdict>;
  awaitHuman(decisionId: string, opts: { timeoutMs: number }): Promise<'approved' | 'rejected' | 'expired'>;
  recordOutcome(decisionId: string, outcome: GatewayCallOutcome): void | Promise<void>;
}

export type { GatewaySessionBindInput, GatewaySessionBinding } from '@/shared/bot-gateway-sessions.js';

export interface GatewayToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface GatewayCallToolResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GatewayToolContext {
  appSessionId: string;
  botId: string;
  episodeId?: string;
  runId?: string;
  provider: string;
  tainted: boolean;
}

export interface GatewayToolRegistration {
  description: string;
  inputSchema: Record<string, unknown>;
  risk: GatewayRisk;
  handler(ctx: GatewayToolContext, args: Record<string, unknown>): Promise<GatewayCallToolResult> | GatewayCallToolResult;
}
