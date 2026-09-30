import { invalidateSharedRequest, sharedJsonGet, type SharedJsonResult } from './requestCache';

/**
 * Session-scoped GETs that several components issue for the same session.
 * Each is keyed by session id (not URL), so equivalent endpoints share one
 * request: e.g. `/api/sessions/:id/token-usage` and
 * `/api/projects/:pid/sessions/:id/token-usage` hit the same server handler.
 */

const TOKEN_USAGE_TTL_MS = 3_000;
const LIVE_USAGE_TTL_MS = 3_000;
// Long enough to cover the permission-mode effect re-running once capabilities
// load; local mode changes invalidate the key (see invalidateSessionMeta).
const SESSION_META_TTL_MS = 10_000;

export function fetchSessionTokenUsage(
  sessionId: string,
  projectId?: string | null,
): Promise<SharedJsonResult<Record<string, unknown>>> {
  const url = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/token-usage`
    : `/api/sessions/${encodeURIComponent(sessionId)}/token-usage`;
  return sharedJsonGet<Record<string, unknown>>(url, {
    key: `token-usage:${sessionId}`,
    ttlMs: TOKEN_USAGE_TTL_MS,
  });
}

export function fetchSessionLiveUsage<T = Record<string, unknown>>(
  sessionId: string,
  { force = false }: { force?: boolean } = {},
): Promise<SharedJsonResult<T>> {
  return sharedJsonGet<T>(`/api/runs/live-usage?sessionId=${encodeURIComponent(sessionId)}`, {
    key: `live-usage:${sessionId}`,
    ttlMs: LIVE_USAGE_TTL_MS,
    force,
  });
}

export function fetchSessionMeta<T = Record<string, unknown>>(
  sessionId: string,
  { force = false }: { force?: boolean } = {},
): Promise<SharedJsonResult<T>> {
  return sharedJsonGet<T>(`/api/providers/sessions/${encodeURIComponent(sessionId)}/meta`, {
    key: `session-meta:${sessionId}`,
    ttlMs: SESSION_META_TTL_MS,
    force,
  });
}

/** Call after changing a session's server-side metadata (e.g. permission mode). */
export function invalidateSessionMeta(sessionId?: string | null): void {
  invalidateSharedRequest(sessionId ? `session-meta:${sessionId}` : 'session-meta:*');
}

/**
 * TaskMaster info for a project. useProjectsState and TaskMasterContext both
 * hydrate it when a project is selected; concurrent calls share one request
 * (in-flight only — nothing is reused once it settles).
 */
export function fetchProjectTaskMasterInfo<T = Record<string, unknown>>(projectId: string): Promise<SharedJsonResult<T>> {
  return sharedJsonGet<T>(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`, {
    key: `taskmaster-info:${projectId}`,
    ttlMs: 0,
  });
}
