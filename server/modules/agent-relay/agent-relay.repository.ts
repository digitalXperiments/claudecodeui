import { getConnection } from '@/modules/database/index.js';
import type {
  AgentRelayApproval,
  AgentRelayApprovalStatus,
  AgentRelayDeniedAction,
  AgentRelayFailover,
  AgentRelayJob,
  AgentRelayResult,
  AgentRelayStatus,
  CreateAgentRelayApprovalInput,
  CreateAgentRelayJobInput,
} from '@/modules/agent-relay/agent-relay.types.js';

type AgentRelayRow = Omit<AgentRelayJob, 'mcp_servers' | 'result' | 'provider' | 'output_schema' | 'depends_on' | 'denied_actions' | 'failovers'> & {
  provider: string;
  denied_actions_json?: string | null;
  failover_json?: string | null;
  mcp_servers_json: string;
  output_schema_json: string | null;
  depends_on_json: string;
  result_json: string | null;
};

type DurableParse = { value: string[]; error?: string };

function parseStringArray(raw: string | null | undefined, field: string): DurableParse {
  if (typeof raw !== 'string') return { value: [], error: `${field} is missing` };
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return { value: [], error: `${field} must be a JSON array of strings` };
    }
    return { value };
  } catch (error) {
    return { value: [], error: `${field} is malformed JSON${error instanceof Error ? `: ${error.message}` : ''}` };
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

/** Advisory history: a corrupt value is dropped rather than quarantining the job. */
function parseDeniedActions(raw: string | null | undefined): AgentRelayDeniedAction[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') as AgentRelayDeniedAction[] : [];
  } catch {
    return [];
  }
}

const MAX_DENIED_ACTIONS = 50;

type AgentRelayApprovalRow = Omit<AgentRelayApproval, 'paths' | 'status'> & {
  status: string;
  paths_json: string;
};

function mapApprovalRow(row: AgentRelayApprovalRow): AgentRelayApproval {
  const { paths_json: _paths, ...rest } = row;
  return {
    ...rest,
    status: row.status as AgentRelayApproval['status'],
    paths: parseStringArray(row.paths_json, 'approval.paths_json').value,
  };
}

type ParsedJob = { job: AgentRelayJob; durableError: string | null };

function parseObject(raw: string | null | undefined, field: string): { value: Record<string, unknown> | null; error?: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { value: null, error: `${field} must be a JSON object` };
    }
    return { value: value as Record<string, unknown> };
  } catch (error) {
    return { value: null, error: `${field} is malformed JSON${error instanceof Error ? `: ${error.message}` : ''}` };
  }
}

function mapRow(row: AgentRelayRow): ParsedJob {
  const {
    mcp_servers_json: _mcp,
    output_schema_json: _schema,
    depends_on_json: _deps,
    result_json: _result,
    denied_actions_json: _denied,
    failover_json: _failovers,
    ...rest
  } = row;
  const mcpServers = parseStringArray(row.mcp_servers_json, 'mcp_servers_json');
  const dependsOn = parseStringArray(row.depends_on_json, 'depends_on_json');
  const outputSchema = parseObject(row.output_schema_json, 'output_schema_json');
  const errors = [mcpServers.error, dependsOn.error, outputSchema.error].filter((error): error is string => Boolean(error));
  const durableError = errors.length > 0
    ? `Malformed durable Agent Relay data quarantined: ${errors.join('; ')}`
    : null;
  const job: AgentRelayJob = {
    ...rest,
    provider: row.provider as AgentRelayJob['provider'],
    mcp_servers: mcpServers.value,
    output_schema: outputSchema.value,
    depends_on: dependsOn.value,
    result: parseResult(row.result_json),
    denied_actions: parseDeniedActions(row.denied_actions_json),
    failovers: parseDeniedActions(row.failover_json) as unknown as AgentRelayFailover[],
  };
  if (durableError) {
    job.status = 'failed';
    job.error = durableError;
    job.finished_at = job.finished_at ?? new Date().toISOString();
  }
  return { job, durableError };
}

function mapRows(rows: AgentRelayRow[]): AgentRelayJob[] {
  const parsed = rows.map(mapRow);
  const db = getConnection();
  const quarantine = db.prepare(`
    UPDATE agent_relay_jobs
    SET status = 'failed', error = ?, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE relay_id = ? AND status != 'failed'
  `);
  for (const entry of parsed) {
    if (entry.durableError) quarantine.run(entry.job.error, entry.job.relay_id);
  }
  return parsed.map(({ job }) => job);
}

function insertJob(db: ReturnType<typeof getConnection>, input: CreateAgentRelayJobInput): void {
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
}

export const agentRelayDb = {
  create(input: CreateAgentRelayJobInput): AgentRelayJob {
    const db = getConnection();
    insertJob(db, input);
    const created = this.get(input.relayId);
    if (!created) throw new Error('Failed to create Agent Relay job.');
    return created;
  },

  /** Inserts a complete batch atomically so no partial pipeline can escape. */
  createBatch(inputs: CreateAgentRelayJobInput[]): AgentRelayJob[] {
    const db = getConnection();
    db.transaction(() => {
      for (const input of inputs) insertJob(db, input);
    })();
    const jobs = inputs.map((input) => this.get(input.relayId));
    if (jobs.some((job): job is null => job === null)) throw new Error('Failed to create the complete Agent Relay batch.');
    return jobs as AgentRelayJob[];
  },

  get(relayId: string): AgentRelayJob | null {
    const row = getConnection()
      .prepare('SELECT * FROM agent_relay_jobs WHERE relay_id = ?')
      .get(relayId) as AgentRelayRow | undefined;
    return row ? mapRows([row])[0] ?? null : null;
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
    return mapRows(getConnection().prepare(sql).all(...params, limit) as AgentRelayRow[]);
  },

  listQueued(limit = 100): AgentRelayJob[] {
    return mapRows((getConnection().prepare(
      "SELECT * FROM agent_relay_jobs WHERE status = 'queued' ORDER BY created_at, relay_id LIMIT ?",
    ).all(Math.min(Math.max(limit, 1), 500)) as AgentRelayRow[]));
  },

  /** FIFO queue scan for the scheduler; unlike listQueued this is not a UI-sized page. */
  listAllQueued(): AgentRelayJob[] {
    return mapRows((getConnection().prepare(
      "SELECT * FROM agent_relay_jobs WHERE status = 'queued' ORDER BY created_at, relay_id",
    ).all() as AgentRelayRow[]));
  },

  /**
   * Move in-flight jobs from one lead session to another (handoff). Finished
   * jobs keep their original source for history.
   */
  rehomeSourceSession(fromSessionId: string, toSessionId: string): number {
    return getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET source_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE source_session_id = ?
        AND status IN ('queued', 'running', 'waiting_approval')
    `).run(toSessionId, fromSessionId).changes;
  },

  /** All open jobs for lifecycle operations that must never truncate at a UI page size. */
  listActive(): AgentRelayJob[] {
    return mapRows((getConnection().prepare(
      "SELECT * FROM agent_relay_jobs WHERE status IN ('queued', 'running', 'waiting_approval') ORDER BY created_at, relay_id",
    ).all() as AgentRelayRow[]));
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
          pending_follow_up = NULL, updated_at = CURRENT_TIMESTAMP
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
          pending_follow_up = NULL, run_id = NULL, finished_at = NULL, schema_retry_count = 0,
          timeout_ms = COALESCE(?, timeout_ms), updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status IN ('completed', 'blocked', 'failed', 'timed_out', 'cancelled')
    `).run(prompt, timeoutMs ?? null, relayId);
    return this.get(relayId);
  },

  /**
   * Merges a lead follow-up directly into `last_prompt` for a job that has
   * not started executing yet, so the attempt about to be dispatched already
   * includes it. Scoped to `queued` only.
   */
  appendToLastPrompt(relayId: string, prompt: string): AgentRelayJob | null {
    const changes = getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET last_prompt = last_prompt || char(10) || char(10) || 'Additional instructions from the lead:' || char(10) || ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status = 'queued'
    `).run(prompt, relayId).changes;
    return changes > 0 ? this.get(relayId) : null;
  },

  /**
   * Records a lead follow-up that could not be delivered into a live provider
   * turn (no mid-run injection support, or the attempt failed). Held for
   * delivery on the job's next attempt. Scoped to non-terminal statuses.
   */
  appendPendingFollowUp(relayId: string, prompt: string): AgentRelayJob | null {
    const changes = getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET pending_follow_up = CASE
            WHEN pending_follow_up IS NULL OR pending_follow_up = '' THEN ?
            ELSE pending_follow_up || char(10) || char(10) || ?
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status IN ('queued', 'running', 'waiting_approval')
    `).run(prompt, prompt, relayId).changes;
    return changes > 0 ? this.get(relayId) : null;
  },

  /** Reads and clears a job's queued mid-session follow-up, if any. */
  takePendingFollowUp(relayId: string): string | null {
    const job = this.get(relayId);
    if (!job || !job.pending_follow_up) return null;
    getConnection().prepare(`
      UPDATE agent_relay_jobs SET pending_follow_up = NULL, updated_at = CURRENT_TIMESTAMP WHERE relay_id = ?
    `).run(relayId);
    return job.pending_follow_up;
  },

  /**
   * Sends a still-running job back to the queue for another attempt carrying
   * a mid-session follow-up that could not be injected live. Used at the end
   * of a run instead of finishing it, so the worker's next turn sees it
   * immediately rather than waiting for the lead to notice completion.
   */
  requeueWithFollowUp(relayId: string, prompt: string): AgentRelayJob | null {
    const changes = getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = 'queued', last_prompt = ?, pending_follow_up = NULL, result_json = NULL,
          error = NULL, run_id = NULL, finished_at = NULL, schema_retry_count = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status = 'running'
    `).run(prompt, relayId).changes;
    return changes > 0 ? this.get(relayId) : null;
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

  /**
   * Re-dispatch a job that failed before doing anything to another provider.
   * Keeps the brief, the attempt, and the writer's (untouched) worktree.
   */
  reassignForFailover(relayId: string, input: {
    provider: AgentRelayJob['provider'];
    model: string | null;
    requestedModel: string | null;
    modelLabel: string | null;
    catalogDefaultModel: string | null;
    catalogResolvedModel: string | null;
    modelSelectionSource: AgentRelayJob['model_selection_source'];
    effort: string | null;
    failover: AgentRelayFailover;
  }): AgentRelayJob | null {
    const job = this.get(relayId);
    if (!job) return null;
    const failovers = [...job.failovers, input.failover].slice(-10);
    const changes = getConnection().prepare(`
      UPDATE agent_relay_jobs
      SET status = 'queued', provider = ?, model = ?, requested_model = ?, model_label = ?,
          catalog_default_model = ?, catalog_resolved_model = ?, runtime_resolved_model = NULL,
          model_selection_source = ?, effort = ?, failover_json = ?,
          app_session_id = NULL, run_id = NULL, result_json = NULL, error = NULL, finished_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE relay_id = ? AND status IN ('queued', 'running', 'waiting_approval')
    `).run(
      input.provider,
      input.model,
      input.requestedModel,
      input.modelLabel,
      input.catalogDefaultModel,
      input.catalogResolvedModel,
      input.modelSelectionSource,
      input.effort,
      JSON.stringify(failovers),
      relayId,
    ).changes;
    return changes > 0 ? this.get(relayId) : null;
  },

  appendDeniedAction(relayId: string, action: AgentRelayDeniedAction): AgentRelayJob | null {
    const job = this.get(relayId);
    if (!job) return null;
    const next = [...job.denied_actions, action].slice(-MAX_DENIED_ACTIONS);
    getConnection().prepare(`
      UPDATE agent_relay_jobs SET denied_actions_json = ?, updated_at = CURRENT_TIMESTAMP WHERE relay_id = ?
    `).run(JSON.stringify(next), relayId);
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
    projectId?: string;
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
    if (input.projectId) {
      where.push('job.project_id = ?');
      params.push(input.projectId);
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

  listTerminalOlderThan(retentionDays: number): AgentRelayJob[] {
    const days = Math.min(Math.max(Math.trunc(retentionDays), 1), 365);
    return mapRows((getConnection().prepare(`
      SELECT * FROM agent_relay_jobs
      WHERE status IN ('completed', 'blocked', 'failed', 'cancelled', 'timed_out')
        AND finished_at IS NOT NULL
        AND datetime(finished_at) < datetime('now', ?)
    `).all(`-${days} days`) as AgentRelayRow[]));
  },

  /**
   * Drop finished jobs (and cascaded approvals) older than `retentionDays`.
   * Active rows are never deleted.
   */
  purgeTerminalOlderThan(retentionDays: number, relayIds?: string[]): number {
    const days = Math.min(Math.max(Math.trunc(retentionDays), 1), 365);
    const ids = [...new Set((relayIds ?? []).filter(Boolean))];
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    return Number(getConnection().prepare(`
      DELETE FROM agent_relay_jobs
      WHERE status IN ('completed', 'blocked', 'failed', 'cancelled', 'timed_out')
        AND finished_at IS NOT NULL
        AND datetime(finished_at) < datetime('now', ?)
        AND relay_id IN (${placeholders})
    `).run(`-${days} days`, ...ids).changes);
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
