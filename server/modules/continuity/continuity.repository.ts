import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';
import type { LLMProvider } from '@/shared/types.js';

import type {
  ContinuityPolicy,
  ContinuityPolicyInput,
  ContinuityRecovery,
  ContinuityRecoveryAction,
  ContinuityRecoveryStatus,
} from './continuity.types.js';

type PolicyRow = {
  session_id: string;
  mode: string;
  fallback_providers_json: string;
  handoff_mode: string;
  max_attempts: number;
  max_wait_seconds: number;
  unknown_reset_delay_seconds: number;
  in_place_handoff?: number | null;
  boomerang_mode?: string | null;
  preflight_quota_guard?: string | null;
  preflight_threshold_ratio?: number | null;
  tier_mapping_enabled?: number | null;
  checkpoint_tools_enabled?: number | null;
  subagent_continuity_enabled?: number | null;
  created_at: string;
  updated_at: string;
};

type RecoveryRow = {
  recovery_id: string;
  source_run_id: string;
  session_id: string;
  source_provider: string;
  status: string;
  action: string;
  fallback_provider: string | null;
  detected_reason: string;
  retry_at: string | null;
  reset_time_source: string;
  attempt: number;
  max_attempts: number;
  policy_json: string;
  last_error: string | null;
  resumed_session_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

function parseArray(raw: string): LLMProvider[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is LLMProvider => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string): ContinuityPolicyInput {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as ContinuityPolicyInput : {};
  } catch {
    return {};
  }
}

function mapPolicy(row: PolicyRow): ContinuityPolicy {
  return {
    sessionId: row.session_id,
    mode: row.mode as ContinuityPolicy['mode'],
    fallbackProviders: parseArray(row.fallback_providers_json),
    handoffMode: row.handoff_mode as ContinuityPolicy['handoffMode'],
    maxAttempts: row.max_attempts,
    maxWaitSeconds: row.max_wait_seconds,
    unknownResetDelaySeconds: row.unknown_reset_delay_seconds,
    inPlaceHandoff: Boolean(row.in_place_handoff ?? 0),
    boomerangMode: (row.boomerang_mode as ContinuityPolicy['boomerangMode']) ?? 'off',
    preflightQuotaGuard: (row.preflight_quota_guard as ContinuityPolicy['preflightQuotaGuard']) ?? 'warn',
    preflightThresholdRatio: typeof row.preflight_threshold_ratio === 'number' ? row.preflight_threshold_ratio : 0.05,
    tierMappingEnabled: row.tier_mapping_enabled === undefined || row.tier_mapping_enabled === null ? true : Boolean(row.tier_mapping_enabled),
    checkpointToolsEnabled: row.checkpoint_tools_enabled === undefined || row.checkpoint_tools_enabled === null ? true : Boolean(row.checkpoint_tools_enabled),
    subagentContinuityEnabled: row.subagent_continuity_enabled === undefined || row.subagent_continuity_enabled === null ? true : Boolean(row.subagent_continuity_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRecovery(row: RecoveryRow): ContinuityRecovery {
  return {
    recoveryId: row.recovery_id,
    sourceRunId: row.source_run_id,
    sessionId: row.session_id,
    sourceProvider: row.source_provider as LLMProvider,
    status: row.status as ContinuityRecoveryStatus,
    action: row.action as ContinuityRecoveryAction,
    fallbackProvider: row.fallback_provider as LLMProvider | null,
    detectedReason: row.detected_reason,
    retryAt: row.retry_at,
    resetTimeSource: row.reset_time_source as ContinuityRecovery['resetTimeSource'],
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    policy: parseObject(row.policy_json),
    lastError: row.last_error,
    resumedSessionId: row.resumed_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export const continuityRepository = {
  getPolicy(sessionId: string): ContinuityPolicy | null {
    const row = getConnection().prepare(
      'SELECT * FROM session_continuity_policies WHERE session_id = ?',
    ).get(sessionId) as PolicyRow | undefined;
    return row ? mapPolicy(row) : null;
  },

  putPolicy(sessionId: string, policy: Omit<ContinuityPolicy, 'sessionId' | 'createdAt' | 'updatedAt'>): ContinuityPolicy {
    getConnection().prepare(
      `INSERT INTO session_continuity_policies (
         session_id, mode, fallback_providers_json, handoff_mode, max_attempts,
         max_wait_seconds, unknown_reset_delay_seconds, in_place_handoff, boomerang_mode,
         preflight_quota_guard, preflight_threshold_ratio, tier_mapping_enabled,
         checkpoint_tools_enabled, subagent_continuity_enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         mode = excluded.mode,
         fallback_providers_json = excluded.fallback_providers_json,
         handoff_mode = excluded.handoff_mode,
         max_attempts = excluded.max_attempts,
         max_wait_seconds = excluded.max_wait_seconds,
         unknown_reset_delay_seconds = excluded.unknown_reset_delay_seconds,
         in_place_handoff = excluded.in_place_handoff,
         boomerang_mode = excluded.boomerang_mode,
         preflight_quota_guard = excluded.preflight_quota_guard,
         preflight_threshold_ratio = excluded.preflight_threshold_ratio,
         tier_mapping_enabled = excluded.tier_mapping_enabled,
         checkpoint_tools_enabled = excluded.checkpoint_tools_enabled,
         subagent_continuity_enabled = excluded.subagent_continuity_enabled,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      sessionId,
      policy.mode,
      JSON.stringify(policy.fallbackProviders),
      policy.handoffMode,
      policy.maxAttempts,
      policy.maxWaitSeconds,
      policy.unknownResetDelaySeconds,
      policy.inPlaceHandoff ? 1 : 0,
      policy.boomerangMode,
      policy.preflightQuotaGuard,
      policy.preflightThresholdRatio,
      policy.tierMappingEnabled ? 1 : 0,
      policy.checkpointToolsEnabled ? 1 : 0,
      policy.subagentContinuityEnabled ? 1 : 0,
    );
    return this.getPolicy(sessionId)!;
  },

  getRecovery(recoveryId: string): ContinuityRecovery | null {
    const row = getConnection().prepare(
      'SELECT * FROM continuity_recoveries WHERE recovery_id = ?',
    ).get(recoveryId) as RecoveryRow | undefined;
    return row ? mapRecovery(row) : null;
  },

  getBySourceRun(sourceRunId: string): ContinuityRecovery | null {
    const row = getConnection().prepare(
      'SELECT * FROM continuity_recoveries WHERE source_run_id = ?',
    ).get(sourceRunId) as RecoveryRow | undefined;
    return row ? mapRecovery(row) : null;
  },

  getLatestForSession(sessionId: string): ContinuityRecovery | null {
    const row = getConnection().prepare(
      `SELECT * FROM continuity_recoveries
       WHERE session_id = ?
       ORDER BY rowid DESC LIMIT 1`,
    ).get(sessionId) as RecoveryRow | undefined;
    return row ? mapRecovery(row) : null;
  },

  /** Newest-first recovery feed for the continuity history view. */
  listRecentRecoveries(limit = 50): ContinuityRecovery[] {
    if (limit <= 0) return [];
    const rows = getConnection().prepare(
      `SELECT * FROM continuity_recoveries
       ORDER BY datetime(created_at) DESC, rowid DESC
       LIMIT ?`,
    ).all(limit) as RecoveryRow[];
    return rows.map(mapRecovery);
  },

  /** Recovery counts per source provider since the given timestamp. */
  countRecoveriesSince(sinceIso: string): Record<string, number> {
    const rows = getConnection().prepare(
      `SELECT source_provider, COUNT(*) AS total FROM continuity_recoveries
       WHERE datetime(created_at) >= datetime(?)
       GROUP BY source_provider`,
    ).all(sinceIso) as Array<{ source_provider: string; total: number }>;
    return Object.fromEntries(rows.map((row) => [row.source_provider, row.total]));
  },

  create(input: {
    sourceRunId: string;
    sessionId: string;
    sourceProvider: LLMProvider;
    status: ContinuityRecoveryStatus;
    action: ContinuityRecoveryAction;
    fallbackProvider: LLMProvider | null;
    detectedReason: string;
    retryAt: string | null;
    resetTimeSource: ContinuityRecovery['resetTimeSource'];
    attempt: number;
    maxAttempts: number;
    policy: ContinuityPolicyInput;
  }): ContinuityRecovery {
    const recoveryId = `recovery_${randomUUID()}`;
    getConnection().prepare(
      `INSERT OR IGNORE INTO continuity_recoveries (
         recovery_id, source_run_id, session_id, source_provider, status, action,
         fallback_provider, detected_reason, retry_at, reset_time_source, attempt,
         max_attempts, policy_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      recoveryId,
      input.sourceRunId,
      input.sessionId,
      input.sourceProvider,
      input.status,
      input.action,
      input.fallbackProvider,
      input.detectedReason,
      input.retryAt,
      input.resetTimeSource,
      input.attempt,
      input.maxAttempts,
      JSON.stringify(input.policy),
    );
    return this.getBySourceRun(input.sourceRunId)!;
  },

  update(recoveryId: string, patch: Partial<{
    status: ContinuityRecoveryStatus;
    action: ContinuityRecoveryAction;
    fallbackProvider: LLMProvider | null;
    retryAt: string | null;
    resetTimeSource: ContinuityRecovery['resetTimeSource'];
    lastError: string | null;
    resumedSessionId: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>): ContinuityRecovery | null {
    const current = this.getRecovery(recoveryId);
    if (!current) return null;
    getConnection().prepare(
      `UPDATE continuity_recoveries SET
         status = ?, action = ?, fallback_provider = ?, retry_at = ?,
         reset_time_source = ?, last_error = ?, resumed_session_id = ?,
         started_at = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE recovery_id = ?`,
    ).run(
      patch.status ?? current.status,
      patch.action ?? current.action,
      patch.fallbackProvider !== undefined ? patch.fallbackProvider : current.fallbackProvider,
      patch.retryAt !== undefined ? patch.retryAt : current.retryAt,
      patch.resetTimeSource ?? current.resetTimeSource,
      patch.lastError !== undefined ? patch.lastError : current.lastError,
      patch.resumedSessionId !== undefined ? patch.resumedSessionId : current.resumedSessionId,
      patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
      patch.completedAt !== undefined ? patch.completedAt : current.completedAt,
      recoveryId,
    );
    return this.getRecovery(recoveryId);
  },

  listWaitingForProviders(sourceProviders: readonly LLMProvider[], limit: number): ContinuityRecovery[] {
    if (sourceProviders.length === 0 || limit <= 0) return [];
    const placeholders = sourceProviders.map(() => '?').join(', ');
    const rows = getConnection().prepare(
      `SELECT * FROM continuity_recoveries
       WHERE status = 'waiting' AND action = 'resume' AND retry_at IS NOT NULL
         AND source_provider IN (${placeholders})
       ORDER BY updated_at ASC, retry_at ASC
       LIMIT ?`,
    ).all(...sourceProviders, limit) as RecoveryRow[];
    return rows.map(mapRecovery);
  },

  updateWaitingRetryAt(
    recoveryId: string,
    retryAt: string,
    resetTimeSource: ContinuityRecovery['resetTimeSource'],
  ): ContinuityRecovery | null {
    const changed = getConnection().prepare(
      `UPDATE continuity_recoveries
       SET retry_at = ?, reset_time_source = ?, updated_at = CURRENT_TIMESTAMP
       WHERE recovery_id = ? AND status = 'waiting' AND action = 'resume'
         AND reset_time_source <> 'manual'
         AND (retry_at IS NOT ? OR reset_time_source IS NOT ?)`,
    ).run(retryAt, resetTimeSource, recoveryId, retryAt, resetTimeSource).changes;
    return changed === 1 ? this.getRecovery(recoveryId) : null;
  },

  claimDue(nowIso: string, limit = 10): ContinuityRecovery[] {
    const db = getConnection();
    return db.transaction(() => {
      const rows = db.prepare(
        `SELECT recovery_id FROM continuity_recoveries
         WHERE status = 'waiting' AND retry_at IS NOT NULL
           AND datetime(retry_at) <= datetime(?)
         ORDER BY retry_at ASC LIMIT ?`,
      ).all(nowIso, limit) as Array<{ recovery_id: string }>;
      const claimed: ContinuityRecovery[] = [];
      for (const row of rows) {
        const changed = db.prepare(
          `UPDATE continuity_recoveries
           SET status = 'running', started_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE recovery_id = ? AND status = 'waiting'`,
        ).run(nowIso, row.recovery_id).changes;
        if (changed === 1) {
          const recovery = this.getRecovery(row.recovery_id);
          if (recovery) claimed.push(recovery);
        }
      }
      return claimed;
    })();
  },

  recoverInterrupted(): number {
    return getConnection().prepare(
      `UPDATE continuity_recoveries
       SET status = 'waiting', retry_at = CURRENT_TIMESTAMP,
           last_error = 'CloudCLI restarted while recovery was dispatching',
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'running'`,
    ).run().changes;
  },

  cancelPendingWithoutPolicyOverrides(): ContinuityRecovery[] {
    const db = getConnection();
    return db.transaction(() => {
      const rows = db.prepare(
        `SELECT recovery_id FROM continuity_recoveries AS recovery
         WHERE recovery.status IN ('waiting', 'needs_attention')
           AND NOT EXISTS (\n             SELECT 1 FROM session_continuity_policies AS policy
             WHERE policy.session_id = recovery.session_id
           )`,
      ).all() as Array<{ recovery_id: string }>;
      if (rows.length === 0) return [];

      const now = new Date().toISOString();
      const cancelled: ContinuityRecovery[] = [];
      for (const row of rows) {
        const changed = db.prepare(
          `UPDATE continuity_recoveries
           SET status = 'cancelled', completed_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE recovery_id = ? AND status IN ('waiting', 'needs_attention')`,
        ).run(now, row.recovery_id).changes;
        if (changed === 1) {
          const recovery = this.getRecovery(row.recovery_id);
          if (recovery) cancelled.push(recovery);
        }
      }
      return cancelled;
    })();
  },
};
