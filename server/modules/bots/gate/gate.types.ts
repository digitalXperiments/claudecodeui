/** Action Gate contract types (see docs/prd/bot-runtime/IMPLEMENTATION.md, gate/). */

export type Risk =
  | 'read'
  | 'draft'
  | 'send'
  | 'publish'
  | 'delete'
  | 'purchase'
  | 'credential'
  | 'prod_change'
  | 'unknown';

/** Risks that default to `ask` and that a global rule can never loosen to `allow`. */
export const SAFETY_FLOOR: Risk[] = ['send', 'publish', 'delete', 'purchase', 'credential', 'prod_change'];

export interface GateContext {
  botId: string;
  episodeId?: string;
  runId?: string;
  tainted: boolean;
  operatorInstructions: string;
  goals: string[];
}

export interface GateRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  description?: string;
}

export interface GateVerdict {
  decision: 'allow' | 'ask' | 'deny';
  /** rule:<id> | floor | taint | reviewer | budget | dry_run | default */
  decidedBy: string;
  reason: string;
  risk: Risk;
  decisionId: string;
  /** Budget soft limit reached (the call is still decided normally). */
  soft?: boolean;
}

export type HumanGateOutcome = 'approved' | 'rejected' | 'expired';

export type AutoReviewer = (
  ctx: GateContext,
  req: GateRequest,
  risk: Risk,
) => Promise<{ ok: boolean; reason: string }>;
