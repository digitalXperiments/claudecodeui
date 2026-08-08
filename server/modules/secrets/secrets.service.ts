/**
 * Secrets vault service (PRD §8.4) — Vault v1 backend.
 *
 * Guarantees:
 *   - Values are NEVER written to the DB in plaintext: v1 always stores
 *     AES-256-GCM ciphertext (backend `encrypted_db`; OS keychain is
 *     detection-only for now, see secrets-keychain.service.ts).
 *   - Values never appear in returned metadata, logs, or error messages.
 *   - Resolved/put values are cached in memory (never persisted) so
 *     `redact()` can scrub them from log text cheaply.
 *
 * Ref grammar (PRD §8.4):
 *   ${secret:GITHUB_TOKEN}                — bare name, resolved via ctx
 *   ${secret:sec_01JABC…}                 — direct secret id
 *   ${secret:project:<projectId>:NAME}    — qualified project-scoped name
 */

import { getConnection } from '@/modules/database/index.js';
import { decryptSecret, encryptSecret } from '@/modules/secrets/secrets-crypto.service.js';
import { getMasterKey } from '@/modules/secrets/secrets-key.service.js';
import { keychainService } from '@/modules/secrets/secrets-keychain.service.js';
import type {
  PutSecretInput,
  ResolveContext,
  SecretMeta,
  SecretRow,
  SecretScope,
} from '@/modules/secrets/secrets.types.js';
import { newSecretId } from '@/shared/ids.js';
import { CloudError } from '@/shared/run-events.js';

const REF_ENVELOPE_PATTERN = /^\$\{secret:([^}]+)\}$/;
const REF_INLINE_PATTERN = /\$\{secret:([^}]+)\}/g;
const SECRET_ID_PREFIX = 'sec_';

const REDACTED = '***REDACTED***';
// Shorter values would over-redact normal log text (e.g. a 1-char secret
// would erase that character everywhere); 4 chars is the sanity floor.
const MIN_REDACT_VALUE_LENGTH = 4;

/** Common token shapes scrubbed even when they were never put in the vault. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{8,}/g, // GitHub personal access token
  /gho_[A-Za-z0-9]{8,}/g, // GitHub OAuth token
  /xox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack tokens
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI-style API keys
];
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi;

/**
 * In-memory cache of known plaintext values, keyed by secret id, plus a set
 * of retired values (rotated-out or deleted secrets) so log lines captured
 * with the old value stay scrubbed for the process lifetime. Never
 * persisted, never logged.
 */
const knownValues = new Map<string, string>();
const retiredValues = new Set<string>();

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

function toMeta(row: SecretRow): SecretMeta {
  const { keychain_account: _keychainAccount, ciphertext: _ciphertext, nonce: _nonce, ...meta } =
    row;
  return meta;
}

function findRowById(secretId: string): SecretRow | null {
  const db = getConnection();
  const row = db.prepare(`SELECT * FROM secrets WHERE secret_id = ?`).get(secretId) as
    | SecretRow
    | undefined;
  return row ?? null;
}

function findRowByName(name: string, scope: SecretScope, scopeRef: string | null): SecretRow | null {
  const db = getConnection();
  const row = (
    scopeRef === null
      ? db
          .prepare(`SELECT * FROM secrets WHERE name = ? AND scope = ? AND scope_ref IS NULL`)
          .get(name, scope)
      : db
          .prepare(`SELECT * FROM secrets WHERE name = ? AND scope = ? AND scope_ref = ?`)
          .get(name, scope, scopeRef)
  ) as SecretRow | undefined;
  return row ?? null;
}

function decryptRow(row: SecretRow): string {
  if (row.backend === 'keychain') {
    // Unreachable in v1 (keychain is detection-only); keeps the backend
    // branch explicit for the future keytar PR.
    throw new CloudError(
      'SECRET_RESOLVE_FAILED',
      `Secret "${row.name}" uses the OS keychain backend, which is unavailable`,
    );
  }
  if (!row.ciphertext || !row.nonce) {
    throw new CloudError(
      'SECRET_RESOLVE_FAILED',
      `Secret "${row.name}" has no stored ciphertext (corrupted row)`,
    );
  }
  try {
    return decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce }, getMasterKey());
  } catch (error) {
    if (error instanceof CloudError) {
      throw error;
    }
    throw new CloudError(
      'SECRET_RESOLVE_FAILED',
      `Secret "${row.name}" could not be decrypted (wrong master key or corrupted ciphertext)`,
    );
  }
}

/** Remember a resolved value for redaction; returns it for convenience. */
function remember(secretId: string, value: string): string {
  knownValues.set(secretId, value);
  return value;
}

function retire(value: string | null): void {
  if (value) {
    retiredValues.add(value);
  }
}

// ---------------------------------------------------------------------------
// Ref parsing
// ---------------------------------------------------------------------------

/** Strips the `${secret:…}` envelope when present; also accepts a bare expression. */
function parseRefExpression(ref: string): string {
  const trimmed = ref.trim();
  const match = REF_ENVELOPE_PATTERN.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

function findRowForExpression(
  expr: string,
  ctx: ResolveContext,
): { row: SecretRow | null; searched: string } {
  // 1. Direct id reference.
  if (expr.startsWith(SECRET_ID_PREFIX)) {
    return { row: findRowById(expr), searched: expr };
  }

  // 2. Qualified form: project:<projectId>:NAME (PRD §8.4 grammar).
  if (expr.startsWith('project:')) {
    const rest = expr.slice('project:'.length);
    const separator = rest.indexOf(':');
    if (separator > 0 && separator < rest.length - 1) {
      const projectId = rest.slice(0, separator);
      const name = rest.slice(separator + 1);
      return { row: findRowByName(name, 'project', projectId), searched: `project:${projectId}:${name}` };
    }
    // Malformed qualified ref — fall through to a bare-name lookup so the
    // error message below still reads sensibly.
  }

  // 3. Bare name: search most-specific scope first using the caller's ctx,
  //    then fall back to the global 'user' scope.
  const candidates: Array<[SecretScope, string | null]> = [];
  if (ctx.projectId) {
    candidates.push(['project', ctx.projectId]);
  }
  if (ctx.provider) {
    candidates.push(['provider', ctx.provider]);
  }
  if (ctx.profileId) {
    candidates.push(['profile', ctx.profileId]);
  }
  candidates.push(['user', null]);

  for (const [scope, scopeRef] of candidates) {
    const row = findRowByName(expr, scope, scopeRef);
    if (row) {
      return { row, searched: expr };
    }
  }
  return { row: null, searched: expr };
}

// ---------------------------------------------------------------------------
// Service (PRD §8.4 interface)
// ---------------------------------------------------------------------------

export const secretsService = {
  /**
   * Insert or rotate a secret. Upsert keyed on UNIQUE(name, scope, scope_ref)
   * (matched manually because SQLite treats NULL scope_ref as distinct);
   * updating keeps the secret_id and bumps updated_at — treat it as a rotation.
   * Returns metadata only; the value is never echoed back.
   */
  put(input: PutSecretInput): SecretMeta {
    const name = input.name.trim();
    if (!name) {
      throw new Error('Secret name must be a non-empty string');
    }
    if (name.includes(':') || name.includes('}') || name.startsWith(SECRET_ID_PREFIX)) {
      throw new Error(
        'Secret name must not contain ":" or "}" and must not start with "sec_" (reserved for secret ids)',
      );
    }
    if (typeof input.value !== 'string' || input.value.length === 0) {
      throw new Error('Secret value must be a non-empty string');
    }
    const scope = input.scope ?? 'user';
    const scopeRef = input.scopeRef ?? null;
    const db = getConnection();
    const existing = findRowByName(name, scope, scopeRef);

    // Backend selection: the keychain is detection-only in v1, so this always
    // lands on encrypted_db. The branch stays explicit for the future keytar PR.
    const backend = keychainService.isAvailable() ? 'keychain' : 'encrypted_db';
    void backend; // encrypted_db path below is the only live one in v1.

    const { ciphertext, nonce } = encryptSecret(input.value, getMasterKey());

    if (existing) {
      // Rotation: scrub the outgoing value from memory into the retired set
      // so old log lines stay redacted, then overwrite in place.
      try {
        retire(decryptRow(existing));
      } catch {
        // Old value undecryptable (e.g. master key changed) — nothing to retire.
      }
      db.prepare(
        `UPDATE secrets
         SET backend = 'encrypted_db', keychain_account = NULL, ciphertext = ?, nonce = ?,
             content_type = ?, description = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE secret_id = ?`,
      ).run(
        ciphertext,
        nonce,
        input.contentType ?? existing.content_type ?? 'token',
        input.description !== undefined ? input.description : existing.description,
        input.expiresAt !== undefined ? input.expiresAt : existing.expires_at,
        existing.secret_id,
      );
      remember(existing.secret_id, input.value);
      return toMeta(findRowById(existing.secret_id)!);
    }

    const secretId = newSecretId();
    db.prepare(
      `INSERT INTO secrets (
         secret_id, name, scope, scope_ref, backend, keychain_account,
         ciphertext, nonce, content_type, description, expires_at
       ) VALUES (?, ?, ?, ?, 'encrypted_db', NULL, ?, ?, ?, ?, ?)`,
    ).run(
      secretId,
      name,
      scope,
      scopeRef,
      ciphertext,
      nonce,
      input.contentType ?? 'token',
      input.description ?? null,
      input.expiresAt ?? null,
    );
    remember(secretId, input.value);
    return toMeta(findRowById(secretId)!);
  },

  /** Fetch metadata by `sec_…` id or by name (optionally narrowed by scope). Never returns values. */
  getMeta(secretIdOrName: string, scope?: SecretScope): SecretMeta | null {
    if (secretIdOrName.startsWith(SECRET_ID_PREFIX)) {
      const row = findRowById(secretIdOrName);
      return row ? toMeta(row) : null;
    }
    const db = getConnection();
    const row = (
      scope
        ? db
            .prepare(
              `SELECT * FROM secrets WHERE name = ? AND scope = ? ORDER BY created_at DESC LIMIT 1`,
            )
            .get(secretIdOrName, scope)
        : db
            .prepare(
              `SELECT * FROM secrets WHERE name = ?
               ORDER BY CASE scope WHEN 'user' THEN 0 WHEN 'project' THEN 1 WHEN 'provider' THEN 2 ELSE 3 END,
                        created_at DESC
               LIMIT 1`,
            )
            .get(secretIdOrName)
    ) as SecretRow | undefined;
    return row ? toMeta(row) : null;
  },

  /**
   * Resolve a `${secret:…}` ref (or bare expression) to its plaintext value.
   * Throws CloudError SECRET_NOT_FOUND when nothing matches — callers turn
   * that into an actionable interrupt. Updates last_used_at on success.
   */
  resolve(ref: string, ctx: ResolveContext = {}): string {
    const expr = parseRefExpression(ref);
    if (!expr) {
      throw new CloudError('SECRET_NOT_FOUND', 'Empty secret reference');
    }
    const { row, searched } = findRowForExpression(expr, ctx);
    if (!row) {
      // Message names the ref only — never a value.
      throw new CloudError(
        'SECRET_NOT_FOUND',
        `Secret not found: "${searched}". Store it first (POST /api/secrets) or fix the reference.`,
      );
    }
    const value = decryptRow(row);
    getConnection()
      .prepare(`UPDATE secrets SET last_used_at = CURRENT_TIMESTAMP WHERE secret_id = ?`)
      .run(row.secret_id);
    return remember(row.secret_id, value);
  },

  /**
   * Deep-replace every `${secret:…}` occurrence inside string values of plain
   * objects/arrays. Strings without refs are returned untouched; non-plain
   * values (Date, Buffer, class instances, …) pass through by reference.
   */
  resolveInObject<T>(obj: T, ctx: ResolveContext = {}): T {
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') {
        if (!value.includes('${secret:')) {
          return value;
        }
        return value.replace(REF_INLINE_PATTERN, (_match, expr: string) =>
          secretsService.resolve(expr, ctx),
        );
      }
      if (Array.isArray(value)) {
        return value.map(walk);
      }
      if (value !== null && typeof value === 'object') {
        const proto: unknown = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === null) {
          const out: Record<string, unknown> = {};
          for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            out[key] = walk(entry);
          }
          return out;
        }
      }
      return value;
    };
    return walk(obj) as T;
  },

  /** Delete a secret by id. The value is retired to the redaction cache. */
  delete(secretId: string): void {
    const row = findRowById(secretId);
    if (!row) {
      return;
    }
    try {
      retire(decryptRow(row));
    } catch {
      // Undecryptable row — still delete it.
    }
    getConnection().prepare(`DELETE FROM secrets WHERE secret_id = ?`).run(secretId);
    knownValues.delete(secretId);
  },

  /** List metadata, optionally filtered by scope. NEVER returns values. */
  list(scope?: SecretScope): SecretMeta[] {
    const db = getConnection();
    const rows = (
      scope
        ? db.prepare(`SELECT * FROM secrets WHERE scope = ? ORDER BY name ASC`).all(scope)
        : db.prepare(`SELECT * FROM secrets ORDER BY scope ASC, name ASC`).all()
    ) as SecretRow[];
    return rows.map(toMeta);
  },

  /**
   * Scrub a text (log line, event payload, error message) of:
   *   1. every known/retired vault value (cached after first put/resolve), and
   *   2. common token shapes (GitHub/Slack/OpenAI/Bearer forms) even if the value
   *      was never stored in the vault.
   */
  redact(text: string): string {
    let out = text;
    const values = [...knownValues.values(), ...retiredValues]
      .filter((value) => value.length >= MIN_REDACT_VALUE_LENGTH)
      // Longest first so overlapping values redact the more specific one.
      .sort((a, b) => b.length - a.length);
    for (const value of values) {
      if (out.includes(value)) {
        out = out.split(value).join(REDACTED);
      }
    }
    for (const pattern of TOKEN_PATTERNS) {
      out = out.replace(pattern, REDACTED);
    }
    out = out.replace(BEARER_PATTERN, `$1${REDACTED}`);
    return out;
  },
};
