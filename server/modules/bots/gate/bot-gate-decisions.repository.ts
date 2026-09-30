import { getConnection } from '@/modules/database/index.js';
import { newBotGateDecisionId } from '@/shared/ids.js';
import { nowIso, parseJsonObject } from '@/modules/bots/bots.util.js';
import type { BotGateDecision, BotRuleDecision } from '@/modules/bots/bots.types.js';

type DecisionRow = {
  decision_id: string;
  bot_id: string;
  episode_id: string | null;
  run_id: string | null;
  server: string;
  tool: string;
  risk: string;
  args_json: string;
  decision: string;
  decided_by: string;
  reason: string;
  interrupt_id: string | null;
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
};

function mapDecision(row: DecisionRow): BotGateDecision {
  return {
    decision_id: row.decision_id,
    bot_id: row.bot_id,
    episode_id: row.episode_id,
    run_id: row.run_id,
    server: row.server,
    tool: row.tool,
    risk: row.risk,
    args: parseJsonObject(row.args_json),
    decision: row.decision as BotRuleDecision,
    decided_by: row.decided_by,
    reason: row.reason,
    interrupt_id: row.interrupt_id,
    outcome: row.outcome,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

export interface CreateBotGateDecisionInput {
  botId: string;
  episodeId?: string | null;
  runId?: string | null;
  server: string;
  tool: string;
  risk: string;
  args?: Record<string, unknown>;
  decision: BotRuleDecision;
  decidedBy: string;
  reason?: string;
  interruptId?: string | null;
}

export const botGateDecisionsDb = {
  get(decisionId: string): BotGateDecision | null {
    const row = getConnection().prepare('SELECT * FROM bot_gate_decisions WHERE decision_id = ?').get(decisionId) as
      | DecisionRow
      | undefined;
    return row ? mapDecision(row) : null;
  },

  create(input: CreateBotGateDecisionInput): BotGateDecision {
    const id = newBotGateDecisionId();
    getConnection()
      .prepare(
        `INSERT INTO bot_gate_decisions (decision_id, bot_id, episode_id, run_id, server, tool, risk, args_json, decision, decided_by, reason, interrupt_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.episodeId ?? null,
        input.runId ?? null,
        input.server,
        input.tool,
        input.risk,
        JSON.stringify(input.args ?? {}),
        input.decision,
        input.decidedBy,
        input.reason ?? '',
        input.interruptId ?? null,
        nowIso(),
      );
    return botGateDecisionsDb.get(id)!;
  },

  setInterrupt(decisionId: string, interruptId: string): BotGateDecision | null {
    const result = getConnection()
      .prepare('UPDATE bot_gate_decisions SET interrupt_id = ? WHERE decision_id = ?')
      .run(interruptId, decisionId);
    return result.changes > 0 ? botGateDecisionsDb.get(decisionId) : null;
  },

  /** Record the final outcome (executed|denied|approved|rejected|expired|error) and stamp resolved_at. */
  recordOutcome(decisionId: string, outcome: string): BotGateDecision | null {
    const result = getConnection()
      .prepare('UPDATE bot_gate_decisions SET outcome = ?, resolved_at = ? WHERE decision_id = ?')
      .run(outcome, nowIso(), decisionId);
    return result.changes > 0 ? botGateDecisionsDb.get(decisionId) : null;
  },

  listForBot(botId: string, limit = 100): BotGateDecision[] {
    const rows = getConnection()
      .prepare('SELECT * FROM bot_gate_decisions WHERE bot_id = ? ORDER BY created_at DESC, decision_id DESC LIMIT ?')
      .all(botId, Math.max(1, limit)) as DecisionRow[];
    return rows.map(mapDecision);
  },

  /** Count decisions for a bot since `sinceIso` (used by action budgets). */
  countSince(botId: string, sinceIso: string, decision?: BotRuleDecision): number {
    const db = getConnection();
    const row = (decision
      ? db
          .prepare('SELECT COUNT(*) AS n FROM bot_gate_decisions WHERE bot_id = ? AND created_at >= ? AND decision = ?')
          .get(botId, sinceIso, decision)
      : db
          .prepare('SELECT COUNT(*) AS n FROM bot_gate_decisions WHERE bot_id = ? AND created_at >= ?')
          .get(botId, sinceIso)) as { n: number };
    return row.n;
  },
};
