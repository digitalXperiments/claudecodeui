import { getConnection } from '@/modules/database/index.js';
import { newBotGoalId } from '@/shared/ids.js';
import { nowIso, parseJsonObject } from '@/modules/bots/bots.util.js';
import type { BotGoal, BotGoalStatus } from '@/modules/bots/bots.types.js';

type GoalRow = {
  goal_id: string;
  bot_id: string;
  statement: string;
  success_criteria: string;
  horizon: string | null;
  status: string;
  progress_json: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function mapGoal(row: GoalRow): BotGoal {
  return {
    goal_id: row.goal_id,
    bot_id: row.bot_id,
    statement: row.statement,
    success_criteria: row.success_criteria,
    horizon: row.horizon,
    status: row.status as BotGoalStatus,
    progress: parseJsonObject(row.progress_json),
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateBotGoalInput {
  botId: string;
  statement: string;
  successCriteria?: string;
  horizon?: string | null;
  status?: BotGoalStatus;
  sortOrder?: number;
}

export interface UpdateBotGoalInput {
  statement?: string;
  successCriteria?: string;
  horizon?: string | null;
  status?: BotGoalStatus;
  progress?: Record<string, unknown>;
  sortOrder?: number;
}

export const botGoalsDb = {
  get(goalId: string): BotGoal | null {
    const row = getConnection().prepare('SELECT * FROM bot_goals WHERE goal_id = ?').get(goalId) as
      | GoalRow
      | undefined;
    return row ? mapGoal(row) : null;
  },

  list(botId: string, status?: BotGoalStatus): BotGoal[] {
    const db = getConnection();
    const rows = (status
      ? db.prepare('SELECT * FROM bot_goals WHERE bot_id = ? AND status = ? ORDER BY sort_order ASC, created_at ASC').all(botId, status)
      : db.prepare('SELECT * FROM bot_goals WHERE bot_id = ? ORDER BY sort_order ASC, created_at ASC').all(botId)) as GoalRow[];
    return rows.map(mapGoal);
  },

  create(input: CreateBotGoalInput): BotGoal {
    const id = newBotGoalId();
    const ts = nowIso();
    getConnection()
      .prepare(
        `INSERT INTO bot_goals (goal_id, bot_id, statement, success_criteria, horizon, status, progress_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.statement,
        input.successCriteria ?? '',
        input.horizon ?? null,
        input.status ?? 'active',
        input.sortOrder ?? 0,
        ts,
        ts,
      );
    return botGoalsDb.get(id)!;
  },

  update(goalId: string, patch: UpdateBotGoalInput): BotGoal | null {
    const current = botGoalsDb.get(goalId);
    if (!current) return null;
    getConnection()
      .prepare(
        `UPDATE bot_goals SET statement = ?, success_criteria = ?, horizon = ?, status = ?, progress_json = ?, sort_order = ?, updated_at = ?
         WHERE goal_id = ?`,
      )
      .run(
        patch.statement ?? current.statement,
        patch.successCriteria ?? current.success_criteria,
        patch.horizon === undefined ? current.horizon : patch.horizon,
        patch.status ?? current.status,
        JSON.stringify(patch.progress ?? current.progress),
        patch.sortOrder ?? current.sort_order,
        nowIso(),
        goalId,
      );
    return botGoalsDb.get(goalId);
  },

  delete(goalId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_goals WHERE goal_id = ?').run(goalId).changes > 0;
  },
};
