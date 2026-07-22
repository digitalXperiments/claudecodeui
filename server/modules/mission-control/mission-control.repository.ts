import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/index.js';
import {
  DEFAULT_MC_ACTIONS,
  type CreateMcSectionInput,
  type McAction,
  type McItem,
  type McItemStatus,
  type McSection,
  type McSectionMode,
  type McSectionScope,
  type UpdateMcSectionInput,
  type McProvider,
  type McDraftItem,
} from '@/modules/mission-control/mission-control.types.js';

type SectionRow = {
  section_id: string;
  title: string;
  icon: string;
  sort_order: number;
  enabled: number;
  scope: string;
  project_id: string | null;
  mode: string;
  schedule_cron: string | null;
  provider: string;
  model: string | null;
  permission_mode: string;
  dry_run: number;
  auto_approve: number;
  produce_prompt: string;
  produce_tools_json: string;
  resolve_prompt: string;
  resolve_tools_json: string;
  actions_json: string;
  last_run_at: string | null;
  last_run_error: string | null;
  created_at: string;
  updated_at: string;
};

type ItemRow = {
  item_id: string;
  section_id: string;
  status: string;
  title: string;
  summary: string;
  body_json: string;
  source_json: string;
  actions_json: string;
  confidence: number;
  provider: string;
  model: string;
  dedupe_key: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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

function parseActions(raw: string | null | undefined): McAction[] {
  const arr = parseJsonArray(raw);
  if (arr.length === 0) return [...DEFAULT_MC_ACTIONS];
  return arr
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
    .map((a) => ({
      id: String(a.id ?? ''),
      label: String(a.label ?? a.id ?? 'Action'),
      kind: String(a.kind ?? 'approve'),
      style: (['primary', 'secondary', 'destructive'].includes(String(a.style))
        ? String(a.style)
        : 'secondary') as McAction['style'],
      terminal: a.terminal === false ? false : true,
    }))
    .filter((a) => a.id);
}

function parseTools(raw: string | null | undefined): string[] {
  return parseJsonArray(raw)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim());
}

function mapSection(row: SectionRow): McSection {
  return {
    section_id: row.section_id,
    title: row.title,
    icon: row.icon ?? '',
    sort_order: row.sort_order ?? 0,
    enabled: Boolean(row.enabled),
    scope: (row.scope === 'project' ? 'project' : 'global') as McSectionScope,
    project_id: row.project_id,
    mode: (row.mode === 'fire_and_forget' ? 'fire_and_forget' : 'review') as McSectionMode,
    schedule_cron: row.schedule_cron || null,
    provider: (row.provider || 'claude') as McProvider,
    model: row.model || null,
    permission_mode: row.permission_mode || 'bypassPermissions',
    dry_run: Boolean(row.dry_run),
    auto_approve: Boolean(row.auto_approve),
    produce_prompt: row.produce_prompt ?? '',
    produce_tools: parseTools(row.produce_tools_json),
    resolve_prompt: row.resolve_prompt ?? '',
    resolve_tools: parseTools(row.resolve_tools_json),
    actions: parseActions(row.actions_json),
    last_run_at: row.last_run_at,
    last_run_error: row.last_run_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapItem(row: ItemRow): McItem {
  return {
    item_id: row.item_id,
    section_id: row.section_id,
    status: row.status as McItemStatus,
    title: row.title,
    summary: row.summary ?? '',
    body: parseJsonObject(row.body_json),
    source: parseJsonObject(row.source_json),
    actions: parseActions(row.actions_json),
    confidence: typeof row.confidence === 'number' ? row.confidence : 0,
    provider: row.provider ?? '',
    model: row.model ?? '',
    dedupe_key: row.dedupe_key,
    result: row.result_json ? parseJsonObject(row.result_json) : null,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export const missionControlDb = {
  listSections(): McSection[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT * FROM mc_sections ORDER BY sort_order ASC, created_at ASC`,
      )
      .all() as SectionRow[];
    return rows.map(mapSection);
  },

  getSection(sectionId: string): McSection | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM mc_sections WHERE section_id = ?`)
      .get(sectionId) as SectionRow | undefined;
    return row ? mapSection(row) : null;
  },

  listEnabledScheduledSections(): McSection[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT * FROM mc_sections
         WHERE enabled = 1
           AND schedule_cron IS NOT NULL
           AND TRIM(schedule_cron) != ''`,
      )
      .all() as SectionRow[];
    return rows.map(mapSection);
  },

  createSection(input: CreateMcSectionInput): McSection {
    const db = getConnection();
    const sectionId = randomUUID();
    const ts = nowIso();
    const actions = input.actions?.length ? input.actions : DEFAULT_MC_ACTIONS;
    db.prepare(
      `INSERT INTO mc_sections (
        section_id, title, icon, sort_order, enabled, scope, project_id, mode,
        schedule_cron, provider, model, permission_mode, dry_run, auto_approve,
        produce_prompt, produce_tools_json, resolve_prompt, resolve_tools_json,
        actions_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )`,
    ).run(
      sectionId,
      input.title.trim(),
      input.icon ?? '',
      input.sort_order ?? 0,
      input.enabled === false ? 0 : 1,
      input.scope === 'project' ? 'project' : 'global',
      input.project_id ?? null,
      input.mode === 'fire_and_forget' ? 'fire_and_forget' : 'review',
      input.schedule_cron?.trim() || null,
      input.provider ?? 'claude',
      input.model ?? null,
      input.permission_mode ?? 'bypassPermissions',
      input.dry_run ? 1 : 0,
      input.auto_approve ? 1 : 0,
      input.produce_prompt ?? '',
      JSON.stringify(input.produce_tools ?? []),
      input.resolve_prompt ?? '',
      JSON.stringify(input.resolve_tools ?? []),
      JSON.stringify(actions),
      ts,
      ts,
    );
    return this.getSection(sectionId)!;
  },

  updateSection(sectionId: string, input: UpdateMcSectionInput): McSection | null {
    const existing = this.getSection(sectionId);
    if (!existing) return null;

    const next: McSection = {
      ...existing,
      title: input.title !== undefined ? input.title.trim() : existing.title,
      icon: input.icon !== undefined ? input.icon : existing.icon,
      sort_order: input.sort_order !== undefined ? input.sort_order : existing.sort_order,
      enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
      scope: input.scope !== undefined ? input.scope : existing.scope,
      project_id:
        input.project_id !== undefined ? input.project_id : existing.project_id,
      mode: input.mode !== undefined ? input.mode : existing.mode,
      schedule_cron:
        input.schedule_cron !== undefined
          ? input.schedule_cron?.trim() || null
          : existing.schedule_cron,
      provider: input.provider !== undefined ? input.provider : existing.provider,
      model: input.model !== undefined ? input.model : existing.model,
      permission_mode:
        input.permission_mode !== undefined
          ? input.permission_mode
          : existing.permission_mode,
      dry_run: input.dry_run !== undefined ? input.dry_run : existing.dry_run,
      auto_approve:
        input.auto_approve !== undefined ? input.auto_approve : existing.auto_approve,
      produce_prompt:
        input.produce_prompt !== undefined
          ? input.produce_prompt
          : existing.produce_prompt,
      produce_tools:
        input.produce_tools !== undefined ? input.produce_tools : existing.produce_tools,
      resolve_prompt:
        input.resolve_prompt !== undefined
          ? input.resolve_prompt
          : existing.resolve_prompt,
      resolve_tools:
        input.resolve_tools !== undefined ? input.resolve_tools : existing.resolve_tools,
      actions: input.actions !== undefined ? input.actions : existing.actions,
    };

    const db = getConnection();
    db.prepare(
      `UPDATE mc_sections SET
        title = ?, icon = ?, sort_order = ?, enabled = ?, scope = ?, project_id = ?,
        mode = ?, schedule_cron = ?, provider = ?, model = ?, permission_mode = ?,
        dry_run = ?, auto_approve = ?, produce_prompt = ?, produce_tools_json = ?,
        resolve_prompt = ?, resolve_tools_json = ?, actions_json = ?, updated_at = ?
       WHERE section_id = ?`,
    ).run(
      next.title,
      next.icon,
      next.sort_order,
      next.enabled ? 1 : 0,
      next.scope,
      next.project_id,
      next.mode,
      next.schedule_cron,
      next.provider,
      next.model,
      next.permission_mode,
      next.dry_run ? 1 : 0,
      next.auto_approve ? 1 : 0,
      next.produce_prompt,
      JSON.stringify(next.produce_tools),
      next.resolve_prompt,
      JSON.stringify(next.resolve_tools),
      JSON.stringify(next.actions),
      nowIso(),
      sectionId,
    );
    return this.getSection(sectionId);
  },

  deleteSection(sectionId: string): boolean {
    const db = getConnection();
    const result = db.prepare(`DELETE FROM mc_sections WHERE section_id = ?`).run(sectionId);
    return result.changes > 0;
  },

  markSectionRun(
    sectionId: string,
    opts: { error?: string | null },
  ): void {
    const db = getConnection();
    db.prepare(
      `UPDATE mc_sections SET last_run_at = ?, last_run_error = ?, updated_at = ? WHERE section_id = ?`,
    ).run(nowIso(), opts.error ?? null, nowIso(), sectionId);
  },

  listItems(options?: {
    sectionId?: string;
    status?: McItemStatus | McItemStatus[];
    limit?: number;
  }): McItem[] {
    const db = getConnection();
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options?.sectionId) {
      clauses.push('section_id = ?');
      params.push(options.sectionId);
    }
    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    const rows = db
      .prepare(
        `SELECT * FROM mc_items ${where}
         ORDER BY
           CASE status
             WHEN 'pending' THEN 0
             WHEN 'failed' THEN 1
             WHEN 'resolving' THEN 2
             ELSE 3
           END,
           created_at DESC
         LIMIT ?`,
      )
      .all(...params) as ItemRow[];
    return rows.map(mapItem);
  },

  getItem(itemId: string): McItem | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM mc_items WHERE item_id = ?`)
      .get(itemId) as ItemRow | undefined;
    return row ? mapItem(row) : null;
  },

  countPending(): number {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM mc_items WHERE status IN ('pending', 'failed')`,
      )
      .get() as { c: number };
    return row?.c ?? 0;
  },

  /**
   * Insert a draft if dedupe_key is new for the section. Returns null when
   * the key already exists (idempotent produce).
   */
  insertItemIfNew(
    section: McSection,
    draft: McDraftItem,
  ): McItem | null {
    const db = getConnection();
    const itemId = randomUUID();
    const ts = nowIso();
    const actions = draft.actions?.length ? draft.actions : section.actions;
    try {
      db.prepare(
        `INSERT INTO mc_items (
          item_id, section_id, status, title, summary, body_json, source_json,
          actions_json, confidence, provider, model, dedupe_key, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        itemId,
        section.section_id,
        draft.title,
        draft.summary ?? '',
        JSON.stringify(draft.body ?? {}),
        JSON.stringify(draft.source ?? { dedupeKey: draft.dedupeKey }),
        JSON.stringify(actions),
        typeof draft.confidence === 'number' ? draft.confidence : 0,
        section.provider,
        section.model ?? '',
        draft.dedupeKey,
        ts,
        ts,
      );
      return this.getItem(itemId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE')) {
        return null;
      }
      throw error;
    }
  },

  /** Upsert by dedupe key (refresh-on-rerun style). */
  upsertItem(section: McSection, draft: McDraftItem): { item: McItem; created: boolean } {
    const db = getConnection();
    const existing = db
      .prepare(
        `SELECT item_id FROM mc_items WHERE section_id = ? AND dedupe_key = ?`,
      )
      .get(section.section_id, draft.dedupeKey) as { item_id: string } | undefined;

    if (!existing) {
      const item = this.insertItemIfNew(section, draft);
      if (!item) {
        // Race: re-read
        const again = this.listItems({ sectionId: section.section_id, limit: 500 }).find(
          (i) => i.dedupe_key === draft.dedupeKey,
        );
        if (again) return { item: again, created: false };
        throw new Error('Failed to insert mission control item');
      }
      return { item, created: true };
    }

    const actions = draft.actions?.length ? draft.actions : section.actions;
    const ts = nowIso();
    db.prepare(
      `UPDATE mc_items SET
        title = ?, summary = ?, body_json = ?, source_json = ?, actions_json = ?,
        confidence = ?, provider = ?, model = ?, status = 'pending', error = NULL,
        updated_at = ?, resolved_at = NULL, result_json = NULL
       WHERE item_id = ?`,
    ).run(
      draft.title,
      draft.summary ?? '',
      JSON.stringify(draft.body ?? {}),
      JSON.stringify(draft.source ?? { dedupeKey: draft.dedupeKey }),
      JSON.stringify(actions),
      typeof draft.confidence === 'number' ? draft.confidence : 0,
      section.provider,
      section.model ?? '',
      ts,
      existing.item_id,
    );
    return { item: this.getItem(existing.item_id)!, created: false };
  },

  setItemStatus(
    itemId: string,
    status: McItemStatus,
    patch?: {
      body?: Record<string, unknown>;
      result?: Record<string, unknown> | null;
      error?: string | null;
      resolvedAt?: string | null;
    },
  ): McItem {
    const existing = this.getItem(itemId);
    if (!existing) {
      throw new Error(`item ${itemId} not found`);
    }
    const ts = nowIso();
    const body = patch?.body !== undefined ? patch.body : existing.body;
    const result =
      patch && 'result' in patch ? patch.result : existing.result;
    const error =
      patch && 'error' in patch ? patch.error : existing.error;
    const resolvedAt =
      patch && 'resolvedAt' in patch
        ? patch.resolvedAt
        : status === 'resolved' || status === 'dismissed'
          ? ts
          : existing.resolved_at;

    const db = getConnection();
    db.prepare(
      `UPDATE mc_items SET
        status = ?, body_json = ?, result_json = ?, error = ?,
        resolved_at = ?, updated_at = ?
       WHERE item_id = ?`,
    ).run(
      status,
      JSON.stringify(body),
      result == null ? null : JSON.stringify(result),
      error ?? null,
      resolvedAt,
      ts,
      itemId,
    );
    return this.getItem(itemId)!;
  },
};
