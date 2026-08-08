/**
 * Master key management for the `encrypted_db` secrets backend (PRD §8.3).
 *
 * Resolution order:
 *   1. `CLOUDCLI_SECRETS_KEY` env var — base64-encoded 32 bytes.
 *   2. `<secretsDir>/secrets.key` — generated once with crypto-random bytes
 *      and persisted with file mode 0600; the directory (default
 *      `~/.cloudcli`) is created with mode 0700.
 *
 * Threat model (PRD §8.3): without an OS keychain backend the master key
 * sits next to the database on the local filesystem. A local attacker with
 * read access to the user's home directory (or any process running as the
 * same user) can still decrypt the vault — the 0600/0700 modes only defend
 * against *other* users on a shared machine. OS keychain storage (see
 * secrets-keychain.service.ts) is the planned hardening path; until then
 * prefer `CLOUDCLI_SECRETS_KEY` injected from a real secret manager on
 * shared hosts.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_ENV_VAR = 'CLOUDCLI_SECRETS_KEY';
const KEY_FILE_NAME = 'secrets.key';
const KEY_BYTES = 32;

let overrideDir: string | null = null;
let cachedFileKey: Buffer | null = null;

/**
 * Test hook: point the key directory at an isolated location (and drop the
 * cached key) so tests never touch the real `~/.cloudcli/secrets.key`.
 */
export function configureSecretsKeyDir(dir: string | null): void {
  overrideDir = dir;
  cachedFileKey = null;
}

export function resolveSecretsDir(): string {
  return overrideDir ?? path.join(os.homedir(), '.cloudcli');
}

function readKeyFromEnv(): Buffer | null {
  const raw = process.env[KEY_ENV_VAR];
  if (!raw) {
    return null;
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${KEY_ENV_VAR} must be a base64-encoded ${KEY_BYTES}-byte key (decoded to ${key.length} bytes)`,
    );
  }
  return key;
}

function readOrCreateKeyFile(): Buffer {
  const dir = resolveSecretsDir();
  const filePath = path.join(dir, KEY_FILE_NAME);

  if (cachedFileKey && fs.existsSync(filePath)) {
    return cachedFileKey;
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(filePath)) {
    const key = Buffer.from(fs.readFileSync(filePath, 'utf8').trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${filePath} is not a valid base64-encoded ${KEY_BYTES}-byte key; delete it to regenerate (existing secrets become unreadable)`,
      );
    }
    cachedFileKey = key;
    return key;
  }

  const key = randomBytes(KEY_BYTES);
  fs.writeFileSync(filePath, `${key.toString('base64')}\n`, { mode: 0o600 });
  try {
    // Guard against restrictive-preserving umasks on re-write paths; chmod is
    // a no-op on filesystems without POSIX modes.
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* non-POSIX filesystem — mode bits unsupported */
  }
  cachedFileKey = key;
  return key;
}

/** Returns the 32-byte AES-256 master key, generating/persisting it on first use. */
export function getMasterKey(): Buffer {
  return readKeyFromEnv() ?? readOrCreateKeyFile();
}
