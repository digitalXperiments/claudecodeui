/**
 * Side effects the kernel (and the `bot__commit` / `bot__goal_progress` gateway tools) apply on
 * behalf of a bot: commitments and goal progress. Everything here is scoped to one bot and
 * validates model-supplied input, because it comes straight from agent output.
 */

import { missionControlDb } from '@/modules/mission-control/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { nowIso } from '@/modules/bots/bots.util.js';
import type { BotCommitment, BotGoal, BotGoalStatus } from '@/modules/bots/bots.types.js';
import { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
import { botGoalsDb } from '@/modules/bots/kernel/bot-goals.repository.js';

export const MAX_COMMITMENT_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
export const MIN_COMMITMENT_DELAY_MS = 60_000;
const DESCRIPTION_MAX = 500;
const GOAL_HISTORY_MAX = 10;
const GOAL_STATUSES: readonly BotGoalStatus[] = ['active', 'paused', 'achieved', 'abandoned'];

export interface CommitmentInput {
  description?: unknown;
  due_at?: unknown;
  waiting_on?: unknown;
  /** An item id, dedupe key or title of one of this bot's items. */
  item_ref?: unknown;
  goal_id?: unknown;
}

export type CommitmentResult = { ok: true; commitment: BotCommitment } | { ok: false; error: string };

const asText = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Resolve a model-supplied reference to one of the bot's items (id, dedupe key, else exact title). */
export function resolveItemRef(
  botId: string,
  ref: unknown,
  recent: Array<{ item_id: string; dedupe_key: string; title: string }> = [],
): string | null {
  const text = asText(ref, 500);
  if (!text) return null;
  const lowered = text.toLowerCase();
  const local = recent.find(
    (item) => item.item_id === text || item.dedupe_key === text || item.title.trim().toLowerCase() === lowered,
  );
  if (local) return local.item_id;
  const byId = missionControlDb.getItem(text);
  if (byId && byId.section_id === botId) return byId.item_id;
  return missionControlDb.findItemByDedupeAliases(botId, [text])?.item_id ?? null;
}

/** Validate and create a commitment. `due_at` is clamped into [now + 1 min, now + 90 days]. */
export function createCommitmentChecked(
  botId: string,
  input: CommitmentInput,
  recentItems: Array<{ item_id: string; dedupe_key: string; title: string }> = [],
  now: Date = new Date(),
): CommitmentResult {
  const description = asText(input.description, DESCRIPTION_MAX);
  if (!description) return { ok: false, error: 'description is required' };
  const parsed = typeof input.due_at === 'string' ? Date.parse(input.due_at) : Number.NaN;
  if (Number.isNaN(parsed)) return { ok: false, error: 'due_at must be an ISO 8601 timestamp' };
  const dueMs = Math.min(
    now.getTime() + MAX_COMMITMENT_HORIZON_MS,
    Math.max(now.getTime() + MIN_COMMITMENT_DELAY_MS, parsed),
  );
  const goalId = asText(input.goal_id, 100);
  const goal = goalId ? botGoalsDb.get(goalId) : null;
  const commitment = botCommitmentsDb.create({
    botId,
    description,
    dueAt: new Date(dueMs).toISOString(),
    waitingOn: asText(input.waiting_on, 200) || null,
    itemId: resolveItemRef(botId, input.item_ref, recentItems),
    goalId: goal && goal.bot_id === botId ? goal.goal_id : null,
  });
  return { ok: true, commitment };
}

export interface GoalProgressInput {
  goal_id?: unknown;
  note?: unknown;
  percent?: unknown;
  status?: unknown;
}

export type GoalProgressResult = { ok: true; goal: BotGoal } | { ok: false; error: string };

/** Record progress on one of this bot's goals (goals of other bots are invisible). */
export function applyGoalProgress(botId: string, input: GoalProgressInput, episodeId?: string): GoalProgressResult {
  const goalId = asText(input.goal_id, 100);
  const goal = goalId ? botGoalsDb.get(goalId) : null;
  if (!goal || goal.bot_id !== botId) return { ok: false, error: 'unknown goal_id for this bot' };
  const note = asText(input.note, 1000);
  const percentRaw = typeof input.percent === 'number' ? input.percent : Number.NaN;
  const percent = Number.isFinite(percentRaw) ? Math.min(100, Math.max(0, Math.round(percentRaw))) : undefined;
  const status = GOAL_STATUSES.find((candidate) => candidate === input.status);
  if (!note && percent === undefined && !status) return { ok: false, error: 'note, percent or status is required' };

  const at = nowIso();
  const previousHistory = Array.isArray(goal.progress.history) ? (goal.progress.history as unknown[]) : [];
  const entry = { at, note, ...(percent !== undefined ? { percent } : {}), ...(episodeId ? { episode_id: episodeId } : {}) };
  const progress: Record<string, unknown> = {
    ...goal.progress,
    note: note || goal.progress.note || '',
    ...(percent !== undefined ? { percent } : {}),
    updated_at: at,
    history: [...previousHistory, entry].slice(-GOAL_HISTORY_MAX),
  };
  const updated = botGoalsDb.update(goal.goal_id, { progress, ...(status ? { status } : {}) });
  if (!updated) return { ok: false, error: 'goal disappeared' };
  broadcastSystemEvent({ kind: 'bot_goal_updated', bot_id: botId, goal_id: goal.goal_id });
  return { ok: true, goal: updated };
}
