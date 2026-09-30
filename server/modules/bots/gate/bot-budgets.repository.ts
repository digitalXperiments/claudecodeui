import { getConnection } from '@/modules/database/index.js';
import { nowIso } from '@/modules/bots/bots.util.js';
import type { BotBudget } from '@/modules/bots/bots.types.js';

export interface PutBotBudgetInput {
  dailyUsd?: number | null;
  monthlyUsd?: number | null;
  dailyActions?: number | null;
  maxWakesPerHour?: number | null;
  softRatio?: number;
}

export const botBudgetsDb = {
  get(botId: string): BotBudget | null {
    return (
      (getConnection().prepare('SELECT * FROM bot_budgets WHERE bot_id = ?').get(botId) as BotBudget | undefined) ??
      null
    );
  },

  /** Upsert; fields left undefined keep their current value, null clears a limit. */
  put(botId: string, input: PutBotBudgetInput): BotBudget {
    const current = botBudgetsDb.get(botId);
    const pick = <T>(next: T | undefined, prev: T | null | undefined): T | null =>
      next !== undefined ? next : (prev ?? null);
    getConnection()
      .prepare(
        `INSERT INTO bot_budgets (bot_id, daily_usd, monthly_usd, daily_actions, max_wakes_per_hour, soft_ratio, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot_id) DO UPDATE SET daily_usd = excluded.daily_usd, monthly_usd = excluded.monthly_usd,
           daily_actions = excluded.daily_actions, max_wakes_per_hour = excluded.max_wakes_per_hour,
           soft_ratio = excluded.soft_ratio, updated_at = excluded.updated_at`,
      )
      .run(
        botId,
        pick(input.dailyUsd, current?.daily_usd),
        pick(input.monthlyUsd, current?.monthly_usd),
        pick(input.dailyActions, current?.daily_actions),
        pick(input.maxWakesPerHour, current?.max_wakes_per_hour),
        input.softRatio ?? current?.soft_ratio ?? 0.8,
        nowIso(),
      );
    return botBudgetsDb.get(botId)!;
  },

  delete(botId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_budgets WHERE bot_id = ?').run(botId).changes > 0;
  },
};
