/**
 * Phase 4 — Secrets vault types (PRD §8.3–8.4).
 *
 * `SecretMeta` is the ONLY shape that crosses the API boundary. It never
 * carries the plaintext value, the ciphertext, or the nonce — those stay
 * inside `SecretRow`, which is confined to the repository/service layer.
 */

/** Scope a secret is bound to (PRD §8.3: user|project|provider|profile). */
export type SecretScope = 'user' | 'project' | 'provider' | 'profile';

export const SECRET_SCOPES: readonly SecretScope[] = [
  'user',
  'project',
  'provider',
  'profile',
] as const;

export function isSecretScope(value: unknown): value is SecretScope {
  return typeof value === 'string' && (SECRET_SCOPES as readonly string[]).includes(value);
}

export type SecretBackend = 'keychain' | 'encrypted_db';

export type SecretContentType = 'token' | 'json' | 'file_ref';

/**
 * Public metadata for a stored secret. NEVER includes the value — this is
 * what `list`/`getMeta`/`put` return and what the REST API serializes.
 * Field names mirror the SQLite columns (snake_case), matching the row
 * conventions used by the kanban module.
 */
export type SecretMeta = {
  secret_id: string; // sec_<ulid>
  name: string;
  scope: SecretScope;
  scope_ref: string | null; // project_id / provider / profile_id
  backend: SecretBackend;
  content_type: SecretContentType;
  description: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Raw SQLite row. Adds the sensitive storage fields that must never leave
 * the service layer. `ciphertext` holds encrypted-bytes||auth-tag and
 * `nonce` the 12-byte GCM IV (see secrets-crypto.service.ts).
 */
export type SecretRow = SecretMeta & {
  keychain_account: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
};

/** Scoping hints used when resolving a bare `${secret:NAME}` ref. */
export type ResolveContext = {
  projectId?: string;
  provider?: string;
  profileId?: string;
};

export type PutSecretInput = {
  name: string;
  value: string;
  scope?: SecretScope;
  scopeRef?: string;
  description?: string;
  expiresAt?: string; // ISO-8601
  contentType?: SecretContentType;
};
