import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import {
    getTemporaryProjectPathRoot,
    isTemporaryProjectPath,
    isTemporaryProjectPathRoot,
    normalizeProjectPath,
} from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    createProjectPath(projectPath: string, customProjectName: string | null = null): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, category_id
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, category_id
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolves a CloudCLI agent workspace root to its logical parent project.
     * Runtime providers execute inside the workspace, but sessions should be
     * grouped under the project that owns the workspace.
     */
    resolveProjectPathForWorkspaceRoot(workspacePath: string): string | null {
        const db = getConnection();
        const normalizedWorkspacePath = normalizeProjectPath(workspacePath);
        if (!normalizedWorkspacePath) {
            return null;
        }

        const row = db.prepare(`
            SELECT parent.project_path
            FROM agent_workspaces AS workspace
            INNER JOIN projects AS parent ON parent.project_id = workspace.project_id
            WHERE workspace.root_path = ?
              AND workspace.root_path <> parent.project_path
            ORDER BY workspace.created_at DESC
            LIMIT 1
        `).get(normalizedWorkspacePath) as { project_path?: string | null } | undefined;

        return row?.project_path ?? null;
    },

    /**
     * Resolves a temporary runtime directory to its logical parent. Prefer
     * the nearest already-registered non-temporary project; otherwise use the
     * operating-system temp root so all `/tmp/*` sessions share `/tmp`.
     */
    resolveProjectPathForTemporaryPath(runtimePath: string): string | null {
        const db = getConnection();
        const normalizedRuntimePath = normalizeProjectPath(runtimePath);
        if (!normalizedRuntimePath || !isTemporaryProjectPath(normalizedRuntimePath)) {
            return null;
        }

        const temporaryRoot = getTemporaryProjectPathRoot(normalizedRuntimePath);
        if (temporaryRoot) {
            return temporaryRoot;
        }

        const projectPaths = db
            .prepare(`
                SELECT project_path
                FROM projects
                WHERE project_path IS NOT NULL AND trim(project_path) <> ''
            `)
            .all() as Array<{ project_path?: string | null }>;

        const projectAncestor = projectPaths
            .map((row) => normalizeProjectPath(row.project_path ?? ''))
            .filter(
                (candidate) =>
                    candidate &&
                    candidate !== normalizedRuntimePath &&
                    !isTemporaryProjectPath(candidate) &&
                    normalizedRuntimePath.startsWith(`${candidate}${path.sep}`),
            )
            .sort((left, right) => right.length - left.length)[0];

        if (projectAncestor) {
            return projectAncestor;
        }

        const reservedScratchMarker = `${path.sep}tmp${path.sep}cloudcli${path.sep}`;
        const markerIndex = normalizedRuntimePath.indexOf(reservedScratchMarker);
        if (markerIndex > 0) {
            const projectPrefix = normalizeProjectPath(normalizedRuntimePath.slice(0, markerIndex));
            if (projectPrefix && !isTemporaryProjectPath(projectPrefix)) {
                return projectPrefix;
            }
        }

        const parentPath = normalizeProjectPath(path.dirname(normalizedRuntimePath));
        return parentPath || normalizedRuntimePath;
    },

    /** Resolves either an agent worktree or a temporary runtime path. */
    resolveProjectPathForRuntimePath(runtimePath: string): string {
        const normalizedRuntimePath = normalizeProjectPath(runtimePath);
        return (
            projectsDb.resolveProjectPathForWorkspaceRoot(normalizedRuntimePath) ??
            projectsDb.resolveProjectPathForTemporaryPath(normalizedRuntimePath) ??
            normalizedRuntimePath
        );
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, category_id
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    /** Active logical projects; agent workspace roots are runtime directories. */
    getProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        const projects = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, category_id
            FROM projects
            WHERE isArchived = 0
              AND NOT EXISTS (
                SELECT 1
                FROM agent_workspaces AS workspace
                WHERE workspace.root_path = projects.project_path
              )
        `).all() as ProjectRepositoryRow[];

        return projects.filter(
            (project) =>
                !isTemporaryProjectPath(project.project_path) ||
                isTemporaryProjectPathRoot(project.project_path),
        );
    },

    /** Archived logical projects, excluding runtime-only agent workspace roots. */
    getArchivedProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        const projects = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, category_id
            FROM projects
            WHERE isArchived = 1
              AND NOT EXISTS (
                SELECT 1
                FROM agent_workspaces AS workspace
                WHERE workspace.root_path = projects.project_path
              )
        `).all() as ProjectRepositoryRow[];

        return projects.filter(
            (project) =>
                !isTemporaryProjectPath(project.project_path) ||
                isTemporaryProjectPathRoot(project.project_path),
        );
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `).run(isArchived ? 1 : 0, projectId);
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
    },

    updateProjectCategoryById(projectId: string, categoryId: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET category_id = ?
            WHERE project_id = ?
        `).run(categoryId, projectId);
    },

    clearCategoryFromProjects(categoryId: string): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET category_id = NULL
            WHERE category_id = ?
        `).run(categoryId);
    },
};
