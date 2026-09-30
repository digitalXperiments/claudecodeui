import { botBudgetsDb, type PutBotBudgetInput } from '@/modules/bots/gate/bot-budgets.repository.js';
import { botSpendDb } from '@/modules/bots/gate/bot-spend.repository.js';
import type { BotBudget } from '@/modules/bots/bots.types.js';

export interface BudgetCheck {
  ok: boolean;
  soft: boolean;
  reason?: string;
}

function startOfLocalDay(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function startOfLocalMonth(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export const budgets = {
  get: (botId: string): BotBudget | null => botBudgetsDb.get(botId),
  put: (botId: string, input: PutBotBudgetInput): BotBudget => botBudgetsDb.put(botId, input),

  /** Hard limit reached → `ok: false`; at or above `soft_ratio` of any limit → `soft: true`. */
  check(botId: string, now: Date = new Date()): BudgetCheck {
    const budget = botBudgetsDb.get(botId);
    if (!budget) return { ok: true, soft: false };

    const dimensions: { label: string; used: () => number; limit: number | null; money: boolean }[] = [
      { label: 'daily spend', used: () => botSpendDb.costSince(botId, startOfLocalDay(now)), limit: budget.daily_usd, money: true },
      { label: 'monthly spend', used: () => botSpendDb.costSince(botId, startOfLocalMonth(now)), limit: budget.monthly_usd, money: true },
      {
        label: 'daily actions',
        used: () => botSpendDb.executedActionsSince(botId, startOfLocalDay(now)),
        limit: budget.daily_actions,
        money: false,
      },
    ];

    let soft = false;
    let softReason: string | undefined;
    for (const dimension of dimensions) {
      if (dimension.limit === null || dimension.limit === undefined) continue;
      const used = dimension.used();
      const fmt = (n: number) => (dimension.money ? `$${n.toFixed(2)}` : String(n));
      if (used >= dimension.limit) {
        return { ok: false, soft: true, reason: `Hard ${dimension.label} limit reached (${fmt(used)} of ${fmt(dimension.limit)})` };
      }
      if (dimension.limit > 0 && used >= dimension.limit * budget.soft_ratio && !soft) {
        soft = true;
        softReason = `Soft ${dimension.label} limit reached (${fmt(used)} of ${fmt(dimension.limit)})`;
      }
    }
    return { ok: true, soft, ...(softReason ? { reason: softReason } : {}) };
  },

  /** False once the bot has started `max_wakes_per_hour` episodes in the last hour. */
  wakeAllowed(botId: string, now: Date = new Date()): boolean {
    const budget = botBudgetsDb.get(botId);
    if (!budget || budget.max_wakes_per_hour === null || budget.max_wakes_per_hour === undefined) return true;
    const since = new Date(now.getTime() - 3_600_000).toISOString();
    return botSpendDb.episodesStartedSince(botId, since) < budget.max_wakes_per_hour;
  },
};

export const wakeAllowed = (botId: string, now?: Date): boolean => budgets.wakeAllowed(botId, now);
