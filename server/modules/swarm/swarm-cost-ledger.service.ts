/**
 * Swarm cost ledger — what each agent profile has ACTUALLY cost, from history.
 *
 * The alternative design (asking each candidate agent to bid its own token/time
 * cost before assignment) was rejected: a model has no introspective access to
 * its future compute, so a bid is a confabulated number that looks like data,
 * and an honest bid costs nearly as much as doing the work. `agent_runs` already
 * records what every swarm step really spent, so the orchestrator is given
 * measured statistics instead of self-reported estimates.
 *
 * The headline metric is **cost per SUCCESSFUL step**, not cost per step: a
 * cheap agent that fails half the time and forces a retry (or a hand-off to a
 * stronger seat) is expensive. Everything is bucketed by difficulty because a
 * profile's economics differ wildly between basic and advanced work.
 */

import { runsDb } from '@/modules/runs/index.js';

/** Statuses that mean the step run produced a usable result. */
const SUCCESS_STATUSES = new Set(['succeeded']);

/** Minimum observations before a bucket is allowed to influence a decision. */
export const MIN_LEDGER_SAMPLES = 3;

export type ProfileCostStats = {
  profileId: string;
  role: string;
  /** null = aggregated across every difficulty (the fallback bucket). */
  difficulty: string | null;
  /** Step runs observed in this bucket (all attempts). */
  runs: number;
  succeeded: number;
  /** Fraction of runs that succeeded (0..1). */
  successRate: number;
  /** Fraction of FIRST attempts that succeeded — the honest quality signal. */
  firstTrySuccessRate: number;
  /** Fraction of runs killed by the stall or hard-ceiling budget. */
  timeoutRate: number;
  /** Median total tokens of a successful run (null when unmeasured). */
  medianTokens: number | null;
  /** Median wall-clock of a successful run (null when unmeasured). */
  medianDurationMs: number | null;
  /**
   * Total observed spend divided by the number of SUCCESSFUL runs — the number
   * to rank on. Null when no cost was recorded or nothing has succeeded.
   */
  costPerSuccessUsd: number | null;
};

export type SwarmCostLedger = {
  /** Lookup by `profileId::role::difficulty`, falling back to `::role::*`. */
  get(profileId: string, role: string, difficulty?: string | null): ProfileCostStats | null;
  /** True when no swarm history exists at all (cold start). */
  isEmpty: boolean;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

type Bucket = {
  runs: number;
  succeeded: number;
  firstAttempts: number;
  firstAttemptSucceeded: number;
  timedOut: number;
  tokens: number[];
  durations: number[];
  costTotal: number;
};

function emptyBucket(): Bucket {
  return {
    runs: 0,
    succeeded: 0,
    firstAttempts: 0,
    firstAttemptSucceeded: 0,
    timedOut: 0,
    tokens: [],
    durations: [],
    costTotal: 0,
  };
}

function summarize(
  profileId: string,
  role: string,
  difficulty: string | null,
  bucket: Bucket,
): ProfileCostStats {
  return {
    profileId,
    role,
    difficulty,
    runs: bucket.runs,
    succeeded: bucket.succeeded,
    successRate: bucket.runs > 0 ? bucket.succeeded / bucket.runs : 0,
    firstTrySuccessRate:
      bucket.firstAttempts > 0 ? bucket.firstAttemptSucceeded / bucket.firstAttempts : 0,
    timeoutRate: bucket.runs > 0 ? bucket.timedOut / bucket.runs : 0,
    medianTokens: median(bucket.tokens),
    medianDurationMs: median(bucket.durations),
    costPerSuccessUsd:
      bucket.succeeded > 0 && bucket.costTotal > 0 ? bucket.costTotal / bucket.succeeded : null,
  };
}

/**
 * Build the ledger from run history. Cheap (one indexed query + in-memory
 * aggregation) and called once per planning pass, never per step.
 */
export function buildSwarmCostLedger(options?: {
  lookbackDays?: number;
  limit?: number;
}): SwarmCostLedger {
  let rows: ReturnType<typeof runsDb.listSwarmStepOutcomes>;
  try {
    rows = runsDb.listSwarmStepOutcomes(options);
  } catch {
    // History is an optimization: never let a ledger failure block planning.
    rows = [];
  }

  const exact = new Map<string, Bucket>();
  const anyDifficulty = new Map<string, Bucket>();

  const record = (map: Map<string, Bucket>, key: string, row: (typeof rows)[number]): void => {
    const bucket = map.get(key) ?? emptyBucket();
    bucket.runs += 1;
    const succeeded = SUCCESS_STATUSES.has(row.status);
    if (succeeded) bucket.succeeded += 1;
    if (row.attempt === 1) {
      bucket.firstAttempts += 1;
      if (succeeded) bucket.firstAttemptSucceeded += 1;
    }
    if (row.status === 'timed_out') bucket.timedOut += 1;
    // Only successful runs describe what the work costs; a run that died early
    // is cheap for the wrong reason and would flatter the profile.
    if (succeeded) {
      if (row.tokenTotal != null && row.tokenTotal > 0) bucket.tokens.push(row.tokenTotal);
      if (row.durationMs != null && row.durationMs > 0) bucket.durations.push(row.durationMs);
    }
    // Cost counts even for failures: a failed attempt still burned money, and
    // that is exactly what cost-per-success is meant to capture.
    if (row.costUsd != null && row.costUsd > 0) bucket.costTotal += row.costUsd;
    map.set(key, bucket);
  };

  for (const row of rows) {
    record(anyDifficulty, `${row.profileId}::${row.role}`, row);
    if (row.difficulty) record(exact, `${row.profileId}::${row.role}::${row.difficulty}`, row);
  }

  return {
    isEmpty: rows.length === 0,
    get(profileId, role, difficulty) {
      if (difficulty) {
        const bucket = exact.get(`${profileId}::${role}::${difficulty}`);
        if (bucket && bucket.runs >= MIN_LEDGER_SAMPLES) {
          return summarize(profileId, role, difficulty, bucket);
        }
      }
      // Too thin (or no difficulty asked for): fall back to the profile's
      // record in that role across all difficulties.
      const pooled = anyDifficulty.get(`${profileId}::${role}`);
      if (pooled && pooled.runs >= MIN_LEDGER_SAMPLES) {
        return summarize(profileId, role, null, pooled);
      }
      return null;
    },
  };
}

/** Compact one-line performance record for the orchestrator's candidate list. */
export function formatCostStats(stats: ProfileCostStats | null): string | null {
  if (!stats) return null;
  const bits = [
    `${stats.runs} step(s) observed${stats.difficulty ? ` at ${stats.difficulty}` : ' (all difficulties)'}`,
    `${Math.round(stats.firstTrySuccessRate * 100)}% first-try success`,
  ];
  if (stats.timeoutRate > 0) bits.push(`${Math.round(stats.timeoutRate * 100)}% timed out`);
  if (stats.medianTokens != null) bits.push(`median ${Math.round(stats.medianTokens / 1000)}k tokens`);
  if (stats.medianDurationMs != null) {
    bits.push(`median ${Math.max(1, Math.round(stats.medianDurationMs / 60_000))}m`);
  }
  if (stats.costPerSuccessUsd != null) {
    bits.push(`~$${stats.costPerSuccessUsd.toFixed(2)}/successful step`);
  }
  return bits.join(' · ');
}

/** Assumed first-try failure rate for a profile with no track record. */
const UNKNOWN_ASSUMED_FAILURE_RATE = 0.25;
/** Cost term used when spend was never recorded. */
const UNKNOWN_COST_TERM = 0.5;

/**
 * Rank two equally-eligible candidates by observed value. **Lower is better.**
 *
 * An untried candidate is scored with a neutral prior rather than 0, so it lands
 * BETWEEN a proven-reliable profile and a proven-flaky one: a profile with a
 * track record of succeeding is preferred over an unknown, and an unknown is
 * preferred over one that demonstrably fails. That ordering is the exploration
 * the retry ladder relies on — scoring unknowns as 0 would make "never used"
 * permanently beat "known good", so nothing would ever build a record.
 *
 * Reliability dominates cost: a cheap agent that fails is not cheap.
 */
export function candidateValueScore(stats: ProfileCostStats | null): number {
  const failureRate = stats ? 1 - stats.firstTrySuccessRate : UNKNOWN_ASSUMED_FAILURE_RATE;
  const timeoutRate = stats ? stats.timeoutRate : 0;
  // Cost is the tie-breaker, capped so a dollar of spend never outweighs a
  // meaningful difference in reliability.
  const costTerm =
    stats?.costPerSuccessUsd != null ? Math.min(stats.costPerSuccessUsd, 5) : UNKNOWN_COST_TERM;
  return failureRate * 10 + timeoutRate * 5 + costTerm;
}
