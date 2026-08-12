import { getConnection } from '@/modules/database/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { newSwarmId, newSwarmMemberId } from '@/shared/ids.js';
import type {
  SwarmAgentSpec,
  SwarmArtifact,
  SwarmConfig,
  SwarmFinding,
  SwarmHandoff,
  SwarmMember,
  SwarmMessage,
  SwarmPlan,
  SwarmRun,
  SwarmStepAttempt,
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
  version?: number;
  cancel_requested_at?: string | null;
  last_error?: string | null;
  idempotency_key?: string | null;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type ArtifactRow = {
  artifact_id: string;
  swarm_id: string;
  step_id: string | null;
  attempt_id: string | null;
  kind: string;
  label: string;
  content: string | null;
  path: string | null;
  created_at: string;
};

type MessageRow = {
  message_id: string;
  swarm_id: string;
  seq: number;
  from_agent: string;
  to_agent: string | null;
  kind: string;
  content: string;
  step_id: string | null;
  at: string;
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

type SwarmPatch = Partial<{
  status: string;
  /** Roster seats (auto-roster selection persists the picked seats here). */
  roles: SwarmAgentSpec[];
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
  cancelRequestedAt: string | null;
  lastError: string | null;
}>;

function parse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Keep credentials out of the durable swarm blackboard and validation reports. */
export function redactSwarmText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\b\s*=\s*)[^\s]+/g, '$1[REDACTED]');
}

function listArtifactsForSwarm(swarmId: string): SwarmArtifact[] {
  try {
    const rows = getConnection()
      .prepare(`SELECT * FROM swarm_artifacts WHERE swarm_id = ? ORDER BY created_at ASC`)
      .all(swarmId) as ArtifactRow[];
    return rows.map((row) => ({
      artifact_id: row.artifact_id,
      swarm_id: row.swarm_id,
      step_id: row.step_id,
      attempt_id: row.attempt_id,
      kind: row.kind,
      label: row.label,
      content: row.content == null ? null : redactSwarmText(row.content),
      path: row.path,
      created_at: row.created_at,
    }));
  } catch {
    return [];
  }
}

function listMessagesForSwarm(swarmId: string): SwarmMessage[] {
  try {
    const rows = getConnection()
      .prepare(`SELECT * FROM swarm_messages WHERE swarm_id = ? ORDER BY seq ASC`)
      .all(swarmId) as MessageRow[];
    return rows.map((row) => ({
      id: row.message_id,
      from: row.from_agent,
      to: row.to_agent,
      kind: row.kind as SwarmMessage['kind'],
      content: redactSwarmText(row.content),
      stepId: row.step_id,
      at: row.at,
    }));
  } catch {
    // Older/partially migrated databases retain the JSON fallback.
    return [];
  }
}

function broadcastSwarmUpdate(swarm: SwarmRun): void {
  broadcastSystemEvent({
    kind: 'swarm_updated',
    swarm_id: swarm.swarm_id,
    project_id: swarm.project_id,
    status: swarm.status,
    version: swarm.version,
    updated_at: swarm.updated_at,
  });
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
  const messages = listMessagesForSwarm(row.swarm_id);
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
    // New rows use the append-only message log. Keep the JSON column as a
    // compatibility fallback for databases upgraded from older swarm builds.
    blackboard:
      messages.length > 0
        ? messages
        : parse<SwarmMessage[]>(row.blackboard_json, []).map((message) => ({
            ...message,
            content: redactSwarmText(message.content || ''),
          })),
    skills: parse<string[]>(row.skills_json, []),
    config: parse<SwarmConfig | null>(row.config_json, null),
    workspace_id: row.workspace_id ?? null,
    feature_branch: row.feature_branch ?? null,
    pr_url: row.pr_url ?? null,
    approval_status: (row.approval_status as SwarmRun['approval_status']) ?? null,
    interrupt_id: row.interrupt_id,
    version: row.version ?? 0,
    cancel_requested_at: row.cancel_requested_at ?? null,
    last_error: row.last_error ?? null,
    idempotency_key: row.idempotency_key ?? null,
    lease_owner: row.lease_owner ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    members,
    artifacts: listArtifactsForSwarm(row.swarm_id),
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
    idempotencyKey?: string | null;
  }): SwarmRun {
    const id = newSwarmId();
    const result = getConnection()
      .prepare(
        `INSERT INTO swarm_runs (
           swarm_id, project_id, parent_run_id, goal, status, roles_json,
           findings_json, approval_status, skills_json, config_json, blackboard_json,
           idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, '[]', ?)`,
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
        input.idempotencyKey ?? null,
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

  getByIdempotency(projectId: string, idempotencyKey: string): SwarmRun | null {
    const row = getConnection()
      .prepare(`SELECT * FROM swarm_runs WHERE project_id = ? AND idempotency_key = ?`)
      .get(projectId, idempotencyKey) as SwarmRow | undefined;
    return row ? mapSwarm(row, this.listMembers(row.swarm_id)) : null;
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
    patch: SwarmPatch,
    guard: {
      expectedStatuses?: string[];
      expectedVersion?: number;
      allowTerminalTransition?: boolean;
    } = {},
  ): SwarmRun | null {
    const current = this.get(swarmId);
    if (!current) return null;
    const terminal = ['succeeded', 'failed', 'aborted'].includes(current.status);
    if (
      terminal &&
      patch.status !== undefined &&
      patch.status !== current.status &&
      guard.allowTerminalTransition !== true
    ) {
      return null;
    }
    if (guard.expectedStatuses && !guard.expectedStatuses.includes(current.status)) return null;
    if (guard.expectedVersion !== undefined && current.version !== guard.expectedVersion) return null;
    const status = patch.status ?? current.status;
    const roles = patch.roles !== undefined ? patch.roles : current.roles;
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
    const cancelRequestedAt =
      patch.cancelRequestedAt !== undefined
        ? patch.cancelRequestedAt
        : current.cancel_requested_at;
    const lastError =
      patch.lastError !== undefined ? patch.lastError : current.last_error;
    const finished =
      patch.finished ||
      ['succeeded', 'failed', 'aborted'].includes(status);
    const result = getConnection()
      .prepare(
        `UPDATE swarm_runs SET
           status = ?, roles_json = ?, findings_json = ?, synthesis_json = ?, plan_json = ?,
           blackboard_json = ?, skills_json = ?, config_json = ?,
           workspace_id = ?, feature_branch = ?, pr_url = ?,
           approval_status = ?, interrupt_id = ?, archived_at = ?,
           cancel_requested_at = ?, last_error = ?, version = version + 1,
           updated_at = CURRENT_TIMESTAMP,
           finished_at = CASE
             WHEN ? THEN COALESCE(finished_at, CURRENT_TIMESTAMP)
             WHEN ? THEN NULL
             ELSE finished_at
           END
         WHERE swarm_id = ?
           AND (? IS NULL OR status IN (${guard.expectedStatuses?.map(() => '?').join(', ') || "''"}))
           AND (? IS NULL OR version = ?)
           AND (? = 1 OR status NOT IN ('succeeded','failed','aborted') OR status = ?)`,
      )
      .run(
        status,
        JSON.stringify(roles ?? []),
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
        cancelRequestedAt,
        lastError,
        finished ? 1 : 0,
        patch.finished === false && guard.allowTerminalTransition === true ? 1 : 0,
        swarmId,
        guard.expectedStatuses ? 1 : null,
        ...(guard.expectedStatuses ?? []),
        guard.expectedVersion ?? null,
        guard.expectedVersion ?? null,
        guard.allowTerminalTransition === true ? 1 : 0,
        status,
      );
    if (result.changes !== 1) return null;
    const updated = this.get(swarmId);
    if (updated) broadcastSwarmUpdate(updated);
    return updated;
  },

  transition(
    swarmId: string,
    expectedStatuses: string[],
    patch: SwarmPatch,
    options: { allowTerminalTransition?: boolean } = {},
  ): SwarmRun | null {
    const current = this.get(swarmId);
    if (!current || !expectedStatuses.includes(current.status)) return null;
    return this.update(swarmId, patch, {
      expectedStatuses,
      expectedVersion: current.version,
      allowTerminalTransition: options.allowTerminalTransition,
    });
  },

  transitionWithLease(
    swarmId: string,
    expectedStatuses: string[],
    patch: SwarmPatch,
    owner: string,
    ttlMs: number,
    options: { allowTerminalTransition?: boolean } = {},
  ): SwarmRun | null {
    const db = getConnection();
    return db.transaction(() => {
      const before = this.get(swarmId);
      if (!before || !expectedStatuses.includes(before.status)) return null;
      if (
        before.lease_owner &&
        before.lease_owner !== owner &&
        before.lease_expires_at &&
        new Date(before.lease_expires_at).getTime() > Date.now()
      ) return null;
      const transitioned = this.transition(swarmId, expectedStatuses, patch, options);
      if (!transitioned) return null;
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const leased = db.prepare(
        `UPDATE swarm_runs SET lease_owner = ?, lease_expires_at = ?, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE swarm_id = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at IS NULL OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP)`,
      ).run(owner, expiresAt, swarmId, owner);
      return leased.changes === 1 ? this.get(swarmId) : null;
    }).immediate();
  },

  tryAcquireLease(swarmId: string, owner: string, ttlMs: number): boolean {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = getConnection().prepare(
      `UPDATE swarm_runs SET lease_owner = ?, lease_expires_at = ?, version = version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE swarm_id = ? AND status NOT IN ('succeeded','failed','aborted')
         AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at IS NULL OR datetime(lease_expires_at) <= CURRENT_TIMESTAMP)`,
    ).run(owner, expiresAt, swarmId, owner);
    return result.changes === 1;
  },

  renewLease(swarmId: string, owner: string, ttlMs: number): boolean {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const result = getConnection().prepare(
      `UPDATE swarm_runs SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE swarm_id = ? AND lease_owner = ? AND status NOT IN ('succeeded','failed','aborted')`,
    ).run(expiresAt, swarmId, owner);
    return result.changes === 1;
  },

  releaseLease(swarmId: string, owner: string): void {
    getConnection().prepare(
      `UPDATE swarm_runs SET lease_owner = NULL, lease_expires_at = NULL,
         updated_at = CURRENT_TIMESTAMP WHERE swarm_id = ? AND lease_owner = ?`,
    ).run(swarmId, owner);
  },

  appendMessage(swarmId: string, message: SwarmMessage): SwarmRun | null {
    const db = getConnection();
    const updated = db.transaction(() => {
      const row = db
        .prepare(`SELECT * FROM swarm_runs WHERE swarm_id = ?`)
        .get(swarmId) as SwarmRow | undefined;
    if (!row) return null;

      // Backfill legacy JSON messages exactly once before appending. The
      // immediate transaction serializes concurrent agents, so no blackboard
      // entries can be lost when explorers finish together.
      const existingCount = db
        .prepare(`SELECT COUNT(*) AS count FROM swarm_messages WHERE swarm_id = ?`)
        .get(swarmId) as { count: number };
      if (existingCount.count === 0) {
        const legacy = parse<SwarmMessage[]>(row.blackboard_json, []);
        const insert = db.prepare(
          `INSERT OR IGNORE INTO swarm_messages
             (message_id, swarm_id, seq, from_agent, to_agent, kind, content, step_id, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        legacy.forEach((entry, index) => {
          insert.run(
            entry.id || `legacy-${swarmId}-${index + 1}`,
            swarmId,
            index + 1,
            entry.from || 'system',
            entry.to ?? null,
            entry.kind || 'system',
            redactSwarmText(entry.content || ''),
            entry.stepId ?? null,
            entry.at || new Date().toISOString(),
          );
        });
      }

      const next = db
        .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM swarm_messages WHERE swarm_id = ?`)
        .get(swarmId) as { seq: number };
      const content = redactSwarmText(message.content || '');
      db.prepare(
        `INSERT INTO swarm_messages
           (message_id, swarm_id, seq, from_agent, to_agent, kind, content, step_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        message.id,
        swarmId,
        next.seq,
        message.from || 'system',
        message.to ?? null,
        message.kind || 'system',
        content,
        message.stepId ?? null,
        message.at || new Date().toISOString(),
      );
      // Keep the legacy column bounded and useful to older clients, while the
      // normalized table remains the source of truth for new readers.
      const recent = listMessagesForSwarm(swarmId).slice(-200);
      db.prepare(
        `UPDATE swarm_runs SET blackboard_json = ?, version = version + 1,
         updated_at = CURRENT_TIMESTAMP WHERE swarm_id = ?`,
      ).run(JSON.stringify(recent), swarmId);
      return this.get(swarmId);
    }).immediate();
    if (updated) broadcastSwarmUpdate(updated);
    return updated;
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

  createArtifact(input: {
    swarmId: string;
    stepId?: string | null;
    attemptId?: string | null;
    kind: string;
    label: string;
    content?: string | null;
    path?: string | null;
  }): SwarmArtifact {
    const artifactId = `sart_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    getConnection()
      .prepare(
        `INSERT INTO swarm_artifacts
           (artifact_id, swarm_id, step_id, attempt_id, kind, label, content, path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        input.swarmId,
        input.stepId ?? null,
        input.attemptId ?? null,
        input.kind,
        input.label,
        input.content == null ? null : redactSwarmText(input.content),
        input.path ?? null,
      );
    const artifact = listArtifactsForSwarm(input.swarmId).find((entry) => entry.artifact_id === artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} was not persisted`);
    return artifact;
  },

  listArtifacts(swarmId: string): SwarmArtifact[] {
    return listArtifactsForSwarm(swarmId);
  },

  updateMember(
    memberId: string,
    patch: Partial<{
      status: string;
      findingsSummary: string | null;
      error: string | null;
      runId: string | null;
      stepId: string | null;
      /** Resolved reasoning effort for the executing run (null = dropped/unsupported). */
      effort: string | null;
      /** Resolved provider permission mode actually used by the executing run. */
      permissionMode: string | null;
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
         effort = ?,
         permission_mode = ?,
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
        patch.effort !== undefined ? patch.effort : current.effort,
        patch.permissionMode !== undefined ? patch.permissionMode : current.permission_mode,
        finished ? 1 : 0,
        memberId,
      );
    return this.getMember(memberId);
  },

  createAttempt(input: {
    swarmId: string;
    stepId: string;
    memberId?: string | null;
    runId?: string | null;
    phase: string;
    status: string;
    workspaceId?: string | null;
  }): SwarmStepAttempt {
    const db = getConnection();
    return db.transaction(() => {
      const next = db
        .prepare(`SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM swarm_step_attempts WHERE swarm_id = ? AND step_id = ?`)
        .get(input.swarmId, input.stepId) as { n: number };
      const attemptId = `swatt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      db.prepare(
        `INSERT INTO swarm_step_attempts (
           attempt_id, swarm_id, step_id, member_id, run_id, phase, attempt_no,
           status, workspace_id, started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'running' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
      ).run(
        attemptId,
        input.swarmId,
        input.stepId,
        input.memberId ?? null,
        input.runId ?? null,
        input.phase,
        next.n,
        input.status,
        input.workspaceId ?? null,
        input.status,
      );
      return db.prepare(`SELECT * FROM swarm_step_attempts WHERE attempt_id = ?`).get(attemptId) as SwarmStepAttempt;
    }).immediate();
  },

  updateAttempt(
    attemptId: string,
    patch: { status: string; error?: string | null; memberId?: string | null; runId?: string | null },
  ): void {
    getConnection().prepare(
      `UPDATE swarm_step_attempts SET status = ?, error = ?,
         member_id = COALESCE(?, member_id), run_id = COALESCE(?, run_id),
         updated_at = CURRENT_TIMESTAMP,
         finished_at = CASE WHEN ? IN ('succeeded','failed','aborted','timed_out') THEN CURRENT_TIMESTAMP ELSE finished_at END
       WHERE attempt_id = ?`,
    ).run(
      patch.status,
      patch.error ?? null,
      patch.memberId ?? null,
      patch.runId ?? null,
      patch.status,
      attemptId,
    );
  },

  listAttempts(swarmId: string, stepId?: string): SwarmStepAttempt[] {
    return (stepId
      ? getConnection().prepare(`SELECT * FROM swarm_step_attempts WHERE swarm_id = ? AND step_id = ? ORDER BY attempt_no`).all(swarmId, stepId)
      : getConnection().prepare(`SELECT * FROM swarm_step_attempts WHERE swarm_id = ? ORDER BY created_at, attempt_no`).all(swarmId)) as SwarmStepAttempt[];
  },
};
