/**
 * Model Capability Registry — automated, cached capability assessment for every
 * model reachable through CloudCLI's provider runtimes.
 *
 * Replaces hand-maintained agent profiles as the swarm staffing source
 * (`swarm.autoStaffing`). Layered data sources, cheapest first:
 *
 *   L1  Provider model catalogs (`providerModelsService`) — ids, context,
 *       pricing where the provider advertises it. Refreshed daily.
 *   L2  Assessment snapshot shipped with the repo
 *       (`model-benchmarks.snapshot.json`) — explicitly labels each model-family
 *       score as heuristic or benchmark-backed. Exact model fragments prevent a
 *       new release from inheriting an older family's prior. Confidence decays.
 *   L3  Live outcome correction — the swarm cost ledger's per-(model × taskKind)
 *       success record nudges scores locally so an overrated newcomer is
 *       corrected within a few swarms without waiting for a snapshot update.
 *
 * Everything degrades gracefully: no network, no ledger history, or a missing
 * snapshot still yields a usable (if conservative) registry.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConnection } from '@/modules/database/index.js';
import { providerModelsService } from '@/modules/providers/index.js';
import { SWARM_PROVIDERS } from '@/modules/swarm/index.js';
import { buildSwarmCostLedger, MIN_LEDGER_SAMPLES } from '@/modules/swarm/swarm-cost-ledger.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** L1 refresh cadence. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** Confidence half-life for assessment data: after this age a score contributes half weight. */
export const BENCHMARK_HALF_LIFE_DAYS = 120;
/** Minimum ledger observations before live outcomes adjust a score. */
export const MIN_OUTCOME_SAMPLES = MIN_LEDGER_SAMPLES;

// ———————————————————————————————————————————————————————— schema

type CapabilityRow = {
  model_id: string;
  provider: string;
  display_name: string | null;
  context_window: number | null;
  max_context_window?: number | null;
  official_context_window?: number | null;
  input_cost_per_mtok: number | null;
  output_cost_per_mtok: number | null;
  coding_score: number;
  agentic_score: number;
  long_context_score: number;
  speed_score: number | null;
  confidence: number;
  source_json: string;
  aliases_json?: string | null;
  assessment_kind?: string | null;
  fetched_at: string;
  enabled?: number | null;
  available?: number | null;
};

function ensureSchema(): void {
  getConnection()
    .prepare(
      `CREATE TABLE IF NOT EXISTS model_capabilities (
         model_id             TEXT NOT NULL,
         provider             TEXT NOT NULL,
         display_name         TEXT,
         context_window       INTEGER,
         max_context_window   INTEGER,
         official_context_window INTEGER,
         input_cost_per_mtok  REAL,
         output_cost_per_mtok REAL,
         coding_score         REAL NOT NULL DEFAULT 0,
         agentic_score        REAL NOT NULL DEFAULT 0,
         long_context_score   REAL NOT NULL DEFAULT 0,
         speed_score          REAL,
         confidence           REAL NOT NULL DEFAULT 0.3,
         source_json          TEXT NOT NULL DEFAULT '{}',
         aliases_json         TEXT NOT NULL DEFAULT '[]',
         assessment_kind      TEXT NOT NULL DEFAULT 'heuristic',
         fetched_at           TEXT NOT NULL,
         enabled              INTEGER NOT NULL DEFAULT 1,
         available            INTEGER NOT NULL DEFAULT 1,
         PRIMARY KEY (provider, model_id)
       )`,
    )
    .run();
  try {
    getConnection()
      .prepare(`ALTER TABLE model_capabilities ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`)
      .run();
  } catch {
    /* column already exists */
  }
  for (const statement of [
    `ALTER TABLE model_capabilities ADD COLUMN max_context_window INTEGER`,
    `ALTER TABLE model_capabilities ADD COLUMN official_context_window INTEGER`,
    `ALTER TABLE model_capabilities ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE model_capabilities ADD COLUMN assessment_kind TEXT NOT NULL DEFAULT 'heuristic'`,
    `ALTER TABLE model_capabilities ADD COLUMN available INTEGER NOT NULL DEFAULT 1`,
  ]) {
    try {
      getConnection().prepare(statement).run();
    } catch {
      /* column already exists */
    }
  }
  getConnection()
    .prepare(
      `CREATE TABLE IF NOT EXISTS swarm_staffing_prefs (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         allowed_providers TEXT,
         default_orchestrator_provider TEXT,
         default_orchestrator_model TEXT,
         updated_at TEXT NOT NULL
       )`,
    )
    .run();
}

// ———————————————————————————————————————————————————————— types

export type ModelCapability = {
  modelId: string;
  provider: string;
  displayName: string | null;
  contextWindow: number | null;
  /** Largest context mode advertised by the installed runtime. */
  maxContextWindow: number | null;
  /** Provider-published capacity, kept distinct from the local runtime budget. */
  officialContextWindow: number | null;
  inputCostPerMtok: number | null;
  outputCostPerMtok: number | null;
  /** 0..1 coding assessment; consult assessmentKind before interpreting it. */
  codingScore: number;
  /** 0..1 agentic tool-use / terminal-work proxy. */
  agenticScore: number;
  /** 0..1 long-context handling proxy. */
  longContextScore: number;
  /** 0..1 relative throughput, null when unmeasured. */
  speedScore: number | null;
  /** 0..1 — decays with assessment age and thin source coverage. */
  confidence: number;
  sources: string[];
  /** Invocation aliases that resolve to this canonical model id. */
  aliases: string[];
  assessmentKind: 'heuristic' | 'benchmark' | 'catalog-only';
  fetchedAt: string;
  /** Settings toggle — disabled models are never auto-staffed. Default true. */
  enabled: boolean;
};

export type SwarmStaffingPrefs = {
  /** Null means every swarm-capable provider is allowed. */
  allowedProviders: string[] | null;
  defaultOrchestratorProvider: string | null;
  defaultOrchestratorModel: string | null;
};

export type StaffingQuery = {
  kind: 'orchestrator' | 'explorer' | 'implementer' | 'reviewer' | 'tester' | 'security' | 'docs' | 'custom';
  difficulty?: 'basic' | 'medium' | 'advanced' | null;
};

/**
 * Snapshot format (L2). One entry per model FAMILY; `match` lists id fragments
 * (lowercase) that map a concrete catalog id onto the family. Scores are 0..1.
 * Regenerate at release time — see scripts/ note at the bottom of this file.
 */
type BenchmarkFamily = {
  family: string;
  match: string[];
  coding: number;
  agentic: number;
  longContext: number;
  speed?: number;
  confidence?: number;
  assessmentKind?: 'heuristic' | 'benchmark';
  officialContextWindow?: number;
  asOf: string;
};

const CORE_FALLBACK_FAMILIES: BenchmarkFamily[] = [
  { family: "claude-opus-5", match: ["claude-opus-5"], coding: 0.95, agentic: 0.96, longContext: 0.94, speed: 0.65, confidence: 0.65, officialContextWindow: 1000000, asOf: "2026-08-25" },
  { family: "claude-opus-4.6", match: ["claude-opus-4.6", "claude-4.6-opus"], coding: 0.93, agentic: 0.94, longContext: 0.90, speed: 0.70, confidence: 0.65, officialContextWindow: 200000, asOf: "2026-08-25" },
  { family: "claude-fable-5", match: ["claude-fable-5"], coding: 0.91, agentic: 0.92, longContext: 0.90, speed: 0.70, confidence: 0.60, officialContextWindow: 1000000, asOf: "2026-08-25" },
  { family: "claude-sonnet-5", match: ["claude-sonnet-5"], coding: 0.94, agentic: 0.94, longContext: 0.92, speed: 0.82, confidence: 0.65, officialContextWindow: 200000, asOf: "2026-08-25" },
  { family: "claude-sonnet-4.6", match: ["claude-sonnet-4.6", "claude-4.6-sonnet"], coding: 0.92, agentic: 0.93, longContext: 0.90, speed: 0.84, confidence: 0.65, officialContextWindow: 200000, asOf: "2026-08-25" },
  { family: "claude-4-sonnet-class", match: ["claude-sonnet", "claude-4-sonnet", "sonnet"], coding: 0.88, agentic: 0.89, longContext: 0.86, speed: 0.85, confidence: 0.60, officialContextWindow: 200000, asOf: "2026-08-25" },
  { family: "claude-haiku-4-class", match: ["claude-haiku", "claude-3-haiku", "haiku"], coding: 0.74, agentic: 0.75, longContext: 0.74, speed: 0.96, confidence: 0.60, officialContextWindow: 200000, asOf: "2026-08-25" },
  { family: "gpt-5.6-sol", match: ["gpt-5.6-sol", "5.6-sol"], coding: 0.95, agentic: 0.94, longContext: 0.90, speed: 0.72, confidence: 0.65, officialContextWindow: 256000, asOf: "2026-08-25" },
  { family: "gpt-5.6-terra", match: ["gpt-5.6-terra", "5.6-terra"], coding: 0.90, agentic: 0.90, longContext: 0.88, speed: 0.82, confidence: 0.65, officialContextWindow: 256000, asOf: "2026-08-25" },
  { family: "gpt-5.6-luna", match: ["gpt-5.6-luna", "5.6-luna"], coding: 0.82, agentic: 0.82, longContext: 0.82, speed: 0.95, confidence: 0.60, officialContextWindow: 256000, asOf: "2026-08-25" },
  { family: "gemini-3.1-pro-class", match: ["gemini-3.1-pro", "gemini-pro-agent"], coding: 0.93, agentic: 0.94, longContext: 0.98, speed: 0.78, confidence: 0.65, officialContextWindow: 2000000, asOf: "2026-08-25" },
  { family: "gemini-flash-class", match: ["gemini-flash", "flash"], coding: 0.85, agentic: 0.86, longContext: 0.94, speed: 0.95, confidence: 0.60, officialContextWindow: 1000000, asOf: "2026-08-25" },
  { family: "deepseek-v4-pro", match: ["deepseek-v4-pro"], coding: 0.95, agentic: 0.93, longContext: 0.89, speed: 0.72, confidence: 0.65, officialContextWindow: 128000, asOf: "2026-08-25" },
  { family: "deepseek-v4-flash", match: ["deepseek-v4-flash"], coding: 0.89, agentic: 0.87, longContext: 0.86, speed: 0.95, confidence: 0.65, officialContextWindow: 128000, asOf: "2026-08-25" },
  { family: "deepseek-v3-class", match: ["deepseek-v3", "deepseek-chat", "deepseek"], coding: 0.88, agentic: 0.86, longContext: 0.85, speed: 0.88, confidence: 0.60, officialContextWindow: 128000, asOf: "2026-08-25" },
  { family: "deepseek-r1-class", match: ["deepseek-r1", "deepseek-reasoner"], coding: 0.95, agentic: 0.91, longContext: 0.88, speed: 0.62, confidence: 0.65, officialContextWindow: 128000, asOf: "2026-08-25" },
  { family: "glm-5.1", match: ["glm-5.1"], coding: 0.90, agentic: 0.89, longContext: 0.86, speed: 0.80, confidence: 0.65, officialContextWindow: 128000, asOf: "2026-08-25" },
  { family: "qwen3-coder-class", match: ["qwen3-coder", "qwen-3-coder", "qwq", "qwen-coder"], coding: 0.93, agentic: 0.90, longContext: 0.87, speed: 0.88, confidence: 0.65, officialContextWindow: 128000, asOf: "2026-08-25" },
  { family: "kimi-k2-class", match: ["kimi-k2", "kimi", "moonshot"], coding: 0.88, agentic: 0.87, longContext: 0.94, speed: 0.82, confidence: 0.60, officialContextWindow: 2000000, asOf: "2026-08-25" },
  { family: "grok-4.6", match: ["grok-4.6"], coding: 0.93, agentic: 0.93, longContext: 0.89, speed: 0.80, confidence: 0.65, officialContextWindow: 128000, asOf: "2026-08-25" },
  { family: "grok-4-class", match: ["grok-4", "grok"], coding: 0.89, agentic: 0.89, longContext: 0.87, speed: 0.84, confidence: 0.60, officialContextWindow: 128000, asOf: "2026-08-25" },
];

let snapshotCache: BenchmarkFamily[] | null = null;

function loadSnapshot(): BenchmarkFamily[] {
  if (snapshotCache && snapshotCache.length > 0) return snapshotCache;
  const candidatePaths = [
    path.join(__dirname, "model-benchmarks.snapshot.json"),
    path.resolve(__dirname, "../../../server/modules/swarm/model-benchmarks.snapshot.json"),
    path.resolve(process.cwd(), "server/modules/swarm/model-benchmarks.snapshot.json"),
    path.resolve(process.cwd(), "dist-server/server/modules/swarm/model-benchmarks.snapshot.json"),
  ];
  for (const candidate of candidatePaths) {
    try {
      if (fsSync.existsSync(candidate)) {
        const raw = fsSync.readFileSync(candidate, "utf8");
        const parsed = JSON.parse(raw) as { families?: BenchmarkFamily[] };
        if (Array.isArray(parsed.families) && parsed.families.length > 0) {
          snapshotCache = parsed.families;
          return snapshotCache;
        }
      }
    } catch {
      // try next candidate
    }
  }
  snapshotCache = CORE_FALLBACK_FAMILIES;
  return snapshotCache;
}

// ———————————————————————————————————————————————————————— matching

/** Extract a comparable version tuple from a model id ("gemini-3.5-flash" → [3,5]). */
function versionOf(id: string): number[] {
  const matches = id.match(/(\d+)(?:[.-](\d+))?(?:[.-](\d+))?/);
  if (!matches) return [];
  return matches.slice(1).filter(Boolean).map(Number);
}

/**
 * Match a concrete catalog model id to the best assessment family. Longest
 * matching fragment wins; among same-fragment families the closest version
 * wins so "gemini-3.5-flash" does not inherit "gemini-2.5" numbers.
 */
export function matchBenchmarkFamily(modelId: string): BenchmarkFamily | null {
  const id = modelId.toLowerCase();
  const cleanId = normalizeCatalogModelId(modelId);
  const families = loadSnapshot();
  let best: { family: BenchmarkFamily; fragLen: number; dist: number } | null = null;
  for (const family of families) {
    for (const fragment of family.match) {
      const matchesRaw = id.includes(fragment);
      const matchesClean = cleanId.includes(fragment);
      if (!matchesRaw && !matchesClean) continue;
      const dist = Math.min(
        matchesRaw ? versionDistance(id, fragment, family) : 99,
        matchesClean ? versionDistance(cleanId, fragment, family) : 99,
      );
      const candidate = { family, fragLen: fragment.length, dist };
      const better =
        !best ||
        candidate.fragLen > best.fragLen ||
        (candidate.fragLen === best.fragLen && candidate.dist < best.dist);
      if (better) best = candidate;
    }
  }
  return best?.family ?? null;
}

function versionDistance(id: string, fragment: string, family: BenchmarkFamily): number {
  const base = versionOf(fragment);
  const actual = versionOf(id);
  const ref = versionOf(family.family);
  // Prefer the family whose reference version is nearest the model's version.
  const target = actual.length > 0 ? actual : base;
  if (ref.length === 0 || target.length === 0) return 99;
  const d = Math.abs((ref[0] ?? 0) - (target[0] ?? 0)) * 10 + Math.abs((ref[1] ?? 0) - (target[1] ?? 0));
  return d;
}

function confidenceFor(family: BenchmarkFamily | null, hasPricing: boolean): number {
  if (!family) return hasPricing ? 0.25 : 0.15;
  const ageDays = Math.max(0, (Date.now() - Date.parse(family.asOf)) / 86_400_000);
  const decay = Math.pow(0.5, ageDays / BENCHMARK_HALF_LIFE_DAYS);
  if (family.confidence != null) {
    // Heuristic snapshots carry an explicit capped confidence. Age may lower it,
    // but must never make a positioning prior look like measured benchmark data.
    return Math.max(0.15, family.confidence * (0.5 + 0.5 * decay));
  }
  return Math.min(0.95, 0.55 + 0.4 * decay);
}

export function normalizeCatalogModelId(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/^(?:openrouter\/~?|anthropic\/|google\/|meta-llama\/|cursor\/|cline\/|xai\/|stepfun\/|z-ai\/|sao10k\/)/i, "")
    .trim();
}

export function inferHeuristicCapability(
  modelId: string,
  provider: string,
  contextWindow: number | null,
  inputCost: number | null,
  outputCost: number | null,
): {
  coding: number;
  agentic: number;
  longContext: number;
  speed: number;
  confidence: number;
  officialContextWindow: number;
} {
  const id = normalizeCatalogModelId(modelId);

  // 1. Determine official context window
  let officialContextWindow = contextWindow ?? 128_000;
  if (contextWindow == null) {
    if (id.includes("[1m]") || id.includes("1m") || id.includes("1000k") || id.includes("gemini") || id.includes("kimi")) {
      officialContextWindow = 1_000_000;
    } else if (id.includes("claude") || id.includes("opus") || id.includes("sonnet")) {
      officialContextWindow = 200_000;
    } else if (id.includes("gpt-5") || id.includes("sol") || id.includes("terra")) {
      officialContextWindow = 256_000;
    } else {
      officialContextWindow = 128_000;
    }
  }

  // 2. Identify capability tier from naming conventions
  const isReasoning = /\b(?:r1|reason|reasoner|reasoning|thinking|thought|o1|o3|o4|qwq)\b/i.test(id);
  const isFrontier = /\b(?:opus|sol|max|pro|plus|large|ultra|405b|70b)\b/i.test(id);
  const isMidTier = /\b(?:sonnet|terra|medium|32b|33b|27b|14b|coder|code)\b/i.test(id);
  const isLightweight = /\b(?:mini|flash|luna|haiku|lite|micro|small|edge|8b|7b|3b|1b|nano)\b/i.test(id);

  let coding = 0.82;
  let agentic = 0.82;
  let longContext = 0.82;
  let speed = 0.85;

  if (isReasoning) {
    coding = 0.94;
    agentic = 0.91;
    longContext = 0.88;
    speed = 0.62;
  } else if (isFrontier) {
    coding = 0.90;
    agentic = 0.90;
    longContext = 0.88;
    speed = 0.78;
  } else if (isLightweight) {
    coding = 0.75;
    agentic = 0.76;
    longContext = 0.78;
    speed = 0.95;
  } else if (isMidTier) {
    coding = 0.86;
    agentic = 0.85;
    longContext = 0.85;
    speed = 0.85;
  }

  // Context size correlates with long-context capability
  if (officialContextWindow >= 1_000_000) {
    longContext = Math.max(longContext, 0.95);
  } else if (officialContextWindow >= 200_000) {
    longContext = Math.max(longContext, 0.88);
  }

  // Pricing correlation
  if (outputCost != null && outputCost > 10) {
    coding = Math.min(0.96, coding + 0.03);
    agentic = Math.min(0.96, agentic + 0.03);
  } else if (outputCost != null && outputCost < 0.5) {
    speed = Math.min(0.98, speed + 0.04);
  }

  const confidence = outputCost != null ? 0.55 : 0.50;

  return {
    coding,
    agentic,
    longContext,
    speed,
    confidence,
    officialContextWindow,
  };
}


// ———————————————————————————————————————————————————————— live outcome correction (L3)

type OutcomeCorrection = { multiplier: number; samples: number };

/**
 * Local correction from real swarm outcomes: models that keep failing a task
 * kind get their effective score multiplied down (and vice versa). Bounded to
 * ±35% so a handful of runs can never fully invert snapshot evidence.
 */
export function outcomeCorrection(modelId: string, kind: string): OutcomeCorrection {
  try {
    const ledger = buildSwarmCostLedger();
    const stats = ledger.get(modelId, kind);
    if (!stats || stats.runs < MIN_OUTCOME_SAMPLES) return { multiplier: 1, samples: stats?.runs ?? 0 };
    const rate = stats.firstTrySuccessRate;
    const pull = (rate - 0.6) / 0.6; // >0 when better than 60% first-try
    const multiplier = Math.max(0.65, Math.min(1.35, 1 + 0.35 * pull));
    return { multiplier, samples: stats.runs };
  } catch {
    return { multiplier: 1, samples: 0 };
  }
}

// ———————————————————————————————————————————————————————— refresh & read

function rowToCapability(row: CapabilityRow): ModelCapability {
  let sources: string[] = [];
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(row.source_json) as string[];
    if (Array.isArray(parsed)) sources = parsed;
  } catch { /* keep empty */ }
  try {
    const parsed = JSON.parse(row.aliases_json ?? '[]') as string[];
    if (Array.isArray(parsed)) aliases = parsed;
  } catch { /* keep empty */ }
  return {
    modelId: row.model_id,
    provider: row.provider,
    displayName: row.display_name,
    contextWindow: row.context_window,
    maxContextWindow: row.max_context_window ?? null,
    officialContextWindow: row.official_context_window ?? null,
    inputCostPerMtok: row.input_cost_per_mtok,
    outputCostPerMtok: row.output_cost_per_mtok,
    codingScore: row.coding_score,
    agenticScore: row.agentic_score,
    longContextScore: row.long_context_score,
    speedScore: row.speed_score,
    confidence: row.confidence,
    sources,
    aliases,
    assessmentKind:
      row.assessment_kind === 'benchmark' || row.assessment_kind === 'heuristic'
        ? row.assessment_kind
        : 'catalog-only',
    fetchedAt: row.fetched_at,
    enabled: row.enabled !== 0,
  };
}

export type CanonicalCatalogModel = {
  modelId: string;
  record: Record<string, unknown>;
  aliases: string[];
};

/** Collapse provider invocation aliases onto the concrete model they resolve to. */
export function canonicalizeCatalogModels(models: Array<Record<string, unknown>>): CanonicalCatalogModel[] {
  const canonicalModels = new Map<string, CanonicalCatalogModel>();
  for (const record of models) {
    const invocationId = String(record.value ?? '').trim();
    if (!invocationId) continue;
    const resolvedModel = typeof record.resolvedModel === 'string' ? record.resolvedModel.trim() : '';
    const modelId = resolvedModel || invocationId;
    const existing = canonicalModels.get(modelId);
    if (existing) {
      if (!existing.aliases.includes(invocationId)) existing.aliases.push(invocationId);
      if (String(existing.record.value ?? '') === 'default' && invocationId !== 'default') {
        existing.record = record;
      }
      continue;
    }
    canonicalModels.set(modelId, { modelId, record, aliases: [invocationId] });
  }
  return [...canonicalModels.values()];
}

/** Effective score after live-outcome correction. */
export function effectiveScore(capability: ModelCapability, kind: string, baseScore = capability.codingScore): number {
  const { multiplier } = outcomeCorrection(capability.modelId, kind);
  return Math.max(0, Math.min(1, baseScore * multiplier));
}

/** Role-aware routing score. Basic work favors fast worker models over frontier models. */
export function capabilityScoreForTask(capability: ModelCapability, query: StaffingQuery): number {
  const roleScore =
    query.kind === 'orchestrator' || query.kind === 'explorer'
      ? capability.agenticScore * 0.6 + capability.longContextScore * 0.4
      : query.kind === 'docs'
        ? capability.codingScore * 0.45 + (capability.speedScore ?? capability.codingScore) * 0.55
        : capability.codingScore;
  const speed = capability.speedScore ?? roleScore;
  const difficultyAdjusted =
    query.difficulty === 'basic'
      ? roleScore * 0.45 + speed * 0.55
      : query.difficulty === 'medium'
        ? roleScore * 0.8 + speed * 0.2
        : roleScore;
  return effectiveScore(capability, query.kind, difficultyAdjusted);
}

/** Refresh L1 catalogs for every swarm-capable provider and recompute vectors. */
export async function refreshModelRegistry(options: { providers?: string[] } = {}): Promise<{
  refreshed: number;
  errors: string[];
}> {
  ensureSchema();
  const providers = options.providers ?? SWARM_PROVIDERS;
  const errors: string[] = [];
  let refreshed = 0;
  const nowIso = new Date().toISOString();
  if (providers.length === 0) return { refreshed, errors };

  for (const provider of providers) {
    try {
      const result = await providerModelsService.getProviderModels(provider as never, {
        bypassCache: true,
      });
      // ProviderModelsDefinition: { OPTIONS: [{ value, label }], DEFAULT }
      const options = (result?.models as { OPTIONS?: Array<Record<string, unknown>> } | undefined)?.OPTIONS;
      const models = Array.isArray(options) ? options : [];
      const canonicalModels = canonicalizeCatalogModels(models);
      if (canonicalModels.length > 0) {
        // Keep disappeared rows (and their user enable preference) but remove
        // them from active inventory until the provider advertises them again.
        getConnection().prepare(`UPDATE model_capabilities SET available = 0 WHERE provider = ?`).run(provider);
      }
      for (const { modelId, record, aliases } of canonicalModels) {
        const displayName = typeof record.label === 'string' ? record.label : null;
        const family = matchBenchmarkFamily(modelId);
        const contextWindow =
          typeof record.runtimeContextWindow === 'number'
            ? record.runtimeContextWindow
            : typeof record.context_window === 'number'
              ? record.context_window
              : typeof record.contextWindow === 'number'
                ? (record.contextWindow as number)
                : typeof record.max_tokens === 'number'
                  ? (record.max_tokens as number)
                  : aliases.some((alias) => alias.includes('[1m]')) || modelId.includes('[1m]')
                    ? 1_000_000
                    : null;
        const maxContextWindow =
          typeof record.runtimeMaxContextWindow === 'number'
            ? record.runtimeMaxContextWindow
            : typeof record.max_context_window === 'number'
              ? record.max_context_window
              : null;
        const inputCost = pickCost(record, ['input_cost_per_mtok', 'inputCost', 'pricing_input']);
        const outputCost = pickCost(record, ['output_cost_per_mtok', 'outputCost', 'pricing_output']);
        const heuristic = !family
          ? inferHeuristicCapability(modelId, provider, contextWindow, inputCost, outputCost)
          : null;
        const officialContextWindow =
          typeof record.officialContextWindow === 'number'
            ? record.officialContextWindow
            : family?.officialContextWindow ?? heuristic?.officialContextWindow ?? (contextWindow ?? 128_000);
        const assessmentKind = family ? (family.assessmentKind ?? 'heuristic') : 'heuristic';
        const capability: ModelCapability = {
          modelId,
          provider,
          displayName,
          contextWindow,
          maxContextWindow,
          officialContextWindow,
          inputCostPerMtok: inputCost,
          outputCostPerMtok: outputCost,
          codingScore: family?.coding ?? heuristic?.coding ?? 0.80,
          agenticScore: family?.agentic ?? heuristic?.agentic ?? 0.80,
          longContextScore: family?.longContext ?? heuristic?.longContext ?? 0.80,
          speedScore: family?.speed ?? heuristic?.speed ?? 0.85,
          confidence: family ? confidenceFor(family, inputCost != null) : (heuristic?.confidence ?? 0.50),
          sources: family ? ['provider-catalog', `${assessmentKind}-snapshot`] : ['provider-catalog', 'heuristic-assessment'],
          aliases,
          assessmentKind,
          fetchedAt: nowIso,
          enabled: true,
        };
        upsert(capability);
        refreshed += 1;
      }
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { refreshed, errors };
}

function pickCost(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function upsert(capability: ModelCapability): void {
  getConnection()
    .prepare(
      `INSERT INTO model_capabilities (
         model_id, provider, display_name, context_window, max_context_window, official_context_window,
         input_cost_per_mtok, output_cost_per_mtok,
         coding_score, agentic_score, long_context_score, speed_score,
         confidence, source_json, aliases_json, assessment_kind, fetched_at, enabled, available
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(provider, model_id) DO UPDATE SET
         display_name=excluded.display_name,
         context_window=excluded.context_window,
         max_context_window=excluded.max_context_window,
         official_context_window=excluded.official_context_window,
         input_cost_per_mtok=excluded.input_cost_per_mtok,
         output_cost_per_mtok=excluded.output_cost_per_mtok,
         coding_score=excluded.coding_score,
         agentic_score=excluded.agentic_score,
         long_context_score=excluded.long_context_score,
         speed_score=excluded.speed_score,
         confidence=excluded.confidence,
         source_json=excluded.source_json,
         aliases_json=excluded.aliases_json,
         assessment_kind=excluded.assessment_kind,
         fetched_at=excluded.fetched_at,
         enabled=COALESCE(model_capabilities.enabled, excluded.enabled),
         available=1`
    )
    .run(
      capability.modelId,
      capability.provider,
      capability.displayName,
      capability.contextWindow,
      capability.maxContextWindow,
      capability.officialContextWindow,
      capability.inputCostPerMtok,
      capability.outputCostPerMtok,
      capability.codingScore,
      capability.agenticScore,
      capability.longContextScore,
      capability.speedScore,
      capability.confidence,
      JSON.stringify(capability.sources),
      JSON.stringify(capability.aliases),
      capability.assessmentKind,
      capability.fetchedAt,
      capability.enabled ? 1 : 0,
    );
}

export function listModelCapabilities(): ModelCapability[] {
  ensureSchema();
  const rows = getConnection()
    .prepare(`SELECT * FROM model_capabilities WHERE available != 0 ORDER BY coding_score DESC, model_id ASC`)
    .all() as CapabilityRow[];
  return rows.map(rowToCapability);
}

/**
 * Enabled registry ids (canonical + aliases) for a provider.
 * Returns `null` when the registry has no enabled rows for that provider,
 * meaning Agent Relay should not restrict by profiles.
 */
export function enabledRegistryModelIdsForProvider(provider: string): string[] | null {
  const enabled = listModelCapabilities().filter((capability) => (
    capability.provider === provider && capability.enabled
  ));
  if (enabled.length === 0) return null;
  const ids = new Set<string>();
  for (const capability of enabled) {
    ids.add(capability.modelId);
    for (const alias of capability.aliases) {
      if (alias.trim()) ids.add(alias);
    }
  }
  return [...ids];
}

export function setModelEnabled(provider: string, modelId: string, enabled: boolean): boolean {
  ensureSchema();
  const result = getConnection()
    .prepare(`UPDATE model_capabilities SET enabled = ? WHERE provider = ? AND model_id = ?`)
    .run(enabled ? 1 : 0, provider, modelId);
  return result.changes > 0;
}

export function getStaffingPrefs(): SwarmStaffingPrefs {
  ensureSchema();
  const row = getConnection()
    .prepare(
      `SELECT allowed_providers, default_orchestrator_provider, default_orchestrator_model
       FROM swarm_staffing_prefs WHERE id = 1`,
    )
    .get() as {
      allowed_providers: string | null;
      default_orchestrator_provider: string | null;
      default_orchestrator_model: string | null;
    } | undefined;
  if (!row) {
    return {
      allowedProviders: null,
      defaultOrchestratorProvider: null,
      defaultOrchestratorModel: null,
    };
  }
  let allowedProviders: string[] | null = null;
  if (row.allowed_providers) {
    try {
      const parsed = JSON.parse(row.allowed_providers) as unknown;
      if (Array.isArray(parsed)) {
        allowedProviders = parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      }
    } catch {
      allowedProviders = null;
    }
  }
  return {
    allowedProviders,
    defaultOrchestratorProvider: row.default_orchestrator_provider,
    defaultOrchestratorModel: row.default_orchestrator_model,
  };
}

export function setStaffingPrefs(patch: Partial<SwarmStaffingPrefs>): SwarmStaffingPrefs {
  ensureSchema();
  const current = getStaffingPrefs();
  const next: SwarmStaffingPrefs = {
    allowedProviders:
      patch.allowedProviders === undefined ? current.allowedProviders : patch.allowedProviders,
    defaultOrchestratorProvider:
      patch.defaultOrchestratorProvider === undefined
        ? current.defaultOrchestratorProvider
        : patch.defaultOrchestratorProvider,
    defaultOrchestratorModel:
      patch.defaultOrchestratorModel === undefined
        ? current.defaultOrchestratorModel
        : patch.defaultOrchestratorModel,
  };
  getConnection()
    .prepare(
      `INSERT INTO swarm_staffing_prefs (
         id, allowed_providers, default_orchestrator_provider, default_orchestrator_model, updated_at
       ) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         allowed_providers=excluded.allowed_providers,
         default_orchestrator_provider=excluded.default_orchestrator_provider,
         default_orchestrator_model=excluded.default_orchestrator_model,
         updated_at=excluded.updated_at`,
    )
    .run(
      next.allowedProviders ? JSON.stringify(next.allowedProviders) : null,
      next.defaultOrchestratorProvider,
      next.defaultOrchestratorModel,
      new Date().toISOString(),
    );
  return next;
}

/** True when the L1 catalog data is older than the TTL (drives UI staleness hints). */
export function registryIsStale(): boolean {
  ensureSchema();
  const row = getConnection()
    .prepare(`SELECT MAX(fetched_at) AS latest FROM model_capabilities`)
    .get() as { latest: string | null };
  if (!row.latest) return true;
  return Date.now() - Date.parse(row.latest) > CATALOG_TTL_MS;
}

/**
 * Rank candidates for a staffing query. **Best first.** Cost-efficiency
 * frontier: within the models meeting the capability threshold, cheapest
 * expected cost per task wins. Thresholds scale with difficulty; low-confidence
 * entries are treated conservatively (their score is shrunk toward 0).
 */
export function rankCandidatesForTask(
  query: StaffingQuery,
  options: { allowedProviders?: string[]; limit?: number } = {},
): ModelCapability[] {
  ensureSchema();
  const prefs = getStaffingPrefs();
  const allowed = options.allowedProviders ?? prefs.allowedProviders ?? undefined;
  const all = listModelCapabilities().filter((c) => {
    if (!c.enabled) return false;
    if (!allowed) return true;
    return allowed.includes(c.provider);
  });
  const difficultyFloor =
    query.difficulty === 'advanced' ? 0.7 : query.difficulty === 'medium' ? 0.45 : 0.35;
  const scored = all.map((capability) => {
    const taskScore = capabilityScoreForTask(capability, query);
    const conservative = taskScore * (0.5 + 0.5 * capability.confidence);
    const meetsBar = conservative >= difficultyFloor;
    const estCost =
      capability.outputCostPerMtok != null
        ? capability.outputCostPerMtok
        : capability.inputCostPerMtok != null
          ? capability.inputCostPerMtok * 4
          : 5; // neutral prior when pricing is unknown
    // Rank key: qualify first, then cheapness, then raw quality.
    const rankKey = (meetsBar ? 0 : 1000) + estCost / (conservative + 0.05);
    return { capability, rankKey, meetsBar };
  });
  scored.sort((a, b) => a.rankKey - b.rankKey);
  return scored.slice(0, options.limit ?? 8).map((entry) => entry.capability);
}

/** Persist a manually-provided or probe-derived capability vector (L4 hook). */
export function upsertModelCapability(capability: ModelCapability): void {
  ensureSchema();
  upsert(capability);
}

/** Export the current registry as the snapshot shape (release-tooling helper). */
export async function exportSnapshot(filePath: string): Promise<void> {
  const capabilities = listModelCapabilities();
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: 'Generated by model-registry.service.ts exportSnapshot — edit scores before shipping.',
        families: loadSnapshot(),
        capabilities,
      },
      null,
      2,
    ),
  );
}
