import { getConnection } from '@/modules/database/index.js';
import type {
  AgentRelayApproval,
  AgentRelayApprovalStatus,
  AgentRelayJob,
  AgentRelayResult,
  AgentRelayStatus,
  CreateAgentRelayApprovalInput,
  CreateAgentRelayJobInput,
} from '@/modules/agent-relay/agent-relay.types.js';

type AgentRelayRow = Omit<AgentRelayJob, 'mcp_servers' | 'result' | 'provider' | 'output_schema' | 'depends_on'> & {
  provider: string;
  mcp_servers_json: string;
  output_schema_json: string | null;
  depends_on_json: string;
  result_json: string | null;
};

function parseStringArray(raw: string | null | undefined): string[] {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseResult(raw: string | null | undefined): AgentRelayResult | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value as AgentRelayResult : null;
  } catch {
    return null;
  }
}

type AgentRelayApprovalRow = Omit<AgentRelayApproval, 'paths' | 'status'> & {
  status: string;
  paths_json: string;
};

function mapApprovalRow(row: AgentRelayApprovalRow): AgentRelayApproval {
  const { paths_json: _paths, ...rest } = row;
  return {
    ...rest,
    status: row.status as AgentRelayApproval['status'],
    paths: parseStringArray(row.paths_json),
  };
}

function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mapRow(row: AgentRelayRow): AgentRelayJob {
  const { mcp_servers_json: _mcp, output_schema_json: _schema, depends_on_json: _deps, result_json: _result, ...rest } = row;
  return {
    ...rest,
    provider: row.provider as AgentRelayJob['provider'],
    mcp_servers: parseStringArray(row.mcp_servers_json),
    output_schema: parseObject(row.output_schema_json),
    depends_on: parseStringArray(row.depends_on_json),
    result: parseResult(row.result_json),
  };
}

export const agentRelayDb = {
  create(input: CreateAgentRelayJobInput): AgentRelayJob {
    const db = getConnection();
    db.prepare(`
      INSERT INTO agent_relay_jobs (
        relay_id, batch_id, project_id, project_path, source_session_id,
        provider, model, requested_model, model_label, catalog_default_model,
        catalog_resolved_model, model_selection_source, effort, mode, approval_policy, status, label, task, last_prompt,
        mcp_servers_json, output_schema_json, depends_on_json, retries,
        timeout_ms, attempt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      input.relayId,
      input.batchId,
      input.projectId,
      input.projectPath,
      input.sourceSessionId ?? null,
      input.provider,
      input.model ?? null,
      input.requestedModel ?? null,
      input.modelLabel ?? null,
      input.catalogDefaultModel ?? null,
      input.catalogResolvedModel ?? null,
      input.modelSelectionSource ?? null,
      input.effort ?? null,
      input.mode,
      input.approvalPolicy ?? 'auto',
      input.label ?? null,
      input.task,
      input.prompt,
      JSON.stringify(input.mcpServers),
      input.outputSchema ? JSON.stringify(input.outputSchema) : null,
      JSON.stringify(input.dependsOn ?? []),
      Math.max(0, Math.trunc(input.retries ?? 0)),
      input.timeoutMs,
    );
    const created = this.get(input.relayId);
    if (!created) throw new Error('Failed to create Agent Relay job.');
    return created;
  },

  get(relayId: string): AgentRelayJob | null {
    const row = getConnection()
      .prepare('SELECT * FROM agent_relay_jobs WHERE relay_id = ?')
      .get(relayId) as AgentRelayRow | undefined;
    return row ? mapRow(row) : null;
  },

  list(input: {
    projectId?: string;
    batchId?: string;
    sourceSessionId?: string;
    /**
     * Everything relevant to one open session: the relays it dispatched, the
     * relay it *is* (when the user is looking at a worker's transcript), and
     * that relay's batch siblings. Without the sibling arm, opening one worker
     * of a three-worker batch shows an empty panel.
     */
    relevantToSessionId?: string;
    active?: boolean;
    limit?: number;
  } = {}): AgentRelayJob[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.projectId) {
      where.push('project_id = ?');
      params.push(input.projectId);
    }
    if (input.batchId) {
      where.push('batch_id = ?');
      params.push(input.batchId);
    }
    if (input.sourceSessionId) {
      where.push('source_session_id = ?');
      params.push(input.sourceSessionId);
    }
    if (input.relevantToSessionId) {
      where.push(`(
        source_session_id = ?
        OR app_session_id = ?
        OR batch_id IN (SELECT batch_id FROM agent_relay_jobs WHERE app_session_id = ?)
      )`);
      params.push(input.relevantToSessionId, input.relevantToSessionId, input.relevantToSessionId);
    }
    if (input.active === true) {
      where.push("status IN ('queued', 'running', 'waiting_approval')");
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
    const sql = `SELECT * FROM agent_relay_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, relay_id DESC LIMIT ?`;
    return (getConnection().prepare(sql).all(...params, limit) as AgentRelayRow[]).map(mapRow);
  },

  listQueued(limit = 100): AgentRelayJob[] {
    return (getConnection().prepare(
      "SELECT * FROM agent_relay_jobs WHERE status = 'queued' ORDER BY created_at, relay_id LIMIT ?",
    ).all(Math.min(Math.max(limit, 1), 500)) as AgentRelayRow[]).map(mapRow);
  },

  /** FIFO queue scan for the scheduler; unlike listQueued this is not a UI-sized page. */
  listAllQueued(): AgentRelayJob[] {
    return (getConnection().prepare(
      "SELECT * FROM agent_relay_jobs WHERE status = 'queued' ORDER BY created_at, relay_id",
    ).all() as AgentRelayRow[]).map(mapRow);
  },

  /** All open jobs for lifecycle operations that must never truncate at a UI page size. */
  listActive(): AgentRelayJob[] {
    return (getConnection().prepare(
      "SELECT * FROM agent_relay_jobs WHERE status IN ('queued', 'running', 'waiting_approval') ORDER BY created_at, relay_id",
    ).all() as AgentRelayRow[]).map(mapRow);
  },

  attachExecution(relayId: string, input: {
    appSessionId: string;
    runId: string;
    workspaceId?: string | null;
  }): AgentRelayJob | null {
    getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET app_session_id = ?, run_id = ?, workspace_id = ?, status = 'running',
          attempt = attempt + 1, started_at = CURRENT_TIMESTAMP,
          finished_at = NULL, error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status = 'queued'
    `).run(input.appSessionId, input.runId, input.workspaceId ?? null, relayId);
    return this.get(relayId);
  },

  setWorkspace(relayId: string, workspaceId: string): void {
    getConnection().prepare(`
      UPDATE agent_relay_jobs SET workspace_id = ?, updated_at = CURRENT_TIMESTAMP WHERE relay_id = ?
    `).run(workspaceId, relayId);
  },

  setRuntimeResolvedModel(relayId: string, model: string): AgentRelayJob | null {
    const normalized = model.trim();
    if (!normalized) return null;
    const changes = getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET runtime_resolved_model = ?, updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND runtime_resolved_model IS NOT ?
    `).run(normalized, relayId, normalized).changes;
    return changes > 0 ? this.get(relayId) : null;
  },

  finish(relayId: string, status: AgentRelayStatus, input: {
    result?: AgentRelayResult | null;
    error?: string | null;
  } = {}): AgentRelayJob | null {
    getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = ?, result_json = ?, error = ?, finished_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status IN ('queued', 'running', 'waiting_approval')
    `).run(
      status,
      input.result ? JSON.stringify(input.result) : null,
      input.error ?? null,
      relayId,
    );
    return this.get(relayId);
  },

  /**
   * Re-queues a job after an infrastructure failure (spawn error, provider
   * crash with no output). The session link is cleared so the retry gets a
   * fresh worker instead of resuming a possibly-poisoned transcript.
   */
  requeueForRetry(relayId: string): AgentRelayJob | null {
    const changes = getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = 'queued', retry_count = retry_count + 1, app_session_id = NULL,
          run_id = NULL, result_json = NULL, error = NULL, finished_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status IN ('queued', 'running', 'waiting_approval') AND retry_count < retries
    `).run(relayId).changes;
    return changes > 0 ? this.get(relayId) : null;
  },

  /**
   * Sends one automatic repair turn to the same worker session when its
   * structured output failed schema validation. At most one repair per turn:
   * the counter is reset by explicit lead follow-ups, not by the repair itself.
   */
  queueSchemaRepair(relayId: string, prompt: string): AgentRelayJob | null {
    const changes = getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = 'queued', schema_retry_count = schema_retry_count + 1, last_prompt = ?,
          result_json = NULL, error = NULL, run_id = NULL, finished_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status IN ('running', 'waiting_approval') AND schema_retry_count < 1
    `).run(prompt, relayId).changes;
    return changes > 0 ? this.get(relayId) : null;
  },

  queueFollowUp(relayId: string, prompt: string, timeoutMs?: number): AgentRelayJob | null {
    getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = 'queued', last_prompt = ?, result_json = NULL, error = NULL,
          run_id = NULL, finished_at = NULL, schema_retry_count = 0,
          timeout_ms = COALESCE(?, timeout_ms), updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status IN ('completed', 'failed', 'timed_out', 'cancelled')
    `).run(prompt, timeoutMs ?? null, relayId);
    return this.get(relayId);
  },

  /**
   * Parks a live job while the lead decides on an out-of-envelope request.
   * Scoped to `running` so a cancel that already landed always wins.
   */
  markWaitingApproval(relayId: string): AgentRelayJob | null {
    getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = 'waiting_approval', updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status = 'running'
    `).run(relayId);
    return this.get(relayId);
  },

  /** Returns a parked job to `running` once its request has been answered. */
  clearWaitingApproval(relayId: string): AgentRelayJob | null {
    getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = 'running', updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status = 'waiting_approval'
    `).run(relayId);
    return this.get(relayId);
  },

  // ——— Out-of-envelope permission approvals ———————————————————————————

  createApproval(input: CreateAgentRelayApprovalInput): AgentRelayApproval {
    getConnection().prepare(`
      INSERT INTO agent_relay_approvals (
        approval_id, relay_id, request_id, tool_name, command, paths_json, cwd, reason, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      input.approvalId,
      input.relayId,
      input.requestId,
      input.toolName,
      input.command,
      JSON.stringify(input.paths),
      input.cwd,
      input.reason,
    );
    const created = this.getApproval(input.approvalId);
    if (!created) throw new Error('Failed to record the Agent Relay approval request.');
    return created;
  },

  getApproval(approvalId: string): AgentRelayApproval | null {
    const row = getConnection()
      .prepare('SELECT * FROM agent_relay_approvals WHERE approval_id = ?')
      .get(approvalId) as AgentRelayApprovalRow | undefined;
    return row ? mapApprovalRow(row) : null;
  },

  getApprovalByRequestId(requestId: string): AgentRelayApproval | null {
    const row = getConnection()
      .prepare('SELECT * FROM agent_relay_approvals WHERE request_id = ?')
      .get(requestId) as AgentRelayApprovalRow | undefined;
    return row ? mapApprovalRow(row) : null;
  },

  /**
   * Lists approvals, optionally narrowed to one lead session's own jobs so a
   * lead can never see (or answer) another session's worker requests.
   */
  listApprovals(input: {
    relayId?: string;
    sourceSessionId?: string;
    status?: AgentRelayApprovalStatus;
    limit?: number;
  } = {}): AgentRelayApproval[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.relayId) {
      where.push('approval.relay_id = ?');
      params.push(input.relayId);
    }
    if (input.status) {
      where.push('approval.status = ?');
      params.push(input.status);
    }
    if (input.sourceSessionId) {
      where.push('job.source_session_id = ?');
      params.push(input.sourceSessionId);
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
    const rows = getConnection().prepare(`
      SELECT approval.* FROM agent_relay_approvals AS approval
      INNER JOIN agent_relay_jobs AS job ON job.relay_id = approval.relay_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY approval.created_at DESC, approval.approval_id DESC LIMIT ?
    `).all(...params, limit) as AgentRelayApprovalRow[];
    return rows.map(mapApprovalRow);
  },

  /**
   * Records a decision exactly once. Returns null when the request was already
   * answered (or expired), which is how the broker keeps a late lead decision
   * from resolving a request the timeout already denied.
   */
  decideApproval(
    approvalId: string,
    status: Exclude<AgentRelayApprovalStatus, 'pending'>,
    input: { reason?: string | null; decidedBy?: string | null } = {},
  ): AgentRelayApproval | null {
    const changes = getConnection().prepare(`
      UPDATE agent_relay_approvals
      SET status = ?, decision_reason = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
      WHERE approval_id = ? AND status = 'pending'
    `).run(status, input.reason ?? null, input.decidedBy ?? null, approvalId).changes;
    return changes > 0 ? this.getApproval(approvalId) : null;
  },

  /** Expires still-pending approvals for a job that has stopped running. */
  expirePendingApprovals(relayId: string, reason: string): number {
    return Number(getConnection().prepare(`
      UPDATE agent_relay_approvals
      SET status = 'expired', decision_reason = ?, decided_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status = 'pending'
    `).run(reason, relayId).changes);
  },

  failNonterminalOnBoot(): number {
    return Number(getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = 'failed', error = 'CloudCLI restarted before this delegation finished.',
          finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      -- Queued work has never crossed the provider boundary and is safe to
      -- retain for the scheduler after restart. Only interrupted executions
      -- are failed because blindly replaying them could duplicate side effects.
      WHERE status IN ('running', 'waiting_approval')
    `).run().changes);
  },

  expireAllPendingApprovals(reason: string): number {
    return Number(getConnection().prepare(`
      UPDATE agent_relay_approvals
      SET status = 'expired', decision_reason = ?, decided_by = 'system', decided_at = CURRENT_TIMESTAMP
      WHERE status = 'pending'
    `).run(reason).changes);
  },

  patchResult(relayId: string, result: AgentRelayResult): AgentRelayJob | null {
    getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET result_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ?
    `).run(JSON.stringify(result), relayId);
    return this.get(relayId);
  },
};
