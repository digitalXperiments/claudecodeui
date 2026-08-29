/**
 * Swarm staffing router — picks the seat roster for a task batch from the Model
 * Capability Registry instead of hand-maintained agent profiles.
 *
 * Design rules (PRD §B4):
 *  - Task kind → capability mapping: implement/review/test → coding score;
 *    explore/orchestrate → agentic + long-context; docs → cheapest passing.
 *  - Cost-efficiency frontier: cheapest model whose conservative score clears
 *    the difficulty floor wins; top-tier models reserved for planning,
 *    synthesis, and remediation roles.
 *  - Diversity guard: cap identical models per batch so one model's systematic
 *    failure mode cannot sink a whole wave.
 *  - Trust rule: a model with fewer than MIN_OUTCOME_SAMPLES observed swarm
 *    outcomes is never given sole ownership of a critical-path advanced task.
 */

import {
  getStaffingPrefs,
  listModelCapabilities,
  outcomeCorrection,
  rankCandidatesForTask,
  type ModelCapability,
} from '@/modules/swarm/model-registry.service.js';

export const MAX_SAME_MODEL_SEATS = 3;

type SeatKind = 'orchestrator' | 'explorer' | 'implementer' | 'reviewer' | 'tester' | 'security' | 'docs' | 'custom';

export type StaffingRequest = {
  kind: SeatKind;
  difficulty?: 'basic' | 'medium' | 'advanced' | null;
  /** How many seats to fill with distinct assignments. */
  seats?: number;
  allowedProviders?: string[];
  /** Critical-path tasks refuse unproven models as the only candidate. */
  criticalPath?: boolean;
};

export type StaffedSeat = {
  kind: SeatKind;
  label: string;
  provider: string;
  model: string;
  /** Why the router picked this — surfaced on the swarm seat card. */
  rationale: string;
};

/**
 * Assign `seats` (default 1) for a task. Returns ranked, diversity-guarded
 * assignments; empty when the registry has no usable candidates.
 */
export function staffTask(request: StaffingRequest): StaffedSeat[] {
  const seats = Math.max(1, request.seats ?? 1);
  const allowedProviders = request.allowedProviders ?? getStaffingPrefs().allowedProviders ?? undefined;
  const candidates = rankCandidatesForTask(
    { kind: request.kind, difficulty: request.difficulty ?? null },
    { allowedProviders, limit: 24 },
  );
  if (candidates.length === 0) return [];

  // rankCandidatesForTask already applies role, difficulty, confidence, cost,
  // and live-outcome correction. Preserve that order here.
  const ranked = candidates;

  const perModelCount = new Map<string, number>();
  const chosen: StaffedSeat[] = [];
  for (const capability of ranked) {
    if (chosen.length >= seats) break;
    const used = perModelCount.get(capability.modelId) ?? 0;
    if (used >= MAX_SAME_MODEL_SEATS) continue;
    // Trust rule: unproven models don't own critical-path advanced work alone.
    const { samples } = outcomeCorrection(capability.modelId, request.kind);
    if (
      request.criticalPath &&
      request.difficulty === 'advanced' &&
      samples === 0 &&
      chosen.length === 0 &&
      ranked.length > 1
    ) {
      continue;
    }
    perModelCount.set(capability.modelId, used + 1);
    const costBit =
      capability.outputCostPerMtok != null
        ? `, ~$${capability.outputCostPerMtok.toFixed(2)}/Mtok out`
        : '';
    chosen.push({
      kind: request.kind,
      label: `${request.kind}-${chosen.length + 1} (${shortModelName(capability)})`,
      provider: capability.provider,
      model: capability.modelId,
      rationale:
        `registry: ${request.kind}${request.difficulty ? `·${request.difficulty}` : ''} → ` +
        `coding ${capability.codingScore.toFixed(2)}, confidence ${capability.confidence.toFixed(2)}` +
        costBit,
    });
  }
  return chosen;
}

/** Projected roster preview for the swarm creation form (PRD §B5). */
export function previewAutoStaffRoster(input: {
  kinds: Array<{ kind: SeatKind; difficulty?: 'basic' | 'medium' | 'advanced' | null }>;
  allowedProviders?: string[];
}): Array<StaffedSeat & { taskKind: SeatKind }> {
  const out: Array<StaffedSeat & { taskKind: SeatKind }> = [];
  for (const entry of input.kinds) {
    for (const seat of staffTask({ ...entry, seats: 1, allowedProviders: input.allowedProviders })) {
      out.push({ ...seat, taskKind: entry.kind });
    }
  }
  return out;
}

function shortModelName(capability: ModelCapability): string {
  if (capability.displayName) return capability.displayName;
  return capability.modelId.split('/').pop() ?? capability.modelId;
}

/**
 * Staff every worker seat a plan needs, straight from the registry. One seat
 * per (kind × difficulty) bucket, capped at 8 seats. Used when auto-roster is
 * enabled but no swarm-tagged agent profiles exist — the "no stale profiles"
 * path.
 */
export function staffPlanSeats(input: {
  plan: { steps: Array<{ kind?: string; difficulty?: string | null }> };
  allowedProviders?: string[];
}): StaffedSeat[] {
  const buckets = new Map<string, { kind: SeatKind; difficulty: 'basic' | 'medium' | 'advanced' }>();
  for (const step of input.plan.steps) {
    const kind = (step.kind ?? 'custom') as SeatKind;
    if (kind === 'orchestrator') continue;
    const difficulty =
      step.difficulty === 'advanced' || step.difficulty === 'basic'
        ? step.difficulty
        : 'medium';
    const key = `${kind}::${difficulty}`;
    if (!buckets.has(key)) buckets.set(key, { kind, difficulty });
  }
  const seats: StaffedSeat[] = [];
  for (const bucket of buckets.values()) {
    if (seats.length >= 8) break;
    const [seat] = staffTask({
      ...bucket,
      seats: 1,
      allowedProviders: input.allowedProviders,
      criticalPath: bucket.difficulty === 'advanced',
    });
    if (seat && !seats.some((existing) => existing.model === seat.model && existing.kind === seat.kind)) {
      seats.push(seat);
    }
  }
  return seats;
}

/** Registry summary for orchestrator prompts / UI. */
export function formatRegistrySummary(limit = 12): string {
  const all = listModelCapabilities().filter((c) => c.enabled);
  if (all.length === 0) return '(model registry empty — run a refresh)';
  return all
    .slice(0, limit)
    .map(
      (c) =>
        `- ${c.provider}/${c.modelId}: coding ${c.codingScore.toFixed(2)}, agentic ${c.agenticScore.toFixed(2)}, ctx ${c.contextWindow ?? '?'}${c.outputCostPerMtok != null ? `, $${c.outputCostPerMtok.toFixed(2)}/Mtok` : ''}`,
    )
    .join('\n');
}
