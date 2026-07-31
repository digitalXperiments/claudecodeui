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

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

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

let cachedStatus: { at: number; value: ProviderAuthStatus } | null = null;
/** Single-flight: concurrent getStatus calls share one resolve. */
let inFlightStatus: Promise<ProviderAuthStatus> | null = null;

const isCacheFresh = (entry: { at: number; value: ProviderAuthStatus }): boolean => {
  const ttl = entry.value.authenticated
    ? AUTHENTICATED_CACHE_TTL_MS
    : UNAUTHENTICATED_CACHE_TTL_MS;
  return Date.now() - entry.at < ttl;
};

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

export class ClaudeProviderAuth implements IProviderAuth {
  /**
   * Discards the memoised status so an explicit login/logout is reflected at once.
   */
  static invalidateStatusCache(): void {
    cachedStatus = null;
  }

  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
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
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    if (cachedStatus && isCacheFresh(cachedStatus)) {
      return cachedStatus.value;
    }

    if (inFlightStatus) {
      return inFlightStatus;
    }

    inFlightStatus = this.resolveStatus()
      .then((status) => {
        cachedStatus = { at: Date.now(), value: status };
        return status;
      })
      .finally(() => {
        inFlightStatus = null;
      });

    return inFlightStatus;
  }

  private async resolveStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
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
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude auth login or configure ANTHROPIC_API_KEY.';

    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'Auth Token', method: 'api_key' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    // Keychain first on macOS: when present it is current; .credentials.json is
    // often a stale leftover after Claude moved OAuth into the keychain.
    const keychain = await this.readMacOSKeychainCredentials();
    if (keychain) {
      return keychain;
    }

    try {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      return this.credentialsFromOAuthRecord(JSON.parse(content), missingCredentialsError);
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude auth login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude auth login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }

  /**
   * Reads `Claude Code-credentials` from the login keychain when present.
   * Hard-capped timeout so a blocked keychain prompt cannot stall the server.
   * Returns null when missing/unreadable so callers fall through to the file.
   */
  private async readMacOSKeychainCredentials(): Promise<ClaudeCredentialsStatus | null> {
    if (process.platform !== 'darwin') {
      return null;
    }

    return new Promise((resolve) => {
      let done = false;
      let child: ReturnType<typeof spawn> | undefined;
      const finish = (value: ClaudeCredentialsStatus | null) => {
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
        finish(null);
      }, KEYCHAIN_TIMEOUT_MS);
      timeout.unref?.();

      try {
        child = spawn('security', [
          'find-generic-password',
          '-s',
          'Claude Code-credentials',
          '-w',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        finish(null);
        return;
      }

      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code !== 0 || !stdout.trim()) {
          finish(null);
          return;
        }
        try {
          finish(this.credentialsFromOAuthRecord(
            JSON.parse(stdout.trim()),
            'Claude CLI is not authenticated. Run claude auth login.',
          ));
        } catch {
          finish(null);
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
    const accessExpired = accessExpiresAt !== null && Date.now() >= accessExpiresAt;

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
