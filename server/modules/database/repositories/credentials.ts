/**
 * User credentials repository.
 *
 * Manages external service tokens (GitHub, GitLab, Bitbucket, etc.)
 * stored per-user. Each credential has a type discriminator so multiple
 * credential kinds can coexist in the same table.
 */

import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { secretsService } from '@/modules/secrets/index.js';
import type {
  CreateCredentialResult,
  CredentialPublicRow,
} from '@/shared/types.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const credentialsDb = {
  /** One-time dual-read migration for legacy plaintext credential rows. */
  migratePlaintextCredentials(): number {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT id, user_id, credential_name, credential_type, credential_value, description FROM user_credentials WHERE (secret_id IS NULL OR secret_id = '') AND credential_value <> ''`)
      .all() as Array<{ id: number; user_id: number; credential_name: string; credential_type: string; credential_value: string; description: string | null }>;
    const migrate = db.transaction(() => {
      for (const row of rows) {
        const secret = secretsService.put({
          name: `credential_${row.user_id}_${row.id}`,
          value: row.credential_value,
          scope: 'user',
          scopeRef: String(row.user_id),
          contentType: 'token',
          description: row.description ?? undefined,
        });
        db.prepare(`UPDATE user_credentials SET credential_value = '', secret_id = ? WHERE id = ?`).run(secret.secret_id, row.id);
      }
    });
    migrate();
    return rows.length;
  },

  /** Stores a new credential and returns a safe (no raw value) result. */
  createCredential(
    userId: number,
    credentialName: string,
    credentialType: string,
    credentialValue: string,
    description: string | null = null
  ): CreateCredentialResult {
    const db = getConnection();
    const secretMeta = secretsService.put({
      name: `credential_${userId}_${randomUUID()}`,
      value: credentialValue,
      scope: 'user',
      scopeRef: String(userId),
      contentType: 'token',
      description: description ?? undefined,
    });
    const result = db
      .prepare(
        'INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description, secret_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(userId, credentialName, credentialType, '', description, secretMeta.secret_id);
    return {
      id: result.lastInsertRowid,
      credentialName,
      credentialType,
    };
  },

  /**
   * Lists credentials for a user (excluding raw values).
   * Optionally filters by credential type (e.g. 'github_token').
   */
  getCredentials(
    userId: number,
    credentialType: string | null = null
  ): CredentialPublicRow[] {
    const db = getConnection();

    if (credentialType) {
      return db
        .prepare(
          'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? AND credential_type = ? ORDER BY created_at DESC'
        )
        .all(userId, credentialType) as CredentialPublicRow[];
    }

    return db
      .prepare(
        'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId) as CredentialPublicRow[];
  },

  /**
   * Returns the raw credential value for the most recent active
   * credential of the given type, or null if none exists.
   */
  getActiveCredential(
    userId: number,
    credentialType: string
  ): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT id, credential_value, secret_id FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1'
      )
      .get(userId, credentialType) as { id: number; credential_value: string; secret_id: string | null } | undefined;
    if (!row) return null;
    return credentialsDb.getCredentialValueById(userId, row.id);
  },

  /** Resolve a managed secret, with a legacy plaintext fallback for migration. */
  getCredentialValueById(userId: number, credentialId: number): string | null {
    const row = getConnection()
      .prepare('SELECT credential_value, secret_id FROM user_credentials WHERE id = ? AND user_id = ? AND is_active = 1')
      .get(credentialId, userId) as { credential_value: string; secret_id: string | null } | undefined;
    if (!row) return null;
    if (row.secret_id) {
      try {
        return secretsService.resolve(row.secret_id, { provider: 'credential', profileId: String(userId) });
      } catch {
        return null;
      }
    }
    return row.credential_value || null;
  },

  /** Permanently removes a credential. Returns true if a row was deleted. */
  deleteCredential(userId: number, credentialId: number): boolean {
    const db = getConnection();
    const existing = db
      .prepare('SELECT secret_id FROM user_credentials WHERE id = ? AND user_id = ?')
      .get(credentialId, userId) as { secret_id: string | null } | undefined;
    const result = db
      .prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?')
      .run(credentialId, userId);
    if (result.changes > 0 && existing?.secret_id) {
      secretsService.delete(existing.secret_id);
    }
    return result.changes > 0;
  },

  /** Enables or disables a credential without deleting it. */
  toggleCredential(
    userId: number,
    credentialId: number,
    isActive: boolean
  ): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        'UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?'
      )
      .run(isActive ? 1 : 0, credentialId, userId);
    return result.changes > 0;
  },
};
