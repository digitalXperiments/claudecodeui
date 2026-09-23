import { getConnection } from '@/modules/database/index.js';
import type { McSection } from '@/modules/mission-control/mission-control.types.js';
import { listApprovedBotMemoryContents } from '@/modules/mission-control/mission-control-memory.service.js';

export type BotVersionOrigin = 'created' | 'edited' | 'baseline';

export type BotVersionConfig = Pick<McSection,
  | 'title' | 'icon' | 'scope' | 'project_id' | 'work_project_id'
  | 'mode' | 'schedule_cron' | 'provider' | 'model' | 'permission_mode'
  | 'dry_run' | 'auto_approve' | 'produce_prompt' | 'produce_tools'
  | 'resolve_prompt' | 'resolve_tools' | 'tool_policy' | 'actions'
  | 'create_kanban_task' | 'kanban_assignee_provider' | 'kanban_review_provider'
  | 'kanban_mcp_tools'
> & { approved_memory: string[] };

export type BotVersion = {
  version: number;
  origin: BotVersionOrigin;
  createdAt: string;
  config: BotVersionConfig;
};

export type BotVersionScorecard = {
  ticks: number;
  succeeded: number;
  failed: number;
  aborted: number;
  active: number;
  successRate: number | null;
  totalTokens: number | null;
  runsWithTokens: number;
  totalCostUsd: number | null;
  runsWithCost: number;
  avgDurationMs: number | null;
  latestRunAt: string | null;
  recentRuns: Array<{
    runId: string;
    status: string;
    createdAt: string;
    tokenTotal: number | null;
    costUsd: number | null;
  }>;
};

export type BotVersionHistory = {
  versions: Array<BotVersion & { scorecard: BotVersionScorecard }>;
  unversionedRuns: number;
};

type VersionRow = { version: number; origin: BotVersionOrigin; created_at: string; snapshot_json: string };
type ScoreRow = {
  version: number | null;
  ticks: number;
  succeeded: number;
  failed: number;
  aborted: number;
  active: number;
  terminal: number;
  total_tokens: number | null;
  token_covered: number;
  total_cost: number | null;
  cost_covered: number;
  avg_duration_ms: number | null;
  latest_run_at: string | null;
};

function snapshotSection(section: McSection): BotVersionConfig {
  return {
    title: section.title,
    icon: section.icon,
    scope: section.scope,
    project_id: section.project_id,
    work_project_id: section.work_project_id ?? null,
    mode: section.mode,
    schedule_cron: section.schedule_cron,
    provider: section.provider,
    model: section.model,
    permission_mode: section.permission_mode,
    dry_run: section.dry_run,
    auto_approve: section.auto_approve,
    produce_prompt: section.produce_prompt,
    produce_tools: section.produce_tools,
    resolve_prompt: section.resolve_prompt,
    resolve_tools: section.resolve_tools,
    tool_policy: section.tool_policy,
    actions: section.actions,
    create_kanban_task: section.create_kanban_task,
    kanban_assignee_provider: section.kanban_assignee_provider,
    kanban_review_provider: section.kanban_review_provider,
    kanban_mcp_tools: section.kanban_mcp_tools,
    approved_memory: listApprovedBotMemoryContents(section.section_id),
  };
}

function mapVersion(row: VersionRow): BotVersion {
  const parsed = JSON.parse(row.snapshot_json) as Partial<BotVersionConfig>;
  return {
    version: row.version,
    origin: row.origin,
    createdAt: row.created_at,
    config: { ...parsed, approved_memory: parsed.approved_memory ?? [] } as BotVersionConfig,
  };
}

/** Save a baseline for an existing bot or append a version when its meaningful configuration changes. */
export function recordSectionVersion(section: McSection, origin: BotVersionOrigin): BotVersion {
  const db = getConnection();
  return db.transaction(() => {
    const latest = db.prepare(
      `SELECT version, origin, created_at, snapshot_json
       FROM mc_section_versions WHERE section_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(section.section_id) as VersionRow | undefined;
    const snapshot = JSON.stringify(snapshotSection(section));
    if (latest && JSON.stringify(mapVersion(latest).config) === snapshot) return mapVersion(latest);

    const version = (latest?.version ?? 0) + 1;
    const createdAt = origin === 'created' && version === 1
      ? section.created_at
      : new Date().toISOString();
    const recordedOrigin = version === 1 ? origin : 'edited';
    db.prepare(
      `INSERT INTO mc_section_versions (section_id, version, snapshot_json, origin, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(section.section_id, version, snapshot, recordedOrigin, createdAt);
    return { version, origin: recordedOrigin, createdAt, config: JSON.parse(snapshot) as BotVersionConfig };
  })();
}

const SCORECARD_SQL = `
  SELECT CAST(json_extract(meta_json, '$.bot_version') AS INTEGER) AS version,
    COUNT(*) AS ticks,
    SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
    SUM(CASE WHEN status = 'failed' OR status = 'timed_out' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) AS aborted,
    SUM(CASE WHEN status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out') THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN status IN ('succeeded', 'failed', 'aborted', 'timed_out') THEN 1 ELSE 0 END) AS terminal,
    SUM(token_total) AS total_tokens,
    COUNT(token_total) AS token_covered,
    SUM(cost_usd_estimate) AS total_cost,
    COUNT(cost_usd_estimate) AS cost_covered,
    AVG(CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
      THEN (julianday(finished_at) - julianday(started_at)) * 86400000 END) AS avg_duration_ms,
    MAX(created_at) AS latest_run_at
  FROM agent_runs
  WHERE source = 'mission_control' AND source_ref = ?
    AND COALESCE(json_extract(meta_json, '$.phase'), 'produce') = 'produce'
    AND COALESCE(trigger, '') != 'preview'
  GROUP BY CAST(json_extract(meta_json, '$.bot_version') AS INTEGER)
`;

export function getSectionVersionHistory(section: McSection): BotVersionHistory {
  recordSectionVersion(section, 'baseline');
  const db = getConnection();
  const rows = db.prepare(
    `SELECT version, origin, created_at, snapshot_json FROM mc_section_versions
     WHERE section_id = ? ORDER BY version DESC`,
  ).all(section.section_id) as VersionRow[];
  const scores = db.prepare(SCORECARD_SQL).all(section.section_id) as ScoreRow[];
  const scoreByVersion = new Map(scores.filter((row) => row.version != null).map((row) => [row.version, row]));
  const recentStatement = db.prepare(
    `SELECT run_id, status, created_at, token_total, cost_usd_estimate FROM agent_runs
     WHERE source = 'mission_control' AND source_ref = ?
       AND json_extract(meta_json, '$.bot_version') = ?
       AND COALESCE(json_extract(meta_json, '$.phase'), 'produce') = 'produce'
       AND COALESCE(trigger, '') != 'preview'
     ORDER BY created_at DESC, run_id DESC LIMIT 3`,
  );

  return {
    unversionedRuns: scores.find((row) => row.version == null)?.ticks ?? 0,
    versions: rows.map((row) => {
      const score = scoreByVersion.get(row.version);
      const recentRows = recentStatement.all(section.section_id, row.version) as Array<{
        run_id: string;
        status: string;
        created_at: string;
        token_total: number | null;
        cost_usd_estimate: number | null;
      }>;
      return {
        ...mapVersion(row),
        scorecard: {
          ticks: score?.ticks ?? 0,
          succeeded: score?.succeeded ?? 0,
          failed: score?.failed ?? 0,
          aborted: score?.aborted ?? 0,
          active: score?.active ?? 0,
          successRate: score?.terminal ? score.succeeded / score.terminal : null,
          totalTokens: score?.token_covered ? score.total_tokens : null,
          runsWithTokens: score?.token_covered ?? 0,
          totalCostUsd: score?.cost_covered ? score.total_cost : null,
          runsWithCost: score?.cost_covered ?? 0,
          avgDurationMs: score?.avg_duration_ms == null ? null : Math.max(0, Math.round(score.avg_duration_ms)),
          latestRunAt: score?.latest_run_at ?? null,
          recentRuns: recentRows.map((run) => ({
            runId: run.run_id,
            status: run.status,
            createdAt: run.created_at,
            tokenTotal: run.token_total,
            costUsd: run.cost_usd_estimate,
          })),
        },
      };
    }),
  };
}
