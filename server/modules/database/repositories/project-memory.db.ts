import { getConnection } from '@/modules/database/connection.js';
import type { ProjectMemoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

/**
 * Per-project Obsidian memory mapping.
 *
 * Each row records that a project (keyed by its workspace path) has memory
 * enabled and which folder inside the shared Obsidian vault holds its notes.
 * Global connection settings (vault path, REST creds) live in `app_config`.
 */
export const projectMemoryDb = {
  get(projectPath: string): ProjectMemoryRow | null {
    const db = getConnection();
    const normalized = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT project_path, enabled, vault_folder, created_at, updated_at
         FROM project_memory
         WHERE project_path = ?`,
      )
      .get(normalized) as ProjectMemoryRow | undefined;

    return row ?? null;
  },

  list(): ProjectMemoryRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT project_path, enabled, vault_folder, created_at, updated_at
         FROM project_memory`,
      )
      .all() as ProjectMemoryRow[];
  },

  upsert(projectPath: string, vaultFolder: string, enabled: boolean): ProjectMemoryRow {
    const db = getConnection();
    const normalized = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `INSERT INTO project_memory (project_path, enabled, vault_folder, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(project_path) DO UPDATE SET
           enabled = excluded.enabled,
           vault_folder = excluded.vault_folder,
           updated_at = CURRENT_TIMESTAMP
         RETURNING project_path, enabled, vault_folder, created_at, updated_at`,
      )
      .get(normalized, enabled ? 1 : 0, vaultFolder) as ProjectMemoryRow;

    return row;
  },

  setEnabled(projectPath: string, enabled: boolean): void {
    const db = getConnection();
    const normalized = normalizeProjectPath(projectPath);
    db.prepare(
      `UPDATE project_memory
       SET enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE project_path = ?`,
    ).run(enabled ? 1 : 0, normalized);
  },

  remove(projectPath: string): void {
    const db = getConnection();
    const normalized = normalizeProjectPath(projectPath);
    db.prepare('DELETE FROM project_memory WHERE project_path = ?').run(normalized);
  },
};
