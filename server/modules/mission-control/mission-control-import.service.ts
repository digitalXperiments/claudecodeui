import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import {
  DEFAULT_MC_ACTIONS,
  type McAction,
  type McProvider,
  isMcProvider,
} from '@/modules/mission-control/mission-control.types.js';
import { AppError } from '@/shared/utils.js';
import { syncMissionControlSchedules } from '@/modules/mission-control/mission-control-scheduler.service.js';

type LegacySectionRow = {
  id: string;
  title: string;
  icon: string | null;
  order: number | null;
  enabled: number | null;
  schedule: string | null;
  engine: string | null;
  model: string | null;
  dry_run: number | null;
  auto_approve: number | null;
  produce_prompt: string | null;
  produce_mcp: string | null;
  actions: string | null;
  resolve_prompt: string | null;
  resolve_mcp: string | null;
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

function mapEngineToProvider(engine: string | null | undefined): McProvider {
  const e = (engine || 'claude').toLowerCase().trim();
  if (isMcProvider(e)) return e;
  if (e === 'opencode') return 'opencode';
  if (e === 'grok') return 'grok';
  return 'claude';
}

function parseTools(raw: string | null | undefined): string[] {
  return parseJsonArray(raw)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.trim());
}

export type ImportResult = {
  path: string;
  imported: number;
  skipped: number;
  sections: string[];
  errors: string[];
};

/**
 * Import sections from a standalone Mission Control SQLite database
 * (the old app's mission-control.db). Items are not imported — only section
 * configs (prompts, MCP, schedule, engine).
 */
export function importFromMissionControlDb(dbPath: string): ImportResult {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    throw new AppError(`Database not found: ${resolved}`, {
      code: 'MC_IMPORT_DB_NOT_FOUND',
      statusCode: 404,
    });
  }

  let db: Database.Database;
  try {
    db = new Database(resolved, { readonly: true, fileMustExist: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(`Failed to open database: ${message}`, {
      code: 'MC_IMPORT_DB_OPEN_FAILED',
      statusCode: 400,
    });
  }

  try {
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sections'`,
      )
      .get() as { name: string } | undefined;
    if (!table) {
      throw new AppError('No sections table found in database', {
        code: 'MC_IMPORT_NO_SECTIONS_TABLE',
        statusCode: 400,
      });
    }

    const rows = db.prepare(`SELECT * FROM sections ORDER BY "order" ASC`).all() as LegacySectionRow[];
    const existingTitles = new Set(
      missionControlDb.listSections().map((s) => s.title.toLowerCase()),
    );

    let imported = 0;
    let skipped = 0;
    const sectionNames: string[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      try {
        const title = (row.title || row.id || 'Imported section').trim();
        // Avoid clobbering: if title exists, suffix with legacy id.
        let finalTitle = title;
        if (existingTitles.has(finalTitle.toLowerCase())) {
          finalTitle = `${title} (${row.id})`;
        }
        if (existingTitles.has(finalTitle.toLowerCase())) {
          skipped++;
          continue;
        }

        const section = missionControlDb.createSection({
          title: finalTitle,
          icon: row.icon ?? '',
          sort_order: typeof row.order === 'number' ? row.order : 0,
          enabled: row.enabled !== 0,
          scope: 'global',
          project_id: null,
          mode: 'review',
          schedule_cron: row.schedule?.trim() || null,
          provider: mapEngineToProvider(row.engine),
          model: row.model?.trim() || null,
          permission_mode: 'bypassPermissions',
          dry_run: Boolean(row.dry_run),
          auto_approve: Boolean(row.auto_approve),
          produce_prompt: row.produce_prompt ?? '',
          produce_tools: parseTools(row.produce_mcp),
          resolve_prompt: row.resolve_prompt ?? '',
          resolve_tools: parseTools(row.resolve_mcp),
          actions: parseActions(row.actions),
        });
        existingTitles.add(finalTitle.toLowerCase());
        imported++;
        sectionNames.push(section.title);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${row.id}: ${message}`);
      }
    }

    syncMissionControlSchedules();
    return {
      path: resolved,
      imported,
      skipped,
      sections: sectionNames,
      errors,
    };
  } finally {
    db.close();
  }
}

/** Well-known default path for the legacy Mission Control backend DB. */
export const DEFAULT_LEGACY_MC_DB_CANDIDATES = [
  path.join(process.env.HOME || '', 'Sites/mission_control/backend/mission-control.db'),
  path.join(process.env.HOME || '', 'Sites/mission_control/backend/dist/mission-control.db'),
];

export function resolveDefaultLegacyDbPath(): string | null {
  for (const candidate of DEFAULT_LEGACY_MC_DB_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}
