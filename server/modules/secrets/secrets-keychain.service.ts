/**
 * Optional OS keychain backend (PRD §8.2: "OS keychain when available").
 *
 * v1 ships DETECTION ONLY: `keytar` would be an optional, dynamically
 * imported dependency and is almost certainly absent, so `isAvailable()`
 * returns false and the vault always falls back to the `encrypted_db`
 * backend. The unavailability is logged once at debug level.
 *
 * A future PR can add `keytar` to optionalDependencies and route
 * put/resolve/delete through this adapter (making SecretsService async or
 * pre-resolving detection at startup) without changing this interface.
 */

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

/** Keychain service (namespace) under which all CloudCLI secrets are stored. */
const KEYCHAIN_SERVICE_NAME = 'cloudcli.secrets';

// Indirect specifier so TypeScript does not try to resolve the optional
// (absent) module at compile time.
const KEYTAR_SPECIFIER = 'keytar';

let keytar: KeytarModule | null = null;
let detectionStarted = false;

async function detect(): Promise<void> {
  if (detectionStarted) {
    return;
  }
  detectionStarted = true;
  try {
    const mod = (await import(KEYTAR_SPECIFIER)) as { default?: KeytarModule } & KeytarModule;
    keytar = mod.default ?? mod;
  } catch {
    keytar = null;
    // Debug level and exactly once: an absent keychain is the expected
    // default, not an error worth spamming logs about.
    console.debug('[secrets] OS keychain (keytar) unavailable; falling back to encrypted_db');
  }
}

// Kick detection off at module load so `isAvailable()` reflects reality by
// the time the first vault operation runs.
void detect();

export const keychainService = {
  /** True only when keytar was successfully imported. Always false in v1. */
  isAvailable(): boolean {
    return keytar !== null;
  },

  async get(account: string): Promise<string | null> {
    await detect();
    if (!keytar) {
      return null;
    }
    return keytar.getPassword(KEYCHAIN_SERVICE_NAME, account);
  },

  async set(account: string, value: string): Promise<void> {
    await detect();
    if (!keytar) {
      throw new Error('OS keychain unavailable');
    }
    await keytar.setPassword(KEYCHAIN_SERVICE_NAME, account, value);
  },

  async delete(account: string): Promise<void> {
    await detect();
    if (!keytar) {
      return;
    }
    await keytar.deletePassword(KEYCHAIN_SERVICE_NAME, account);
  },
};
