import { getConnection } from '@/modules/database/index.js';
import { newSwarmId, newSwarmMemberId } from '@/shared/ids.js';
import type {
  SwarmAgentSpec,
  SwarmConfig,
  SwarmFinding,
  SwarmHandoff,
  SwarmMember,
  SwarmMessage,
  SwarmPlan,
  SwarmRun,
} from '@/modules/swarm/swarm.types.js';

type SwarmRow = {
  swarm_id: string;
  project_id: string;
  parent_run_id: string | null;
  goal: string;
  status: string;
  roles_json: string;
  findings_json: string | null;
  synthesis_json: string | null;
  plan_json?: string | null;
  blackboard_json?: string | null;
  skills_json?: string | null;
  config_json?: string | null;
  workspace_id?: string | null;
  pr_url?: string | null;
  feature_branch?: string | null;
  approval_status: string | null;
  interrupt_id: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type MemberRow = {
  member_id: string;
  swarm_id: string;
  role: string;
  kind?: string | null;
  label: string | null;
  provider: string | null;
  model: string | null;
  effort?: string | null;
  permission_mode?: string | null;
  skills_json?: string | null;
  step_id?: string | null;
  run_id: string | null;
  status: string;
  findings_summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

function parse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapMember(row: MemberRow): SwarmMember {
  return {
    member_id: row.member_id,
    swarm_id: row.swarm_id,
    role: row.role,
    kind: row.kind ?? null,
    label: row.label,
    provider: row.provider,
    model: row.model,
    effort: row.effort ?? null,
    permission_mode: row.permission_mode ?? null,
    skills_json: row.skills_json ?? null,
    step_id: row.step_id ?? null,
    run_id: row.run_id,
    status: row.status,
    findings_summary: row.findings_summary,
    error: row.error,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

function mapSwarm(row: SwarmRow, members?: SwarmMember[]): SwarmRun {
  return {
    swarm_id: row.swarm_id,
    project_id: row.project_id,
    parent_run_id: row.parent_run_id,
    goal: row.goal,
    status: row.status,
    roles: parse<SwarmAgentSpec[]>(row.roles_json, []),
    findings: parse<SwarmFinding[]>(row.findings_json, []),
    synthesis: parse<SwarmHandoff | null>(row.synthesis_json, null),
    plan: parse<SwarmPlan | null>(row.plan_json, null),
    blackboard: parse<SwarmMessage[]>(row.blackboard_json, []),
    skills: parse<string[]>(row.skills_json, []),
    config: parse<SwarmConfig | null>(row.config_json, null),
    workspace_id: row.workspace_id ?? null,
    feature_branch: row.feature_branch ?? null,
    pr_url: row.pr_url ?? null,
    approval_status: (row.approval_status as SwarmRun['approval_status']) ?? null,
    interrupt_id: row.interrupt_id,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    members,
  };
}

export const swarmDb = {
  create(input: {
    projectId: string;
    goal: string;
    parentRunId: string | null;
    roles: SwarmAgentSpec[];
    status: string;
    approvalStatus: string | null;
    skills?: string[];
    config?: SwarmConfig | null;
  }): SwarmRun {
    const id = newSwarmId();
    getConnection()
      .prepare(
        `INSERT INTO swarm_runs (
           swarm_id, project_id, parent_run_id, goal, status, roles_json,
           findings_json, approval_status, skills_json, config_json, blackboard_json
         ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, '[]')`,
      )
      .run(
        id,
        input.projectId,
        input.parentRunId,
        input.goal,
        input.status,
        JSON.stringify(input.roles),
        input.approvalStatus,
        JSON.stringify(input.skills ?? []),
        input.config ? JSON.stringify(input.config) : null,
      );
    return this.get(id)!;
  },

  get(swarmId: string): SwarmRun | null {
    const row = getConnection()
      .prepare(`SELECT * FROM swarm_runs WHERE swarm_id = ?`)
      .get(swarmId) as SwarmRow | undefined;
    if (!row) return null;
    return mapSwarm(row, this.listMembers(swarmId));
  },

  list(
    projectId: string,
    limit = 30,
    options: { includeArchived?: boolean; archivedOnly?: boolean } = {},
  ): SwarmRun[] {
    const archiveClause = options.archivedOnly
      ? 'AND archived_at IS NOT NULL'
      : options.includeArchived
        ? ''
        : 'AND archived_at IS NULL';
    const rows = getConnection()
      .prepare(
        `SELECT * FROM swarm_runs WHERE project_id = ? ${archiveClause} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as SwarmRow[];
    return rows.map((row) => mapSwarm(row, this.listMembers(row.swarm_id)));
  },

  /** Global list (all projects). */
  listAll(
    limit = 50,
    options: { includeArchived?: boolean; archivedOnly?: boolean } = {},
  ): SwarmRun[] {
    const archiveClause = options.archivedOnly
      ? 'WHERE archived_at IS NOT NULL'
      : options.includeArchived
        ? ''
        : 'WHERE archived_at IS NULL';
    const rows = getConnection()
      .prepare(
        `SELECT * FROM swarm_runs ${archiveClause} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as SwarmRow[];
    return rows.map((row) => mapSwarm(row, this.listMembers(row.swarm_id)));
  },

  archive(swarmId: string): SwarmRun | null {
    return this.update(swarmId, { archivedAt: new Date().toISOString() });
  },

  unarchive(swarmId: string): SwarmRun | null {
    return this.update(swarmId, { archivedAt: null });
  },

  delete(swarmId: string): boolean {
    const existing = this.get(swarmId);
    if (!existing) return false;
    const db = getConnection();
    db.prepare(`DELETE FROM swarm_members WHERE swarm_id = ?`).run(swarmId);
    db.prepare(`DELETE FROM swarm_runs WHERE swarm_id = ?`).run(swarmId);
    return true;
  },

  update(
    swarmId: string,
    patch: Partial<{
      status: string;
      findings: SwarmFinding[];
      synthesis: SwarmHandoff | null;
      plan: SwarmPlan | null;
      blackboard: SwarmMessage[];
      skills: string[];
      config: SwarmConfig | null;
      workspaceId: string | null;
      featureBranch: string | null;
      prUrl: string | null;
      approvalStatus: string | null;
      interruptId: string | null;
      archivedAt: string | null;
      finished: boolean;
    }>,
  ): SwarmRun | null {
    const current = this.get(swarmId);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const findings = patch.findings ?? current.findings;
    const synthesis =
      patch.synthesis !== undefined ? patch.synthesis : current.synthesis;
    const plan = patch.plan !== undefined ? patch.plan : current.plan;
    const blackboard =
      patch.blackboard !== undefined ? patch.blackboard : current.blackboard;
    const skills = patch.skills !== undefined ? patch.skills : current.skills;
    const config = patch.config !== undefined ? patch.config : current.config;
    const workspaceId =
      patch.workspaceId !== undefined ? patch.workspaceId : current.workspace_id;
    const featureBranch =
      patch.featureBranch !== undefined
        ? patch.featureBranch
        : current.feature_branch;
    const prUrl = patch.prUrl !== undefined ? patch.prUrl : current.pr_url;
    const approvalStatus =
      patch.approvalStatus !== undefined
        ? patch.approvalStatus
        : current.approval_status;
    const interruptId =
      patch.interruptId !== undefined ? patch.interruptId : current.interrupt_id;
    const archivedAt =
      patch.archivedAt !== undefined ? patch.archivedAt : current.archived_at;
    const finished =
      patch.finished ||
      ['succeeded', 'failed', 'aborted'].includes(status);
    getConnection()
      .prepare(
        `UPDATE swarm_runs SET
           status = ?, findings_json = ?, synthesis_json = ?, plan_json = ?,
           blackboard_json = ?, skills_json = ?, config_json = ?,
           workspace_id = ?, feature_branch = ?, pr_url = ?,
           approval_status = ?, interrupt_id = ?, archived_at = ?,
           updated_at = CURRENT_TIMESTAMP,
           finished_at = CASE WHEN ? THEN COALESCE(finished_at, CURRENT_TIMESTAMP) ELSE finished_at END
         WHERE swarm_id = ?`,
      )
      .run(
        status,
        JSON.stringify(findings),
        synthesis ? JSON.stringify(synthesis) : null,
        plan ? JSON.stringify(plan) : null,
        JSON.stringify(blackboard ?? []),
        JSON.stringify(skills ?? []),
        config ? JSON.stringify(config) : null,
        workspaceId,
        featureBranch,
        prUrl,
        approvalStatus,
        interruptId,
        archivedAt,
        finished ? 1 : 0,
        swarmId,
      );
    return this.get(swarmId);
  },

  appendMessage(swarmId: string, message: SwarmMessage): SwarmRun | null {
    const current = this.get(swarmId);
    if (!current) return null;
    const blackboard = [...(current.blackboard ?? []), message];
    return this.update(swarmId, { blackboard });
  },

  createMember(input: {
    swarmId: string;
    role: string;
    kind?: string | null;
    label?: string | null;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    permissionMode?: string | null;
    skills?: string[] | null;
    stepId?: string | null;
    runId?: string | null;
    status: string;
  }): SwarmMember {
    const id = newSwarmMemberId();
    getConnection()
      .prepare(
        `INSERT INTO swarm_members (
           member_id, swarm_id, role, kind, label, provider, model, effort,
           permission_mode, skills_json, step_id, run_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.swarmId,
        input.role,
        input.kind ?? null,
        input.label ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.effort ?? null,
        input.permissionMode ?? null,
        input.skills ? JSON.stringify(input.skills) : null,
        input.stepId ?? null,
        input.runId ?? null,
        input.status,
      );
    return this.getMember(id)!;
  },

  getMember(memberId: string): SwarmMember | null {
    const row = getConnection()
      .prepare(`SELECT * FROM swarm_members WHERE member_id = ?`)
      .get(memberId) as MemberRow | undefined;
    return row ? mapMember(row) : null;
  },

  listMembers(swarmId: string): SwarmMember[] {
    return (
      getConnection()
        .prepare(`SELECT * FROM swarm_members WHERE swarm_id = ? ORDER BY created_at ASC`)
        .all(swarmId) as MemberRow[]
    ).map(mapMember);
  },

  updateMember(
    memberId: string,
    patch: Partial<{
      status: string;
      findingsSummary: string | null;
      error: string | null;
      runId: string | null;
      stepId: string | null;
      finished: boolean;
    }>,
  ): SwarmMember | null {
    const current = this.getMember(memberId);
    if (!current) return null;
    const status = patch.status ?? current.status;
    const finished =
      patch.finished ||
      ['succeeded', 'failed', 'aborted'].includes(status);
    getConnection()
      .prepare(
        `UPDATE swarm_members SET status = ?, findings_summary = ?, error = ?,
         run_id = COALESCE(?, run_id),
         step_id = COALESCE(?, step_id),
         finished_at = CASE WHEN ? THEN COALESCE(finished_at, CURRENT_TIMESTAMP) ELSE finished_at END
         WHERE member_id = ?`,
      )
      .run(
        status,
        patch.findingsSummary !== undefined
          ? patch.findingsSummary
          : current.findings_summary,
        patch.error !== undefined ? patch.error : current.error,
        patch.runId ?? null,
        patch.stepId ?? null,
        finished ? 1 : 0,
        memberId,
      );
    return this.getMember(memberId);
  },
};
