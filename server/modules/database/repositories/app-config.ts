/**
 * App config repository.
 *
 * Key-value store for application-level configuration that persists
 * across restarts (JWT secret, feature flags, etc.). Values are always
 * stored as strings; callers handle parsing.
 */

import crypto from 'crypto';

import { getConnection } from '@/modules/database/connection.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function isSqliteBusy(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // JWT bootstrap happens at module load, before any event loop is spinning.
    // A short busy-wait is cheaper than failing open and rotating the secret.
  }
}

function readValue(key: string): string | null {
  const db = getConnection();
  const row = db
    .prepare('SELECT value FROM app_config WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export const appConfigDb = {
  /** Returns the stored value for a config key, or null if missing. */
  get(key: string): string | null {
    try {
      return readValue(key);
    } catch {
      // Swallow errors so optional feature-flag reads do not crash callers.
      return null;
    }
  },

  /** Inserts or updates a config key (upsert). */
  set(key: string, value: string): void {
    const db = getConnection();
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },

  /**
   * Returns the JWT signing secret, generating and persisting one
   * if it does not already exist. This ensures the secret survives
   * server restarts while being created automatically on first boot.
   *
   * A failed read must never look like "missing" — that used to mint a new
   * secret during SQLITE_BUSY (LaunchAgent flap) and log everyone out.
   */
  getOrCreateJwtSecret(): string {
    const maxAttempts = 8;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const existing = readValue('jwt_secret');
        if (existing) return existing;

        const generated = crypto.randomBytes(64).toString('hex');
        const db = getConnection();
        // Another process may win the insert. Prefer whatever is persisted.
        db.prepare(
          `INSERT INTO app_config (key, value) VALUES ('jwt_secret', ?)
           ON CONFLICT(key) DO NOTHING`,
        ).run(generated);
        return readValue('jwt_secret') ?? generated;
      } catch (error) {
        lastError = error;
        if (isSqliteBusy(error) && attempt < maxAttempts - 1) {
          sleepSync(25 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Could not read or create jwt_secret');
  },
};
