import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';
import { newPackId } from '@/shared/ids.js';
import type { ContextPack, ContextPackAttachment, ContextPackItem } from '@/modules/context-packs/context-packs.types.js';

type PackRow = {
  pack_id: string;
  project_id: string;
  goal: string;
  budget_tokens: number;
  estimated_tokens: number;
  content_markdown: string;
  items_json: string;
  warnings_json: string;
  created_at: string;
};

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function mapPack(row: PackRow): ContextPack {
  return {
    pack_id: row.pack_id,
    project_id: row.project_id,
    goal: row.goal,
    budgetTokens: row.budget_tokens,
    estimatedTokens: row.estimated_tokens,
    items: parseArray<ContextPackItem>(row.items_json),
    warnings: parseArray<string>(row.warnings_json),
    markdown: row.content_markdown,
    created_at: row.created_at,
  };
}

export const contextPacksDb = {
  create(input: Omit<ContextPack, 'pack_id' | 'created_at'>): ContextPack {
    const db = getConnection();
    const packId = newPackId();
    db.prepare(
      `INSERT INTO context_packs (pack_id, project_id, goal, budget_tokens, estimated_tokens, content_markdown, items_json, warnings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      packId,
      input.project_id,
      input.goal,
      input.budgetTokens,
      input.estimatedTokens,
      input.markdown,
      JSON.stringify(input.items),
      JSON.stringify(input.warnings),
    );
    return this.get(packId)!;
  },

  get(packId: string): ContextPack | null {
    const row = getConnection().prepare(`SELECT * FROM context_packs WHERE pack_id = ?`).get(packId) as PackRow | undefined;
    return row ? mapPack(row) : null;
  },

  attach(packId: string, input: { runId?: string; sessionId?: string }): ContextPackAttachment {
    if (!input.runId && !input.sessionId) throw new Error('A runId or sessionId is required');
    const db = getConnection();
    const existing = db.prepare(
      `SELECT * FROM context_pack_attachments WHERE pack_id = ? AND run_id IS ? AND session_id IS ?`,
    ).get(packId, input.runId ?? null, input.sessionId ?? null) as ContextPackAttachment | undefined;
    if (existing) return existing;
    const attachmentId = `att_${randomUUID()}`;
    db.prepare(
      `INSERT INTO context_pack_attachments (attachment_id, pack_id, run_id, session_id) VALUES (?, ?, ?, ?)`,
    ).run(attachmentId, packId, input.runId ?? null, input.sessionId ?? null);
    return db.prepare(`SELECT * FROM context_pack_attachments WHERE attachment_id = ?`).get(attachmentId) as ContextPackAttachment;
  },

  listAttachments(packId: string): ContextPackAttachment[] {
    return getConnection().prepare(`SELECT * FROM context_pack_attachments WHERE pack_id = ? ORDER BY created_at ASC`).all(packId) as ContextPackAttachment[];
  },
};
