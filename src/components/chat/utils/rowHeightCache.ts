/**
 * Measured transcript row heights that outlive the row component.
 *
 * LazyMessageRow swaps off-screen content for a fixed-height placeholder. The
 * height used to live in a component ref, so any remount (a tool group
 * re-keyed by a prepend, a row re-keyed by a history re-read, leaving and
 * revisiting the session) fell back to a flat estimate and the geometry above
 * the reader changed — a visible jump. Heights are kept here per session,
 * keyed by the row's stable key, with bounded LRU eviction.
 */

export type RowHeightCache = {
  /** First hit among `keys`, most specific first. */
  get: (keys: readonly string[]) => number | undefined;
  set: (keys: readonly string[], height: number) => void;
};

const MAX_SCOPES = 24;
const MAX_ROWS_PER_SCOPE = 5000;

const scopes = new Map<string, Map<string, number>>();

function touchScope(scope: string): Map<string, number> {
  let rows = scopes.get(scope);
  if (rows) {
    scopes.delete(scope);
  } else {
    rows = new Map();
  }
  scopes.set(scope, rows);
  while (scopes.size > MAX_SCOPES) {
    const oldest = scopes.keys().next().value;
    if (oldest === undefined) break;
    scopes.delete(oldest);
  }
  return rows;
}

export function getRowHeightCache(scope: string): RowHeightCache {
  const rows = touchScope(scope);
  return {
    get(keys) {
      for (const key of keys) {
        const height = rows.get(key);
        if (height !== undefined) return height;
      }
      return undefined;
    },
    set(keys, height) {
      if (!(height > 0)) return;
      for (const key of keys) {
        rows.delete(key);
        rows.set(key, height);
      }
      while (rows.size > MAX_ROWS_PER_SCOPE) {
        const oldest = rows.keys().next().value;
        if (oldest === undefined) break;
        rows.delete(oldest);
      }
    },
  };
}

/** Test hook. */
export function clearRowHeightCaches(): void {
  scopes.clear();
}

/** Namespaced member key under which a tool group's height is also stored. */
export const groupMemberHeightKey = (memberKey: string) => `group:${memberKey}`;
