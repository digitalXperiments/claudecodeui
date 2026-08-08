import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import type {
  CreateWebhookSourceInput,
  UpdateWebhookSourceInput,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookProvider,
  WebhookScope,
  WebhookSource,
} from '@/modules/webhooks/webhooks.types.js';

type SourceRow = {
  source_id: string;
  source: string;
  name: string;
  description: string | null;
  enabled: number;
  provider: string;
  model: string | null;
  prompt: string | null;
  permission_mode: string | null;
  mcp_tools_json: string | null;
  skills_json: string | null;
  profile_id: string | null;
  scope: string | null;
  project_id: string | null;
  retry_max: number | null;
  retry_backoff_seconds: number | null;
  secret: string | null;
  secret_id: string | null;
  created_at: string;
  updated_at: string;
};

type DeliveryRow = {
  delivery_id: string;
  source_id: string;
  status: string;
  request_json: string | null;
  app_session_id: string | null;
  agent_run_id: string | null;
  error_message: string | null;
  result_preview: string | null;
  attempt: number | null;
  next_retry_at: string | null;
  created_at: string;
  finished_at: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim());
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapSource(row: SourceRow): WebhookSource {
  let secret = row.secret || null;
  if (row.secret_id) {
    try {
      secret = secretsService.resolve(row.secret_id, { provider: 'webhook' });
    } catch {
      secret = null;
    }
  }
  return {
    source_id: row.source_id,
    source: row.source,
    name: row.name,
    description: row.description ?? '',
    enabled: Boolean(row.enabled),
    provider: (row.provider || 'claude') as WebhookProvider,
    model: row.model || null,
    prompt: row.prompt ?? '',
    permission_mode: row.permission_mode || 'bypassPermissions',
    mcp_tools: parseStringArray(row.mcp_tools_json),
    skills: parseStringArray(row.skills_json),
    profile_id: row.profile_id || null,
    scope: (row.scope === 'project' ? 'project' : 'global') as WebhookScope,
    project_id: row.project_id || null,
    retryMax: row.retry_max ?? 0,
    retryBackoffSeconds: row.retry_backoff_seconds ?? 60,
    secret,
    secret_id: row.secret_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    delivery_id: row.delivery_id,
    source_id: row.source_id,
    status: (row.status || 'accepted') as WebhookDeliveryStatus,
    request: parseJsonObject(row.request_json),
    app_session_id: row.app_session_id,
    agent_run_id: row.agent_run_id,
    error_message: row.error_message,
    result_preview: row.result_preview,
    attempt: row.attempt ?? 0,
    next_retry_at: row.next_retry_at || null,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

function normalizeSourceSlug(value: string): string {
  return value.trim();
}

export const webhooksDb = {
  listSources(): WebhookSource[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT * FROM webhook_sources ORDER BY name ASC, created_at ASC`)
      .all() as SourceRow[];
    return rows.map(mapSource);
  },

  getSourceById(sourceId: string): WebhookSource | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM webhook_sources WHERE source_id = ?`)
      .get(sourceId) as SourceRow | undefined;
    return row ? mapSource(row) : null;
  },

  getSourceBySlug(source: string): WebhookSource | null {
    const slug = normalizeSourceSlug(source);
    if (!slug) return null;
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM webhook_sources WHERE source = ?`)
      .get(slug) as SourceRow | undefined;
    return row ? mapSource(row) : null;
  },

  createSource(input: CreateWebhookSourceInput): WebhookSource {
    const db = getConnection();
    const sourceId = randomUUID();
    const now = nowIso();
    const slug = normalizeSourceSlug(input.source);
    const name = (input.name || slug).trim();
    const scope: WebhookScope = input.scope === 'project' ? 'project' : 'global';
    const secretMeta = input.secret
      ? secretsService.put({
          name: `webhook_hmac_${sourceId}`,
          value: input.secret,
          scope: 'user',
          scopeRef: 'webhook',
          contentType: 'token',
        })
      : null;

    db.prepare(
      `INSERT INTO webhook_sources (
        source_id, source, name, description, enabled, provider, model, prompt,
        permission_mode, mcp_tools_json, skills_json, profile_id, scope, project_id,
        retry_max, retry_backoff_seconds, secret, secret_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceId,
      slug,
      name,
      input.description ?? '',
      input.enabled === false ? 0 : 1,
      input.provider || 'claude',
      input.model ?? null,
      input.prompt ?? '',
      input.permission_mode || 'bypassPermissions',
      JSON.stringify(input.mcp_tools ?? []),
      JSON.stringify(input.skills ?? []),
      input.profile_id ?? null,
      scope,
      scope === 'project' ? input.project_id ?? null : null,
      input.retryMax ?? 0,
      input.retryBackoffSeconds ?? 60,
      null,
      secretMeta?.secret_id ?? null,
      now,
      now,
    );

    const created = this.getSourceById(sourceId);
    if (!created) {
      throw new Error('Failed to create webhook source');
    }
    return created;
  },

  updateSource(sourceId: string, input: UpdateWebhookSourceInput): WebhookSource | null {
    const existing = this.getSourceById(sourceId);
    if (!existing) return null;

    const next: WebhookSource = {
      ...existing,
      ...(input.source !== undefined ? { source: normalizeSourceSlug(input.source) } : {}),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.permission_mode !== undefined ? { permission_mode: input.permission_mode } : {}),
      ...(input.mcp_tools !== undefined ? { mcp_tools: input.mcp_tools } : {}),
      ...(input.skills !== undefined ? { skills: input.skills } : {}),
      ...(input.profile_id !== undefined ? { profile_id: input.profile_id } : {}),
      ...(input.scope !== undefined
        ? { scope: input.scope === 'project' ? 'project' : 'global' }
        : {}),
      ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      ...(input.retryMax !== undefined ? { retryMax: input.retryMax } : {}),
      ...(input.retryBackoffSeconds !== undefined
        ? { retryBackoffSeconds: input.retryBackoffSeconds }
        : {}),
      ...(input.secret !== undefined ? { secret: input.secret } : {}),
      updated_at: nowIso(),
    };

    if (next.scope !== 'project') {
      next.project_id = null;
    }

    let secretId = existing.secret_id ?? null;
    if (input.secret !== undefined) {
      if (input.secret === null || !input.secret.trim()) {
        if (secretId) secretsService.delete(secretId);
        secretId = null;
      } else {
        const previous = secretId ? secretsService.getMeta(secretId) : null;
        const rotated = secretsService.put({
          name: previous?.name ?? `webhook_hmac_${sourceId}`,
          value: input.secret,
          scope: previous?.scope ?? 'user',
          scopeRef: previous?.scope_ref ?? 'webhook',
          contentType: 'token',
        });
        secretId = rotated.secret_id;
      }
    }

    const db = getConnection();
    db.prepare(
      `UPDATE webhook_sources SET
        source = ?, name = ?, description = ?, enabled = ?, provider = ?, model = ?,
        prompt = ?, permission_mode = ?, mcp_tools_json = ?, skills_json = ?,
        profile_id = ?, scope = ?, project_id = ?, retry_max = ?, retry_backoff_seconds = ?,
        secret = ?, secret_id = ?, updated_at = ?
      WHERE source_id = ?`,
    ).run(
      next.source,
      next.name,
      next.description,
      next.enabled ? 1 : 0,
      next.provider,
      next.model,
      next.prompt,
      next.permission_mode,
      JSON.stringify(next.mcp_tools),
      JSON.stringify(next.skills),
      next.profile_id,
      next.scope,
      next.project_id,
      next.retryMax,
      next.retryBackoffSeconds,
      null,
      secretId,
      next.updated_at,
      sourceId,
    );

    return this.getSourceById(sourceId);
  },

  deleteSource(sourceId: string): boolean {
    const db = getConnection();
    const existing = db
      .prepare(`SELECT secret_id FROM webhook_sources WHERE source_id = ?`)
      .get(sourceId) as { secret_id: string | null } | undefined;
    const result = db.prepare(`DELETE FROM webhook_sources WHERE source_id = ?`).run(sourceId);
    if (result.changes > 0 && existing?.secret_id) secretsService.delete(existing.secret_id);
    return result.changes > 0;
  },

  createDelivery(params: {
    sourceId: string;
    request: Record<string, unknown>;
    status?: WebhookDeliveryStatus;
    appSessionId?: string | null;
    agentRunId?: string | null;
  }): WebhookDelivery {
    const db = getConnection();
    const deliveryId = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO webhook_deliveries (
        delivery_id, source_id, status, request_json, app_session_id, agent_run_id, attempt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      deliveryId,
      params.sourceId,
      params.status || 'accepted',
      JSON.stringify(params.request ?? {}),
      params.appSessionId ?? null,
      params.agentRunId ?? null,
      1,
      now,
    );
    const created = this.getDeliveryById(deliveryId);
    if (!created) {
      throw new Error('Failed to create webhook delivery');
    }
    return created;
  },

  getDeliveryById(deliveryId: string): WebhookDelivery | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM webhook_deliveries WHERE delivery_id = ?`)
      .get(deliveryId) as DeliveryRow | undefined;
    return row ? mapDelivery(row) : null;
  },

  findDeliveryByAppSession(appSessionId: string): WebhookDelivery | null {
    if (!appSessionId) return null;
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE app_session_id = ? AND status IN ('accepted', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(appSessionId) as DeliveryRow | undefined;
    return row ? mapDelivery(row) : null;
  },

  listDeliveries(sourceId: string, limit = 50): WebhookDelivery[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE source_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sourceId, Math.min(Math.max(limit, 1), 200)) as DeliveryRow[];
    return rows.map(mapDelivery);
  },

  markDeliveryRunning(deliveryId: string, appSessionId: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE webhook_deliveries
       SET status = 'running', app_session_id = ?
       WHERE delivery_id = ?`,
    ).run(appSessionId, deliveryId);
  },

  setAgentRunId(deliveryId: string, agentRunId: string | null): void {
    const db = getConnection();
    db.prepare(`UPDATE webhook_deliveries SET agent_run_id = ? WHERE delivery_id = ?`).run(
      agentRunId,
      deliveryId,
    );
  },

  finishDelivery(
    deliveryId: string,
    status: 'done' | 'failed',
    params: { errorMessage?: string | null; resultPreview?: string | null } = {},
  ): void {
    const db = getConnection();
    db.prepare(
      `UPDATE webhook_deliveries
       SET status = ?, error_message = ?, result_preview = ?, finished_at = ?
       WHERE delivery_id = ?`,
    ).run(
      status,
      params.errorMessage ?? null,
      params.resultPreview ?? null,
      nowIso(),
      deliveryId,
    );
  },

  /** Set only the next retry timestamp; status is managed by the caller. */
  scheduleWebhookRetry(deliveryId: string, nextRetryAtIso: string): void {
    const db = getConnection();
    db.prepare(`UPDATE webhook_deliveries SET next_retry_at = ? WHERE delivery_id = ?`).run(
      nextRetryAtIso,
      deliveryId,
    );
  },

  /**
   * Mark a delivery failed, stamping finished_at and (when provided) scheduling
   * the next retry attempt in one write.
   */
  markDeliveryFailed(
    deliveryId: string,
    params: {
      errorMessage?: string | null;
      resultPreview?: string | null;
      nextRetryAtIso?: string;
    } = {},
  ): void {
    const db = getConnection();
    db.prepare(
      `UPDATE webhook_deliveries
       SET status = 'failed', error_message = ?, result_preview = ?, finished_at = ?,
           next_retry_at = COALESCE(?, next_retry_at)
       WHERE delivery_id = ?`,
    ).run(
      params.errorMessage ?? null,
      params.resultPreview ?? null,
      nowIso(),
      params.nextRetryAtIso ?? null,
      deliveryId,
    );
  },

  incrementDeliveryAttempt(deliveryId: string): void {
    const db = getConnection();
    db.prepare(`UPDATE webhook_deliveries SET attempt = attempt + 1 WHERE delivery_id = ?`).run(
      deliveryId,
    );
  },

  /** Prepare a previously-failed delivery for another dispatch (replay/retry). */
  resetDeliveryForReplay(deliveryId: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE webhook_deliveries
       SET status = 'accepted', error_message = NULL, result_preview = NULL,
           attempt = attempt + 1, next_retry_at = NULL, finished_at = NULL
       WHERE delivery_id = ?`,
    ).run(deliveryId);
  },

  /**
   * Failed deliveries whose source still allows automatic retries and whose
   * next_retry_at has passed, ordered soonest-first.
   */
  listRetryableDeliveries(nowIsoTime: string): WebhookDelivery[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT d.* FROM webhook_deliveries d
         JOIN webhook_sources s ON s.source_id = d.source_id
         WHERE d.status = 'failed'
           AND d.next_retry_at IS NOT NULL
           AND datetime(d.next_retry_at) <= datetime(?)
           AND s.retry_max > 0
           AND d.attempt <= s.retry_max
         ORDER BY d.next_retry_at ASC`,
      )
      .all(nowIsoTime) as DeliveryRow[];
    return rows.map(mapDelivery);
  },
};
