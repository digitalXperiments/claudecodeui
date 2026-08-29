/**
 * Swarm dynamic-engine guardrails — the feedback-loop pitfall mitigations from
 * `docs/prd/dynamic-swarm-and-model-registry.md` §9, as pure testable units:
 *
 *   P1  digestDecisions      — orchestrator context budget for supervisor history
 *   P2  stepLineageDepth     — remediation-chain cap (anti ping-pong)
 *   P2  ProgressTracker      — two zero-progress cycles force a rethink
 *   P2  reviewHasEvidence    — "needs changes" must cite specifics (hysteresis)
 *   P4  splitCanaryGroup     — validate an approach on one seat before fanning out
 *   P6  needsDriftAudit      — periodic orchestrator re-grounding signal
 *   P7  finishModeVerdict    — escape-reserve: consolidate instead of death-spiral
 *   P8  isSlowFailure        — slow-fail preemption in the retry ladder
 */

import type { SwarmPlanStep, SwarmSupervisorDecision } from '@/modules/swarm/swarm.types.js';

// —————————————————————————————————————————————— P1: context budget

export const MAX_PERSISTED_DECISIONS = 40;
/** How many recent decisions are shown verbatim in a supervisor prompt. */
export const PROMPT_DECISION_WINDOW = 6;

export type DecisionDigest = {
  /** The decisions to keep verbatim (most recent). */
  kept: SwarmSupervisorDecision[];
  /** One-line summary of everything dropped, or null when nothing was dropped. */
  digest: string | null;
};

/**
 * Cap the persisted decision log and summarize what was dropped, so long
 * supervisor sessions neither grow the goal-card JSON unboundedly nor lose the
 * arc of the story to a silent truncation.
 */
export function digestDecisions(
  decisions: SwarmSupervisorDecision[],
  maxPersisted = MAX_PERSISTED_DECISIONS,
): DecisionDigest {
  if (decisions.length <= maxPersisted) {
    return { kept: decisions, digest: null };
  }
  const overflow = decisions.length - maxPersisted;
  const dropped = decisions.slice(0, overflow);
  const kept = decisions.slice(overflow);
  const actions = new Map<string, number>();
  for (const decision of dropped) {
    const key = `${decision.action}${decision.kind ? `:${decision.kind}` : ''}`;
    actions.set(key, (actions.get(key) ?? 0) + 1);
  }
  const summary = [...actions.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${count}× ${key}`)
    .join(', ');
  return {
    kept,
    digest: `earlier ticks (${dropped[0].tick}–${dropped[dropped.length - 1].tick}) summarized: ${summary}`,
  };
}

// —————————————————————————————————————————————— P2: anti-thrash

/** Remediation generations after which "retry harder" is no longer an option. */
export const MAX_REMEDIATION_LINEAGE = 3;

/**
 * Count how many remediation generations a step sits down the
 * `replacesStepId` chain. A step the orchestrator already recreated twice has
 * consumed its "try again" budget — the next failure must change scope or
 * escalate, not loop.
 */
export function stepLineageDepth(plan: SwarmPlanStep, allSteps: SwarmPlanStep[]): number {
  const byId = new Map(allSteps.map((step) => [step.id, step]));
  let depth = 0;
  let cursor: SwarmPlanStep | undefined = plan;
  const seen = new Set<string>();
  while (cursor?.replacesStepId && !seen.has(cursor.replacesStepId)) {
    seen.add(cursor.replacesStepId);
    depth += 1;
    cursor = byId.get(cursor.replacesStepId);
  }
  return depth;
}

/**
 * Wave-cycle progress tracker. Two consecutive cycles with zero newly
 * succeeded steps means the swarm is thrashing — the caller must stop local
 * fixes and force a plan-level rethink.
 */
export class ProgressTracker {
  private zeroProgressCycles = 0;

  /** Record one dispatch cycle's success count; returns true when a rethink is due. */
  recordCycle(succeededThisCycle: number): boolean {
    if (succeededThisCycle > 0) {
      this.zeroProgressCycles = 0;
      return false;
    }
    this.zeroProgressCycles += 1;
    return this.zeroProgressCycles >= 2;
  }
}

/**
 * Reviewer hysteresis: a "needs changes" verdict may only flip the swarm into
 * remediation when it cites specifics — critique packets or a concrete error.
 * Vibes-based rejections stay advisory notes so a vague reviewer cannot
 * ping-pong implementers forever.
 */
export function reviewHasEvidence(packets: unknown[], errorOrOutput: string | null | undefined): boolean {
  if (packets.length > 0) return true;
  const text = (errorOrOutput ?? '').trim();
  // A bare approval-ish or near-empty verdict carries no actionable evidence.
  return text.length >= 40;
}

// —————————————————————————————————————————————— P4: canary

export type CanarySplit<T> = { canary: T[]; rest: T[]; canaryUsed: boolean };

/**
 * Echo-chamber guard: when a batch of writers is about to run with no writer
 * success yet, validate the approach on ONE seat first. If the canary fails,
 * the rest are deferred instead of N×-wasting the same bad assumption.
 */
export function splitCanaryGroup<T>(items: T[], canaryRequired: boolean): CanarySplit<T> {
  if (!canaryRequired || items.length <= 1) {
    return { canary: items, rest: [], canaryUsed: false };
  }
  return { canary: items.slice(0, 1), rest: items.slice(1), canaryUsed: true };
}

// —————————————————————————————————————————————— P6: drift audit

export const DRIFT_AUDIT_EVERY_TICKS = 4;

/** True when the supervisor has gone this many ticks without recovering a step. */
export function needsDriftAudit(ticksSinceProgress: number): boolean {
  return ticksSinceProgress > 0 && ticksSinceProgress % DRIFT_AUDIT_EVERY_TICKS === 0;
}

// —————————————————————————————————————————————— P7: finish mode

export const ESCAPE_RESERVE_RATIO = 0.15;

export type FinishVerdict = {
  finishMode: boolean;
  reserveUsd: number | null;
  reason: string | null;
};

/**
 * Budget death-spiral guard: when spend crosses into the escape reserve
 * (the last ~15% before the soft cap), stop starting new feature work —
 * consolidate what exists, run validation, ship an honest handoff/PR.
 */
export function finishModeVerdict(spentUsd: number, softCapUsd: number | null): FinishVerdict {
  if (softCapUsd == null || softCapUsd <= 0) {
    return { finishMode: false, reserveUsd: null, reason: null };
  }
  const threshold = softCapUsd * (1 - ESCAPE_RESERVE_RATIO);
  if (spentUsd < threshold) {
    return { finishMode: false, reserveUsd: null, reason: null };
  }
  return {
    finishMode: true,
    reserveUsd: softCapUsd - spentUsd,
    reason: `spend $${spentUsd.toFixed(2)} entered the escape reserve (soft cap $${softCapUsd.toFixed(2)})`,
  };
}

// —————————————————————————————————————————————— P8: slow-fail preemption

/** A failed attempt that took this multiple of the role's median successful duration... */
export const SLOW_FAILURE_MULTIPLIER = 2;
/** ...and at least this long, is a slow fail worth preempting. */
const SLOW_FAILURE_FLOOR_MS = 2 * 60 * 1000;

/**
 * Slow-fail detection: a failed attempt that burned far more wall-clock than
 * successful runs of the same role typically do should not be retried on the
 * same approach — preempt to escalation early.
 */
export function isSlowFailure(elapsedMs: number, medianSuccessfulMs: number | null): boolean {
  if (medianSuccessfulMs == null || medianSuccessfulMs <= 0) return false;
  if (elapsedMs < SLOW_FAILURE_FLOOR_MS) return false;
  return elapsedMs > medianSuccessfulMs * SLOW_FAILURE_MULTIPLIER;
}
