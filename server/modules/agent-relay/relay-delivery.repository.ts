import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';

export type RelayDeliveryKind = 'verify' | 'rehearse' | 'land' | 'recover';
export type RelayDeliveryRecord = {
  delivery_id: string;
  project_id: string;
  source_session_id: string | null;
  kind: RelayDeliveryKind;
  workspace_ids: string[];
  tips: Record<string, string>;
  base_sha: string | null;
  result: Record<string, unknown>;
  passed: boolean;
  landed_sha: string | null;
  created_at: string;
};

type RelayDeliveryRow = Omit<RelayDeliveryRecord, 'workspace_ids' | 'tips' | 'result' | 'passed' | 'kind'> & {
  kind: string;
  workspace_ids_json: string;
  tips_json: string;
  result_json: string;
  passed: number;
};

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function mapRow(row: RelayDeliveryRow): RelayDeliveryRecord {
  return {
    ...row,
    kind: row.kind as RelayDeliveryKind,
    workspace_ids: parseJson(row.workspace_ids_json, []),
    tips: parseJson(row.tips_json, {}),
    result: parseJson(row.result_json, {}),
    passed: row.passed === 1,
  };
}

export const relayDeliveryDb = {
  create(input: Omit<RelayDeliveryRecord, 'delivery_id' | 'created_at'>): RelayDeliveryRecord {
    const deliveryId = `rd_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    getConnection().prepare(`
      INSERT INTO agent_relay_delivery_records (
        delivery_id, project_id, source_session_id, kind, workspace_ids_json,
        tips_json, base_sha, result_json, passed, landed_sha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deliveryId,
      input.project_id,
      input.source_session_id,
      input.kind,
      JSON.stringify(input.workspace_ids),
      JSON.stringify(input.tips),
      input.base_sha,
      JSON.stringify(input.result),
      input.passed ? 1 : 0,
      input.landed_sha,
    );
    const row = getConnection().prepare('SELECT * FROM agent_relay_delivery_records WHERE delivery_id = ?').get(deliveryId) as RelayDeliveryRow;
    return mapRow(row);
  },

  get(deliveryId: string): RelayDeliveryRecord | null {
    const row = getConnection().prepare('SELECT * FROM agent_relay_delivery_records WHERE delivery_id = ?').get(deliveryId) as RelayDeliveryRow | undefined;
    return row ? mapRow(row) : null;
  },

  list(input: { projectId: string; sourceSessionId?: string | null; kind?: RelayDeliveryKind; limit?: number }): RelayDeliveryRecord[] {
    const where = ['project_id = ?'];
    const params: unknown[] = [input.projectId];
    if (input.sourceSessionId) { where.push('source_session_id = ?'); params.push(input.sourceSessionId); }
    if (input.kind) { where.push('kind = ?'); params.push(input.kind); }
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), 500);
    return (getConnection().prepare(`SELECT * FROM agent_relay_delivery_records WHERE ${where.join(' AND ')} ORDER BY created_at DESC, delivery_id DESC LIMIT ?`).all(...params, limit) as RelayDeliveryRow[]).map(mapRow);
  },
};
