import { randomBytes, timingSafeEqual } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

import {
  agentRelayPermissionBroker,
  configureRelayPermissionObserver,
} from '@/modules/agent-relay/agent-relay-permission.service.js';
import { agentRelayDb } from '@/modules/agent-relay/agent-relay.repository.js';
import {
  AGENT_RELAY_PROVIDERS,
  AGENT_RELAY_TERMINAL_STATUSES,
  type AgentRelayApproval,
  type AgentRelayApprovalPolicy,
  type AgentRelayBatchInput,
  type AgentRelayJob,
  type AgentRelayJobSummary,
  type AgentRelayMode,
  type AgentRelayResult,
  type AgentRelayScope,
  type AgentRelaySettings,
  type AgentRelaySettingsPatch,
  type AgentRelayWorkerProfile,
  type AgentRelayStructuredResult,
} from '@/modules/agent-relay/agent-relay.types.js';
import { normalizeDeclaredSchema, validateJsonSchema } from '@/shared/json-schema-lite.js';
import { appConfigDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  globalSkillsService,
  mcpCatalogService,
  providerAuthService,
  providerModelsService,
  sessionsService,
} from '@/modules/providers/index.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  startProviderRun,
  broadcastSystemEvent,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import { expandMcpSelectionsToTools } from '@/shared/mcp-tool-expand.js';
import { newRelayBatchId, newRelayJobId } from '@/shared/ids.js';
import { TERMINAL_RUN_STATUSES, type RunStatus } from '@/shared/run-events.js';
import type { AnyRecord, LLMProvider, NormalizedMessage, ProviderModelsDefinition } from '@/shared/types.js';
import { enabledRegistryModelIdsForProvider } from '@/modules/swarm/index.js';
import { notifyAgentRelayTerminal } from '@/modules/agent-relay/lead-session-wake.service.js';
import { AppError } from '@/shared/utils.js';
import { findAppRoot, findServerRoot, getModuleDir } from '@/utils/runtime-paths.js';

const SETTINGS_KEY = 'agent_relay.settings';
const MCP_TOKEN_KEY = 'agent_relay.mcp_token';
const OPENCODE_LEAD_MIGRATION_KEY = 'agent_relay.opencode_lead_v1';
const MCP_SERVER_NAME = 'cloudcli-agent-relay';
const SKILL_DIRECTORY_NAME = 'delegate-agent-work';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TASKS_PER_BATCH = 20;
const MAX_TASK_CHARS = 12_000;
const MAX_RESULT_CHARS = 100_000;
const MAX_LABEL_CHARS = 80;
const MAX_RETRIES = 2;
const MAX_CONCURRENCY = 16;
/** Compact summary caps so fleet-wide status reads stay context-cheap. */
const SUMMARY_PREVIEW_CHARS = 2_400;
const STRUCTURED_OUTPUT_PREVIEW_CHARS = 16_000;
const LIVE_OUTPUT_TAIL_CHARS = 4_000;
const DEP_CONTEXT_CHARS = 4_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 3 * 60 * 1000;
const MIN_APPROVAL_TIMEOUT_MS = 15_000;
const MAX_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ALLOWED_MODELS_PER_PROVIDER = 200;
/** Finished jobs older than this are deleted on boot. */
export const AGENT_RELAY_RETENTION_DAYS = 14;

const DEFAULT_SETTINGS: AgentRelaySettings = {
  enabled: false,
  leadProviders: ['claude', 'codex', 'opencode'],
  workerProviders: [...AGENT_RELAY_PROVIDERS],
  allowedWorkerModels: {},
  workerProfiles: {},
  maxConcurrency: 4,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  defaultMode: 'read_only',
  defaultApprovalPolicy: 'auto',
  installSkill: true,
  approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
};

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};
let runtimeAbortFns: Partial<Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>> = {};
/**
 * Mid-run injection hooks (e.g. Claude's open stdin), keyed by provider. Only
 * providers that expose one can receive a lead follow-up while their worker
 * is still live; every other provider falls back to a queued next-turn
 * prompt (see `injectMidSessionFollowUp`).
 */
let runtimeInjectFns: Partial<Record<LLMProvider, (command: string, options: AnyRecord) => Promise<boolean>>> = {};
const activeJobs = new Set<string>();
let draining = false;
let drainAgain = false;
let workerCursor = 0;
const leadLastScheduled = new Map<string, number>();
let leadScheduleSequence = 0;

/**
 * Tail of each running worker's streamed prose, kept in memory only. The run
 * spine deliberately does not persist stream text, so this is what lets
 * `relay_peek` show *what the worker is saying*, not just which tools it used.
 */
const liveOutputTails = new Map<string, { text: string; updatedAt: number }>();

function appendLiveOutput(relayId: string, chunk: string): void {
  const existing = liveOutputTails.get(relayId);
  const text = ((existing?.text ?? '') + chunk).slice(-LIVE_OUTPUT_TAIL_CHARS);
  liveOutputTails.set(relayId, { text, updatedAt: Date.now() });
}

/** Providers whose `plan` mode is a real read-only/tool-restricting seat. */
const READ_ONLY_PLAN_PROVIDERS = new Set<LLMProvider>([
  'claude',
  'codex',
  'opencode',
  'kilo',
  'cline',
  'grok',
  'kimi',
  'qwencode',
  'pi',
  'omp',
]);

/**
 * Providers whose runtimes honor a per-task CloudCLI MCP catalog grant
 * (`options.mcpServers`). The rest run on their native MCP config, so a
 * lead's `mcpServers` selection is advisory there — surfaced in
 * capabilities so leads can route MCP-dependent tasks correctly.
 */
const MCP_GRANT_PROVIDERS = new Set<LLMProvider>([
  'claude',
  'grok',
  'opencode',
  'kilo',
  'cline',
  'qwencode',
  'antigravity',
]);

/**
 * Permission mode for a relay worker. Isolated writers must still emit
 * permission_request events so the envelope broker can allow in-worktree
 * writes and escalate the rest. `bypassPermissions` skips that path (and
 * Codex maps it to danger-full-access).
 */
export function relayPermissionMode(job: Pick<AgentRelayJob, 'mode' | 'provider'>): string {
  if (job.mode === 'read_only') {
    return READ_ONLY_PLAN_PROVIDERS.has(job.provider) ? 'plan' : 'default';
  }
  return 'default';
}

export function sanitizeWorkerMcpServers(names: string[]): string[] {
  return [...new Set(names.filter((name) => {
    const trimmed = name.trim();
    return trimmed && trimmed !== MCP_SERVER_NAME && trimmed !== 'cloudcli-agent-relay';
  }))];
}

export function providerSupportsReadOnlyRelay(provider: LLMProvider): boolean {
  return READ_ONLY_PLAN_PROVIDERS.has(provider);
}

/** Catalog effort ids for a model, or null when the catalog does not constrain effort. */
export function catalogEffortValuesForModel(
  catalog: ProviderModelsDefinition | null | undefined,
  model: string | null,
): string[] | null {
  if (!catalog || !model || !Array.isArray(catalog.OPTIONS)) return null;
  const option = catalog.OPTIONS.find((candidate) => candidate.value === model)
    ?? catalog.OPTIONS.find((candidate) => candidate.resolvedModel === model)
    ?? null;
  const values = option?.effort?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const ids = [...new Set(
    values
      .map((entry) => (typeof entry?.value === 'string' ? entry.value.trim() : ''))
      .filter(Boolean),
  )];
  return ids.length > 0 ? ids : null;
}

export function resolveRelayEffort(
  requested: unknown,
  catalog: ProviderModelsDefinition | null | undefined,
  model: string | null,
): string | null {
  const trimmed = typeof requested === 'string' ? requested.trim() : '';
  if (!trimmed || trimmed === 'default') return null;
  const allowed = catalogEffortValuesForModel(catalog, model);
  if (allowed && !allowed.includes(trimmed)) {
    throw new AppError(
      `Effort "${trimmed}" is not in the catalog for model "${model}". Allowed: ${allowed.join(', ')}.`,
      { code: 'RELAY_EFFORT_NOT_IN_CATALOG', statusCode: 400 },
    );
  }
  return trimmed;
}

export function providerHonorsRelayMcpGrants(provider: LLMProvider): boolean {
  return MCP_GRANT_PROVIDERS.has(provider);
}

type RegistryIdsFn = (provider: string) => string[] | null;

let registryIdsLookup: RegistryIdsFn | null = null;

/** Test seam: isolate allowlist intersection from the live Model profiles DB. */
export function configureRelayModelRegistry(fn: RegistryIdsFn | null): void {
  registryIdsLookup = fn;
}

function registryEnabledIds(provider: LLMProvider): string[] | null {
  try {
    return (registryIdsLookup ?? enabledRegistryModelIdsForProvider)(provider);
  } catch {
    return null;
  }
}

function intersectModelIds(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((id) => rightSet.has(id));
}

/**
 * Allowlisted worker model ids for one provider, or `null` when that provider
 * is unrestricted (legacy / "all models").
 *
 * When Model profiles has enabled rows for the provider, the catalog and
 * dispatch lists are intersected with those ids. An explicit
 * `allowedWorkerModels` entry is intersected as well. A missing key stays
 * unrestricted only when the registry has no enabled models for the provider.
 */
export function allowedWorkerModelsFor(
  settings: Pick<AgentRelaySettings, 'allowedWorkerModels'>,
  provider: LLMProvider,
): string[] | null {
  const list = settings.allowedWorkerModels?.[provider];
  const registryIds = registryEnabledIds(provider);
  if (list === undefined) {
    return registryIds === null ? null : [...registryIds];
  }
  if (registryIds === null) return [...list];
  return intersectModelIds(list, registryIds);
}

function catalogModelIsAllowed(
  allowed: string[] | null,
  model: { value: string; resolvedModel?: string | null },
): boolean {
  if (allowed === null) return true;
  if (allowed.includes(model.value)) return true;
  const resolved = typeof model.resolvedModel === 'string' ? model.resolvedModel.trim() : '';
  return Boolean(resolved && allowed.includes(resolved));
}

/** Near-miss catalog ids listed back to a lead that asked for a bad model. */
const MAX_MODEL_SUGGESTIONS = 5;

function catalogModelIds(catalog: ProviderModelsDefinition | null | undefined): string[] {
  if (!catalog || !Array.isArray(catalog.OPTIONS)) return [];
  const ids: string[] = [];
  for (const option of catalog.OPTIONS) {
    const value = typeof option?.value === 'string' ? option.value.trim() : '';
    if (value && !ids.includes(value)) ids.push(value);
    const resolved = typeof option?.resolvedModel === 'string' ? option.resolvedModel.trim() : '';
    if (resolved && !ids.includes(resolved)) ids.push(resolved);
  }
  return ids;
}

/** Trailing `count` `/`-separated segments of a catalog id, or '' if shorter. */
function idSuffix(id: string, count: number): string {
  const segments = id.split('/');
  return segments.length > count ? segments.slice(-count).join('/') : '';
}

function lastSegment(id: string): string {
  const segments = id.split('/');
  return segments[segments.length - 1] ?? id;
}

function modelSuggestions(requested: string, candidates: string[]): string[] {
  const tail = lastSegment(requested).toLowerCase();
  const near = candidates.filter((candidate) => candidate.toLowerCase().includes(tail));
  return (near.length > 0 ? near : candidates).slice(0, MAX_MODEL_SUGGESTIONS);
}

// NVIDIA retired its hosted `deepseek-v4-flash` catalog entry (HTTP 410 as of
// 2026-08-07). OpenCode now serves the same weights through its own
// `opencode-go` provider, so requests for the dead NVIDIA id are redirected
// there when it is live in the catalog, ahead of the legacy NVIDIA remap.
const RETIRED_NVIDIA_DEEPSEEK_V4_FLASH_IDS = new Set([
  'nvidia/deepseek-v4-flash',
  'nvidia/deepseek-ai/deepseek-v4-flash',
]);
const OPENCODE_GO_DEEPSEEK_V4_FLASH_ID = 'opencode-go/deepseek-v4-flash';

/**
 * Map a requested model id onto the provider catalog. Leads routinely abbreviate
 * multi-segment ids — OpenCode's NVIDIA catalog is `nvidia/<vendor>/<model>` and
 * a lead asking for `nvidia/deepseek-v4-flash` used to be passed through
 * unvalidated, only for ACP to reject it as "model not found". Unambiguous
 * suffix matches are repaired to the full catalog id (the vendor namespace is
 * never stripped); anything still unmatched fails fast with suggestions.
 */
export function resolveCatalogModelId(
  provider: LLMProvider,
  requested: string,
  catalog: ProviderModelsDefinition | null | undefined,
): { model: string; repaired: boolean } {
  const candidates = catalogModelIds(catalog);
  // Providers whose catalog is empty (offline/unlisted) keep the legacy
  // pass-through — there is nothing to validate against.
  if (candidates.length === 0) return { model: requested, repaired: false };
  if (candidates.includes(requested)) return { model: requested, repaired: false };

  if (
    RETIRED_NVIDIA_DEEPSEEK_V4_FLASH_IDS.has(requested)
    && candidates.includes(OPENCODE_GO_DEEPSEEK_V4_FLASH_ID)
  ) {
    return { model: OPENCODE_GO_DEEPSEEK_V4_FLASH_ID, repaired: true };
  }

  const requestedHead = requested.split('/')[0] ?? requested;
  const requestedTail = lastSegment(requested);
  const tiers: Array<(candidate: string) => boolean> = [
    // The request is the tail of a longer catalog id (`deepseek-v4-flash`,
    // `deepseek-ai/deepseek-v4-flash` → `nvidia/deepseek-ai/…`).
    (candidate) => requested === idSuffix(candidate, 1) || requested === idSuffix(candidate, 2),
    // The request kept the provider namespace but dropped a middle vendor
    // segment (`nvidia/deepseek-v4-flash` → `nvidia/deepseek-ai/…`).
    (candidate) => requested.includes('/')
      && candidate.split('/')[0] === requestedHead
      && lastSegment(candidate) === requestedTail,
    // The request omitted a suffix like `-flash` or `-preview` on the model name
    // (e.g. `gemini-3.7` → `gemini-3.7-flash`, `gemini-3.8` → `gemini-3.8-flash`).
    (candidate) => {
      const candidateTail = lastSegment(candidate);
      return candidateTail === `${requestedTail}-flash`
        || candidateTail === `${requestedTail}-preview`
        || (requested.includes('/') && candidate.split('/')[0] === requestedHead && (
          candidateTail === `${requestedTail}-flash` || candidateTail === `${requestedTail}-preview`
        ));
    },
  ];
  for (const matches of tiers) {
    const hits = candidates.filter(matches);
    if (hits.length === 1) return { model: hits[0]!, repaired: true };
    if (hits.length > 1) {
      throw new AppError(
        `Model "${requested}" is ambiguous in the ${provider} catalog. Matches: ${hits.slice(0, MAX_MODEL_SUGGESTIONS).join(', ')}. Use the full catalog id.`,
        { code: 'RELAY_MODEL_NOT_IN_CATALOG', statusCode: 400 },
      );
    }
  }
  throw new AppError(
    `Model "${requested}" is not in the ${provider} model catalog. Closest ids: ${modelSuggestions(requested, candidates).join(', ')}.`,
    { code: 'RELAY_MODEL_NOT_IN_CATALOG', statusCode: 400 },
  );
}

/**
 * Resolve the model a relay task will run. Omitted models are pinned to the
 * provider catalog's current default so the durable job never loses which
 * model "provider default" meant at dispatch time. Restricted providers use
 * the first allowlisted id only when the catalog default is not allowed.
 * A `catalog` (when supplied) additionally validates/repairs the requested id
 * before the allowlist check, so unrestricted providers are checked too.
 */
export function resolveRelayWorkerModel(
  settings: Pick<AgentRelaySettings, 'allowedWorkerModels'>,
  provider: LLMProvider,
  requested: string | null | undefined,
  providerDefault?: string | null,
  catalog?: ProviderModelsDefinition | null,
): string | null {
  const allowed = allowedWorkerModelsFor(settings, provider);
  const rawRequested = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
  const trimmed = rawRequested && catalog
    ? resolveCatalogModelId(provider, rawRequested, catalog).model
    : rawRequested;
  const normalizedDefault = typeof providerDefault === 'string' && providerDefault.trim()
    ? providerDefault.trim()
    : null;
  if (allowed === null) return trimmed ?? normalizedDefault;
  if (allowed.length === 0) {
    throw new AppError(
      `Provider "${provider}" has no allowed Agent Relay models. Pick models in Agent Relay settings.`,
      { code: 'RELAY_WORKER_MODEL_REQUIRED', statusCode: 400 },
    );
  }
  if (trimmed) {
    if (!allowed.includes(trimmed)) {
      const preview = allowed.slice(0, 8).join(', ');
      throw new AppError(
        `Model "${trimmed}" is not allowlisted for ${provider} Agent Relay workers. Allowed: ${preview}${allowed.length > 8 ? ', …' : ''}.`,
        { code: 'RELAY_MODEL_NOT_ALLOWED', statusCode: 400 },
      );
    }
    return trimmed;
  }
  if (normalizedDefault && allowed.includes(normalizedDefault)) return normalizedDefault;
  return allowed[0] ?? null;
}

export function resolveRelayModelIdentity(
  settings: Pick<AgentRelaySettings, 'allowedWorkerModels'>,
  provider: LLMProvider,
  requested: string | null | undefined,
  catalog: ProviderModelsDefinition,
) {
  const requestedModel = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
  const catalogDefaultModel = typeof catalog.DEFAULT === 'string' && catalog.DEFAULT.trim()
    ? catalog.DEFAULT.trim()
    : null;
  // Validate/repair the requested id against the catalog first, so the
  // allowlist (whose entries are catalog ids) is checked against the canonical
  // form and the job persists what the runtime will actually be handed.
  const canonical = requestedModel ? resolveCatalogModelId(provider, requestedModel, catalog) : null;
  const model = resolveRelayWorkerModel(settings, provider, canonical?.model ?? null, catalogDefaultModel);
  if (!model) {
    throw new AppError(
      `Provider "${provider}" did not report a usable default model. Choose a model explicitly or refresh its catalog.`,
      { code: 'RELAY_MODEL_DEFAULT_UNAVAILABLE', statusCode: 409 },
    );
  }
  // Catalog ids are opaque. In particular, OpenCode ids may contain multiple
  // slashes (`openrouter/z-ai/glm-5.2`), so matching and persistence must never
  // split or reconstruct them.
  const option = catalog.OPTIONS.find((candidate) => candidate.value === model)
    ?? catalog.OPTIONS.find((candidate) => candidate.resolvedModel === model)
    ?? null;
  const allowed = allowedWorkerModelsFor(settings, provider);
  return {
    model,
    requestedModel,
    modelLabel: option?.label?.trim() || model,
    catalogDefaultModel,
    // A suffix repair is recorded here so the durable job shows the catalog id
    // the abbreviated request was widened to.
    catalogResolvedModel: option?.resolvedModel?.trim() || (canonical?.repaired ? model : null),
    modelSelectionSource: requestedModel
      ? 'requested' as const
      : allowed !== null && model !== catalogDefaultModel
        ? 'allowlist_fallback' as const
        : 'catalog_default' as const,
  };
}

export function mcpTokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function configureAgentRelayRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
  abortFns: Partial<Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>>,
  injectFns: Partial<Record<LLMProvider, (command: string, options: AnyRecord) => Promise<boolean>>> = {},
): void {
  runtimeSpawnFns = spawnFns;
  runtimeAbortFns = abortFns;
  runtimeInjectFns = injectFns;
}

function uniqueProviders(value: unknown, fallback: LLMProvider[]): LLMProvider[] {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.filter(
    (entry): entry is LLMProvider => typeof entry === 'string' && AGENT_RELAY_PROVIDERS.includes(entry as LLMProvider),
  ))];
}

function uniqueModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
      .map((entry) => entry.trim()),
  )].slice(0, MAX_ALLOWED_MODELS_PER_PROVIDER);
}

function uniqueAllowedWorkerModels(value: unknown): Partial<Record<LLMProvider, string[]>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<LLMProvider, string[]>> = {};
  for (const [key, models] of Object.entries(value as Record<string, unknown>)) {
    if (!AGENT_RELAY_PROVIDERS.includes(key as LLMProvider)) continue;
    out[key as LLMProvider] = uniqueModelIds(models);
  }
  return out;
}

function uniqueWorkerProfiles(value: unknown): Partial<Record<LLMProvider, AgentRelayWorkerProfile>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<LLMProvider, AgentRelayWorkerProfile>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!AGENT_RELAY_PROVIDERS.includes(key as LLMProvider)) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const profile: AgentRelayWorkerProfile = {};
    if (record.mcpServers !== undefined) {
      profile.mcpServers = uniqueModelIds(record.mcpServers).filter(
        (name) => name !== MCP_SERVER_NAME && name !== 'cloudcli-agent-relay',
      );
    }
    if (record.defaultMode === null) profile.defaultMode = null;
    else if (record.defaultMode === 'read_only' || record.defaultMode === 'isolated_write') {
      profile.defaultMode = record.defaultMode;
    }
    if (record.defaultApprovalPolicy === null) profile.defaultApprovalPolicy = null;
    else if (record.defaultApprovalPolicy === 'auto' || record.defaultApprovalPolicy === 'manual') {
      profile.defaultApprovalPolicy = record.defaultApprovalPolicy;
    }
    const hasMcp = (profile.mcpServers?.length ?? 0) > 0;
    const hasMode = profile.defaultMode === 'read_only' || profile.defaultMode === 'isolated_write';
    const hasApproval = profile.defaultApprovalPolicy === 'auto' || profile.defaultApprovalPolicy === 'manual';
    if (!hasMcp && !hasMode && !hasApproval) continue;
    if (!hasMcp) delete profile.mcpServers;
    out[key as LLMProvider] = profile;
  }
  return out;
}

function resolveWorkerMcpServers(input: {
  provider: LLMProvider;
  taskMcpServers: unknown;
  profile: AgentRelayWorkerProfile | undefined;
}): string[] {
  const rawTaskMcpServers = input.taskMcpServers;
  const taskSpecified = Array.isArray(rawTaskMcpServers);
  const taskServers = sanitizeWorkerMcpServers(
    Array.isArray(rawTaskMcpServers)
      ? rawTaskMcpServers
          .filter((entry: unknown): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
          .map((entry) => entry.trim())
      : [],
  );
  const profileServers = sanitizeWorkerMcpServers(input.profile?.mcpServers ?? []);
  if (!providerHonorsRelayMcpGrants(input.provider)) {
    return taskServers.slice(0, 30);
  }
  if (!taskSpecified || taskServers.length === 0) {
    return (profileServers.length > 0 ? profileServers : []).slice(0, 30);
  }
  if (profileServers.length > 0) {
    const allow = new Set(profileServers);
    return taskServers.filter((name) => allow.has(name)).slice(0, 30);
  }
  return taskServers.slice(0, 30);
}

function sameProviders(left: LLMProvider[], right: LLMProvider[]): boolean {
  return left.length === right.length && left.every((provider) => right.includes(provider));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function withOpenCodeLeadMigration(settings: AgentRelaySettings): AgentRelaySettings {
  if (appConfigDb.get(OPENCODE_LEAD_MIGRATION_KEY)) return settings;
  appConfigDb.set(OPENCODE_LEAD_MIGRATION_KEY, '1');
  if (settings.leadProviders.includes('opencode')) return settings;
  const next: AgentRelaySettings = { ...settings, leadProviders: [...settings.leadProviders, 'opencode' as LLMProvider] };
  writeSettings(next);
  return next;
}

function readSettings(): AgentRelaySettings {
  const raw = appConfigDb.get(SETTINGS_KEY);
  if (!raw) {
    return withOpenCodeLeadMigration({
      ...DEFAULT_SETTINGS,
      leadProviders: [...DEFAULT_SETTINGS.leadProviders],
      workerProviders: [...DEFAULT_SETTINGS.workerProviders],
    });
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentRelaySettings>;
    return withOpenCodeLeadMigration({
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
      leadProviders: uniqueProviders(parsed.leadProviders, DEFAULT_SETTINGS.leadProviders),
      workerProviders: uniqueProviders(parsed.workerProviders, DEFAULT_SETTINGS.workerProviders),
      allowedWorkerModels: uniqueAllowedWorkerModels(parsed.allowedWorkerModels),
      workerProfiles: uniqueWorkerProfiles(parsed.workerProfiles),
      maxConcurrency: clampInteger(parsed.maxConcurrency, DEFAULT_SETTINGS.maxConcurrency, 1, MAX_CONCURRENCY),
      defaultTimeoutMs: clampInteger(parsed.defaultTimeoutMs, DEFAULT_SETTINGS.defaultTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      defaultMode: parsed.defaultMode === 'isolated_write' ? 'isolated_write' : 'read_only',
      defaultApprovalPolicy: parsed.defaultApprovalPolicy === 'manual' ? 'manual' : 'auto',
      installSkill: typeof parsed.installSkill === 'boolean' ? parsed.installSkill : DEFAULT_SETTINGS.installSkill,
      approvalTimeoutMs: clampInteger(
        parsed.approvalTimeoutMs,
        DEFAULT_SETTINGS.approvalTimeoutMs,
        MIN_APPROVAL_TIMEOUT_MS,
        MAX_APPROVAL_TIMEOUT_MS,
      ),
    });
  } catch {
    return withOpenCodeLeadMigration({
      ...DEFAULT_SETTINGS,
      leadProviders: [...DEFAULT_SETTINGS.leadProviders],
      workerProviders: [...DEFAULT_SETTINGS.workerProviders],
    });
  }
}

function writeSettings(settings: AgentRelaySettings): AgentRelaySettings {
  appConfigDb.set(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

function getOrCreateMcpToken(): string {
  const existing = appConfigDb.get(MCP_TOKEN_KEY)?.trim();
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(MCP_TOKEN_KEY, token);
  return token;
}

function getApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/agent-relay-mcp`;
}

function getMcpCommand(): { command: string; args: string[] } {
  const moduleDir = getModuleDir(import.meta.url);
  const serverDir = findServerRoot(moduleDir);
  const compiled = path.join(serverDir, 'agent-relay-mcp.js');
  if (fs.existsSync(compiled)) {
    return { command: process.execPath, args: [compiled] };
  }
  const source = path.join(serverDir, 'agent-relay-mcp.ts');
  const tsxCli = path.join(findAppRoot(moduleDir), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(source) && fs.existsSync(tsxCli)) {
    return {
      command: process.execPath,
      args: [tsxCli, '--tsconfig', path.join(serverDir, 'tsconfig.json'), source],
    };
  }
  return { command: 'cloudcli', args: ['agent-relay-mcp'] };
}

async function readBundledSkill(): Promise<{ content: string; files: Array<{ relativePath: string; content: string; encoding: 'utf8' }> }> {
  const appRoot = findAppRoot(getModuleDir(import.meta.url));
  const sourceRoot = path.join(appRoot, 'server', 'modules', 'agent-relay', 'skill', SKILL_DIRECTORY_NAME);
  const compiledRoot = path.join(appRoot, 'dist-server', 'server', 'modules', 'agent-relay', 'skill', SKILL_DIRECTORY_NAME);
  const skillRoot = fs.existsSync(sourceRoot) ? sourceRoot : compiledRoot;
  const [content, openaiYaml] = await Promise.all([
    readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
    readFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8'),
  ]);
  return {
    content,
    files: [{ relativePath: 'agents/openai.yaml', content: openaiYaml, encoding: 'utf8' }],
  };
}

async function syncManagedIntegrations(settings: AgentRelaySettings): Promise<string[]> {
  const warnings: string[] = [];
  const providers = settings.enabled ? settings.leadProviders : [];
  const { command, args } = getMcpCommand();
  await mcpCatalogService.upsert({
    name: MCP_SERVER_NAME,
    scope: 'user',
    transport: 'stdio',
    command,
    args,
    env: {
      CLOUDCLI_AGENT_RELAY_API_URL: getApiUrl(),
      CLOUDCLI_AGENT_RELAY_MCP_TOKEN: getOrCreateMcpToken(),
    },
    // Per-session, so it cannot be a static `env` value. Codex only forwards
    // named parent variables to MCP children, so the relay entry must declare
    // it; providers that inherit the whole environment get it for free.
    envVars: ['CLOUDCLI_LEAD_SESSION_ID'],
    providers,
    kind: 'agent-relay',
  });

  const bundled = await readBundledSkill();
  const existing = (await globalSkillsService.listGlobalSkills())
    .some((skill) => skill.directoryName === SKILL_DIRECTORY_NAME);

  // Re-scope an existing managed skill first so providers removed from the
  // lead list (or all providers when Relay is disabled) are torn down using
  // the manifest's previous target list. Re-installing afterward refreshes
  // SKILL.md and supporting files in both the canonical and active copies.
  if (existing) {
    await globalSkillsService.setGlobalSkillScope({
      directoryName: SKILL_DIRECTORY_NAME,
      scope: 'all',
      providers: settings.enabled && settings.installSkill ? providers : [],
    });
  }
  const [installed] = await globalSkillsService.addGlobalSkills({
    entries: [{
      directoryName: SKILL_DIRECTORY_NAME,
      content: bundled.content,
      files: bundled.files,
    }],
    scope: 'all',
    providers: settings.enabled && settings.installSkill ? providers : [],
  });

  // A silently skipped skill target means a lead provider that will happily
  // expose the relay MCP tools but never see the delegation playbook — the
  // exact failure mode that is invisible until a lead behaves poorly.
  if (settings.enabled && settings.installSkill && installed) {
    for (const provider of installed.conflicts) {
      warnings.push(`Skill "${SKILL_DIRECTORY_NAME}" was not written for ${provider}: an unmanaged skill with the same name already exists there.`);
    }
    for (const provider of installed.unsupported) {
      if (providers.includes(provider)) {
        warnings.push(`Provider ${provider} has no global skill directory; its leads rely on shared skill folders or the MCP tool descriptions alone.`);
      }
    }
  }
  if (warnings.length > 0) console.warn('[AgentRelay] managed integration warnings:', warnings);
  return warnings;
}

function timeoutMs(value: number | undefined, fallback: number): number {
  return clampInteger(value, fallback, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

function normalizeMode(value: unknown, fallback: AgentRelayMode): AgentRelayMode {
  return value === 'isolated_write' ? 'isolated_write' : value === 'read_only' ? 'read_only' : fallback;
}

function normalizeApprovalPolicy(value: unknown, fallback: AgentRelayApprovalPolicy): AgentRelayApprovalPolicy {
  return value === 'manual' ? 'manual' : value === 'auto' ? 'auto' : fallback;
}

/**
 * Compact context block describing this job's completed dependencies, injected
 * into the worker prompt so a pipeline stage sees what its inputs produced
 * without the lead having to relay results by hand.
 */
function buildDependencyContext(job: Pick<AgentRelayJob, 'depends_on'>): string {
  if (job.depends_on.length === 0) return '';
  const sections: string[] = [];
  for (const depId of job.depends_on) {
    const dep = agentRelayDb.get(depId);
    if (!dep?.result) continue;
    const name = dep.label || dep.task.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 80) || depId;
    const parts = [`### Prerequisite "${name}" (${dep.result.status})`, dep.result.summary.slice(0, DEP_CONTEXT_CHARS)];
    if (dep.result.structuredOutput !== undefined) {
      parts.push(`Structured output:\n${JSON.stringify(dep.result.structuredOutput).slice(0, DEP_CONTEXT_CHARS)}`);
    }
    sections.push(parts.join('\n'));
  }
  if (sections.length === 0) return '';
  return ['', 'Results from prerequisite tasks this assignment builds on:', ...sections].join('\n');
}

function resultContractLines(job: Pick<AgentRelayJob, 'output_schema'>): string[] {
  const lines = [
    'Finish with exactly one tagged JSON object using this shape:',
    '<agent_relay_result>{"status":"completed|failed|blocked","summary":"...","evidence":["..."],"filesTouched":["..."],"testsRun":["..."],"openQuestions":["..."]}</agent_relay_result>',
  ];
  if (job.output_schema) {
    lines.push(
      'This assignment declares a required structured output. Add a "data" key to that same JSON object whose value validates against this JSON Schema:',
      JSON.stringify(job.output_schema),
      'The "data" key is mandatory and must match the schema exactly — the lead consumes it programmatically.',
    );
  }
  lines.push('Keep prose before the tag concise. Never include hidden reasoning or secrets.');
  return lines;
}

function workerRoleLines(job: Pick<AgentRelayJob, 'mode' | 'approval_policy'>): string[] {
  if (job.mode === 'read_only') {
    return [
      'Role: EXPLORER. This is a read-only assignment.',
      'Inspect and report only. Do not edit, create, delete, rename, format, install, commit, or run mutating commands.',
      'Host permission policy: inspect tools and inspect bash (ls, rg, git status/log/diff/show, find without -exec, cat/head) are auto-approved — do not wait for permission. Prefer Read/Grep/Glob when they exist. Every write, network-out, package install, build-that-emits, or unclassifiable action is auto-DENIED; skip it and report the blocker. Never retry a denied command.',
    ];
  }
  if (job.approval_policy === 'manual') {
    return [
      'Role: IMPLEMENTER in an isolated CloudCLI worktree.',
      'You may edit files in this worktree only. Do not merge into the base branch. Run relevant checks, commit completed changes to the current feature branch with a clear message, and leave a reviewable diff.',
      'Permission policy is manual: safe reads proceed automatically, but isolated-worktree mutations wait for the lead before execution. Do not attempt network, installs, or paths outside this worktree.',
    ];
  }
  return [
    'Role: IMPLEMENTER in an isolated CloudCLI worktree.',
    'You may edit files in this worktree only. Do not merge into the base branch. Run relevant checks, commit completed changes to the current feature branch with a clear message, and leave a reviewable diff.',
    'Host permission policy is auto: reads and writes inside this worktree are auto-approved. Network (except localhost), package installs, paths outside this worktree, destructive commands, and unclassifiable tools are auto-DENIED without asking the lead. Do not attempt them — report a blocker instead.',
  ];
}

function buildWorkerPrompt(job: Pick<AgentRelayJob, 'relay_id' | 'task' | 'mode' | 'approval_policy' | 'label' | 'output_schema' | 'depends_on'>): string {
  return [
    'You are a delegated sidekick for a lead agent. Complete only the bounded assignment below.',
    'Do not expand scope. Do not ask the end user questions; report blockers to the lead.',
    'Delegation is owned by the lead. Never call Agent Relay relay_* tools or create sub-delegations.',
    ...workerRoleLines(job),
    '',
    `Relay job: ${job.relay_id}${job.label ? ` — ${job.label}` : ''}`,
    `Assignment:\n${job.task}`,
    buildDependencyContext(job),
    '',
    ...resultContractLines(job),
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

function buildFollowUpPrompt(job: Pick<AgentRelayJob, 'output_schema'>, prompt: string): string {
  return [
    'The requesting lead has a focused follow-up for the same delegated assignment.',
    prompt,
    '',
    'Return the answer and finish with the same <agent_relay_result> JSON contract.',
    ...(job.output_schema ? ['Include the mandatory "data" key validating against the previously declared JSON Schema.'] : []),
  ].join('\n');
}

/** One automatic remediation turn when structured output failed validation. */
function buildSchemaRepairPrompt(job: Pick<AgentRelayJob, 'output_schema'>, errors: string[]): string {
  return [
    'Your previous reply did not satisfy the structured output contract for this assignment.',
    errors.length > 0 ? `Validation errors:\n${errors.map((error) => `- ${error}`).join('\n')}` : 'The <agent_relay_result> tag was missing or its JSON did not parse.',
    '',
    'Reply with ONLY one corrected <agent_relay_result> tagged JSON object.',
    'It must include the standard keys (status, summary, evidence, filesTouched, testsRun, openQuestions)' + (job.output_schema ? ' and a "data" key that validates against this JSON Schema:' : '.'),
    ...(job.output_schema ? [JSON.stringify(job.output_schema)] : []),
    'Do not redo the assignment; reuse the work you already did.',
  ].join('\n');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 100)
    : [];
}

export type ParsedWorkerResult = {
  result: AgentRelayStructuredResult;
  /** Whether the tagged JSON contract was honored. `malformed` = tag present but unparseable. */
  contract: 'valid' | 'malformed' | 'missing';
};

/**
 * Strips a single leading/trailing ```json (or bare ```) fence some workers
 * wrap their tagged JSON in despite the contract asking for the tag alone.
 */
function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Returns every top-level `{...}` substring of `text`, respecting string
 * literals (so a brace inside a quoted value never throws off the depth
 * count). Used to recover a result object when the `<agent_relay_result>` tag
 * itself is missing but the worker still ended with JSON.
 */
function extractBalancedJsonObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let stringChar = '';
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
}

/**
 * Last-resort recovery for a worker that skipped the `<agent_relay_result>`
 * tag entirely but still ended its output with a plausible result object
 * (status + summary present). Scans every top-level JSON object, latest
 * first, so a stray unrelated object earlier in the transcript never wins
 * over the worker's actual final answer.
 */
function recoverJsonResultFromOutput(output: string): Record<string, unknown> | null {
  const candidates = extractBalancedJsonObjects(output);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        typeof (parsed as AnyRecord).summary === 'string' &&
        typeof (parsed as AnyRecord).status === 'string'
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON on its own; try the previous (earlier) candidate.
    }
  }
  return null;
}

function structuredResultFromParsedJson(parsed: Record<string, unknown>, output: string): AgentRelayStructuredResult {
  const status = parsed.status === 'failed' || parsed.status === 'blocked' ? parsed.status : 'completed';
  return {
    status,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 20_000) : output.slice(0, 20_000),
    evidence: stringArray(parsed.evidence),
    filesTouched: stringArray(parsed.filesTouched),
    testsRun: stringArray(parsed.testsRun),
    openQuestions: stringArray(parsed.openQuestions),
    ...(parsed.data !== undefined ? { structuredOutput: parsed.data } : {}),
  };
}

/**
 * Tolerant reader for the worker result contract. Prefers the last
 * well-formed `<agent_relay_result>` tag, stripping a markdown code fence a
 * worker may have wrapped the JSON in. When the tag is missing outright, it
 * falls back to recovering a trailing JSON object that looks like a result
 * (has `status` + `summary`) before giving up and treating the whole output
 * as prose. A tag that is present but unparseable is still reported
 * `malformed` (not silently recovered) so the existing one-shot schema
 * repair turn still fires — the worker contract itself is unchanged.
 */
export function parseStructuredResult(output: string, failed: boolean): ParsedWorkerResult {
  const matches = [...output.matchAll(/<agent_relay_result>\s*([\s\S]*?)\s*<\/agent_relay_result>/gi)];
  const raw = matches.at(-1)?.[1];
  if (raw) {
    try {
      const parsed = JSON.parse(stripJsonFences(raw)) as Record<string, unknown>;
      return { contract: 'valid', result: structuredResultFromParsedJson(parsed, output) };
    } catch {
      // Fall through to a useful unstructured result.
    }
  } else {
    const recovered = recoverJsonResultFromOutput(output);
    if (recovered) {
      return { contract: 'valid', result: structuredResultFromParsedJson(recovered, output) };
    }
  }
  const cleaned = output.replace(/<agent_relay_result>[\s\S]*?<\/agent_relay_result>/gi, '').trim();
  return {
    contract: raw ? 'malformed' : 'missing',
    result: {
      status: failed ? 'failed' : 'completed',
      summary: (cleaned || output || (failed ? 'The provider run failed.' : 'The delegate completed without a text result.')).slice(0, 20_000),
      evidence: [],
      filesTouched: [],
      testsRun: [],
      openQuestions: [],
    },
  };
}

/**
 * Validates the worker's structured output against the task's declared schema
 * and stamps the verdict onto the result. A missing `data` key on a schema
 * task is a validation failure, not a silent pass.
 */
function applyOutputValidation(job: Pick<AgentRelayJob, 'output_schema'>, parsed: ParsedWorkerResult): { valid: boolean; errors: string[] } | null {
  if (!job.output_schema) return null;
  const verdict = parsed.result.structuredOutput === undefined
    ? { valid: false, errors: parsed.contract === 'valid' ? ['$: missing required "data" key in <agent_relay_result>'] : ['the <agent_relay_result> tag was missing or unparseable'] }
    : validateJsonSchema(parsed.result.structuredOutput, job.output_schema);
  parsed.result.outputValidation = verdict;
  return verdict;
}

/**
 * Human-readable title for a delegate session, so the Relay panel and the
 * Running rail show the assignment rather than the sidekick preamble.
 */
/** Compact, non-secret one-liner describing one spine event for the lead. */
function summarizeEventPayload(type: string, payload: AnyRecord | undefined): string | null {
  if (!payload) return null;
  const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
  if (type === 'tool.call') {
    const input = payload.input as AnyRecord | string | undefined;
    const command = typeof input === 'object' && input ? text(input.command) : text(input);
    return command ? command.slice(0, 300) : null;
  }
  if (type === 'tool.result') {
    const content = text(payload.content);
    return `${payload.is_error ? 'error: ' : ''}${(content ?? '').slice(0, 300)}` || null;
  }
  if (type === 'permission.requested') return text(payload.reason) ?? `awaiting decision for ${text(payload.tool) ?? 'a tool'}`;
  if (type === 'permission.resolved') return payload.resolved ? 'resolved' : text(payload.reason);
  return text(payload.message) ?? text(payload.status);
}

function relayWorkerSessionTitle(job: Pick<AgentRelayJob, 'task' | 'provider' | 'label'>): string {
  const firstLine = job.label || job.task.split('\n').map((line) => line.trim()).find(Boolean) || 'delegated task';
  return `Relay · ${job.provider} · ${firstLine.slice(0, 90)}`;
}

/**
 * Approval wait bounded by the job's own deadline: a parked worker must get
 * its denial early enough to still report the blocker before the job timeout
 * kills it mid-answer.
 */
function effectiveApprovalTimeoutMs(job: Pick<AgentRelayJob, 'timeout_ms'>): number {
  return Math.min(readSettings().approvalTimeoutMs, Math.max(MIN_APPROVAL_TIMEOUT_MS, job.timeout_ms - 30_000));
}

function buildRuntimeOptions(job: AgentRelayJob, cwd: string): AnyRecord {
  const permissionMode = relayPermissionMode(job);
  const mcpServers = sanitizeWorkerMcpServers(job.mcp_servers);
  const options: AnyRecord = {
    unattended: true,
    permissionMode,
    approvalTimeoutMs: effectiveApprovalTimeoutMs(job),
    cwd,
    projectPath: cwd,
    sessionSummary: `Agent Relay · ${job.task.slice(0, 100)}`,
    images: [],
    relayWorker: true,
  };
  // catalog_resolved_model is the concrete pinned id behind an alias (e.g.
  // 'haiku' -> 'claude-haiku-4-5-20251001'). Passing the alias to the CLI lets
  // it re-resolve against the operator's own project/user default model,
  // silently overriding what the lead actually requested. The runtime must
  // receive the id that cannot be reinterpreted.
  const runtimeModel = job.catalog_resolved_model || job.model;
  if (runtimeModel) options.model = runtimeModel;
  if (job.effort) options.effort = job.effort;
  // An explicit empty list is security-significant. Providers must not fall
  // back to their user/project MCP config for a relay worker that received no
  // grant. Adapters use relayWorker + this list to enforce that boundary.
  options.mcpServers = mcpServers;
  const expandedTools = expandMcpSelectionsToTools(mcpServers, job.provider);
  if (job.provider === 'claude' || job.provider === 'cursor') {
    options.toolsSettings = {
      allowedTools: expandedTools,
      // Relay owns fan-out. Native Task/Agent tools would create invisible
      // grandchildren with no Relay ownership, budget, approval, or lifecycle.
      disallowedTools: [
        'Task',
        'Agent',
        'TaskOutput',
        'TaskStop',
        'mcp__cloudcli-agent-relay',
        'mcp__cloudcli-agent-relay__*',
      ],
      skipPermissions: false,
    };
  } else if (job.provider === 'grok') {
    options.toolsSettings = { allowedCommands: expandedTools, disallowedCommands: [] };
  }
  return options;
}

function publish(job: AgentRelayJob | null): void {
  if (!job) return;
  broadcastSystemEvent({ kind: 'agent_relay_updated', job });
  notifyAgentRelayTerminal(job);
}

/**
 * Resolves a relay job for a specific caller, refusing jobs the caller does
 * not own. This is what stops one lead chat from reading, steering, or
 * cancelling another chat's workers.
 *
 * The default is deliberately unscoped: this service is a trusted internal API
 * (operator REST surface, boot recovery, tests). Identity is enforced at the
 * MCP boundary, which passes an explicit caller scope on every call.
 */
function requireOwnedJob(relayId: string, scope: AgentRelayScope = { allowUnscoped: true }): AgentRelayJob {
  const job = agentRelayDb.get(relayId);
  if (!job) throw new AppError('Relay job not found.', { code: 'RELAY_NOT_FOUND', statusCode: 404 });
  if (scope.allowUnscoped) return job;
  const caller = scope.sourceSessionId?.trim() || null;
  if (!caller || job.source_session_id !== caller) {
    // Deliberately the same shape as "not found": a lead must not be able to
    // probe for the existence of another session's relay ids.
    throw new AppError('Relay job not found.', { code: 'RELAY_NOT_FOUND', statusCode: 404 });
  }
  return job;
}

function closeCanonicalRun(
  runId: string | null | undefined,
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'aborted' | 'timed_out'>,
  errorSummary?: string | null,
): void {
  if (!runId) return;
  const current = runService.get(runId);
  if (!current || TERMINAL_RUN_STATUSES.has(current.status)) return;
  try {
    runService.markTerminal(runId, { status, errorSummary: errorSummary ?? null });
  } catch {
    // A provider completion event may win this race and close the run first.
  }
}

function projectBudgetExceeded(projectId: string): string | null {
  const budget = runService.getBudget(projectId);
  const stats = runService.projectStats(projectId);
  if (budget.monthly_token_budget != null && stats.tokensMonth >= budget.monthly_token_budget) {
    return `Project monthly token budget is exhausted (${stats.tokensMonth.toLocaleString()} / ${budget.monthly_token_budget.toLocaleString()}).`;
  }
  if (budget.monthly_cost_usd_budget != null && stats.costMonth >= budget.monthly_cost_usd_budget) {
    return `Project monthly cost budget is exhausted ($${stats.costMonth.toFixed(2)} / $${budget.monthly_cost_usd_budget.toFixed(2)}).`;
  }
  return null;
}

async function abortLiveJob(job: AgentRelayJob): Promise<void> {
  if (!job.app_session_id) return;
  const live = chatRunRegistry.getRun(job.app_session_id);
  const providerSessionId = live?.providerSessionId ?? sessionsDb.getSessionById(job.app_session_id)?.provider_session_id;
  const abortFn = providerSessionId ? runtimeAbortFns[job.provider] : undefined;
  if (abortFn && providerSessionId) {
    await Promise.resolve(abortFn(providerSessionId)).catch(() => false);
  }
  chatRunRegistry.completeRun(job.app_session_id, { exitCode: 1, aborted: true });
}

/**
 * Attempts to deliver a lead follow-up straight into a worker's live turn
 * instead of waiting for it to finish. Only works for a provider with a
 * mid-run injection hook (see `configureAgentRelayRuntimes`) and only while
 * the worker's run is still registered as active — `startProviderRun`
 * resolves that by returning `injected: true` rather than starting a second
 * run. Any other outcome (no hook, injection rejected, no session yet) means
 * the caller must fall back to queuing the prompt for the next attempt.
 */
async function injectMidSessionFollowUp(job: AgentRelayJob, prompt: string): Promise<boolean> {
  if (!job.app_session_id) return false;
  const spawnFn = runtimeSpawnFns[job.provider];
  const injectFn = runtimeInjectFns[job.provider];
  if (!spawnFn || !injectFn) return false;
  const providerSessionId = chatRunRegistry.getRun(job.app_session_id)?.providerSessionId
    ?? sessionsDb.getSessionById(job.app_session_id)?.provider_session_id
    ?? null;
  const cwd = job.workspace_id ? workspaceService.resolveCwd(job.workspace_id) : job.project_path;
  try {
    const result = await startProviderRun({
      appSessionId: job.app_session_id,
      provider: job.provider,
      providerSessionId,
      projectPath: cwd,
      spawnFn,
      injectFn,
      content: prompt,
      options: {},
      connection: DETACHED_CONNECTION,
      userId: null,
    });
    return result.ok === true && result.injected === true;
  } catch {
    return false;
  }
}

async function collectWorkspaceResult(job: AgentRelayJob): Promise<AgentRelayResult['workspace'] | undefined> {
  if (!job.workspace_id) return undefined;
  const workspace = workspaceService.get(job.workspace_id);
  if (!workspace) return undefined;
  try {
    const diff = await workspaceService.getDiff(job.workspace_id);
    return {
      workspaceId: workspace.workspace_id,
      rootPath: workspace.root_path,
      featureBranch: workspace.feature_branch,
      files: diff.files.map((file) => ({ path: file.path, status: file.status })),
      additions: diff.summary.additions,
      deletions: diff.summary.deletions,
    };
  } catch {
    return {
      workspaceId: workspace.workspace_id,
      rootPath: workspace.root_path,
      featureBranch: workspace.feature_branch,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }
}

async function executeJob(relayId: string): Promise<void> {
  let job = agentRelayDb.get(relayId);
  let canonicalRunId: string | null = null;
  if (!job || job.status !== 'queued') return;
  const exhaustedBudget = projectBudgetExceeded(job.project_id);
  if (exhaustedBudget) {
    publish(agentRelayDb.finish(relayId, 'failed', { error: exhaustedBudget }));
    return;
  }
  const spawnFn = runtimeSpawnFns[job.provider];
  if (!spawnFn) {
    publish(agentRelayDb.finish(relayId, 'failed', { error: `Provider "${job.provider}" runtime is unavailable.` }));
    return;
  }

  let cwd = job.project_path;
  let workspaceId = job.workspace_id;
  try {
    if (job.mode === 'isolated_write' && !workspaceId) {
      const gitRepo = fs.existsSync(path.join(job.project_path, '.git'));
      const workspace = await workspaceService.create({
        projectId: job.project_id,
        projectPath: job.project_path,
        taskId: job.relay_id,
        branchName: `relay/${job.relay_id.toLowerCase()}`,
        mode: gitRepo ? 'git_worktree' : 'sandbox_copy',
      });
      workspaceId = workspace.workspace_id;
      cwd = workspace.root_path;
      agentRelayDb.setWorkspace(job.relay_id, workspace.workspace_id);
    } else if (workspaceId) {
      cwd = workspaceService.resolveCwd(workspaceId);
    }

    job = agentRelayDb.get(relayId);
    if (!job || job.status !== 'queued') return;
    const existingSession = job.app_session_id ? sessionsDb.getSessionById(job.app_session_id) : null;
    const appSessionId = existingSession
      ? existingSession.session_id
      : sessionsService.createAppSession(job.provider, cwd, { internal: true }).sessionId;
    if (!existingSession) {
      // Name the worker session deterministically, the way swarm members are
      // named. Without this the row keeps whatever the provider derived from
      // the prompt, and Codex/OpenCode used the whole sidekick preamble ("You
      // are a delegated sidekick for a lead agent…") as the session title.
      try {
        sessionsService.renameSessionById(appSessionId, relayWorkerSessionTitle(job));
      } catch {
        // A cosmetic title must never fail the dispatch.
      }
    }
    if (workspaceId) sessionsDb.updateSessionRuntimeProjectPath(appSessionId, cwd);

    const canonicalRun = runService.create({
      source: 'agent_relay',
      sourceRef: job.relay_id,
      projectId: job.project_id,
      workspaceId: workspaceId ?? null,
      appSessionId,
      provider: job.provider,
      model: job.model,
      effort: job.effort,
      permissionMode: relayPermissionMode(job),
      title: `Relay · ${(job.label || job.task).slice(0, 120)}`,
      trigger: job.attempt > 0 ? 'follow_up' : 'delegate',
      meta: { relay_id: job.relay_id, batch_id: job.batch_id, mode: job.mode },
    });
    canonicalRunId = canonicalRun.run_id;
    if (workspaceId) {
      workspaceService.bindRun(workspaceId, canonicalRun.run_id);
      runService.linkWorkspace(canonicalRun.run_id, workspaceId);
    }
    runService.linkSession(canonicalRun.run_id, appSessionId);
    const attached = agentRelayDb.attachExecution(job.relay_id, {
      appSessionId,
      runId: canonicalRun.run_id,
      workspaceId,
    });
    if (!attached || attached.status !== 'running') return;
    job = attached;
    publish(job);

    const textChunks: string[] = [];
    const deltaChunks: string[] = [];
    const errorChunks: string[] = [];
    let providerFailed = false;
    let budgetStopReason: string | null = null;
    const onEvent = (message: NormalizedMessage) => {
      recordNormalizedRunEvent(canonicalRun.run_id, message, 'agent_relay');
      if (!budgetStopReason && message.kind === 'status' && message.text === 'token_budget') {
        const tokenBudget = message.tokenBudget as { model?: unknown } | null | undefined;
        const runtimeModel = typeof tokenBudget?.model === 'string' ? tokenBudget.model.trim() : '';
        if (runtimeModel) {
          // Keep the provider's exact id. OpenCode provider-qualified ids can
          // contain multiple slashes and Claude aliases may resolve to a
          // versioned id only after the process starts.
          publish(agentRelayDb.setRuntimeResolvedModel(job!.relay_id, runtimeModel));
        }
        budgetStopReason = projectBudgetExceeded(job!.project_id);
        if (budgetStopReason) {
          providerFailed = true;
          errorChunks.push(budgetStopReason);
          appendLiveOutput(job!.relay_id, `\n[Relay stopped: ${budgetStopReason}]\n`);
          void abortLiveJob(job!).catch(() => undefined);
        }
      }
      if (message.kind === 'permission_request') {
        // Fire-and-forget: the broker resolves the pending approval through the
        // process-wide registry every runtime waits on. Without this the worker
        // sits in `waiting_permission` until its unattended timeout kills it.
        void agentRelayPermissionBroker
          .handlePermissionRequest(job!.relay_id, message as unknown as AnyRecord)
          .catch((error) => {
            console.error('[AgentRelayPermission] Unhandled broker failure', error);
          });
      }
      if (typeof message.content === 'string') {
        if (message.kind === 'text') {
          textChunks.push(message.content);
          appendLiveOutput(job!.relay_id, `${message.content}\n`);
        } else if (message.kind === 'stream_delta') {
          deltaChunks.push(message.content);
          appendLiveOutput(job!.relay_id, message.content);
        } else if (message.kind === 'error') errorChunks.push(message.content);
      }
      if (message.kind === 'complete') {
        const complete = message as NormalizedMessage & { exitCode?: number; success?: boolean; aborted?: boolean };
        providerFailed = Boolean(complete.aborted) || complete.success === false || (typeof complete.exitCode === 'number' && complete.exitCode !== 0);
      }
    };

    // The envelope is what the lead declared: a writer may touch its own
    // worktree, a read-only worker may touch nothing.
    agentRelayPermissionBroker.register({
      relayId: job.relay_id,
      mode: job.mode,
      approvalPolicy: job.approval_policy,
      provider: job.provider,
      envelopeRoot: cwd,
      sourceSessionId: job.source_session_id,
      approvalTimeoutMs: effectiveApprovalTimeoutMs(job),
    });

    runService.updateStatus(canonicalRun.run_id, 'starting');
    const started = await startProviderRun({
      appSessionId,
      provider: job.provider,
      providerSessionId: existingSession?.provider_session_id ?? null,
      projectPath: cwd,
      spawnFn,
      content: existingSession
        ? buildFollowUpPrompt(job, job.last_prompt)
        : job.last_prompt !== job.task
          ? `${buildWorkerPrompt(job)}\n\nFollow-up from the lead:\n${job.last_prompt}`
          : buildWorkerPrompt(job),
      options: buildRuntimeOptions(job, cwd),
      connection: DETACHED_CONNECTION,
      userId: null,
      onEvent,
    });
    if (!started.ok) throw new AppError('A run is already active for this delegate session.', { code: 'RELAY_RUN_IN_PROGRESS', statusCode: 409 });
    if (runService.get(canonicalRun.run_id)?.status === 'starting') runService.updateStatus(canonicalRun.run_id, 'running');

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        void abortLiveJob(agentRelayDb.get(job!.relay_id) ?? job!).finally(resolve);
      }, job!.timeout_ms);
    });
    await Promise.race([started.completion, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    const current = agentRelayDb.get(job.relay_id);
    const output = (textChunks.length > 0 ? textChunks.join('\n') : deltaChunks.join('')).trim().slice(0, MAX_RESULT_CHARS);

    if (current?.status === 'cancelled') {
      if (output) {
        const partial = parseStructuredResult(output, true).result;
        publish(agentRelayDb.patchResult(job.relay_id, {
          ...partial,
          status: 'blocked',
          summary: `Cancelled before reporting. Partial findings:\n${partial.summary}`,
          openQuestions: [...partial.openQuestions, 'The delegate was cancelled before it finished.'],
          output,
          workspace: await collectWorkspaceResult(current),
        }));
      }
      return;
    }
    if (!current || (AGENT_RELAY_TERMINAL_STATUSES.has(current.status) && current.status !== 'running')) return;

    if (timedOut) {
      // A cancelled worker often did real investigation before the deadline.
      // Reporting "no contribution" throws that away, so the partial output is
      // preserved as a `blocked` result the lead can still act on.
      const timeoutError = `Delegate exceeded ${job.timeout_ms}ms timeout.`;
      closeCanonicalRun(canonicalRun.run_id, 'timed_out', timeoutError);
      const partial = parseStructuredResult(output, true).result;
      publish(agentRelayDb.finish(job.relay_id, 'timed_out', {
        error: timeoutError,
        result: output
          ? {
            ...partial,
            status: 'blocked',
            summary: `Timed out before reporting. Partial findings:\n${partial.summary}`,
            openQuestions: [...partial.openQuestions, 'The delegate was cancelled by the relay timeout before it finished.'],
            output,
            workspace: await collectWorkspaceResult(agentRelayDb.get(job.relay_id) ?? job),
          }
          : null,
      }));
      return;
    }

    // An infrastructure failure that produced nothing usable consumes a retry
    // (when the task granted one) instead of reporting a dead job to the lead.
    if (providerFailed && !output && job.retry_count < job.retries) {
      closeCanonicalRun(canonicalRun.run_id, 'failed', 'Provider run failed with no output; retrying with a fresh worker.');
      const requeued = agentRelayDb.requeueForRetry(job.relay_id);
      if (requeued) {
        publish(requeued);
        return;
      }
    }

    const parsed = parseStructuredResult(output, providerFailed);
    const verdict = applyOutputValidation(job, parsed);
    // One automatic repair turn on a broken structured contract: either the
    // declared schema failed to validate, or the worker produced prose with a
    // present-but-unparseable result tag. The repair resumes the same session,
    // so the worker fixes its reply instead of redoing the assignment.
    const contractBroken = (verdict !== null && !verdict.valid) || (parsed.contract === 'malformed' && output.length > 0);
    if (!providerFailed && contractBroken) {
      const repair = agentRelayDb.queueSchemaRepair(job.relay_id, buildSchemaRepairPrompt(job, verdict?.errors ?? []));
      if (repair) {
        closeCanonicalRun(canonicalRun.run_id, 'succeeded', null);
        publish(repair);
        return;
      }
    }

    // A lead follow-up arrived mid-session but could not be injected into the
    // live turn (no provider hook, or the injection attempt failed). Rather
    // than report this turn's result as final and wait for the lead to notice
    // and resume, dispatch it as the very next attempt right away.
    if (!providerFailed) {
      const pendingFollowUp = agentRelayDb.takePendingFollowUp(job.relay_id);
      if (pendingFollowUp) {
        const requeued = agentRelayDb.requeueWithFollowUp(job.relay_id, buildFollowUpPrompt(job, pendingFollowUp));
        if (requeued) {
          closeCanonicalRun(canonicalRun.run_id, 'succeeded', null);
          publish(requeued);
          void drainQueue();
          return;
        }
      }
    }

    const structured = parsed.result;
    if (providerFailed && structured.status === 'completed') structured.status = 'failed';
    if (parsed.contract !== 'valid' && output && !providerFailed) {
      structured.openQuestions = [
        ...structured.openQuestions,
        'The worker did not return a valid <agent_relay_result> contract; the summary is its raw prose.',
      ];
    }
    const result: AgentRelayResult = {
      ...structured,
      output,
      workspace: await collectWorkspaceResult(agentRelayDb.get(job.relay_id) ?? job),
    };
    const error = errorChunks.join('\n').trim().slice(0, 20_000) || null;
    closeCanonicalRun(canonicalRun.run_id, providerFailed ? 'failed' : 'succeeded', error);
    publish(agentRelayDb.finish(job.relay_id, providerFailed ? 'failed' : 'completed', { result, error }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    closeCanonicalRun(canonicalRunId, 'failed', message.slice(0, 20_000));
    const current = agentRelayDb.get(relayId);
    if (current && !AGENT_RELAY_TERMINAL_STATUSES.has(current.status)) {
      // Spawn/setup failures are the classic transient case; honor the task's
      // retry budget here too.
      if (current.retry_count < current.retries) {
        const requeued = agentRelayDb.requeueForRetry(relayId);
        if (requeued) {
          publish(requeued);
          return;
        }
      }
      publish(agentRelayDb.finish(relayId, 'failed', { error: message.slice(0, 20_000) }));
    }
  } finally {
    liveOutputTails.delete(relayId);
    // Always tear the envelope down: a dangling registration would let a later
    // run's prompt be judged against a stale worktree root, and a dangling
    // pending approval would show up in the lead's queue forever.
    agentRelayPermissionBroker.releaseJob(relayId, 'The delegate run ended before this request was answered.');
  }
}

/**
 * Whether a queued job's in-batch dependencies allow it to start. A failed,
 * cancelled, or timed-out dependency fails the dependent fast — matching
 * pipeline semantics where a broken stage drops everything built on it.
 */
function dependencyGate(job: AgentRelayJob): { state: 'ready' | 'waiting' | 'dependency_failed'; reason?: string } {
  for (const depId of job.depends_on) {
    const dep = agentRelayDb.get(depId);
    if (!dep) return { state: 'dependency_failed', reason: `Dependency ${depId} no longer exists.` };
    if (!AGENT_RELAY_TERMINAL_STATUSES.has(dep.status)) return { state: 'waiting' };
    if (dep.status !== 'completed') {
      const name = dep.label || dep.relay_id;
      return {
        state: 'dependency_failed',
        reason: `Dependency "${name}" ended ${dep.status}${dep.error ? `: ${dep.error.slice(0, 300)}` : '.'}`,
      };
    }
  }
  return { state: 'ready' };
}

async function drainQueue(): Promise<void> {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    for (;;) {
      drainAgain = false;
      const settings = readSettings();
      if (!settings.enabled || activeJobs.size >= settings.maxConcurrency) {
        if (drainAgain) continue;
        return;
      }
      let next: AgentRelayJob | null = null;
      const queuedJobs = agentRelayDb.listAllQueued();
      const activeJobRows = [...activeJobs]
        .map((relayId) => agentRelayDb.get(relayId))
        .filter((job): job is AgentRelayJob => Boolean(job));
      const leadKey = (job: AgentRelayJob) => job.source_session_id || `batch:${job.batch_id}`;
      const contenders = new Set([...queuedJobs, ...activeJobRows].map(leadKey));
      // Preserve full speed for one lead. Under contention, reserve roughly
      // half the fleet for other leads so a large batch cannot monopolize all
      // worker slots indefinitely.
      const perLeadCap = contenders.size > 1 ? Math.max(1, Math.ceil(settings.maxConcurrency / 2)) : settings.maxConcurrency;
      const activeByLead = new Map<string, number>();
      for (const active of activeJobRows) {
        const key = leadKey(active);
        activeByLead.set(key, (activeByLead.get(key) ?? 0) + 1);
      }
      const leadOrder = [...new Set(queuedJobs.map(leadKey))]
        .sort((left, right) => (leadLastScheduled.get(left) ?? 0) - (leadLastScheduled.get(right) ?? 0));
      // Inspect one lead at a time in round-robin order, preserving FIFO
      // within each lead. This stays fair even at maxConcurrency=1 and with
      // three or more continuously backlogged leads.
      const fairQueuedJobs = leadOrder.flatMap((key) => queuedJobs.filter((job) => leadKey(job) === key));
      for (const job of fairQueuedJobs) {
        if (activeJobs.has(job.relay_id)) continue;
        if ((activeByLead.get(leadKey(job)) ?? 0) >= perLeadCap) continue;
        const gate = dependencyGate(job);
        if (gate.state === 'dependency_failed') {
          publish(agentRelayDb.finish(job.relay_id, 'failed', { error: gate.reason ?? 'A dependency did not complete.' }));
          continue;
        }
        if (gate.state === 'waiting') continue;
        next = job;
        leadScheduleSequence += 1;
        leadLastScheduled.set(leadKey(job), leadScheduleSequence);
        break;
      }
      if (!next) {
        if (drainAgain) continue;
        return;
      }
      activeJobs.add(next.relay_id);
      void executeJob(next.relay_id).finally(() => {
        activeJobs.delete(next.relay_id);
        void drainQueue();
      });
    }
  } finally {
    draining = false;
    if (drainAgain) void drainQueue();
  }
}

async function getRuntimeStatus(settings: AgentRelaySettings) {
  const providerStatuses = await Promise.all(AGENT_RELAY_PROVIDERS.map(async (provider) => {
    try {
      const status = await providerAuthService.getProviderAuthStatus(provider);
      return { provider, installed: status.installed, authenticated: status.authenticated, runtimeAvailable: Boolean(runtimeSpawnFns[provider]) };
    } catch (error) {
      return { provider, installed: false, authenticated: false, runtimeAvailable: Boolean(runtimeSpawnFns[provider]), error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return {
    enabled: settings.enabled,
    activeCount: activeJobs.size,
    queuedCount: agentRelayDb.listActive().filter((job) => job.status === 'queued').length,
    mcpServerName: MCP_SERVER_NAME,
    skillName: SKILL_DIRECTORY_NAME,
    providers: providerStatuses,
  };
}

async function getCapabilities() {
  const settings = readSettings();
  const [status, catalogs] = await Promise.all([
    getRuntimeStatus(settings),
    Promise.all(settings.workerProviders.map(async (provider) => {
      const allowed = allowedWorkerModelsFor(settings, provider);
      try {
        const result = await providerModelsService.getProviderModels(provider);
        const models = result.models.OPTIONS
          .filter((model) => catalogModelIsAllowed(allowed, model))
          .map((model) => ({
            value: model.value,
            label: model.label,
            description: model.description,
            resolvedModel: model.resolvedModel,
            effort: model.effort,
          }));
        const unrestrictedDefault = result.models.DEFAULT;
        const defaultModel = allowed === null
          ? unrestrictedDefault
          : (unrestrictedDefault && allowed.includes(unrestrictedDefault) ? unrestrictedDefault : (models[0]?.value ?? null));
        return {
          provider,
          defaultModel,
          models,
          restricted: allowed !== null,
          readOnlyPlanSeat: READ_ONLY_PLAN_PROVIDERS.has(provider),
          honorsMcpGrants: MCP_GRANT_PROVIDERS.has(provider),
          cache: result.cache,
        };
      } catch (error) {
        return {
          provider,
          defaultModel: allowed?.[0] ?? null,
          models: [],
          restricted: allowed !== null,
          readOnlyPlanSeat: READ_ONLY_PLAN_PROVIDERS.has(provider),
          honorsMcpGrants: MCP_GRANT_PROVIDERS.has(provider),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })),
  ]);
  return {
    settings,
    status,
    catalogs,
    limits: {
      maxTasksPerBatch: MAX_TASKS_PER_BATCH,
      maxTaskChars: MAX_TASK_CHARS,
      maxConcurrency: settings.maxConcurrency,
      defaultTimeoutMs: settings.defaultTimeoutMs,
      maxTimeoutMs: MAX_TIMEOUT_MS,
      approvalTimeoutMs: settings.approvalTimeoutMs,
      maxWaitMs: 60_000,
      maxRetries: MAX_RETRIES,
      maxOutputSchemaChars: 8_000,
    },
    features: ['labels', 'modelIdentity', 'outputSchema', 'dependsOn', 'retries', 'usage', 'liveOutputPeek', 'followUp', 'isolatedWriteWorktrees', 'approvals', 'approvalPolicy'],
  };
}

// Escalations and decisions reach the chat panel through the same system-event
// channel as job updates, so a parked worker shows up without a poll.
configureRelayPermissionObserver({
  onEscalated: (approval) => {
    publish(agentRelayDb.get(approval.relay_id));
    broadcastSystemEvent({ kind: 'agent_relay_approval_updated', approval });
    const job = agentRelayDb.get(approval.relay_id);
    void import('@/modules/interrupt-queue/index.js').then(({ interruptsService }) => {
      interruptsService.create({
        projectId: job?.project_id ?? null,
        kind: 'approval_pending',
        severity: 'warning',
        title: `Relay worker needs approval: ${approval.tool_name || 'tool use'}`,
        body: [approval.command, approval.reason].filter(Boolean).join('\n') || approval.reason,
        runId: job?.run_id ?? null,
        href: job?.source_session_id ? `/session/${job.source_session_id}` : null,
        actions: [
          { id: 'approve_relay', label: 'Approve', style: 'primary' },
          { id: 'deny_relay', label: 'Deny', style: 'destructive' },
        ],
        expiresAt: new Date(Date.now() + (job ? readSettings().approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS)).toISOString(),
        dedupeKey: `relay-approval:${approval.approval_id}`,
        meta: { approvalId: approval.approval_id, relayId: approval.relay_id },
      });
    }).catch(() => undefined);
  },
  onSettled: (outcome) => {
    const approvalId = outcome.approvalId;
    if (!approvalId) return;
    const approval = agentRelayDb.getApproval(approvalId);
    publish(agentRelayDb.get(outcome.relayId));
    if (approval) broadcastSystemEvent({ kind: 'agent_relay_approval_updated', approval });
    void import('@/modules/interrupt-queue/index.js').then(({ interruptsService }) => {
      interruptsService.resolveRelayApproval(approvalId, outcome.via);
    }).catch(() => undefined);
  },
});

export const agentRelayService = {
  getSettings: readSettings,

  async updateSettings(patch: AgentRelaySettingsPatch): Promise<AgentRelaySettings> {
    const current = readSettings();
    const next: AgentRelaySettings = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      leadProviders: patch.leadProviders === undefined ? current.leadProviders : uniqueProviders(patch.leadProviders, current.leadProviders),
      workerProviders: patch.workerProviders === undefined ? current.workerProviders : uniqueProviders(patch.workerProviders, current.workerProviders),
      allowedWorkerModels: patch.allowedWorkerModels === undefined
        ? current.allowedWorkerModels
        : uniqueAllowedWorkerModels(patch.allowedWorkerModels),
      workerProfiles: patch.workerProfiles === undefined
        ? (current.workerProfiles ?? {})
        : uniqueWorkerProfiles(patch.workerProfiles),
      maxConcurrency: clampInteger(patch.maxConcurrency, current.maxConcurrency, 1, MAX_CONCURRENCY),
      defaultTimeoutMs: clampInteger(patch.defaultTimeoutMs, current.defaultTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      defaultMode: normalizeMode(patch.defaultMode, current.defaultMode),
      defaultApprovalPolicy: normalizeApprovalPolicy(patch.defaultApprovalPolicy, current.defaultApprovalPolicy),
      installSkill: typeof patch.installSkill === 'boolean' ? patch.installSkill : current.installSkill,
      approvalTimeoutMs: clampInteger(
        patch.approvalTimeoutMs,
        current.approvalTimeoutMs,
        MIN_APPROVAL_TIMEOUT_MS,
        MAX_APPROVAL_TIMEOUT_MS,
      ),
    };
    if (next.enabled && next.leadProviders.length === 0) {
      throw new AppError('Select at least one lead provider for the Agent Relay MCP.', { code: 'RELAY_LEAD_PROVIDER_REQUIRED', statusCode: 400 });
    }
    if (next.enabled && next.workerProviders.length === 0) {
      throw new AppError('Select at least one worker provider.', { code: 'RELAY_WORKER_PROVIDER_REQUIRED', statusCode: 400 });
    }
    if (next.enabled) {
      const usableWorkers = next.workerProviders.filter((provider) => {
        const allowed = allowedWorkerModelsFor(next, provider);
        return !allowed || allowed.length > 0;
      });
      if (usableWorkers.length === 0) {
        throw new AppError(
          'Select at least one worker model in Agent Relay settings, or turn off the per-agent limit.',
          { code: 'RELAY_WORKER_MODEL_REQUIRED', statusCode: 400 },
        );
      }
    }
    const integrationsChanged = next.enabled !== current.enabled
      || next.installSkill !== current.installSkill
      || !sameProviders(next.leadProviders, current.leadProviders);
    writeSettings(next);
    if (integrationsChanged) {
      try {
        await syncManagedIntegrations(next);
      } catch (error) {
        // Do not report settings as enabled when native MCP/skill fan-out did
        // not complete. A best-effort reverse sync also repairs partial writes.
        writeSettings(current);
        await syncManagedIntegrations(current).catch(() => undefined);
        throw error;
      }
    }
    if (current.enabled && !next.enabled) {
      for (const job of agentRelayDb.listActive()) {
        await agentRelayService.cancel(job.relay_id);
      }
    }
    if (next.enabled) void drainQueue();
    return next;
  },

  async syncIntegrations(): Promise<{ settings: AgentRelaySettings; warnings: string[] }> {
    const settings = readSettings();
    const warnings = await syncManagedIntegrations(settings);
    return { settings, warnings };
  },

  /**
   * Boot-time sync that also tears down stale managed artifacts when Relay is
   * disabled, without creating any artifacts for installs that never enabled
   * it. Without this, native MCP projections and skill copies from a previous
   * enabled state survive a disable-then-restart forever.
   */
  async syncIntegrationsOnBoot(): Promise<void> {
    const settings = readSettings();
    if (!settings.enabled) {
      const hasManagedSkill = (await globalSkillsService.listGlobalSkills())
        .some((skill) => skill.directoryName === SKILL_DIRECTORY_NAME);
      const hasCatalogEntry = (await mcpCatalogService.listCatalog()).some((entry) => entry.name === MCP_SERVER_NAME);
      if (!hasManagedSkill && !hasCatalogEntry) return;
    }
    await syncManagedIntegrations(settings);
  },

  async getStatus() {
    const settings = readSettings();
    return getRuntimeStatus(settings);
  },

  getCapabilities,

  async submitBatch(input: AgentRelayBatchInput): Promise<{ batchId: string; jobs: AgentRelayJob[] }> {
    const settings = readSettings();
    if (!settings.enabled) throw new AppError('Agent Relay is disabled in Settings.', { code: 'RELAY_DISABLED', statusCode: 409 });
    const projectPath = path.resolve(input.projectPath || process.cwd());
    await access(projectPath).catch(() => {
      throw new AppError(`Project path does not exist: ${projectPath}`, { code: 'RELAY_PROJECT_NOT_FOUND', statusCode: 404 });
    });
    if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > MAX_TASKS_PER_BATCH) {
      throw new AppError(`Provide between 1 and ${MAX_TASKS_PER_BATCH} relay tasks.`, { code: 'RELAY_TASKS_INVALID', statusCode: 400 });
    }
    if (settings.workerProviders.length === 0) {
      throw new AppError('Agent Relay has no allowed worker providers.', { code: 'RELAY_WORKER_PROVIDER_REQUIRED', statusCode: 409 });
    }
    const projectResult = projectsDb.createProjectPath(projectPath);
    const project = projectResult.project;
    if (!project) throw new AppError('Could not register the relay project.', { code: 'RELAY_PROJECT_INVALID', statusCode: 400 });
    const exhaustedBudget = projectBudgetExceeded(project.project_id);
    if (exhaustedBudget) {
      throw new AppError(exhaustedBudget, { code: 'RELAY_BUDGET_EXCEEDED', statusCode: 409 });
    }
    if (input.sourceSessionId) {
      const source = sessionsDb.getSessionById(input.sourceSessionId);
      if (!source || source.is_internal || source.project_path !== project.project_path) {
        throw new AppError('sourceSessionId must be an interactive session in the same project.', { code: 'RELAY_SOURCE_SESSION_INVALID', statusCode: 400 });
      }
    }

    // Normalize the complete batch before writing any rows. A malformed later
    // task must not strand earlier tasks as invisible queued work.
    const normalizedTasks = await Promise.all(input.tasks.map(async (task, index) => {
      const text = typeof task.task === 'string' ? task.task.trim() : '';
      if (!text || text.length > MAX_TASK_CHARS) {
        throw new AppError(`Relay task ${index + 1} must contain 1-${MAX_TASK_CHARS} characters.`, { code: 'RELAY_TASK_INVALID', statusCode: 400 });
      }
      const eligible = settings.workerProviders.filter((candidate) => {
        const allowed = allowedWorkerModelsFor(settings, candidate);
        return !allowed || allowed.length > 0;
      });
      const runnable = eligible.filter((candidate) => runtimeSpawnFns[candidate]);
      let pool = runnable.length > 0 ? runnable : eligible;
      // Auto-pick must honor the requested/default mode. Cursor has no plan
      // seat, so a read_only default used to land on it and then throw.
      const requestedMode = task.mode === 'isolated_write' || task.mode === 'read_only' ? task.mode : null;
      const poolMode = requestedMode ?? settings.defaultMode;
      if (poolMode === 'read_only') {
        const modeCapable = pool.filter((candidate) => providerSupportsReadOnlyRelay(candidate));
        if (modeCapable.length > 0) pool = modeCapable;
      }
      if (pool.length === 0) {
        throw new AppError(
          'No Agent Relay worker models are allowed. Pick models in Agent Relay settings.',
          { code: 'RELAY_WORKER_MODEL_REQUIRED', statusCode: 409 },
        );
      }
      const provider = task.provider ?? pool[workerCursor++ % pool.length]!;
      if (!settings.workerProviders.includes(provider)) {
        throw new AppError(`Provider "${provider}" is not allowed for Agent Relay.`, { code: 'RELAY_PROVIDER_NOT_ALLOWED', statusCode: 400 });
      }
      const allowed = allowedWorkerModelsFor(settings, provider);
      if (allowed && allowed.length === 0) {
        throw new AppError(
          `Provider "${provider}" has no allowed Agent Relay models. Pick models in Agent Relay settings.`,
          { code: 'RELAY_WORKER_MODEL_REQUIRED', statusCode: 400 },
        );
      }
      const profile = settings.workerProfiles?.[provider];
      const modeFallback = profile?.defaultMode ?? settings.defaultMode;
      const approvalFallback = profile?.defaultApprovalPolicy ?? settings.defaultApprovalPolicy;
      let mode = normalizeMode(task.mode, modeFallback);
      const approvalPolicy = normalizeApprovalPolicy(task.approvalPolicy, approvalFallback);
      if (mode === 'read_only' && !providerSupportsReadOnlyRelay(provider)) {
        // An explicit ask for read_only on an incapable provider is an honest
        // error. But when read_only only arrived via the default/profile
        // fallback (the lead just picked a provider and didn't think about
        // mode), silently containing it in isolated_write is friendlier than
        // failing the whole batch over a mode nobody actually requested.
        if (requestedMode === 'read_only') {
          throw new AppError(
            `Provider "${provider}" does not expose a host-enforceable read-only relay mode. Choose another worker or use isolated_write.`,
            { code: 'RELAY_READ_ONLY_UNSUPPORTED', statusCode: 400 },
          );
        }
        mode = 'isolated_write';
      }
      let modelIdentity: ReturnType<typeof resolveRelayModelIdentity>;
      let catalogModels: ProviderModelsDefinition | null = null;
      try {
        const catalog = await providerModelsService.getProviderModels(provider);
        catalogModels = catalog.models;
        modelIdentity = resolveRelayModelIdentity(
          settings,
          provider,
          typeof task.model === 'string' ? task.model : null,
          catalog.models,
        );
      } catch (error) {
        if (error instanceof AppError) {
          throw new AppError(`Relay task ${index + 1}: ${error.message}`, { code: error.code, statusCode: error.statusCode });
        }
        throw new AppError(
          `Relay task ${index + 1}: could not load the ${provider} model catalog: ${error instanceof Error ? error.message : String(error)}`,
          { code: 'RELAY_MODEL_CATALOG_UNAVAILABLE', statusCode: 409 },
        );
      }
      const label = typeof task.label === 'string' && task.label.trim() ? task.label.trim().slice(0, MAX_LABEL_CHARS) : null;
      let outputSchema: Record<string, unknown> | null = null;
      if (task.outputSchema !== undefined && task.outputSchema !== null) {
        outputSchema = normalizeDeclaredSchema(task.outputSchema);
        if (!outputSchema) {
          throw new AppError(
            `Relay task ${index + 1}: outputSchema must be a non-empty JSON Schema object under 8000 characters.`,
            { code: 'RELAY_OUTPUT_SCHEMA_INVALID', statusCode: 400 },
          );
        }
      }
      const dependsOnIndices = [...new Set(Array.isArray(task.dependsOn) ? task.dependsOn : [])];
      for (const dep of dependsOnIndices) {
        if (typeof dep !== 'number' || !Number.isInteger(dep) || dep < 0 || dep >= index) {
          throw new AppError(
            `Relay task ${index + 1}: dependsOn must list zero-based indices of earlier tasks in this batch.`,
            { code: 'RELAY_DEPENDS_ON_INVALID', statusCode: 400 },
          );
        }
      }
      const mcpServers = resolveWorkerMcpServers({
        provider,
        taskMcpServers: task.mcpServers,
        profile,
      });
      if (mcpServers.length > 0 && !providerHonorsRelayMcpGrants(provider)) {
        throw new AppError(
          `Provider "${provider}" cannot receive explicit Agent Relay MCP grants. Choose a provider that honors task MCP grants.`,
          { code: 'RELAY_MCP_GRANTS_UNSUPPORTED', statusCode: 400 },
        );
      }
      return {
        provider,
        ...modelIdentity,
        effort: resolveRelayEffort(task.effort, catalogModels, modelIdentity.model),
        mode,
        approvalPolicy,
        label,
        task: text,
        prompt: text,
        outputSchema,
        dependsOnIndices,
        retries: clampInteger(task.retries, 0, 0, MAX_RETRIES),
        mcpServers,
        timeoutMs: timeoutMs(task.timeoutMs, settings.defaultTimeoutMs),
      };
    }));
    const batchId = newRelayBatchId();
    // Ids are generated up front so in-batch dependency indices can be
    // resolved to durable relay ids before any row is written.
    const relayIds = normalizedTasks.map(() => newRelayJobId());
    const jobs = normalizedTasks.map((task, index) => {
      const { dependsOnIndices, ...rest } = task;
      return agentRelayDb.create({
        relayId: relayIds[index]!,
        batchId,
        projectId: project.project_id,
        projectPath: project.project_path,
        sourceSessionId: input.sourceSessionId ?? null,
        dependsOn: dependsOnIndices.map((dep) => relayIds[dep]!),
        ...rest,
      });
    });
    jobs.forEach(publish);
    void drainQueue();
    return { batchId, jobs };
  },

  /** Unscoped read for trusted server-internal callers only. */
  get(relayId: string): AgentRelayJob | null {
    return agentRelayDb.get(relayId);
  },

  /** Scoped read for the MCP surface: returns null for jobs the lead does not own. */
  getForScope(relayId: string, scope: AgentRelayScope): AgentRelayJob | null {
    const job = agentRelayDb.get(relayId);
    if (!job) return null;
    if (scope.allowUnscoped) return job;
    const caller = scope.sourceSessionId?.trim() || null;
    return caller && job.source_session_id === caller ? job : null;
  },

  list(input: {
    projectId?: string;
    batchId?: string;
    sourceSessionId?: string;
    relevantToSessionId?: string;
    active?: boolean;
    limit?: number;
  } = {}): AgentRelayJob[] {
    return agentRelayDb.list(input);
  },

  queuePositions(): Map<string, number> {
    return new Map(agentRelayDb.listAllQueued().map((job, index) => [job.relay_id, index + 1]));
  },

  /** Lifecycle guard used before a lead/worker session or project is deleted. */
  activeForSession(sessionId: string): AgentRelayJob[] {
    return agentRelayDb.listActive().filter((job) => job.source_session_id === sessionId || job.app_session_id === sessionId);
  },

  rehomeSourceSession(fromSessionId: string, toSessionId: string): number {
    return agentRelayDb.rehomeSourceSession(fromSessionId, toSessionId);
  },

  activeForProject(projectId: string): AgentRelayJob[] {
    return agentRelayDb.listActive().filter((job) => job.project_id === projectId);
  },

  /**
   * Compact job view for the MCP surface. Raw output can reach 100k characters
   * per worker, so fleet-wide reads (status, wait, delegate acks) return this
   * shape and the lead pulls one full result at a time via `relay_result`.
   */
  summarize(job: AgentRelayJob): AgentRelayJobSummary {
    let usage: AgentRelayJobSummary['usage'] = null;
    if (job.app_session_id) {
      try {
        const sessionUsage = runService.usageForSession(job.app_session_id);
        if (sessionUsage.runCount > 0) {
          usage = { totalTokens: sessionUsage.tokens || null, costUsd: sessionUsage.costUsd || null, runs: sessionUsage.runCount };
        }
      } catch {
        // Usage is advisory; a read failure must not break status.
      }
    }
    let structuredOutput = job.result?.structuredOutput;
    if (structuredOutput !== undefined) {
      const serialized = JSON.stringify(structuredOutput) ?? '';
      if (serialized.length > STRUCTURED_OUTPUT_PREVIEW_CHARS) {
        structuredOutput = { truncated: true, note: `Structured output is ${serialized.length} characters; fetch it with relay_result.` };
      }
    }
    return {
      relayId: job.relay_id,
      batchId: job.batch_id,
      label: job.label,
      provider: job.provider,
      model: job.model,
      requestedModel: job.requested_model,
      selectedModel: job.model,
      modelLabel: job.model_label,
      catalogDefaultModel: job.catalog_default_model,
      catalogResolvedModel: job.catalog_resolved_model,
      runtimeResolvedModel: job.runtime_resolved_model,
      modelSelectionSource: job.model_selection_source,
      effort: job.effort,
      mode: job.mode,
      approvalPolicy: job.approval_policy,
      status: job.status,
      queuePosition: job.status === 'queued' ? (agentRelayService.queuePositions().get(job.relay_id) ?? null) : null,
      task: job.task.length > 400 ? `${job.task.slice(0, 400)}…` : job.task,
      dependsOn: job.depends_on,
      error: job.error,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      timeoutMs: job.timeout_ms,
      attempt: job.attempt,
      retryCount: job.retry_count,
      pendingApprovalCount: agentRelayDb.listApprovals({ relayId: job.relay_id, status: 'pending', limit: 20 }).length,
      usage,
      result: job.result
        ? {
          status: job.result.status,
          summary: job.result.summary.length > SUMMARY_PREVIEW_CHARS
            ? `${job.result.summary.slice(0, SUMMARY_PREVIEW_CHARS)}… [truncated — full text via relay_result]`
            : job.result.summary,
          evidence: job.result.evidence.slice(0, 10),
          filesTouched: job.result.filesTouched.slice(0, 20),
          testsRun: job.result.testsRun.slice(0, 10),
          openQuestions: job.result.openQuestions.slice(0, 10),
          ...(structuredOutput !== undefined ? { structuredOutput } : {}),
          ...(job.result.outputValidation ? { outputValidation: job.result.outputValidation } : {}),
          hasFullOutput: Boolean(job.result.output),
          ...(job.result.workspace
            ? {
              workspace: {
                workspaceId: job.result.workspace.workspaceId,
                featureBranch: job.result.workspace.featureBranch,
                files: job.result.workspace.files.length,
                additions: job.result.workspace.additions,
                deletions: job.result.workspace.deletions,
              },
            }
            : {}),
        }
        : null,
    };
  },

  /** Full result for one job: complete summary, structured output, and raw output. */
  getResult(relayId: string, input: { includeOutput?: boolean; scope?: AgentRelayScope } = {}) {
    const job = requireOwnedJob(relayId, input.scope ?? { allowUnscoped: true });
    return {
      relayId: job.relay_id,
      label: job.label,
      provider: job.provider,
      model: job.model,
      requestedModel: job.requested_model,
      selectedModel: job.model,
      modelLabel: job.model_label,
      catalogDefaultModel: job.catalog_default_model,
      catalogResolvedModel: job.catalog_resolved_model,
      runtimeResolvedModel: job.runtime_resolved_model,
      modelSelectionSource: job.model_selection_source,
      effort: job.effort,
      mode: job.mode,
      approvalPolicy: job.approval_policy,
      status: job.status,
      error: job.error,
      result: job.result
        ? {
          ...job.result,
          output: input.includeOutput === false ? '' : job.result.output,
        }
        : null,
    };
  },

  /**
   * Live progress for one running job: what the worker has actually been doing.
   *
   * `relay_status` only carries a usable result once the worker has finished,
   * so a lead watching a long job has nothing to observe and looks idle. The
   * run spine already records every tool call, result, and permission event,
   * so this replays the recent trail plus liveness timing.
   *
   * Streaming prose is deliberately not persisted to the spine (the provider
   * transcript stays authoritative), so this is a tool-activity view, not a
   * transcript.
   */
  peek(relayId: string, input: { limit?: number; scope?: AgentRelayScope } = {}) {
    const job = requireOwnedJob(relayId, input.scope ?? { allowUnscoped: true });
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 100);
    const events = job.run_id ? runService.listEvents(job.run_id, { limit: 500, newest: true }) : [];
    const interesting = events.filter((event) => event.type === 'tool.call'
      || event.type === 'tool.result'
      || event.type === 'permission.requested'
      || event.type === 'permission.resolved'
      || event.type === 'run.status');
    const trail = interesting.slice(-limit).map((event) => ({
      at: event.ts,
      type: event.type,
      tool: (event.payload as AnyRecord | undefined)?.tool ?? null,
      detail: summarizeEventPayload(event.type, event.payload as AnyRecord | undefined),
    }));
    const startedAt = job.started_at ? Date.parse(`${job.started_at.replace(' ', 'T')}Z`) : null;
    const lastAt = interesting.length > 0 ? Date.parse(interesting[interesting.length - 1]!.ts) : null;
    const now = Date.now();
    const finishedAt = job.finished_at ? Date.parse(`${job.finished_at.replace(' ', 'T')}Z`) : null;
    const observationEnd = AGENT_RELAY_TERMINAL_STATUSES.has(job.status) && finishedAt ? finishedAt : now;
    const liveTail = liveOutputTails.get(job.relay_id);
    return {
      relayId: job.relay_id,
      status: job.status,
      provider: job.provider,
      model: job.model,
      requestedModel: job.requested_model,
      selectedModel: job.model,
      modelLabel: job.model_label,
      catalogDefaultModel: job.catalog_default_model,
      catalogResolvedModel: job.catalog_resolved_model,
      runtimeResolvedModel: job.runtime_resolved_model,
      modelSelectionSource: job.model_selection_source,
      effort: job.effort,
      mode: job.mode,
      label: job.label,
      task: job.task,
      elapsedMs: startedAt ? Math.max(0, observationEnd - startedAt) : null,
      timeoutMs: job.timeout_ms,
      // How long since the worker last did anything observable. A large value
      // on a `running` job is the signal that it is genuinely stuck.
      idleMs: lastAt ? Math.max(0, observationEnd - lastAt) : null,
      toolCallCount: interesting.filter((event) => event.type === 'tool.call').length,
      pendingApprovals: agentRelayDb.listApprovals({ relayId: job.relay_id, status: 'pending', limit: 20 }),
      recentActivity: trail,
      // Tail of the worker's streamed prose, in-memory only, so the lead can
      // read what a live worker is currently saying — not just its tool trail.
      recentOutput: liveTail?.text || null,
      result: job.result,
      error: job.error,
    };
  },

  /**
   * Pending out-of-envelope requests for the caller's own jobs. The lead polls
   * this (or reads it off `relay_status`) to unblock its workers.
   */
  listApprovals(input: {
    relayId?: string;
    /** Defaults to trusted; the MCP boundary always passes the caller's scope. */
    scope?: AgentRelayScope;
    status?: AgentRelayApproval['status'];
    limit?: number;
  }): AgentRelayApproval[] {
    const scope = input.scope ?? { allowUnscoped: true };
    if (input.relayId) requireOwnedJob(input.relayId, scope);
    return agentRelayDb.listApprovals({
      relayId: input.relayId,
      status: input.status,
      limit: input.limit,
      // An unidentifiable caller is scoped to a session id that cannot exist,
      // so it sees nothing rather than every session's requests.
      sourceSessionId: scope.allowUnscoped ? undefined : (scope.sourceSessionId?.trim() || '__unowned__'),
    });
  },

  /**
   * Records a lead or operator decision on one pending request and releases
   * the parked worker.
   */
  decideApproval(approvalId: string, input: {
    allow: boolean;
    reason?: string | null;
    decidedBy: 'lead' | 'operator';
    /** Defaults to trusted; the MCP boundary always passes the caller's scope. */
    scope?: AgentRelayScope;
  }): AgentRelayApproval {
    const approval = agentRelayDb.getApproval(approvalId);
    if (!approval) throw new AppError('Relay approval request not found.', { code: 'RELAY_APPROVAL_NOT_FOUND', statusCode: 404 });
    requireOwnedJob(approval.relay_id, input.scope ?? { allowUnscoped: true });
    const decided = agentRelayPermissionBroker.decide(approvalId, {
      allow: input.allow,
      reason: input.reason,
      decidedBy: input.decidedBy,
    });
    if (!decided) {
      throw new AppError(
        `This request was already ${approval.status === 'pending' ? 'answered' : approval.status}.`,
        { code: 'RELAY_APPROVAL_SETTLED', statusCode: 409 },
      );
    }
    publish(agentRelayDb.get(approval.relay_id));
    broadcastSystemEvent({ kind: 'agent_relay_approval_updated', approval: decided });
    return decided;
  },

  async wait(relayIds: string[], input: {
    returnWhen?: 'any' | 'all';
    timeoutMs?: number;
    scope?: AgentRelayScope;
  } = {}): Promise<{ timedOut: boolean; jobs: AgentRelayJob[]; pendingApprovals: AgentRelayApproval[] }> {
    const ids = [...new Set(relayIds.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
    if (ids.length === 0) throw new AppError('At least one relay id is required.', { code: 'RELAY_IDS_REQUIRED', statusCode: 400 });
    const scope = input.scope ?? { allowUnscoped: true };
    // Ownership is checked once, up front, so an unowned id fails loudly
    // instead of silently waiting out the full timeout.
    ids.forEach((id) => requireOwnedJob(id, scope));
    const returnWhen = input.returnWhen === 'all' ? 'all' : 'any';
    const maxWait = Math.min(Math.max(input.timeoutMs ?? 30_000, 0), 60_000);
    const deadline = Date.now() + maxWait;
    for (;;) {
      const jobs = ids.map((id) => agentRelayDb.get(id)).filter((job): job is AgentRelayJob => Boolean(job));
      const pendingApprovals = agentRelayDb
        .listApprovals({ status: 'pending', limit: 200 })
        .filter((approval) => ids.includes(approval.relay_id));
      const terminalCount = jobs.filter((job) => AGENT_RELAY_TERMINAL_STATUSES.has(job.status)).length;
      const ready = returnWhen === 'all' ? jobs.length === ids.length && terminalCount === jobs.length : terminalCount > 0;
      // A worker blocked on a decision this lead has to make is a reason to
      // hand control back now — waiting out the full budget would deadlock the
      // pair until the approval timeout fires.
      if (ready || pendingApprovals.length > 0) return { timedOut: false, jobs, pendingApprovals };
      if (Date.now() >= deadline) return { timedOut: true, jobs, pendingApprovals };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  },

  /**
   * Sends the lead's additional instructions to a delegate. A finished job is
   * resumed for another attempt exactly as before. A job that is still
   * running, queued, or parked on an approval receives it immediately: a live
   * worker gets it injected into its current turn when the provider supports
   * that, and everything else (no injection hook, injection failed, or the
   * worker has not started yet) queues it as `pending_follow_up`, delivered
   * as the prompt for the very next attempt instead of making the lead wait
   * for the job to finish first.
   */
  async followUp(relayId: string, prompt: string, requestedTimeoutMs?: number, scope: AgentRelayScope = { allowUnscoped: true }): Promise<AgentRelayJob> {
    const normalized = prompt.trim();
    if (!normalized || normalized.length > MAX_TASK_CHARS) throw new AppError('Follow-up prompt is required and must stay bounded.', { code: 'RELAY_FOLLOW_UP_INVALID', statusCode: 400 });
    const existing = requireOwnedJob(relayId, scope);

    if (AGENT_RELAY_TERMINAL_STATUSES.has(existing.status)) {
      const queued = agentRelayDb.queueFollowUp(relayId, normalized, requestedTimeoutMs ? timeoutMs(requestedTimeoutMs, existing.timeout_ms) : undefined);
      if (!queued) throw new AppError('Only a finished relay job can receive a follow-up.', { code: 'RELAY_NOT_FINISHED', statusCode: 409 });
      publish(queued);
      void drainQueue();
      return queued;
    }

    if (existing.status === 'running' || existing.status === 'waiting_approval') {
      if (await injectMidSessionFollowUp(existing, normalized)) {
        appendLiveOutput(relayId, `\n[Lead follow-up]\n${normalized}\n`);
        const current = agentRelayDb.get(relayId) ?? existing;
        publish(current);
        return current;
      }
    }

    // Not yet started, or live injection was not possible: hold it for the
    // job's very next attempt rather than dropping it.
    const updated = existing.status === 'queued'
      ? agentRelayDb.appendToLastPrompt(relayId, normalized)
      : agentRelayDb.appendPendingFollowUp(relayId, normalized);
    if (!updated) throw new AppError('This relay job could not accept a follow-up right now.', { code: 'RELAY_FOLLOW_UP_FAILED', statusCode: 409 });
    if (existing.status !== 'queued') appendLiveOutput(relayId, `\n[Lead follow-up queued for the worker's next turn]\n${normalized}\n`);
    publish(updated);
    return updated;
  },

  async cancel(relayId: string, scope: AgentRelayScope = { allowUnscoped: true }): Promise<AgentRelayJob> {
    const job = requireOwnedJob(relayId, scope);
    if (AGENT_RELAY_TERMINAL_STATUSES.has(job.status)) return job;
    const cancelled = agentRelayDb.finish(relayId, 'cancelled', { error: 'Cancelled by the requesting lead or operator.' });
    // Settle any parked request first so the worker is not blocked on a prompt
    // while we abort it.
    agentRelayPermissionBroker.releaseJob(relayId, 'The delegate was cancelled before this request was answered.');
    closeCanonicalRun(job.run_id, 'aborted', 'Cancelled by the requesting lead or operator.');
    publish(cancelled);
    // A provider abort can take tens of seconds. Persist and publish the
    // cancellation immediately, then reap the underlying process without
    // holding the MCP/HTTP response open.
    void abortLiveJob(job).catch(() => undefined);
    return cancelled ?? job;
  },

  async diff(relayId: string, includePatch = false, scope: AgentRelayScope = { allowUnscoped: true }) {
    const job = requireOwnedJob(relayId, scope);
    if (!job.workspace_id) return { relayId, workspace: null, files: [], summary: { additions: 0, deletions: 0 } };
    const existingWorkspace = workspaceService.get(job.workspace_id);
    if (!existingWorkspace) throw new AppError('Relay workspace was not found.', { code: 'RELAY_WORKSPACE_NOT_FOUND', statusCode: 404 });
    await workspaceService.refreshStatus(job.workspace_id);
    const workspace = workspaceService.get(job.workspace_id) ?? existingWorkspace;
    const diff = await workspaceService.getDiff(job.workspace_id);
    return {
      relayId,
      workspace,
      files: diff.files.map((file) => includePatch ? { ...file, patch: file.patch?.slice(0, 50_000) } : { path: file.path, status: file.status }),
      summary: diff.summary,
    };
  },

  getMcpToken: getOrCreateMcpToken,

  async purgeExpiredJobs(retentionDays = AGENT_RELAY_RETENTION_DAYS): Promise<{ jobsDeleted: number; workspacesDiscarded: number }> {
    const expired = agentRelayDb.listTerminalOlderThan(retentionDays);
    let workspacesDiscarded = 0;
    const seenWorkspaces = new Set<string>();
    for (const job of expired) {
      const workspaceId = job.workspace_id;
      if (!workspaceId || seenWorkspaces.has(workspaceId)) continue;
      seenWorkspaces.add(workspaceId);
      const workspace = workspaceService.get(workspaceId);
      if (!workspace) continue;
      // Isolated relay worktrees only — never the user's primary checkout.
      if (workspace.mode !== 'git_worktree' && workspace.mode !== 'sandbox_copy') continue;
      try {
        await workspaceService.discard(workspaceId, { deleteBranch: true });
        workspacesDiscarded += 1;
      } catch (error) {
        console.warn('[Agent Relay] failed to discard expired workspace', workspaceId, error);
      }
    }
    const jobsDeleted = agentRelayDb.purgeTerminalOlderThan(retentionDays);
    return { jobsDeleted, workspacesDiscarded };
  },

  recoverOnBoot(): number {
    activeJobs.clear();
    leadLastScheduled.clear();
    leadScheduleSequence = 0;
    agentRelayPermissionBroker.clearAll();
    const interrupted = agentRelayDb.listActive();
    const failed = agentRelayDb.failNonterminalOnBoot();
    agentRelayDb.expireAllPendingApprovals('CloudCLI restarted before this request was answered.');
    void this.purgeExpiredJobs().catch((error) => {
      console.error('[Agent Relay] retention purge failed', error);
    });
    for (const job of interrupted) {
      closeCanonicalRun(job.run_id, 'failed', 'CloudCLI restarted before this delegation finished.');
    }
    if (readSettings().enabled) void drainQueue();
    return failed;
  },

  mcpTokenMatches(supplied: string): boolean {
    return mcpTokensEqual(supplied, getOrCreateMcpToken());
  },
};
