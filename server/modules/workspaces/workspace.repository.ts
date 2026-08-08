/**
 * Repository for the `agent_workspaces` table (PRD §5.4).
 * Follows the kanban.repository.ts style: better-sqlite3 via the shared
 * singleton connection, row coercion at the boundary, no business logic.
 */

import { getConnection } from '@/modules/database/index.js';
import {
  WORKSPACE_LIFECYCLE_STATUSES,
  type AgentWorkspace,
  type WorkspaceLifecycleStatus,
  type WorkspaceMode,
} from '@/modules/workspaces/workspace.types.js';

type AgentWorkspaceRow = Omit<AgentWorkspace, 'mode' | 'status'> & {
  mode: string;
  status: string;
};

function mapWorkspace(row: AgentWorkspaceRow): AgentWorkspace {
  return {
    ...row,
    mode: row.mode === 'sandbox_copy' ? 'sandbox_copy' : 'git_worktree',
    status: (
      WORKSPACE_LIFECYCLE_STATUSES.includes(row.status as WorkspaceLifecycleStatus)
        ? row.status
        : 'error'
    ) as WorkspaceLifecycleStatus,
  };
}

export type InsertWorkspaceInput = {
  workspace_id: string;
  project_id: string;
  run_id: string | null;
  task_id: string | null;
  mode: WorkspaceMode;
  root_path: string;
  base_branch: string;
  base_sha: string | null;
  feature_branch: string;
  head_sha: string | null;
  status: WorkspaceLifecycleStatus;
  last_error?: string | null;
};

export const workspaceDb = {
  insert(input: InsertWorkspaceInput): AgentWorkspace {
    const db = getConnection();
    db.prepare(
      `INSERT INTO agent_workspaces (
         workspace_id, project_id, run_id, task_id, mode, root_path,
         base_branch, base_sha, feature_branch, head_sha, status, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.workspace_id,
      input.project_id,
      input.run_id,
      input.task_id,
      input.mode,
      input.root_path,
      input.base_branch,
      input.base_sha,
      input.feature_branch,
      input.head_sha,
      input.status,
      input.last_error ?? null,
    );
    return workspaceDb.get(input.workspace_id)!;
  },

  get(workspaceId: string): AgentWorkspace | null {
    const db = getConnection();
    const row = db
      .prepare(`SELECT * FROM agent_workspaces WHERE workspace_id = ?`)
      .get(workspaceId) as AgentWorkspaceRow | undefined;
    return row ? mapWorkspace(row) : null;
  },

  listByProject(projectId: string, filter?: { status?: string[] }): AgentWorkspace[] {
    const db = getConnection();
    const statuses = filter?.status?.filter((s) => typeof s === 'string' && s.length > 0) ?? [];
    const rows =
      statuses.length > 0
        ? (db
            .prepare(
              `SELECT * FROM agent_workspaces
               WHERE project_id = ? AND status IN (${statuses.map(() => '?').join(', ')})
               ORDER BY created_at DESC, workspace_id DESC`,
            )
            .all(projectId, ...statuses) as AgentWorkspaceRow[])
        : (db
            .prepare(
              `SELECT * FROM agent_workspaces WHERE project_id = ? ORDER BY created_at DESC, workspace_id DESC`,
            )
            .all(projectId) as AgentWorkspaceRow[]);
    return rows.map(mapWorkspace);
  },

  /** Rows across every project (boot-time reconcile without a projectId). */
  listAll(filter?: { status?: string[] }): AgentWorkspace[] {
    const db = getConnection();
    const statuses = filter?.status?.filter((s) => typeof s === 'string' && s.length > 0) ?? [];
    const rows =
      statuses.length > 0
        ? (db
            .prepare(
              `SELECT * FROM agent_workspaces
               WHERE status IN (${statuses.map(() => '?').join(', ')})
               ORDER BY created_at ASC, workspace_id ASC`,
            )
            .all(...statuses) as AgentWorkspaceRow[])
        : (db
            .prepare(
              `SELECT * FROM agent_workspaces ORDER BY created_at ASC, workspace_id ASC`,
            )
            .all() as AgentWorkspaceRow[]);
    return rows.map(mapWorkspace);
  },

  setStatus(
    workspaceId: string,
    status: WorkspaceLifecycleStatus,
    lastError?: string | null,
  ): void {
    const db = getConnection();
    db.prepare(
      `UPDATE agent_workspaces
       SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = ?`,
    ).run(status, lastError ?? null, workspaceId);
  },

  setHeadSha(workspaceId: string, headSha: string | null): void {
    const db = getConnection();
    db.prepare(
      `UPDATE agent_workspaces SET head_sha = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`,
    ).run(headSha, workspaceId);
  },

  setRunId(workspaceId: string, runId: string | null): void {
    const db = getConnection();
    db.prepare(
      `UPDATE agent_workspaces SET run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`,
    ).run(runId, workspaceId);
  },

  markCleaned(workspaceId: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE agent_workspaces SET cleaned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = ?`,
    ).run(workspaceId);
  },

  delete(workspaceId: string): boolean {
    const db = getConnection();
    const result = db
      .prepare(`DELETE FROM agent_workspaces WHERE workspace_id = ?`)
      .run(workspaceId);
    return result.changes > 0;
  },
};
