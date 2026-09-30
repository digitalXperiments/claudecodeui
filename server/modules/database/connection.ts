/**
 * Database connection management.
 *
 * Owns the single SQLite connection used across all repositories.
 * Handles path resolution, directory creation, legacy database migration,
 * and eager app_config bootstrap so the auth middleware can read the
 * JWT secret before the full schema is applied.
 *
 * Consumers should never create their own Database instance — they use
 * `getConnection()` to obtain the shared singleton.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the database file path from environment or falls back
 * to the legacy location inside the server/database/ folder.
 *
 * Priority:
 *   1. DATABASE_PATH environment variable (set by cli.js or load-env-vars.js)
 *   2. Legacy path: server/database/auth.db
 */
function resolveDatabasePath(): string {
    // process.env.DATABASE_PATH is set by load-env-vars.js to either the .env value or a default(~/.cloudcli/auth.db) in the user's home directory. 
    return process.env.DATABASE_PATH || resolveLegacyDatabasePath();
}

/**
 * Resolves the legacy database path (always inside server/database/).
 * Used for the one-time migration to the new external location.
 */
function resolveLegacyDatabasePath(): string {
  const serverDir = path.resolve(__dirname, '..', '..', '..');
  return path.join(serverDir, 'database', 'auth.db');
}

// ---------------------------------------------------------------------------
// Directory & migration helpers
// ---------------------------------------------------------------------------

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created database directory:', dir);
  }
}

/**
 * If the database was moved to an external location (e.g. ~/.cloudcli/)
 * but the user still has a legacy auth.db inside the install directory,
 * copy it to the new location as a one-time migration.
 */
function migrateLegacyDatabase(targetPath: string): void {
  const legacyPath = resolveLegacyDatabasePath();

  if (targetPath === legacyPath) return;
  if (fs.existsSync(targetPath)) return;
  if (!fs.existsSync(legacyPath)) return;

  try {
    fs.copyFileSync(legacyPath, targetPath);
    console.log('Migrated legacy database', { from: legacyPath, to: targetPath });


    // copy the write-ahead log and shared memory files (auth.db-wal, auth.db-shm) if they exist, to preserve any uncommitted transactions
    for (const suffix of ['-wal', '-shm']) {
      const src = legacyPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, targetPath + suffix);
      }
    }
  } catch (err: any) {
    console.error('Could not migrate legacy database', { error: err.message });
  }
}


// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

let instance: Database.Database | null = null;

/**
 * Performance pragmas applied to every connection opened here.
 * WAL lets readers run alongside the single writer (and other processes such
 * as the MCP stdio servers); NORMAL sync is durable across app crashes in WAL
 * mode; busy_timeout absorbs short cross-process write contention instead of
 * throwing SQLITE_BUSY. cache_size is in KiB when negative (64 MiB).
 */
function applyConnectionPragmas(db: Database.Database): void {
  try {
    db.pragma('journal_mode = WAL');
  } catch (err: any) {
    // e.g. read-only or network filesystems; keep the default journal mode.
    console.warn('Could not enable SQLite WAL mode', { error: err.message });
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');
}

/**
 * Returns the shared database connection, creating it on first call.
 *
 * The first invocation:
 *   1. Resolves the target database path
 *   2. Ensures the parent directory exists
 *   3. Migrates from the legacy install-directory path if needed
 *   4. Opens the SQLite connection
 *   5. Eagerly creates the app_config table (auth reads JWT secret at import time)
 *   6. Logs the database location
 */
export function getConnection(): Database.Database {
  if (instance) return instance;

  const dbPath = resolveDatabasePath();

  ensureDatabaseDirectory(dbPath);
  migrateLegacyDatabase(dbPath);

  instance = new Database(dbPath);
  applyConnectionPragmas(instance);

  // app_config must exist immediately — the auth middleware reads
  // the JWT secret at module-load time, before initializeDatabase() runs.
  instance.exec(APP_CONFIG_TABLE_SCHEMA_SQL);

  return instance;
}

/**
 * Returns the resolved database file path without opening a connection.
 * Useful for diagnostics and CLI status commands.
 */
export function getDatabasePath(): string {
  return resolveDatabasePath();
}

/**
 * Closes the database connection and clears the singleton.
 * Primarily used for graceful shutdown or testing.
 */
export function closeConnection(): void {
  if (instance) {
    instance.close();
    instance = null;
    console.log('Database connection closed');
  }
}
