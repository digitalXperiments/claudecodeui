import { getConnection } from '@/modules/database/index.js';

/** Spend and activity counters that feed the bot budgets. */
export const botSpendDb = {
  /** Sum of estimated run cost for runs tagged with `meta.section_id = botId` since `sinceIso`. */
  costSince(botId: string, sinceIso: string): number {
    const row = getConnection()
      .prepare(
        `SELECT COALESCE(SUM(cost_usd_estimate), 0) AS cost FROM agent_runs
         WHERE json_extract(meta_json, '$.section_id') = ? AND datetime(created_at) >= datetime(?)`,
      )
      .get(botId, sinceIso) as { cost: number };
    return Number(row.cost ?? 0);
  },

  /** Gate decisions whose action ran (`outcome = 'executed'`) since `sinceIso`. */
  executedActionsSince(botId: string, sinceIso: string): number {
    const row = getConnection()
      .prepare(
        `SELECT COUNT(*) AS n FROM bot_gate_decisions
         WHERE bot_id = ? AND outcome = 'executed' AND created_at >= ?`,
      )
      .get(botId, sinceIso) as { n: number };
    return row.n;
  },

  episodesStartedSince(botId: string, sinceIso: string): number {
    const row = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM bot_episodes WHERE bot_id = ? AND started_at >= ?')
      .get(botId, sinceIso) as { n: number };
    return row.n;
  },
};
