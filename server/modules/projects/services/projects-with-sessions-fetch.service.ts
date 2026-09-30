import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { sessionSynchronizerService } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

type SessionSummary = {
  id: string;
  provider_session_id: string | null;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
  studioPrototypeIds: string[];
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  provider_session_id?: string | null;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  is_internal?: number | boolean | null;
  is_studio_only?: number | boolean | null;
  studio_prototype_ids?: string | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  categoryId: string | null;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type GetProjectsWithSessionsOptions = {
  /**
   * Run a full provider rescan before reading the DB. Off by default: the
   * boot sync plus the filesystem watchers keep the index current, so the
   * list is served straight from SQLite. Only an explicit user refresh (or a
   * never-synced database) pays for the full scan.
   */
  synchronize?: boolean;
  /** Legacy flag; `true` always wins over `synchronize`. */
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
  };
};

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/** Bounded fan-out for per-project filesystem work (package.json stat/read). */
const PROJECT_FS_CONCURRENCY = 8;
const DISPLAY_NAME_CACHE_MAX_ENTRIES = 2000;

type DisplayNameCacheEntry = {
  /** package.json mtime (ms) the name was read from; null when it was missing/unreadable. */
  packageJsonMtimeMs: number | null;
  packageName: string | null;
};

/**
 * package.json-derived names keyed by project path. Validated with one `stat`
 * per lookup (the mtime is part of the key), so an edited package.json is
 * picked up on the next request while unchanged projects skip the read+parse.
 */
const displayNameCache = new Map<string, DisplayNameCacheEntry>();

/** Test-only: drop cached package.json names. */
export function clearDisplayNameCache(): void {
  displayNameCache.clear();
}

async function readPackageJsonName(projectPath: string): Promise<string | null> {
  const packageJsonPath = path.join(projectPath, 'package.json');
  let mtimeMs: number | null = null;
  try {
    const stat = await fs.stat(packageJsonPath);
    mtimeMs = stat.isFile() ? stat.mtimeMs : null;
  } catch {
    mtimeMs = null;
  }

  const cached = displayNameCache.get(projectPath);
  if (cached && cached.packageJsonMtimeMs === mtimeMs) {
    return cached.packageName;
  }

  let packageName: string | null = null;
  if (mtimeMs !== null) {
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { name?: unknown };
      packageName = typeof packageJson.name === 'string' && packageJson.name ? packageJson.name : null;
    } catch {
      packageName = null;
    }
  }

  if (displayNameCache.size >= DISPLAY_NAME_CACHE_MAX_ENTRIES && !displayNameCache.has(projectPath)) {
    const oldestKey = displayNameCache.keys().next().value;
    if (oldestKey !== undefined) displayNameCache.delete(oldestKey);
  }
  displayNameCache.set(projectPath, { packageJsonMtimeMs: mtimeMs, packageName });
  return packageName;
}

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Prefer the package.json name (cached per path + package.json mtime).
  const packageName = await readPackageJsonName(projectPath);
  if (packageName) {
    return packageName;
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(row: SessionRepositoryRow): SessionSummary {
  let studioPrototypeIds: string[] = [];
  try {
    const parsed = JSON.parse(row.studio_prototype_ids || '[]') as unknown;
    if (Array.isArray(parsed)) studioPrototypeIds = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    studioPrototypeIds = [];
  }
  return {
    id: row.session_id,
    provider_session_id: row.provider_session_id ?? null,
    provider: row.provider,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    studioPrototypeIds,
  };
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  // The repository call intentionally returns every row (permanent deletion
  // needs them all), so the internal delegate rows are filtered here — the
  // archived view is a user-facing list like the session picker.
  const rows = (sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[])
    .filter((row) => !row.is_internal && !row.is_studio_only);

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total: rows.length,
    hasMore: false,
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath);

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total,
    hasMore: pagination.offset + rows.length < total,
  };
}

/**
 * Maps `items` through `worker` with at most `limit` promises in flight,
 * preserving input order in the result.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

type ProjectRow = {
  project_id: string;
  project_path: string;
  custom_project_name?: string | null;
  isStarred?: number;
  category_id?: string | null;
};

function resolveProjectDisplayName(row: ProjectRow): Promise<string> {
  return row.custom_project_name && row.custom_project_name.trim().length > 0
    ? Promise.resolve(row.custom_project_name)
    : generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);
}

/**
 * Full provider rescans are expensive (every provider's artifact tree), so the
 * project list only runs one when explicitly asked to, or when the index has
 * never been populated (first boot before the watcher's initial sync landed).
 * Concurrent callers share the synchronizer's single in-flight scan.
 */
async function synchronizeIfRequested(options: Pick<GetProjectsWithSessionsOptions, 'synchronize' | 'skipSynchronization'>): Promise<void> {
  if (options.skipSynchronization) {
    return;
  }
  const neverScanned = !scanStateDb.getLastScannedAt();
  if (options.synchronize || neverScanned) {
    await sessionSynchronizerService.synchronizeSessions();
  }
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  // Legacy workspace/temp rows are rehomed by every full sync (boot + explicit
  // refresh), so the hot read path no longer pays for that scan.
  await synchronizeIfRequested(options);

  const projectRows = projectsDb.getProjectPaths() as ProjectRow[];
  const displayNames = await mapWithConcurrency(projectRows, PROJECT_FS_CONCURRENCY, resolveProjectDisplayName);

  return projectRows.map((row, index) => {
    const projectPath = row.project_path;
    const sessionsPage = readProjectSessionsPageByPath(projectPath, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
    });

    return {
      projectId: row.project_id,
      path: projectPath,
      displayName: displayNames[index],
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      categoryId: row.category_id ?? null,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    };
  });
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'synchronize' | 'skipSynchronization'> = {},
): Promise<ArchivedProjectListItem[]> {
  await synchronizeIfRequested(options);

  const projectRows = projectsDb.getArchivedProjectPaths() as ProjectRow[];
  const displayNames = await mapWithConcurrency(projectRows, PROJECT_FS_CONCURRENCY, resolveProjectDisplayName);

  return projectRows.map((row, index) => {
    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);
    return {
      projectId: row.project_id,
      path: row.project_path,
      displayName: displayNames[index],
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      categoryId: row.category_id ?? null,
      isArchived: true as const,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
      },
    };
  });
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
    },
  };
}
