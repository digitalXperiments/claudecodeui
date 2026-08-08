import { getConnection } from '@/modules/database/index.js';
import { newPlaybookId } from '@/shared/ids.js';
import type {
  FailoverApproval,
  FailoverMatch,
  FailoverPlaybook,
  FailoverStrategy,
} from '@/modules/failover/failover.types.js';

type PlaybookRow = {
  playbook_id: string;
  name: string;
  project_id: string | null;
  enabled: number;
  match_json: string;
  strategy_json: string;
  approval: string;
  created_at: string;
  updated_at: string;
};

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: PlaybookRow): FailoverPlaybook {
  return {
    playbook_id: row.playbook_id,
    name: row.name,
    project_id: row.project_id,
    enabled: Boolean(row.enabled),
    match: parse<FailoverMatch>(row.match_json, {}),
    strategy: parse<FailoverStrategy>(row.strategy_json, {
      candidates: [],
      handoffMode: 'summary',
      maxFailovers: 1,
    }),
    approval: row.approval === 'interrupt' ? 'interrupt' : 'auto',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const failoverDb = {
  create(input: {
    name: string;
    projectId: string | null;
    enabled: boolean;
    match: FailoverMatch;
    strategy: FailoverStrategy;
    approval: FailoverApproval;
  }): FailoverPlaybook {
    const playbookId = newPlaybookId();
    getConnection()
      .prepare(
        `INSERT INTO failover_playbooks
         (playbook_id, name, project_id, enabled, match_json, strategy_json, approval)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        playbookId,
        input.name,
        input.projectId,
        input.enabled ? 1 : 0,
        JSON.stringify(input.match),
        JSON.stringify(input.strategy),
        input.approval,
      );
    return this.get(playbookId)!;
  },

  get(playbookId: string): FailoverPlaybook | null {
    const row = getConnection()
      .prepare(`SELECT * FROM failover_playbooks WHERE playbook_id = ?`)
      .get(playbookId) as PlaybookRow | undefined;
    return row ? mapRow(row) : null;
  },

  list(projectId?: string): FailoverPlaybook[] {
    const rows = projectId
      ? getConnection()
          .prepare(
            `SELECT * FROM failover_playbooks
             WHERE project_id = ? OR project_id IS NULL
             ORDER BY name ASC, playbook_id ASC`,
          )
          .all(projectId)
      : getConnection()
          .prepare(`SELECT * FROM failover_playbooks ORDER BY name ASC, playbook_id ASC`)
          .all();
    return (rows as PlaybookRow[]).map(mapRow);
  },

  update(
    playbookId: string,
    patch: Partial<{
      name: string;
      projectId: string | null;
      enabled: boolean;
      match: FailoverMatch;
      strategy: FailoverStrategy;
      approval: FailoverApproval;
    }>,
  ): FailoverPlaybook | null {
    const current = this.get(playbookId);
    if (!current) return null;
    getConnection()
      .prepare(
        `UPDATE failover_playbooks
         SET name = ?, project_id = ?, enabled = ?, match_json = ?, strategy_json = ?,
             approval = ?, updated_at = CURRENT_TIMESTAMP
         WHERE playbook_id = ?`,
      )
      .run(
        patch.name ?? current.name,
        patch.projectId !== undefined ? patch.projectId : current.project_id,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        JSON.stringify(patch.match ?? current.match),
        JSON.stringify(patch.strategy ?? current.strategy),
        patch.approval ?? current.approval,
        playbookId,
      );
    return this.get(playbookId);
  },

  delete(playbookId: string): boolean {
    return getConnection()
      .prepare(`DELETE FROM failover_playbooks WHERE playbook_id = ?`)
      .run(playbookId).changes > 0;
  },
};
