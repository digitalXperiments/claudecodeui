import { getConnection } from '@/modules/database/index.js';
import { newBotCommitmentId } from '@/shared/ids.js';
import { nowIso, parseJsonObject } from '@/modules/bots/bots.util.js';
import type { BotCommitment, BotCommitmentStatus } from '@/modules/bots/bots.types.js';

type CommitmentRow = {
  commitment_id: string;
  bot_id: string;
  item_id: string | null;
  goal_id: string | null;
  description: string;
  waiting_on: string | null;
  due_at: string;
  nudge_policy_json: string;
  status: string;
  source_episode_id: string | null;
  tainted: number | null;
  created_at: string;
  updated_at: string;
};

function mapCommitment(row: CommitmentRow): BotCommitment {
  return {
    commitment_id: row.commitment_id,
    bot_id: row.bot_id,
    item_id: row.item_id,
    goal_id: row.goal_id,
    description: row.description,
    waiting_on: row.waiting_on,
    due_at: row.due_at,
    nudge_policy: parseJsonObject(row.nudge_policy_json),
    status: row.status as BotCommitmentStatus,
    source_episode_id: row.source_episode_id ?? null,
    tainted: row.tainted === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateBotCommitmentInput {
  botId: string;
  description: string;
  dueAt: string;
  itemId?: string | null;
  goalId?: string | null;
  waitingOn?: string | null;
  nudgePolicy?: Record<string, unknown>;
  sourceEpisodeId?: string | null;
  tainted?: boolean;
}

export const botCommitmentsDb = {
  get(commitmentId: string): BotCommitment | null {
    const row = getConnection()
      .prepare('SELECT * FROM bot_commitments WHERE commitment_id = ?')
      .get(commitmentId) as CommitmentRow | undefined;
    return row ? mapCommitment(row) : null;
  },

  list(botId: string, status?: BotCommitmentStatus): BotCommitment[] {
    const db = getConnection();
    const rows = (status
      ? db.prepare('SELECT * FROM bot_commitments WHERE bot_id = ? AND status = ? ORDER BY due_at ASC').all(botId, status)
      : db.prepare('SELECT * FROM bot_commitments WHERE bot_id = ? ORDER BY due_at ASC').all(botId)) as CommitmentRow[];
    return rows.map(mapCommitment);
  },

  /** Open commitments (any bot) whose due_at is at or before `now`. */
  listDue(now: Date = new Date()): BotCommitment[] {
    const rows = getConnection()
      .prepare("SELECT * FROM bot_commitments WHERE status = 'open' AND due_at <= ? ORDER BY due_at ASC")
      .all(now.toISOString()) as CommitmentRow[];
    return rows.map(mapCommitment);
  },

  create(input: CreateBotCommitmentInput): BotCommitment {
    const id = newBotCommitmentId();
    const ts = nowIso();
    getConnection()
      .prepare(
        `INSERT INTO bot_commitments (commitment_id, bot_id, item_id, goal_id, description, waiting_on, due_at, nudge_policy_json, status, source_episode_id, tainted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.itemId ?? null,
        input.goalId ?? null,
        input.description,
        input.waitingOn ?? null,
        input.dueAt,
        JSON.stringify(input.nudgePolicy ?? {}),
        input.sourceEpisodeId ?? null,
        input.tainted ? 1 : 0,
        ts,
        ts,
      );
    return botCommitmentsDb.get(id)!;
  },

  setStatus(commitmentId: string, status: BotCommitmentStatus): BotCommitment | null {
    const result = getConnection()
      .prepare('UPDATE bot_commitments SET status = ?, updated_at = ? WHERE commitment_id = ?')
      .run(status, nowIso(), commitmentId);
    return result.changes > 0 ? botCommitmentsDb.get(commitmentId) : null;
  },

  complete(commitmentId: string): BotCommitment | null {
    return botCommitmentsDb.setStatus(commitmentId, 'done');
  },

  cancel(commitmentId: string): BotCommitment | null {
    return botCommitmentsDb.setStatus(commitmentId, 'cancelled');
  },

  delete(commitmentId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_commitments WHERE commitment_id = ?').run(commitmentId).changes > 0;
  },
};
