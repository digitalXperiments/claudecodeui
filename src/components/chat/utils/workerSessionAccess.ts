/**
 * Single source of truth for whether the chat view must render as a
 * read-only Agent Relay/internal worker transcript. Everything that hides or
 * disables a composer/header control derives from `resolveReadOnlyWorkerSession`
 * (or the `guardWhenReadOnly` no-op wrapper below) so there is exactly one
 * predicate to reason about instead of scattered `isInternal` checks.
 */

export interface WorkerSessionLike {
  id?: string | null;
  isInternal?: boolean;
}

/**
 * Carried through router navigation state by callers that already know the
 * target session is an internal worker (e.g. opening a worker's transcript
 * from the Agent Relay panel, before that session has ever loaded here).
 * This is never trusted as an ongoing source of truth — it only fails the
 * gate closed for the brief window before `selectedSession.isInternal`
 * resolves for the routed session, and is superseded the instant it does.
 */
export interface WorkerSessionNavigationHint {
  isInternal?: boolean;
}

export interface ResolveReadOnlyWorkerSessionArgs {
  /** The session currently loaded into the chat view. May still describe a
   * different (stale) session while the route is mid-transition. */
  selectedSession: WorkerSessionLike | null;
  /** The session id the route/URL currently points at. */
  routeSessionId: string | null;
  /** Same-navigation hint from `location.state`; not a source of truth. */
  navigationHint: WorkerSessionNavigationHint | null;
}

/**
 * Whether the currently viewed session must be treated as a read-only
 * worker transcript. Once the loaded session matches the routed session id,
 * its own `isInternal` field wins outright — including flipping a
 * fail-closed hint back to interactive. Until then, a stale loaded session's
 * `isInternal: true`, or a same-navigation hint, keeps the gate closed so
 * controls never flicker enabled for a worker session while it loads.
 */
export function resolveReadOnlyWorkerSession({
  selectedSession,
  routeSessionId,
  navigationHint,
}: ResolveReadOnlyWorkerSessionArgs): boolean {
  const sessionMatchesRoute =
    Boolean(selectedSession) && Boolean(routeSessionId) && selectedSession!.id === routeSessionId;

  if (sessionMatchesRoute) {
    return selectedSession!.isInternal === true;
  }

  if (selectedSession?.isInternal === true) {
    return true;
  }

  return Boolean(navigationHint?.isInternal);
}

const NO_OP = (() => undefined) as (...args: unknown[]) => undefined;

/**
 * Returns `handler` unchanged, or a stable no-op when `readOnly` is true.
 * Defense-in-depth: a control that is supposed to be hidden/disabled for a
 * read-only worker session cannot fire even if it still renders somehow.
 * An absent (`undefined`) handler passes through untouched either way.
 */
export function guardWhenReadOnly<T extends (...args: any[]) => any>(
  readOnly: boolean,
  handler: T,
): T | typeof NO_OP;
export function guardWhenReadOnly<T extends (...args: any[]) => any>(
  readOnly: boolean,
  handler: T | undefined,
): T | typeof NO_OP | undefined;
export function guardWhenReadOnly(
  readOnly: boolean,
  handler: ((...args: any[]) => any) | undefined,
): ((...args: any[]) => any) | undefined {
  if (!handler) {
    return handler;
  }
  return readOnly ? NO_OP : handler;
}
