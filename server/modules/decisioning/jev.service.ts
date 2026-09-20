/**
 * App-wide Jev decision layer.
 *
 * This module owns the credential, the settings, and the single generic way to
 * ask Jev a bounded question. It knows nothing about Agent Relay, Mission
 * Control, or any other caller — each of those owns its own questions and its
 * own guardrails, and comes here only to make the call.
 *
 * Every failure mode (disabled, unconfigured, timed out, HTTP error, illegal
 * answer) surfaces as `null` or as a decision carrying `error`, so a caller
 * can always fall back to the behavior it had before Jev existed.
 */

import {
  JEV_API_KEY_ENV,
  JEV_DEFAULT_BASE_URL,
  JEV_DEFAULT_MODEL,
  callJev,
} from '@/modules/decisioning/jev-client.js';
import {
  JEV_CAPABILITIES,
  type JevCapability,
  type JevCapabilityMode,
  type JevConnectionTest,
  type JevDecision,
  type JevKeyStatus,
  type JevQuestion,
  type JevResponse,
  type JevSettings,
  type JevSettingsPatch,
} from '@/modules/decisioning/jev.types.js';
import { appConfigDb } from '@/modules/database/index.js';

const SETTINGS_KEY = 'jev.settings';
/**
 * Stored outside the settings JSON so a settings GET can never serialize it,
 * and so clearing the key does not rewrite unrelated settings.
 */
const API_KEY_CONFIG_KEY = 'jev.api_key';
/** Where the key lived while Jev was still an Agent Relay-only feature. */
const LEGACY_API_KEY_CONFIG_KEY = 'agent_relay.jev_api_key';
/** Where the toggles lived over the same period. */
const LEGACY_SETTINGS_KEY = 'agent_relay.settings';

export const JEV_MIN_TIMEOUT_MS = 500;
export const JEV_MAX_TIMEOUT_MS = 20_000;
export const JEV_MIN_CONFIDENCE = 0.5;
export const JEV_MAX_CONFIDENCE = 0.999;

const DEFAULT_SETTINGS: JevSettings = {
  enabled: false,
  model: JEV_DEFAULT_MODEL,
  baseUrl: JEV_DEFAULT_BASE_URL,
  timeoutMs: 4_000,
  confidenceThreshold: 0.85,
  capabilities: {
    relay_permissions: 'off',
    relay_results: 'off',
    browser_page_state: 'off',
  },
  relayMayApprovePermissions: false,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function mode(value: unknown, fallback: JevCapabilityMode): JevCapabilityMode {
  return value === 'off' || value === 'shadow' || value === 'enforcing' ? value : fallback;
}

/** An unknown capability key in stored JSON is dropped, never trusted. */
function normalizeCapabilities(
  source: unknown,
  current: Record<JevCapability, JevCapabilityMode>,
): Record<JevCapability, JevCapabilityMode> {
  const raw = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>;
  const next = {} as Record<JevCapability, JevCapabilityMode>;
  for (const capability of JEV_CAPABILITIES) {
    next[capability] = mode(raw[capability], current[capability] ?? 'off');
  }
  return next;
}

function normalize(source: Partial<JevSettings>, current: JevSettings): JevSettings {
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : current.enabled;
  const capabilities = normalizeCapabilities(source.capabilities, current.capabilities);
  return {
    enabled,
    model: nonEmptyString(source.model, current.model),
    baseUrl: nonEmptyString(source.baseUrl, current.baseUrl),
    timeoutMs: clampInteger(source.timeoutMs, current.timeoutMs, JEV_MIN_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS),
    confidenceThreshold: clampFloat(
      source.confidenceThreshold,
      current.confidenceThreshold,
      JEV_MIN_CONFIDENCE,
      JEV_MAX_CONFIDENCE,
    ),
    capabilities,
    // Approval authority is meaningless unless permission adjudication is
    // actually enforcing, and leaving it set would silently arm on the next
    // mode change. Collapse it here instead of trusting the stored value.
    relayMayApprovePermissions: capabilities.relay_permissions === 'enforcing'
      && (typeof source.relayMayApprovePermissions === 'boolean'
        ? source.relayMayApprovePermissions
        : current.relayMayApprovePermissions),
  };
}

function defaults(): JevSettings {
  return { ...DEFAULT_SETTINGS, capabilities: { ...DEFAULT_SETTINGS.capabilities } };
}

/**
 * Jev shipped first as a set of flat `jev*` booleans on the Agent Relay
 * settings blob. Translate those once, so an install that already configured
 * the sidecar does not silently revert to every capability off.
 *
 * `relay_results` maps to `shadow` rather than `enforcing` because result
 * assessment has never been allowed to act, whatever the old flag said.
 */
function migrateFromAgentRelaySettings(): JevSettings | null {
  const raw = appConfigDb.get(LEGACY_SETTINGS_KEY);
  if (!raw) return null;
  let legacy: Record<string, unknown>;
  try {
    legacy = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof legacy.jevEnabled !== 'boolean') return null;

  const enforcing = legacy.jevEnforcing === true;
  const migrated = normalize(
    {
      enabled: legacy.jevEnabled,
      model: legacy.jevModel as string | undefined,
      baseUrl: legacy.jevBaseUrl as string | undefined,
      timeoutMs: legacy.jevTimeoutMs as number | undefined,
      confidenceThreshold: legacy.jevConfidenceThreshold as number | undefined,
      capabilities: {
        relay_permissions: legacy.jevAdjudicatePermissions === true
          ? (enforcing ? 'enforcing' : 'shadow')
          : 'off',
        relay_results: legacy.jevAdjudicateResults === true ? 'shadow' : 'off',
        browser_page_state: 'off',
      },
      relayMayApprovePermissions: legacy.jevMayApprovePermissions === true,
    },
    defaults(),
  );
  appConfigDb.set(SETTINGS_KEY, JSON.stringify(migrated));
  return migrated;
}

export function readJevSettings(): JevSettings {
  const raw = appConfigDb.get(SETTINGS_KEY);
  if (!raw) return migrateFromAgentRelaySettings() ?? defaults();
  try {
    return normalize(JSON.parse(raw) as Partial<JevSettings>, defaults());
  } catch {
    return defaults();
  }
}

export function updateJevSettings(patch: JevSettingsPatch): JevSettings {
  const next = normalize(patch as Partial<JevSettings>, readJevSettings());
  appConfigDb.set(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** The effective mode of one capability, master switch included. */
export function capabilityMode(settings: JevSettings, capability: JevCapability): JevCapabilityMode {
  if (!settings.enabled) return 'off';
  return settings.capabilities[capability] ?? 'off';
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function storedKey(): string | null {
  const current = appConfigDb.get(API_KEY_CONFIG_KEY)?.trim();
  if (current) return current;
  // One-time read-through for installs that configured the key while Jev was
  // still an Agent Relay setting. Migrated on first access, not on boot.
  const legacy = appConfigDb.get(LEGACY_API_KEY_CONFIG_KEY)?.trim();
  if (legacy) {
    appConfigDb.set(API_KEY_CONFIG_KEY, legacy);
    appConfigDb.set(LEGACY_API_KEY_CONFIG_KEY, '');
    return legacy;
  }
  return null;
}

/** The stored key, falling back to the env var the official SDK also reads. */
function readApiKey(): string | null {
  return storedKey() ?? process.env[JEV_API_KEY_ENV]?.trim() ?? null;
}

function maskKey(key: string): string {
  if (key.length <= 8) return `${'•'.repeat(Math.max(0, key.length - 2))}${key.slice(-2)}`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export const jevCredentials = {
  status(): JevKeyStatus {
    const stored = storedKey();
    if (stored) return { configured: true, source: 'stored', masked: maskKey(stored) };
    const fromEnv = process.env[JEV_API_KEY_ENV]?.trim();
    if (fromEnv) return { configured: true, source: 'env', masked: maskKey(fromEnv) };
    return { configured: false, source: null, masked: null };
  },

  set(apiKey: string): void {
    appConfigDb.set(API_KEY_CONFIG_KEY, apiKey.trim());
  },

  clear(): void {
    appConfigDb.set(API_KEY_CONFIG_KEY, '');
    appConfigDb.set(LEGACY_API_KEY_CONFIG_KEY, '');
  },
};

// ---------------------------------------------------------------------------
// Asking Jev
// ---------------------------------------------------------------------------

function probabilities(response: JevResponse, key: string): Record<string, number> {
  const raw = response.answers?.[key]?.probabilities;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
  }
  return out;
}

function numberAnswer(response: JevResponse, key: string, field: 'confidence' | 'noul'): number {
  const raw = response.answers?.[key]?.[field];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

export type AskJevInput<TVerdict extends string> = {
  capability: JevCapability;
  /** Compact, redacted summary. Never a transcript, file contents, or a key. */
  state: unknown;
  /** The enumerated answers. An answer outside this set is discarded. */
  verdicts: readonly TVerdict[];
  verdictInstructions: string;
  /** Description per verdict, shown to Jev as the choice criteria. */
  verdictCriteria: Record<TVerdict, string>;
  /** Extra yes/no signals the caller wants alongside the verdict. */
  signals?: Record<string, string>;
  /** Upper bound for this one call; never raises the configured timeout. */
  maxTimeoutMs?: number;
  /** Verdict returned when Jev answers illegally or the call fails. */
  fallbackVerdict: TVerdict;
};

/**
 * The single place any CloudCLI module talks to Jev.
 *
 * Returns `null` when Jev must not be consulted at all (master switch off,
 * capability off, no credential) — which every caller reads as "behave exactly
 * as before". A returned decision with a non-null `error` is also a fall-back
 * signal, but carries latency so shadow mode can still measure the attempt.
 */
export async function askJev<TVerdict extends string>(
  settings: JevSettings,
  input: AskJevInput<TVerdict>,
): Promise<JevDecision<TVerdict> | null> {
  if (capabilityMode(settings, input.capability) === 'off') return null;
  const apiKey = readApiKey();
  if (!apiKey) return null;

  const questions: Record<string, JevQuestion> = {
    verdict: {
      type: 'choice',
      instructions: input.verdictInstructions,
      criteria: input.verdictCriteria as Record<string, string>,
    },
  };
  for (const [id, instructions] of Object.entries(input.signals ?? {})) {
    questions[id] = { type: 'noul', instructions };
  }

  const timeoutMs = Math.min(settings.timeoutMs, input.maxTimeoutMs ?? settings.timeoutMs);
  const startedAt = Date.now();
  const failure = (error: string): JevDecision<TVerdict> => ({
    verdict: input.fallbackVerdict,
    confidence: 0,
    probabilities: {},
    signals: Object.fromEntries(Object.keys(input.signals ?? {}).map((id) => [id, 1])),
    latencyMs: Date.now() - startedAt,
    model: settings.model,
    error,
  });

  try {
    const response = await callJev({
      baseUrl: settings.baseUrl,
      apiKey,
      timeoutMs,
      body: {
        model: settings.model,
        state: typeof input.state === 'string' ? input.state : JSON.stringify(input.state),
        questions,
      },
    });
    const choice = response.answers?.verdict?.choice;
    // An answer outside the enumerated set is not an answer. Jev may only ever
    // pick from what the caller defined.
    if (typeof choice !== 'string' || !(input.verdicts as readonly string[]).includes(choice)) {
      return failure('Jev returned no legal verdict.');
    }
    return {
      verdict: choice as TVerdict,
      confidence: numberAnswer(response, 'verdict', 'confidence'),
      probabilities: probabilities(response, 'verdict'),
      signals: Object.fromEntries(
        Object.keys(input.signals ?? {}).map((id) => [id, numberAnswer(response, id, 'noul')]),
      ),
      latencyMs: Date.now() - startedAt,
      model: response.model || settings.model,
      error: null,
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** One trivial question, used by the settings UI to prove the key works. */
export async function testJevConnection(settings: JevSettings): Promise<JevConnectionTest> {
  const apiKey = readApiKey();
  if (!apiKey) {
    return { ok: false, latencyMs: 0, model: null, error: 'No TypeSafe API key is configured.' };
  }
  const startedAt = Date.now();
  try {
    const response = await callJev({
      baseUrl: settings.baseUrl,
      apiKey,
      timeoutMs: Math.max(settings.timeoutMs, 5_000),
      body: {
        model: settings.model,
        state: 'CloudCLI connectivity check.',
        questions: { reachable: { type: 'noul', instructions: 'This message is a connectivity check.' } },
      },
    });
    return { ok: true, latencyMs: Date.now() - startedAt, model: response.model || settings.model, error: null };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
