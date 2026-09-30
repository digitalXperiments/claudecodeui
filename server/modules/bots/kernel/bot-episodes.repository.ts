import { getConnection } from '@/modules/database/index.js';
import { newBotEpisodeId } from '@/shared/ids.js';
import { nowIso, parseJsonArray, parseJsonObject, parseStringArray } from '@/modules/bots/bots.util.js';
import type { BotEpisode, BotEpisodeSearchHit, BotEpisodeStatus } from '@/modules/bots/bots.types.js';

type EpisodeRow = {
  episode_id: string;
  bot_id: string;
  status: string;
  trigger_kinds: string;
  event_ids_json: string;
  run_ids_json: string;
  plan_text: string;
  summary: string;
  outcome_json: string;
  feedback_json: string;
  tainted: number;
  cost_usd: number;
  bot_version: number | null;
  started_at: string;
  finished_at: string | null;
};

function mapEpisode(row: EpisodeRow): BotEpisode {
  return {
    episode_id: row.episode_id,
    bot_id: row.bot_id,
    status: row.status as BotEpisodeStatus,
    trigger_kinds: row.trigger_kinds,
    event_ids: parseStringArray(row.event_ids_json),
    run_ids: parseStringArray(row.run_ids_json),
    plan_text: row.plan_text,
    summary: row.summary,
    outcome: parseJsonObject(row.outcome_json),
    feedback: parseJsonArray(row.feedback_json),
    tainted: row.tainted === 1,
    cost_usd: row.cost_usd,
    bot_version: row.bot_version,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

export interface CreateBotEpisodeInput {
  botId: string;
  triggerKinds?: string;
  eventIds?: string[];
  botVersion?: number | null;
}

export interface UpdateBotEpisodeInput {
  status?: BotEpisodeStatus;
  runIds?: string[];
  planText?: string;
  summary?: string;
  outcome?: Record<string, unknown>;
  feedback?: unknown[];
  tainted?: boolean;
  costUsd?: number;
  finishedAt?: string | null;
}

/** Turn free text into a safe FTS5 query: quoted OR-ed terms (no operator injection). */
function toFtsQuery(query: string): string | null {
  const terms = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

export const botEpisodesDb = {
  get(episodeId: string): BotEpisode | null {
    const row = getConnection().prepare('SELECT * FROM bot_episodes WHERE episode_id = ?').get(episodeId) as
      | EpisodeRow
      | undefined;
    return row ? mapEpisode(row) : null;
  },

  list(botId: string, limit = 50): BotEpisode[] {
    const rows = getConnection()
      .prepare('SELECT * FROM bot_episodes WHERE bot_id = ? ORDER BY started_at DESC, episode_id DESC LIMIT ?')
      .all(botId, Math.max(1, limit)) as EpisodeRow[];
    return rows.map(mapEpisode);
  },

  listByStatus(status: BotEpisodeStatus): BotEpisode[] {
    const rows = getConnection()
      .prepare('SELECT * FROM bot_episodes WHERE status = ? ORDER BY started_at ASC')
      .all(status) as EpisodeRow[];
    return rows.map(mapEpisode);
  },

  create(input: CreateBotEpisodeInput): BotEpisode {
    const id = newBotEpisodeId();
    getConnection()
      .prepare(
        `INSERT INTO bot_episodes (episode_id, bot_id, status, trigger_kinds, event_ids_json, bot_version, started_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.triggerKinds ?? '',
        JSON.stringify(input.eventIds ?? []),
        input.botVersion ?? null,
        nowIso(),
      );
    return botEpisodesDb.get(id)!;
  },

  update(episodeId: string, patch: UpdateBotEpisodeInput): BotEpisode | null {
    const current = botEpisodesDb.get(episodeId);
    if (!current) return null;
    getConnection()
      .prepare(
        `UPDATE bot_episodes SET status = ?, run_ids_json = ?, plan_text = ?, summary = ?, outcome_json = ?,
           feedback_json = ?, tainted = ?, cost_usd = ?, finished_at = ? WHERE episode_id = ?`,
      )
      .run(
        patch.status ?? current.status,
        JSON.stringify(patch.runIds ?? current.run_ids),
        patch.planText ?? current.plan_text,
        patch.summary ?? current.summary,
        JSON.stringify(patch.outcome ?? current.outcome),
        JSON.stringify(patch.feedback ?? current.feedback),
        (patch.tainted ?? current.tainted) ? 1 : 0,
        patch.costUsd ?? current.cost_usd,
        patch.finishedAt === undefined ? current.finished_at : patch.finishedAt,
        episodeId,
      );
    return botEpisodesDb.get(episodeId);
  },

  /** (Re)index an episode's summary + plan in FTS5. Replaces any previous entry. */
  indexEpisode(episodeId: string): boolean {
    const db = getConnection();
    const episode = botEpisodesDb.get(episodeId);
    if (!episode) return false;
    db.transaction(() => {
      db.prepare('DELETE FROM bot_episodes_fts WHERE episode_id = ?').run(episodeId);
      db.prepare('INSERT INTO bot_episodes_fts (episode_id, bot_id, summary, plan_text) VALUES (?, ?, ?, ?)').run(
        episode.episode_id,
        episode.bot_id,
        episode.summary,
        episode.plan_text,
      );
    })();
    return true;
  },

  removeFromIndex(episodeId: string): void {
    getConnection().prepare('DELETE FROM bot_episodes_fts WHERE episode_id = ?').run(episodeId);
  },

  /** FTS5 search scoped to a bot; higher score = better (negated bm25). */
  search(botId: string, query: string, limit = 5): BotEpisodeSearchHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const rows = getConnection()
      .prepare(
        `SELECT episode_id, summary, -bm25(bot_episodes_fts) AS score FROM bot_episodes_fts
         WHERE bot_episodes_fts MATCH ? AND bot_id = ? ORDER BY bm25(bot_episodes_fts) LIMIT ?`,
      )
      .all(match, botId, Math.max(1, limit)) as { episode_id: string; summary: string; score: number }[];
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.episode_id);
    const taintedRows = getConnection()
      .prepare(`SELECT episode_id FROM bot_episodes WHERE tainted = 1 AND episode_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { episode_id: string }[];
    const tainted = new Set(taintedRows.map((row) => row.episode_id));
    return rows.map((row) => ({
      episode_id: row.episode_id,
      summary: row.summary,
      score: row.score,
      tainted: tainted.has(row.episode_id),
    }));
  },
};
