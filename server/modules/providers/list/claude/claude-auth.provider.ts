import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export type AuthDetectionKind = 'authenticated' | 'unauthenticated' | 'inconclusive';

/**
 * Provider auth status plus an optional detection kind.
 * `inconclusive` means credential I/O, parse, timeout, or spawn failed —
 * not a confirmed logout.
 */
export type DetectedProviderAuthStatus = ProviderAuthStatus & {
  detection?: AuthDetectionKind;
};

export type ProviderAuthDetection = {
  kind: AuthDetectionKind;
  status: DetectedProviderAuthStatus;
  error?: string;
};

export type ClaudeAuthIo = {
  readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  spawn: typeof spawn;
  platform: () => NodeJS.Platform;
  homedir: () => string;
  env: () => NodeJS.ProcessEnv;
  now: () => number;
  keychainTimeoutMs: () => number;
  unrefTimers?: boolean;
  isCliInstalled?: () => boolean;
};

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

/** macOS Security framework: the keychain item does not exist. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

/**
 * `getStatus` is hit on every providers mount and session start. Cache a
 * confirmed login long enough to absorb that fan-out; cache a failure only
 * briefly so an out-of-band `claude auth login` is picked up on refresh.
 *
 * Intentionally does **not** spawn `claude auth status` — that CLI call is
 * hundreds of ms and can pile up under concurrent UI polls. File + keychain
 * reads (with short timeouts) are enough for UI status.
 */
const AUTHENTICATED_CACHE_TTL_MS = 30_000;
const UNAUTHENTICATED_CACHE_TTL_MS = 3_000;
const KEYCHAIN_TIMEOUT_MS = 2_000;

const defaultAuthIo = (): ClaudeAuthIo => ({
  readFile: (filePath, encoding) => readFile(filePath, encoding),
  spawn,
  platform: () => process.platform,
  homedir: () => os.homedir(),
  env: () => process.env,
  now: () => Date.now(),
  keychainTimeoutMs: () => KEYCHAIN_TIMEOUT_MS,
});

let authIoOverride: Partial<ClaudeAuthIo> | null = null;

const authIo = (): ClaudeAuthIo => ({
  ...defaultAuthIo(),
  ...authIoOverride,
});

/**
 * Test-only hook to stub filesystem, keychain, and CLI checks.
 * Pass `null` to restore production I/O.
 */
export function setClaudeAuthIoForTests(next: Partial<ClaudeAuthIo> | null): void {
  authIoOverride = next;
  cachedDetection = null;
  inFlightDetection = null;
}

let cachedDetection: { at: number; value: ProviderAuthDetection } | null = null;
/** Single-flight: concurrent getStatus/detectAuth calls share one resolve. */
let inFlightDetection: Promise<ProviderAuthDetection> | null = null;

const cacheTtlMs = (kind: AuthDetectionKind): number => (
  kind === 'authenticated' ? AUTHENTICATED_CACHE_TTL_MS : UNAUTHENTICATED_CACHE_TTL_MS
);

const isCacheFresh = (entry: { at: number; value: ProviderAuthDetection }): boolean => (
  authIo().now() - entry.at < cacheTtlMs(entry.value.kind)
);

type KeychainRead =
  | { kind: 'found'; status: ClaudeCredentialsStatus }
  | { kind: 'missing' }
  | { kind: 'inconclusive'; error: string };

type CredentialDetection =
  | { kind: 'authenticated'; status: ClaudeCredentialsStatus }
  | { kind: 'unauthenticated'; status: ClaudeCredentialsStatus }
  | { kind: 'inconclusive'; error: string };

/**
 * Parses a Claude OAuth expiry field.
 * Claude stores `expiresAt` as epoch milliseconds (sometimes seconds).
 */
const parseExpiryMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }
    const asDate = Date.parse(value);
    if (Number.isFinite(asDate)) {
      return asDate;
    }
  }
  return null;
};

const toAuthStatus = (
  installed: boolean,
  credentials: ClaudeCredentialsStatus,
  detection: AuthDetectionKind,
): DetectedProviderAuthStatus => ({
  installed,
  provider: 'claude',
  authenticated: credentials.authenticated,
  email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
  method: credentials.method,
  error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
  ...(detection === 'inconclusive' ? { detection: 'inconclusive' as const } : {}),
});

const unauthenticatedStatus = (
  installed: boolean,
  error: string,
): DetectedProviderAuthStatus => ({
  installed,
  provider: 'claude',
  authenticated: false,
  email: null,
  method: null,
  error,
});

const inconclusiveStatus = (
  installed: boolean,
  error: string,
): DetectedProviderAuthStatus => ({
  installed,
  provider: 'claude',
  authenticated: false,
  email: null,
  method: null,
  error,
  detection: 'inconclusive',
});

export class ClaudeProviderAuth implements IProviderAuth {
  /**
   * Discards the memoised status so an explicit login/logout is reflected at once.
   */
  static invalidateStatusCache(): void {
    cachedDetection = null;
  }

  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
    const override = authIo().isCliInstalled;
    if (override) {
      return override();
    }

    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    try {
      const result = spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      // spawn.sync often does not throw on ENOENT; it sets result.error instead.
      return !result.error;
    } catch {
      return false;
    }
  }

  /**
   * Returns Claude installation and credential status.
   *
   * Priority: env/settings API keys → macOS keychain OAuth → ~/.claude/.credentials.json.
   * Keychain is preferred over a stale on-disk file when both exist (Claude Code
   * moved OAuth material into the keychain on macOS).
   *
   * Transient credential I/O is still reported as `authenticated: false` for
   * Settings/UI compatibility, but `detection: 'inconclusive'` is set so
   * callers such as provider-usage can keep last-known quota instead of
   * treating the failure as a logout.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    return (await this.detectAuth()).status;
  }

  /**
   * Resolves a tri-state auth detection. Use `bypassCache` after login/logout
   * so the 30-second authenticated memo cannot hide membership changes.
   */
  async detectAuth(options: { bypassCache?: boolean } = {}): Promise<ProviderAuthDetection> {
    const bypassCache = options.bypassCache === true;

    if (!bypassCache && cachedDetection && isCacheFresh(cachedDetection)) {
      return cachedDetection.value;
    }

    if (!bypassCache && inFlightDetection) {
      return inFlightDetection;
    }

    const pending = this.resolveDetection()
      .then((detection) => {
        cachedDetection = { at: authIo().now(), value: detection };
        return detection;
      })
      .finally(() => {
        if (inFlightDetection === pending) {
          inFlightDetection = null;
        }
      });

    if (!bypassCache) {
      inFlightDetection = pending;
    }

    return pending;
  }

  private async resolveDetection(): Promise<ProviderAuthDetection> {
    const installed = this.checkInstalled();

    if (!installed) {
      const status = unauthenticatedStatus(installed, 'Claude Code CLI is not installed');
      return { kind: 'unauthenticated', status, error: status.error };
    }

    const credentials = await this.checkCredentials();

    if (credentials.kind === 'inconclusive') {
      const status = inconclusiveStatus(installed, credentials.error);
      return { kind: 'inconclusive', status, error: credentials.error };
    }

    return {
      kind: credentials.kind,
      status: toAuthStatus(installed, credentials.status, credentials.kind),
      error: credentials.status.error,
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(authIo().homedir(), '.claude', 'settings.json');
      const content = await authIo().readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * File/keychain credential checks. Matches Claude Code priority for API keys,
   * then OAuth. An expired access token is still "logged in" when a refresh
   * token exists — the CLI refreshes on use.
   *
   * Transient keychain/file failures are `inconclusive`. A missing item or
   * file (ENOENT / keychain 44) is a definitive unauthenticated signal.
   */
  private async checkCredentials(): Promise<CredentialDetection> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude auth login or configure ANTHROPIC_API_KEY.';
    const env = authIo().env();

    if (env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { kind: 'authenticated', status: { authenticated: true, email: 'Auth Token', method: 'api_key' } };
    }

    if (env.ANTHROPIC_API_KEY?.trim()) {
      return { kind: 'authenticated', status: { authenticated: true, email: 'API Key Auth', method: 'api_key' } };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { kind: 'authenticated', status: { authenticated: true, email: 'API Key Auth', method: 'api_key' } };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { kind: 'authenticated', status: { authenticated: true, email: 'Configured via settings.json', method: 'api_key' } };
    }

    // Keychain first on macOS: when present it is current; .credentials.json is
    // often a stale leftover after Claude moved OAuth into the keychain.
    const keychain = await this.readMacOSKeychainCredentials();
    if (keychain.kind === 'found') {
      return keychain.status.authenticated
        ? { kind: 'authenticated', status: keychain.status }
        : { kind: 'unauthenticated', status: keychain.status };
    }

    const file = await this.readCredentialsFile(missingCredentialsError);
    // A valid file can still rescue a flaky keychain. A missing file after a
    // keychain I/O/timeout/parse failure is inconclusive — the keychain may
    // still hold credentials we failed to read.
    if (file.kind === 'authenticated') {
      return file;
    }
    if (keychain.kind === 'inconclusive') {
      return {
        kind: 'inconclusive',
        error: keychain.error,
      };
    }

    return file;
  }

  private async readCredentialsFile(missingCredentialsError: string): Promise<CredentialDetection> {
    try {
      const credPath = path.join(authIo().homedir(), '.claude', '.credentials.json');
      const content = await authIo().readFile(credPath, 'utf8');
      try {
        const status = this.credentialsFromOAuthRecord(JSON.parse(content), missingCredentialsError);
        return status.authenticated
          ? { kind: 'authenticated', status }
          : { kind: 'unauthenticated', status };
      } catch (error) {
        const message = error instanceof SyntaxError
          ? 'Claude credentials are unreadable. Run claude auth login again.'
          : error instanceof Error
            ? error.message
            : 'Claude credentials are unreadable. Run claude auth login again.';
        return { kind: 'inconclusive', error: message };
      }
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return {
          kind: 'unauthenticated',
          status: {
            authenticated: false,
            email: null,
            method: null,
            error: missingCredentialsError,
          },
        };
      }

      const message = error instanceof SyntaxError
        ? 'Claude credentials are unreadable. Run claude auth login again.'
        : error instanceof Error
          ? `Unable to read Claude credentials: ${error.message}`
          : 'Unable to read Claude credentials. Run claude auth login again.';
      return { kind: 'inconclusive', error: message };
    }
  }

  /**
   * Reads `Claude Code-credentials` from the login keychain when present.
   * Hard-capped timeout so a blocked keychain prompt cannot stall the server.
   * Distinguishes missing items from timeouts, spawn failures, and parse errors.
   */
  private async readMacOSKeychainCredentials(): Promise<KeychainRead> {
    if (authIo().platform() !== 'darwin') {
      return { kind: 'missing' };
    }

    return new Promise((resolve) => {
      let done = false;
      let child: ReturnType<typeof spawn> | undefined;
      const finish = (value: KeychainRead) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        try {
          child?.kill();
        } catch {
          // ignore
        }
        finish({ kind: 'inconclusive', error: 'Claude keychain credential read timed out' });
      }, authIo().keychainTimeoutMs());
      if (authIo().unrefTimers !== false) {
        timeout.unref?.();
      }

      try {
        child = authIo().spawn('security', [
          'find-generic-password',
          '-s',
          'Claude Code-credentials',
          '-w',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        finish({
          kind: 'inconclusive',
          error: error instanceof Error
            ? `Failed to spawn Claude keychain lookup: ${error.message}`
            : 'Failed to spawn Claude keychain lookup',
        });
        return;
      }

      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('error', (error) => {
        finish({
          kind: 'inconclusive',
          error: error instanceof Error
            ? `Claude keychain lookup failed: ${error.message}`
            : 'Claude keychain lookup failed',
        });
      });
      child.on('close', (code) => {
        if (code === KEYCHAIN_ITEM_NOT_FOUND) {
          finish({ kind: 'missing' });
          return;
        }
        if (code !== 0 || !stdout.trim()) {
          if (code !== 0) {
            finish({
              kind: 'inconclusive',
              error: `Claude keychain lookup exited with code ${code}`,
            });
            return;
          }
          finish({ kind: 'missing' });
          return;
        }
        try {
          finish({
            kind: 'found',
            status: this.credentialsFromOAuthRecord(
              JSON.parse(stdout.trim()),
              'Claude CLI is not authenticated. Run claude auth login.',
            ),
          });
        } catch {
          finish({ kind: 'inconclusive', error: 'Claude keychain credentials were not valid JSON' });
        }
      });
    });
  }

  /**
   * Maps a credentials JSON blob (file or keychain) into auth status.
   */
  private credentialsFromOAuthRecord(
    raw: unknown,
    missingCredentialsError: string,
  ): ClaudeCredentialsStatus {
    const creds = readObjectRecord(raw) ?? {};
    const oauth = readObjectRecord(creds.claudeAiOauth) ?? creds;
    const accessToken = readOptionalString(oauth.accessToken);
    const refreshToken = readOptionalString(oauth.refreshToken);
    const email = readOptionalString(creds.email)
      ?? readOptionalString(creds.user)
      ?? readOptionalString(oauth.email)
      ?? null;

    if (!accessToken && !refreshToken) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    }

    const accessExpiresAt = parseExpiryMs(oauth.expiresAt);
    const accessExpired = accessExpiresAt !== null && authIo().now() >= accessExpiresAt;

    // Access token expired but refresh token present: CLI will refresh on use.
    if (accessExpired && !refreshToken) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude login has expired. Run claude auth login again.',
      };
    }

    return {
      authenticated: true,
      email,
      method: 'credentials_file',
    };
  }
}
