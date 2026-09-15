import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Ensures `sdkOptions.env` contains necessary environment context (like `USER`)
 * so Claude Agent SDK child processes can use Claude's native credential store.
 *
 * NOTE: When native auth (Keychain, credentials file, or API key) is available,
 * we intentionally do NOT inject static `CLAUDE_CODE_OAUTH_TOKEN`.
 * Claude Code treats `CLAUDE_CODE_OAUTH_TOKEN` as a static session token without
 * a refresh token; injecting it disables Claude's automatic OAuth token refresh
 * loop and causes the session to sign out and fail after ~8 hours when the access
 * token expires.
 *
 * We only inject `CLAUDE_CODE_OAUTH_TOKEN` as a fallback when native auth is unavailable.
 */

const KEYCHAIN_ITEM_NOT_FOUND = 44;
const KEYCHAIN_TIMEOUT_MS = 2_000;
const SERVICE = 'Claude Code-credentials';

type SpawnFn = typeof spawn;

export type ClaudeSpawnAuthEnvIo = {
  spawn: SpawnFn;
  platform: () => NodeJS.Platform;
  homedir: () => string;
  env: () => NodeJS.ProcessEnv;
  readFile: typeof readFile;
  username: () => string | null;
  now: () => number;
  keychainTimeoutMs: () => number;
};

const defaultIo = (): ClaudeSpawnAuthEnvIo => ({
  spawn,
  platform: () => process.platform,
  homedir: () => os.homedir(),
  env: () => process.env,
  readFile,
  username: () => {
    try {
      return os.userInfo().username || null;
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  keychainTimeoutMs: () => KEYCHAIN_TIMEOUT_MS,
});

let ioOverride: Partial<ClaudeSpawnAuthEnvIo> | null = null;

export function setClaudeSpawnAuthEnvIoForTests(next: Partial<ClaudeSpawnAuthEnvIo> | null): void {
  ioOverride = next;
}

const io = (): ClaudeSpawnAuthEnvIo => ({ ...defaultIo(), ...ioOverride });

const readOptionalString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const readObject = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const parseExpiryMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    }
  }
  return null;
};

type TokenCandidate = {
  accessToken: string;
  expiresAtMs: number | null;
};

const pickBestToken = (candidates: TokenCandidate[], now: number): string | null => {
  const live = candidates.filter((c) => c.expiresAtMs === null || c.expiresAtMs > now);
  const pool = live.length > 0 ? live : candidates;
  return pool[0]?.accessToken ?? null;
};

const readKeychainJson = (account: string | undefined): Promise<Record<string, unknown> | null> => {
  const { spawn: spawnFn, platform, keychainTimeoutMs } = io();
  if (platform() !== 'darwin') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let done = false;
    let child: ReturnType<SpawnFn> | undefined;
    const finish = (value: Record<string, unknown> | null) => {
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
    }, keychainTimeoutMs());
    timeout.unref?.();

    const args = ['find-generic-password', '-s', SERVICE];
    if (account) {
      args.push('-a', account);
    }
    args.push('-w');

    try {
      child = spawnFn('security', args, { stdio: ['ignore', 'pipe', 'ignore'] });
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
      if (code === KEYCHAIN_ITEM_NOT_FOUND || code !== 0 || !stdout.trim()) {
        finish(null);
        return;
      }
      try {
        finish(readObject(JSON.parse(stdout.trim())));
      } catch {
        finish(null);
      }
    });
  });
};

const tokenFromRecord = (record: Record<string, unknown> | null): TokenCandidate | null => {
  if (!record) return null;
  const oauth = readObject(record.claudeAiOauth) ?? record;
  const accessToken = readOptionalString(oauth.accessToken) ?? readOptionalString(oauth.access_token);
  if (!accessToken) return null;
  return { accessToken, expiresAtMs: parseExpiryMs(oauth.expiresAt ?? oauth.expires_at) };
};

const readSettingsEnvToken = async (): Promise<string | null> => {
  try {
    const content = await io().readFile(path.join(io().homedir(), '.claude', 'settings.json'), 'utf8');
    const settings = readObject(JSON.parse(content));
    const env = readObject(settings?.env);
    return readOptionalString(env?.CLAUDE_CODE_OAUTH_TOKEN);
  } catch {
    return null;
  }
};

const readCredentialsFileToken = async (): Promise<TokenCandidate | null> => {
  try {
    const content = await io().readFile(path.join(io().homedir(), '.claude', '.credentials.json'), 'utf8');
    return tokenFromRecord(readObject(JSON.parse(content)));
  } catch {
    return null;
  }
};

/**
 * Checks if native Claude CLI authentication is available (via API key,
 * settings.json, macOS Keychain, or ~/.claude/.credentials.json).
 *
 * When native authentication is present, Claude Code manages its own OAuth
 * tokens and runs an automatic background refresh loop with its refresh token.
 * Injecting a static CLAUDE_CODE_OAUTH_TOKEN in that state is harmful:
 * Claude Code disables auto-refresh whenever CLAUDE_CODE_OAUTH_TOKEN is set,
 * causing the session to fail and sign out after ~8 hours when the token expires.
 */
export async function hasNativeClaudeAuth(
  existingEnv: NodeJS.ProcessEnv = io().env(),
): Promise<boolean> {
  if (
    readOptionalString(existingEnv.CLAUDE_CODE_OAUTH_TOKEN) ||
    readOptionalString(existingEnv.ANTHROPIC_API_KEY) ||
    readOptionalString(existingEnv.ANTHROPIC_AUTH_TOKEN)
  ) {
    return true;
  }

  const fromSettings = await readSettingsEnvToken();
  if (fromSettings) {
    return true;
  }

  const username = io().username();
  if (username) {
    const keychainRecord = await readKeychainJson(username);
    const candidate = tokenFromRecord(keychainRecord);
    if (candidate && (candidate.expiresAtMs === null || candidate.expiresAtMs > io().now())) {
      return true;
    }
  }

  const creds = await readCredentialsFileToken();
  if (creds && (creds.expiresAtMs === null || creds.expiresAtMs > io().now())) {
    return true;
  }

  return false;
}

/**
 * Resolves an OAuth access token the Claude CLI subprocess can use.
 * Returns null when the caller already has a token, or none can be read.
 */
export async function resolveClaudeSpawnOAuthToken(
  existingEnv: NodeJS.ProcessEnv = io().env(),
): Promise<string | null> {
  if (readOptionalString(existingEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
    return null;
  }
  if (readOptionalString(existingEnv.ANTHROPIC_API_KEY) || readOptionalString(existingEnv.ANTHROPIC_AUTH_TOKEN)) {
    return null;
  }

  const fromSettings = await readSettingsEnvToken();
  if (fromSettings) {
    return fromSettings;
  }

  const candidates: TokenCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: TokenCandidate | null) => {
    if (!candidate || seen.has(candidate.accessToken)) return;
    seen.add(candidate.accessToken);
    candidates.push(candidate);
  };

  const username = io().username();
  if (username) {
    add(tokenFromRecord(await readKeychainJson(username)));
  }
  if (candidates.length === 0) {
    add(tokenFromRecord(await readKeychainJson('unknown')));
    add(tokenFromRecord(await readKeychainJson(undefined)));
  }
  add(await readCredentialsFileToken());

  return pickBestToken(candidates, io().now());
}

/**
 * Sets up environment for Claude Agent SDK child processes.
 * Ensures `USER` is set so Claude CLI can query macOS Keychain natively.
 * If native credentials (Keychain, credentials file, or explicit API key)
 * are present, avoids setting CLAUDE_CODE_OAUTH_TOKEN so Claude CLI's
 * background OAuth token refresh continues to work.
 * Only injects CLAUDE_CODE_OAUTH_TOKEN as a fallback when native auth is unavailable.
 */
export async function applyClaudeSpawnAuthEnv(sdkOptions: { env?: NodeJS.ProcessEnv }): Promise<void> {
  const env = { ...(sdkOptions.env ?? io().env()) };
  const username = io().username();
  if (username && !env.USER) {
    env.USER = username;
  }

  const nativeAuth = await hasNativeClaudeAuth(env);
  if (!nativeAuth) {
    const token = await resolveClaudeSpawnOAuthToken(env);
    if (token) {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
  }

  sdkOptions.env = env;
}
