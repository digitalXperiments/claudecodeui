import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import spawn from 'cross-spawn';

import type { ProviderAuthStatus } from '@/shared/types.js';

import { createCodexAppServer } from '../../codex-app-server.js';

import type { ProviderUsage, UsageWindow, UsageWindowUnit } from './provider-usage.types.js';

export type ProviderUsageAdapterResult = Pick<
  ProviderUsage,
  'planName' | 'primaryWindowId' | 'windows' | 'status' | 'error'
> & {
  /**
   * Set when the payload is a cached snapshot (e.g. the Claude CLI cache) so
   * the service can report when the data was really fetched instead of now.
   */
  fetchedAt?: string | null;
};

export type ProviderUsageAdapterContext = {
  authStatus: ProviderAuthStatus;
};

export type ProviderUsageAdapter = (
  context: ProviderUsageAdapterContext,
) => Promise<ProviderUsageAdapterResult>;

type FetchLike = typeof fetch;

/** One usable Claude login found in a keychain item or the credentials file. */
export type ClaudeCredentialCandidate = {
  source: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
};

type AdapterOptions = {
  fetchImpl?: FetchLike;
  endpoint?: string;
  readCredentials?: () => Promise<Record<string, unknown> | null>;
  readCredentialCandidates?: () => Promise<ClaudeCredentialCandidate[]>;
  readCachedUsage?: () => Promise<Record<string, unknown> | null>;
  readRateLimits?: () => Promise<unknown>;
};

type GrokAdapterOptions = {
  readBilling?: () => Promise<unknown>;
};

type KimiAdapterOptions = {
  fetchImpl?: FetchLike;
  endpoint?: string;
  oauthEndpoint?: string;
  readCredentials?: () => Promise<Record<string, unknown> | null>;
  writeCredentials?: (credentials: Record<string, unknown>) => Promise<void>;
  now?: () => number;
};

type AnyRecord = Record<string, unknown>;

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  kilo: 'Kilo Code',
  grok: 'Grok',
  kimi: 'Kimi',
  qwencode: 'Qwen Code',
  pi: 'Pi',
};

/** macOS Security framework: the keychain item does not exist. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

export const TRANSIENT_CREDENTIAL_ERROR_CODE = 'TRANSIENT_CREDENTIAL';

/**
 * Keychain timeouts, I/O errors, and unreadable credential files. These are
 * not the same as "this auth method has no usage API" — callers should keep
 * last-known quota windows and mark them stale.
 */
export class TransientCredentialError extends Error {
  readonly code = TRANSIENT_CREDENTIAL_ERROR_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'TransientCredentialError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export const isTransientCredentialError = (error: unknown): error is TransientCredentialError => {
  if (error instanceof TransientCredentialError) {
    return true;
  }
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === TRANSIENT_CREDENTIAL_ERROR_CODE,
  );
};

export const providerDisplayName = (providerId: string): string => (
  PROVIDER_NAMES[providerId] || providerId
);

const asRecord = (value: unknown): AnyRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null
);

const isNodeErrorCode = (error: unknown, code: string): boolean => (
  Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code)
);

const readFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const readNonNegativeNumber = (value: unknown): number | null => {
  const parsed = readFiniteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
};

const readString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const readResetAt = (value: unknown): string | null => {
  const stringValue = readString(value);
  if (stringValue) {
    const parsed = Date.parse(stringValue);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  const numericValue = readNonNegativeNumber(value);
  if (numericValue === null) {
    return null;
  }

  // Vendor payloads commonly use epoch seconds while a few use milliseconds.
  const milliseconds = numericValue < 1e12 ? numericValue * 1000 : numericValue;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const clampRatio = (value: number): number => (
  Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000
);

const readRatio = (record: AnyRecord): number | null => {
  const direct = readFiniteNumber(record.remainingRatio ?? record.remaining_ratio);
  if (direct !== null) {
    return clampRatio(direct > 1 ? direct / 100 : direct);
  }

  const remainingPercent = readFiniteNumber(
    record.remainingPercent ?? record.remaining_percent ?? record.percentRemaining,
  );
  if (remainingPercent !== null) {
    return clampRatio(remainingPercent / 100);
  }

  const remaining = readNonNegativeNumber(record.remaining);
  const limit = readNonNegativeNumber(record.limit);
  if (remaining !== null && limit !== null && limit > 0) {
    return clampRatio(remaining / limit);
  }

  return null;
};

const readWindowValues = (
  rawValue: unknown,
  defaults: { id: string; label: string; unit: UsageWindowUnit },
): UsageWindow | null => {
  const record = asRecord(rawValue);
  if (!record) {
    return null;
  }

  const usedPercent = readFiniteNumber(
    record.usedPercent ?? record.used_percent ?? record.used_percentage ?? record.utilization,
  );
  const used = readNonNegativeNumber(record.used);
  const limit = readNonNegativeNumber(record.limit);
  const remaining = readNonNegativeNumber(
    record.remaining ?? record.balance ?? record.creditBalance ?? record.credit_balance,
  );
  const remainingRatio = readRatio(record)
    ?? (usedPercent !== null ? clampRatio(1 - usedPercent / 100) : null)
    ?? (used !== null && limit !== null && limit > 0 ? clampRatio((limit - used) / limit) : null);

  // Percent-only vendor windows must not invent used/limit as N/100 counts.
  const resolvedUsed = used;
  const resolvedLimit = limit;
  const resolvedRemaining = remaining
    ?? (used !== null && limit !== null ? Math.max(0, limit - used) : null)
    ?? (usedPercent !== null ? Math.max(0, 100 - usedPercent) : null);
  const resetValue = record.resetsAt ?? record.resets_at ?? record.resetAt ?? record.reset_at;
  const unitValue = readString(record.unit);
  const unit: UsageWindowUnit = unitValue === 'tokens'
    || unitValue === 'requests'
    || unitValue === 'credits'
    || unitValue === 'percent'
    ? unitValue
    : defaults.unit;

  // A reset timestamp by itself is useful, but a completely empty vendor
  // window is not a real usage value and should not create a fake row.
  if (
    resolvedUsed === null
    && resolvedLimit === null
    && resolvedRemaining === null
    && remainingRatio === null
    && readResetAt(resetValue) === null
  ) {
    return null;
  }

  return {
    id: defaults.id,
    label: defaults.label,
    used: resolvedUsed,
    limit: resolvedLimit,
    remaining: resolvedRemaining,
    remainingRatio,
    resetsAt: readResetAt(resetValue),
    unit,
  };
};

const firstRecord = (record: AnyRecord, keys: string[]): AnyRecord | null => {
  for (const key of keys) {
    const candidate = asRecord(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return null;
};

const readPlanName = (record: AnyRecord): string | null => (
  readString(record.planName)
  ?? readString(record.plan_name)
  ?? readString(record.plan)
  ?? readString(record.planType)
  ?? readString(record.plan_type)
);

export function parseClaudeUsagePayload(payload: unknown): ProviderUsageAdapterResult {
  const payloadRoot = asRecord(payload) ?? {};
  const cached = asRecord(payloadRoot.cachedUsageUtilization) ?? payloadRoot;
  const root = asRecord(cached.utilization) ?? cached;
  const windowsById = new Map<string, UsageWindow>();
  const candidates: Array<{ id: string; label: string; keys: string[] }> = [
    { id: 'five_hour', label: 'Current session', keys: ['five_hour', 'fiveHour', 'session', 'hourly'] },
    { id: 'weekly', label: 'All models', keys: ['seven_day', 'sevenDay', 'weekly', 'week'] },
    { id: 'weekly_opus', label: 'Opus', keys: ['seven_day_opus', 'sevenDayOpus'] },
    { id: 'weekly_sonnet', label: 'Sonnet', keys: ['seven_day_sonnet', 'sevenDaySonnet'] },
  ];

  for (const candidate of candidates) {
    const raw = candidate.keys.map((key) => root[key]).find((value) => value !== undefined);
    const window = readWindowValues(raw, { ...candidate, unit: 'percent' });
    if (window) {
      windowsById.set(window.id, window);
    }
  }

  const limitRows = Array.isArray(root.limits) ? root.limits : [];
  for (const rawLimit of limitRows) {
    const limit = asRecord(rawLimit);
    const kind = readString(limit?.kind)?.toLowerCase() ?? '';
    let descriptor: { id: string; label: string } | null = null;
    if (kind === 'session') {
      descriptor = { id: 'five_hour', label: 'Current session' };
    } else if (kind === 'weekly_all') {
      descriptor = { id: 'weekly', label: 'All models' };
    } else if (kind === 'weekly_scoped') {
      const scope = asRecord(limit?.scope);
      const model = asRecord(scope?.model);
      const modelName = readString(model?.display_name ?? model?.displayName);
      const modelId = readString(model?.id) ?? modelName;
      if (!modelName || !modelId) continue;
      const slug = modelId.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      descriptor = {
        id: ['opus', 'sonnet'].includes(slug) ? `weekly_${slug}` : `weekly_scoped_${slug}`,
        label: modelName,
      };
    }
    if (!limit || !descriptor) continue;

    const window = readWindowValues({
      usedPercent: limit.percent ?? limit.used_percentage ?? limit.utilization,
      resetsAt: limit.resets_at ?? limit.resetsAt,
      unit: 'percent',
    }, { ...descriptor, unit: 'percent' });
    if (window) windowsById.set(window.id, window);
  }

  const windows = [...windowsById.values()];

  const primaryWindowId = readString(root.primaryWindowId ?? root.primary_window_id)
    ?? windows[0]?.id
    ?? null;

  return {
    planName: readPlanName(payloadRoot) ?? readPlanName(cached) ?? readPlanName(root),
    primaryWindowId,
    windows,
    status: windows.length > 0 ? 'ok' : 'unavailable',
    error: windows.length > 0 ? null : 'Usage unavailable',
  };
}

const readDurationSeconds = (record: AnyRecord): number | null => {
  const seconds = readNonNegativeNumber(
    record.limit_window_seconds ?? record.windowDurationSeconds ?? record.window_duration_seconds,
  );
  if (seconds !== null) return seconds;
  const minutes = readNonNegativeNumber(record.windowDurationMins ?? record.window_duration_mins);
  return minutes === null ? null : minutes * 60;
};

const describeUsageWindow = (
  record: AnyRecord,
  fallback: { id: string; label: string },
): { id: string; label: string } => {
  const seconds = readDurationSeconds(record);
  if (seconds === null) return fallback;
  if (Math.abs(seconds - 5 * 60 * 60) < 60) return { id: 'five_hour', label: '5h window' };
  if (Math.abs(seconds - 7 * 24 * 60 * 60) < 60) return { id: 'weekly', label: 'Weekly' };
  if (seconds % (24 * 60 * 60) === 0) {
    const days = seconds / (24 * 60 * 60);
    return { id: `${days}_day`, label: `${days}d window` };
  }
  if (seconds % (60 * 60) === 0) {
    const hours = seconds / (60 * 60);
    return { id: `${hours}_hour`, label: `${hours}h window` };
  }
  return fallback;
};

export function parseCodexUsagePayload(payload: unknown): ProviderUsageAdapterResult {
  const root = asRecord(payload) ?? {};
  const rateLimit = firstRecord(root, ['rate_limit', 'rateLimit', 'rateLimits']) ?? root;
  const windows: UsageWindow[] = [];

  const windowCandidates: Array<{ id: string; label: string; keys: string[] }> = [
    { id: 'five_hour', label: '5h window', keys: ['primary_window', 'primaryWindow', 'primary', 'hourly', 'five_hour'] },
    { id: 'weekly', label: 'Weekly', keys: ['secondary_window', 'secondaryWindow', 'secondary', 'weekly', 'seven_day'] },
  ];

  for (const candidate of windowCandidates) {
    const raw = candidate.keys.map((key) => rateLimit[key]).find((value) => value !== undefined);
    const windowRecord = asRecord(raw);
    if (!windowRecord) {
      continue;
    }
    const usedPercent = readFiniteNumber(
      windowRecord.used_percent ?? windowRecord.usedPercent ?? windowRecord.utilization,
    );
    const normalized = usedPercent === null
      ? windowRecord
      : { ...windowRecord, usedPercent, unit: 'percent' };
    const descriptor = describeUsageWindow(windowRecord, candidate);
    const window = readWindowValues(normalized, { ...descriptor, unit: 'percent' });
    if (window) {
      windows.push(window);
    }
  }

  const credits = firstRecord(root, ['credits', 'credit_balance', 'creditBalance']);
  if (credits) {
    const creditWindow = readWindowValues(credits, {
      id: 'credits',
      label: 'Credits',
      unit: 'credits',
    });
    if (creditWindow) {
      windows.push(creditWindow);
    }
  }

  const primaryWindowId = readString(root.primaryWindowId ?? root.primary_window_id)
    ?? windows[0]?.id
    ?? null;

  return {
    planName: readPlanName(root),
    primaryWindowId,
    windows,
    status: windows.length > 0 ? 'ok' : 'unavailable',
    error: windows.length > 0 ? null : 'Usage unavailable',
  };
}

export function parseGrokBillingPayload(payload: unknown): ProviderUsageAdapterResult {
  const root = asRecord(payload) ?? {};
  const config = asRecord(root.config) ?? root;
  const usedPercent = readFiniteNumber(config.creditUsagePercent ?? config.credit_usage_percent);
  const period = firstRecord(config, ['currentPeriod', 'current_period']);
  if (usedPercent === null && !period) return unavailable('Grok usage is unavailable');

  const periodType = readString(period?.type)?.toLowerCase() ?? '';
  const descriptor = periodType.includes('weekly')
    ? { id: 'weekly', label: 'Weekly' }
    : periodType.includes('daily')
      ? { id: 'daily', label: 'Daily' }
      : { id: 'current_period', label: 'Current period' };
  const window = readWindowValues({
    usedPercent,
    resetsAt: period?.end,
    unit: 'percent',
  }, { ...descriptor, unit: 'percent' });

  return {
    planName: readString(root.subscription_tier ?? root.subscriptionTier) ?? readPlanName(root),
    primaryWindowId: window?.id ?? null,
    windows: window ? [window] : [],
    status: window ? 'ok' : 'unavailable',
    error: window ? null : 'Grok usage is unavailable',
  };
}

const KIMI_CODE_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
const KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';
const KIMI_TOKEN_EXPIRY_SKEW_MS = 30_000;
const KIMI_CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.kimi-code',
  'credentials',
  'kimi-code.json',
);

const kimiUsageWindow = (
  rawValue: unknown,
  defaults: { id: string; label: string; unit: UsageWindowUnit },
): UsageWindow | null => {
  const raw = asRecord(rawValue);
  if (!raw) {
    return null;
  }

  const used = readNonNegativeNumber(raw.used);
  const limit = readNonNegativeNumber(raw.limit);
  const remaining = readNonNegativeNumber(raw.remaining)
    ?? (used !== null && limit !== null ? Math.max(0, limit - used) : null);
  const resetAt = raw.resetTime ?? raw.reset_at ?? raw.resetsAt ?? raw.resets_at;

  return readWindowValues({
    ...raw,
    used,
    limit,
    remaining,
    resetsAt: resetAt,
  }, defaults);
};

const kimiWindowDescriptor = (
  rawValue: unknown,
  fallback: { id: string; label: string },
): { id: string; label: string } => {
  const raw = asRecord(rawValue);
  const window = asRecord(raw?.window);
  let duration = readNonNegativeNumber(window?.duration);
  const timeUnit = readString(window?.timeUnit)?.toLowerCase() ?? '';

  if (duration !== null
    && (timeUnit === 'time_unit_minute' || timeUnit === 'minute')
    && duration >= 60
    && duration % 60 === 0) {
    duration /= 60;
  }

  if (duration !== null) {
    const normalizedUnit = (timeUnit === 'time_unit_minute' || timeUnit === 'minute') && duration >= 1
      ? 'hour'
      : timeUnit.replace(/^time_unit_/, '') || 'window';
    if (normalizedUnit === 'hour' && duration === 5) {
      return { id: 'five_hour', label: '5h window' };
    }
    if (normalizedUnit === 'week' && duration === 1) {
      return { id: 'weekly', label: 'Weekly' };
    }

    return {
      id: `${duration}_${normalizedUnit}`,
      label: `${duration}${normalizedUnit[0] ?? ''} window`,
    };
  }

  return fallback;
};

const uniqueWindowId = (id: string, windows: UsageWindow[]): string => {
  if (!windows.some((window) => window.id === id)) {
    return id;
  }
  let suffix = 2;
  while (windows.some((window) => window.id === `${id}_${suffix}`)) {
    suffix += 1;
  }
  return `${id}_${suffix}`;
};

/** Parse the managed Kimi Code `/usages` response. */
export function parseKimiUsagePayload(payload: unknown): ProviderUsageAdapterResult {
  const root = asRecord(payload) ?? {};
  const windows: UsageWindow[] = [];
  const summary = kimiUsageWindow(root.usage, {
    id: 'weekly',
    label: 'Weekly',
    unit: 'unknown',
  });

  if (summary) {
    windows.push(summary);
  }

  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const rawLimit of limits) {
    const limit = asRecord(rawLimit);
    if (!limit) {
      continue;
    }

    const descriptor = kimiWindowDescriptor(limit, {
      id: 'limit',
      label: readString(limit.name) ?? 'Usage limit',
    });
    const detail = asRecord(limit.detail) ?? limit;
    const window = kimiUsageWindow(detail, { ...descriptor, unit: 'unknown' });
    if (!window) {
      continue;
    }

    const id = uniqueWindowId(window.id, windows);
    windows.push(id === window.id ? window : { ...window, id });
  }

  const primaryWindowId = windows.find((window) => window.id === 'five_hour')?.id
    ?? windows.find((window) => window.id === 'weekly')?.id
    ?? windows[0]?.id
    ?? null;

  return {
    planName: readPlanName(root),
    primaryWindowId,
    windows,
    status: windows.length > 0 ? 'ok' : 'unavailable',
    error: windows.length > 0 ? null : 'Kimi usage is unavailable',
  };
}

const readJsonObject = async (filePath: string): Promise<Record<string, unknown> | null> => {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw new TransientCredentialError(`Failed to read credentials at ${filePath}`, { cause: error });
  }

  try {
    return asRecord(JSON.parse(contents));
  } catch (error) {
    throw new TransientCredentialError(`Invalid credential JSON at ${filePath}`, { cause: error });
  }
};

const readKimiCredentials = async (): Promise<Record<string, unknown> | null> => (
  readJsonObject(KIMI_CREDENTIALS_PATH)
);

/** Persist rotated Kimi OAuth tokens so the next poll does not reuse a spent refresh token. */
const writeKimiCredentials = async (credentials: Record<string, unknown>): Promise<void> => {
  await writeFile(KIMI_CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
};

const readKimiExpiryMs = (record: AnyRecord): number | null => {
  const value = readFiniteNumber(record.expiresAt ?? record.expires_at);
  if (value === null) {
    return null;
  }
  return value < 1e12 ? value * 1000 : value;
};

const readClaudeKeychainCredentials = async (
  account?: string,
): Promise<Record<string, unknown> | null> => {
  if (process.platform !== 'darwin') {
    return null;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const timeout = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // Ignore an already-exited keychain process.
      }
      finishError(new TransientCredentialError('Claude keychain credential read timed out'));
    }, 2_000);
    timeout.unref?.();

    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const args = ['find-generic-password', '-s', 'Claude Code-credentials'];
    if (account) {
      args.push('-a', account);
    }
    args.push('-w');

    try {
      child = spawn('security', args, {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      finishError(new TransientCredentialError('Failed to spawn Claude keychain lookup', { cause: error }));
      return;
    }

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', (error) => {
      finishError(new TransientCredentialError('Claude keychain lookup failed', { cause: error }));
    });
    child.on('close', (code) => {
      if (code === KEYCHAIN_ITEM_NOT_FOUND) {
        finish(null);
        return;
      }
      if (code !== 0) {
        finishError(new TransientCredentialError(`Claude keychain lookup exited with code ${code}`));
        return;
      }
      if (!stdout.trim()) {
        finish(null);
        return;
      }
      try {
        finish(asRecord(JSON.parse(stdout.trim())));
      } catch (error) {
        finishError(new TransientCredentialError('Claude keychain credentials were not valid JSON', { cause: error }));
      }
    });
  });
};

const readOsUsername = (): string | null => {
  try {
    return readString(os.userInfo().username);
  } catch {
    return null;
  }
};

const readClaudeExpiryMs = (record: AnyRecord): number | null => {
  const value = readFiniteNumber(record.expiresAt ?? record.expires_at);
  if (value === null) {
    return null;
  }
  // Vendor payloads occasionally use epoch seconds instead of milliseconds.
  return value < 1e12 ? value * 1000 : value;
};

/**
 * Claude Code keeps one keychain item per account (e.g. the OS username,
 * legacy `unknown`) and `security` without `-a` only returns the first match,
 * which can be an expired login. Collect every store and pick below.
 */
const readClaudeCredentialCandidates = async (): Promise<ClaudeCredentialCandidate[]> => {
  const candidates: ClaudeCredentialCandidate[] = [];
  const seenTokens = new Set<string>();
  let firstTransientError: unknown;

  const addCandidate = (source: string, record: Record<string, unknown> | null): void => {
    if (!record) {
      return;
    }
    const oauth = asRecord(record.claudeAiOauth) ?? record;
    const accessToken = readCredentialString(oauth, ['accessToken', 'access_token']);
    if (!accessToken || seenTokens.has(accessToken)) {
      return;
    }
    seenTokens.add(accessToken);
    candidates.push({
      source,
      accessToken,
      refreshToken: readCredentialString(oauth, ['refreshToken', 'refresh_token']),
      expiresAtMs: readClaudeExpiryMs(oauth),
    });
  };

  const addKeychainCandidate = async (account: string | undefined, source: string): Promise<void> => {
    try {
      addCandidate(source, await readClaudeKeychainCredentials(account));
    } catch (error) {
      // A missing item (exit 44) resolves to null above; anything else is
      // transient and only fatal if no other store yields a credential.
      firstTransientError ??= isTransientCredentialError(error)
        ? error
        : new TransientCredentialError('Claude keychain credential read failed', { cause: error });
    }
  };

  const username = readOsUsername();
  if (username) {
    await addKeychainCandidate(username, `keychain:${username}`);
  }
  await addKeychainCandidate('unknown', 'keychain:unknown');
  await addKeychainCandidate(undefined, 'keychain:first-match');

  try {
    addCandidate(
      'credentials-file',
      await readJsonObject(path.join(os.homedir(), '.claude', '.credentials.json')),
    );
  } catch (error) {
    throw isTransientCredentialError(error)
      ? error
      : new TransientCredentialError('Claude credential file read failed', { cause: error });
  }

  if (candidates.length === 0 && firstTransientError) {
    throw firstTransientError;
  }

  return candidates;
};

const readCodexCredentials = async (): Promise<Record<string, unknown> | null> => (
  readJsonObject(path.join(os.homedir(), '.codex', 'auth.json'))
);

const readJwtPayload = (token: string | null): AnyRecord | null => {
  if (!token) return null;
  const encoded = token.split('.')[1];
  if (!encoded) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
};

const readCodexPlanName = (credentials: AnyRecord | null): string | null => {
  const tokens = asRecord(credentials?.tokens);
  const idToken = readCredentialString(tokens, ['id_token', 'idToken']);
  const payload = readJwtPayload(idToken);
  const authClaims = asRecord(payload?.['https://api.openai.com/auth']);
  return readString(authClaims?.chatgpt_plan_type ?? authClaims?.chatgptPlanType)
    ?? readPlanName(payload ?? {});
};

const readClaudeCachedUsage = async (): Promise<Record<string, unknown> | null> => {
  const config = await readJsonObject(path.join(os.homedir(), '.claude.json'));
  return asRecord(config?.cachedUsageUtilization);
};

const readCredentialString = (record: AnyRecord | null, keys: string[]): string | null => {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
};

const unavailable = (error: string): ProviderUsageAdapterResult => ({
  planName: null,
  primaryWindowId: null,
  windows: [],
  status: 'unavailable',
  error,
});

const requestJson = async (
  endpoint: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<unknown> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  timeout.unref?.();
  try {
    const response = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`Usage endpoint returned HTTP ${response.status}`) as Error & {
        status?: number;
        retryAfter?: string | null;
      };
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const readAccessToken = async (
  readCredentials: () => Promise<Record<string, unknown> | null>,
  keys: string[],
): Promise<{ credentials: Record<string, unknown> | null; accessToken: string | null }> => {
  try {
    const credentials = await readCredentials();
    return {
      credentials,
      accessToken: readCredentialString(credentials, keys),
    };
  } catch (error) {
    if (isTransientCredentialError(error)) {
      throw error;
    }
    throw new TransientCredentialError('Provider credential read failed', { cause: error });
  }
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const readCodexRateLimits = async (): Promise<unknown> => {
  const rpc = createCodexAppServer({ cwd: process.cwd(), env: process.env });
  try {
    await withTimeout(rpc.request('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }), 12_000, 'Codex app-server initialization timed out');
    rpc.notify('initialized');
    return await withTimeout(
      rpc.request('account/rateLimits/read'),
      12_000,
      'Codex rate-limit request timed out',
    );
  } finally {
    rpc.close();
  }
};

const readGrokBilling = async (): Promise<unknown> => {
  const child = spawn('grok', ['agent', 'stdio'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout! });
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 1;
  const rejectPending = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on('error', (error) => rejectPending(error));
  child.on('exit', () => rejectPending(new Error('Grok ACP process exited')));
  child.stderr?.resume();
  lines.on('line', (line) => {
    let message: AnyRecord | null = null;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    const id = readFiniteNumber(message.id);
    if (id === null || message.method) return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    const error = asRecord(message.error);
    if (error) waiter.reject(new Error(readString(error.message) ?? 'Grok ACP request failed'));
    else waiter.resolve(message.result);
  });
  const request = (method: string, params: AnyRecord = {}): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  try {
    await withTimeout(request('initialize', {
      protocolVersion: '1',
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'cloudcli', version: '1' },
    }), 15_000, 'Grok ACP initialization timed out');
    child.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    })}\n`);
    return await withTimeout(request('_x.ai/billing'), 15_000, 'Grok billing request timed out');
  } finally {
    lines.close();
    rejectPending(new Error('Grok billing connection closed'));
    child.stdin?.end();
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
};

const readClaudeFallback = async (
  readCachedUsage: () => Promise<Record<string, unknown> | null>,
  cause: string,
): Promise<ProviderUsageAdapterResult | null> => {
  const cached = await readCachedUsage();
  if (!cached) return null;
  const parsed = parseClaudeUsagePayload(cached);
  if (parsed.windows.length === 0) return null;
  const fetchedAtMs = readNonNegativeNumber(cached.fetchedAtMs);
  return {
    ...parsed,
    status: 'stale',
    error: `Last known Claude CLI usage · ${cause}`,
    fetchedAt: fetchedAtMs !== null ? new Date(fetchedAtMs).toISOString() : null,
  };
};

const CLAUDE_TOKEN_EXPIRY_SKEW_MS = 30_000;
const CLAUDE_EXPIRED_LOGIN_CAUSE = 'stored Claude login expired — run claude to re-authenticate';
const CLAUDE_DEFAULT_RATE_LIMIT_SECONDS = 15 * 60;
const CLAUDE_REJECTED_GATE_SECONDS = 30 * 60;

/**
 * Module-scoped on purpose: it must survive the service's 5-minute snapshot
 * cache and also throttle `?fresh=1` manual refreshes, which bypass that TTL.
 */
const claudeLiveGate: { notBeforeMs: number; reason: string | null } = {
  notBeforeMs: 0,
  reason: null,
};

/** Exported for tests. */
export const resetClaudeLiveGate = (): void => {
  claudeLiveGate.notBeforeMs = 0;
  claudeLiveGate.reason = null;
};

const readHttpErrorStatus = (error: unknown): number | null => (
  error && typeof error === 'object' && 'status' in error
    ? readFiniteNumber((error as { status?: unknown }).status)
    : null
);

const parseRetryAfterSeconds = (value: unknown): number | null => {
  const raw = readString(value);
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, Math.ceil((dateMs - Date.now()) / 1000)) : null;
};

/** Unknown expiry counts as usable; among usable, the latest expiry wins. */
const pickFreshestClaudeCredential = (
  candidates: ClaudeCredentialCandidate[],
  nowMs: number,
): ClaudeCredentialCandidate | null => {
  let best: ClaudeCredentialCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.expiresAtMs !== null && candidate.expiresAtMs <= nowMs + CLAUDE_TOKEN_EXPIRY_SKEW_MS) {
      continue;
    }
    const candidateExpiry = candidate.expiresAtMs ?? Number.NEGATIVE_INFINITY;
    const bestExpiry = best?.expiresAtMs ?? Number.NEGATIVE_INFINITY;
    if (!best || candidateExpiry > bestExpiry) {
      best = candidate;
    }
  }
  return best;
};

const claudeGateRetryCause = (notBeforeMs: number, nowMs: number): string => {
  const retryMinutes = Math.max(1, Math.ceil((notBeforeMs - nowMs) / 60_000));
  return `live usage ${claudeLiveGate.reason ?? 'unavailable'}, retrying in ${retryMinutes}m`;
};

export function createClaudeUsageAdapter(options: AdapterOptions = {}): ProviderUsageAdapter {
  const readCredentialCandidates = async (): Promise<ClaudeCredentialCandidate[]> => {
    try {
      if (options.readCredentialCandidates) {
        return await options.readCredentialCandidates();
      }
      if (options.readCredentials) {
        const { credentials, accessToken } = await readAccessToken(
          options.readCredentials,
          ['accessToken', 'access_token'],
        );
        if (!credentials || !accessToken) {
          return [];
        }
        return [{
          source: 'readCredentials',
          accessToken,
          refreshToken: readCredentialString(credentials, ['refreshToken', 'refresh_token']),
          expiresAtMs: readClaudeExpiryMs(credentials),
        }];
      }
      return await readClaudeCredentialCandidates();
    } catch (error) {
      if (isTransientCredentialError(error)) {
        throw error;
      }
      throw new TransientCredentialError('Provider credential read failed', { cause: error });
    }
  };

  return async ({ authStatus }) => {
    if (authStatus.method === 'api_key') {
      return unavailable('Usage unavailable for API-key authentication');
    }

    const readCachedUsage = options.readCachedUsage ?? readClaudeCachedUsage;
    const candidates = await readCredentialCandidates();
    if (candidates.length === 0) {
      return await readClaudeFallback(readCachedUsage, 'live usage credentials are unavailable')
        ?? unavailable('Claude usage credentials are unavailable');
    }

    const nowMs = Date.now();
    const credential = pickFreshestClaudeCredential(candidates, nowMs);
    if (!credential) {
      // Every stored login is expired — a live call only burns rate limit.
      return await readClaudeFallback(readCachedUsage, CLAUDE_EXPIRED_LOGIN_CAUSE)
        ?? unavailable(CLAUDE_EXPIRED_LOGIN_CAUSE);
    }

    if (nowMs < claudeLiveGate.notBeforeMs) {
      const cause = claudeGateRetryCause(claudeLiveGate.notBeforeMs, nowMs);
      return await readClaudeFallback(readCachedUsage, cause) ?? unavailable(`Claude ${cause}`);
    }

    try {
      const payload = await requestJson(
        options.endpoint ?? process.env.CLAUDE_USAGE_ENDPOINT ?? 'https://api.anthropic.com/api/oauth/usage',
        {
          Authorization: `Bearer ${credential.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
        options.fetchImpl ?? fetch,
      );
      resetClaudeLiveGate();
      return parseClaudeUsagePayload(payload);
    } catch (error) {
      const status = readHttpErrorStatus(error);
      if (status === 429 || status === 401 || status === 403) {
        const gateSeconds = status === 429
          ? parseRetryAfterSeconds((error as { retryAfter?: unknown }).retryAfter)
            ?? CLAUDE_DEFAULT_RATE_LIMIT_SECONDS
          : CLAUDE_REJECTED_GATE_SECONDS;
        claudeLiveGate.notBeforeMs = Date.now() + gateSeconds * 1000;
        claudeLiveGate.reason = status === 429
          ? 'rate-limited (HTTP 429)'
          : `rejected (HTTP ${status})`;
        const cause = claudeGateRetryCause(claudeLiveGate.notBeforeMs, Date.now());
        const gatedFallback = await readClaudeFallback(readCachedUsage, cause);
        if (gatedFallback) return gatedFallback;
      } else {
        const reason = error instanceof Error ? error.message : 'live usage request failed';
        const fallback = await readClaudeFallback(readCachedUsage, reason);
        if (fallback) return fallback;
      }
      throw error instanceof Error ? error : new Error('Claude usage request failed');
    }
  };
}

export function createCodexUsageAdapter(options: AdapterOptions = {}): ProviderUsageAdapter {
  return async () => {
    if (!options.fetchImpl && !options.endpoint && !options.readCredentials) {
      try {
        const parsed = parseCodexUsagePayload(await (options.readRateLimits ?? readCodexRateLimits)());
        if (parsed.planName) return parsed;
        try {
          return {
            ...parsed,
            planName: readCodexPlanName(await readCodexCredentials()),
          };
        } catch {
          return parsed;
        }
      } catch (error) {
        throw error instanceof Error ? error : new Error('Codex rate-limit request failed');
      }
    }

    let credentials: Record<string, unknown> | null;
    try {
      credentials = await (options.readCredentials ?? readCodexCredentials)();
    } catch (error) {
      if (isTransientCredentialError(error)) {
        throw error;
      }
      throw new TransientCredentialError('Codex credential read failed', { cause: error });
    }
    const tokens = asRecord(credentials?.tokens);
    const resolvedToken = readCredentialString(tokens, ['access_token', 'accessToken'])
      ?? readCredentialString(credentials, ['access_token', 'accessToken']);
    if (!resolvedToken) {
      return unavailable('Codex usage credentials are unavailable');
    }

    const accountId = readCredentialString(tokens, ['account_id', 'accountId'])
      ?? readCredentialString(credentials, ['account_id', 'accountId']);

    try {
      return parseCodexUsagePayload(await requestJson(
        options.endpoint ?? process.env.CODEX_USAGE_ENDPOINT ?? 'https://chatgpt.com/backend-api/wham/usage',
        accountId
          ? { Authorization: `Bearer ${resolvedToken}`, 'ChatGPT-Account-ID': accountId }
          : { Authorization: `Bearer ${resolvedToken}` },
        options.fetchImpl ?? fetch,
      ));
    } catch (error) {
      throw error instanceof Error ? error : new Error('Codex usage request failed');
    }
  };
}

const refreshKimiAccessToken = async ({
  credentials,
  refreshToken,
  fetchImpl,
  endpoint,
  nowMs,
}: {
  credentials: Record<string, unknown>;
  refreshToken: string;
  fetchImpl: FetchLike;
  endpoint: string;
  nowMs: number;
}): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  timeout.unref?.();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: KIMI_CODE_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  let payload: AnyRecord = {};
  try {
    payload = asRecord(await response.json()) ?? {};
  } catch {
    // The status below is more useful than a second JSON parsing error.
  }

  if (!response.ok) {
    const detail = readString(payload.error_description)
      ?? readString(payload.message)
      ?? readString(payload.detail)
      ?? readString(payload.error);
    const error = new Error(
      `Kimi OAuth refresh returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const accessToken = readCredentialString(payload, ['access_token', 'accessToken']);
  if (!accessToken) {
    throw new Error('Kimi OAuth refresh response did not include an access token');
  }

  const refreshTokenFromResponse = readCredentialString(payload, ['refresh_token', 'refreshToken']);
  const expiresIn = readFiniteNumber(payload.expires_in ?? payload.expiresIn);
  const expiresAt = readFiniteNumber(payload.expires_at ?? payload.expiresAt)
    ?? (expiresIn !== null ? Math.floor(nowMs / 1000) + expiresIn : null);

  return {
    ...credentials,
    access_token: accessToken,
    refresh_token: refreshTokenFromResponse ?? refreshToken,
    ...(expiresAt !== null ? { expires_at: expiresAt } : {}),
    ...(expiresIn !== null ? { expires_in: expiresIn } : {}),
  };
};

export function createKimiUsageAdapter(options: KimiAdapterOptions = {}): ProviderUsageAdapter {
  return async () => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const credentials = await (options.readCredentials ?? readKimiCredentials)();
    if (!credentials) {
      return unavailable('Kimi usage credentials are unavailable');
    }

    let currentCredentials = credentials;
    let accessToken = readCredentialString(currentCredentials, ['access_token', 'accessToken']);
    const refreshToken = readCredentialString(currentCredentials, ['refresh_token', 'refreshToken']);
    const nowMs = options.now?.() ?? Date.now();
    let refreshed = false;

    const refresh = async (): Promise<boolean> => {
      if (!refreshToken) {
        return false;
      }

      currentCredentials = await refreshKimiAccessToken({
        credentials: currentCredentials,
        refreshToken,
        fetchImpl,
        endpoint: options.oauthEndpoint
          ?? `${(process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? KIMI_CODE_OAUTH_HOST).replace(/\/+$/, '')}/api/oauth/token`,
        nowMs,
      });
      accessToken = readCredentialString(currentCredentials, ['access_token', 'accessToken']);
      if (!accessToken) {
        return false;
      }

      refreshed = true;
      try {
        await (options.writeCredentials ?? writeKimiCredentials)(currentCredentials);
      } catch {
        // The refreshed token is still valid for this request. A later poll
        // can retry persistence without hiding otherwise usable quota data.
      }
      return true;
    };

    const expiresAtMs = readKimiExpiryMs(currentCredentials);
    if (!accessToken || (expiresAtMs !== null && expiresAtMs <= nowMs + KIMI_TOKEN_EXPIRY_SKEW_MS)) {
      if (!(await refresh())) {
        return unavailable('Kimi usage credentials are unavailable');
      }
    }

    const readUsage = async (): Promise<ProviderUsageAdapterResult> => (
      parseKimiUsagePayload(await requestJson(
        options.endpoint
          ?? `${(process.env.KIMI_CODE_BASE_URL ?? KIMI_CODE_BASE_URL).replace(/\/+$/, '')}/usages`,
        { Authorization: `Bearer ${accessToken}` },
        fetchImpl,
      ))
    );

    try {
      return await readUsage();
    } catch (error) {
      // A token can be rejected before its local expiry (for example after a
      // refresh-token rotation in another Kimi process). Refresh once and
      // retry the provider-native usage endpoint.
      if (readHttpErrorStatus(error) === 401 && !refreshed && await refresh()) {
        return await readUsage();
      }
      throw error instanceof Error ? error : new Error('Kimi usage request failed');
    }
  };
}

export function createGrokUsageAdapter(options: GrokAdapterOptions = {}): ProviderUsageAdapter {
  return async () => {
    try {
      return parseGrokBillingPayload(await (options.readBilling ?? readGrokBilling)());
    } catch (error) {
      throw error instanceof Error ? error : new Error('Grok billing request failed');
    }
  };
}

export const grokUsageAdapter: ProviderUsageAdapter = createGrokUsageAdapter();

/** Providers without a real quota adapter still appear as signed-in/N/A rows. */
export const unavailableUsageAdapter = (providerId: string): ProviderUsageAdapter => (
  async () => unavailable(`Usage unavailable for ${providerDisplayName(providerId)}`)
);
