/**
 * Live spend governor — soft downgrade / hard pause on the run you are looking at.
 *
 * Monthly project budgets already block a *new* swarm. This watches the
 * in-flight swarm or chat and either cheapens the next seat or stops it.
 */

import { getAppFeatures } from '@/modules/app-features/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { rankCandidatesForTask } from '@/modules/swarm/index.js';

export type SpendVerdict = {
  spentUsd: number;
  softUsd: number | null;
  hardUsd: number | null;
  soft: boolean;
  hard: boolean;
};

export function evaluateSpend(spentUsd: number): SpendVerdict {
  const features = getAppFeatures();
  const softUsd = features.spendSoftCostUsd;
  const hardUsd = features.spendHardCostUsd;
  return {
    spentUsd,
    softUsd,
    hardUsd,
    soft: softUsd != null && spentUsd >= softUsd,
    hard: hardUsd != null && spentUsd >= hardUsd,
  };
}

const OPUS_RE = /\bopus\b/i;
const FABLE_RE = /\bfable\b/i;
const SONNET_RE = /\bsonnet\b/i;

/**
 * Cheapen the next seat when the soft cap has tripped.
 *
 * Primary path: Model Capability Registry lookup — find a cheaper model from
 * the same provider that still clears the basic-difficulty bar. This works
 * across every provider, not just Claude name families, and adapts as new
 * models ship. The legacy regex rewrite stays as the offline fallback when the
 * registry has no cheaper same-provider candidate.
 */
export function downgradeModelForSoftCap(
  model: string | null | undefined,
  options: { provider?: string | null } = {},
): string | null {
  const current = (model ?? '').trim();
  const inferredProvider = options.provider ?? (
    OPUS_RE.test(current) || FABLE_RE.test(current) || SONNET_RE.test(current) || /^claude/i.test(current)
      ? 'claude'
      : undefined
  );
  try {
    const candidates = rankCandidatesForTask({ kind: 'implementer', difficulty: 'basic' }, {
      allowedProviders: inferredProvider ? [inferredProvider] : undefined,
      limit: 8,
    });
    const currentEntry = candidates.find((c) => c.modelId === current);
    const cheaper = candidates.find((c) => {
      if (c.modelId === current) return false;
      if (currentEntry) {
        if (c.provider !== currentEntry.provider) return false;
        if (c.outputCostPerMtok != null && currentEntry.outputCostPerMtok != null) {
          return c.outputCostPerMtok < currentEntry.outputCostPerMtok;
        }
        return c.codingScore < currentEntry.codingScore;
      }
      return true;
    });
    if (cheaper) return cheaper.modelId;
  } catch {
    // Registry unavailable (no DB, cold start) — fall through to regex.
  }
  if (!current) return 'sonnet';
  if (OPUS_RE.test(current) || FABLE_RE.test(current)) {
    return current.replace(OPUS_RE, 'sonnet').replace(FABLE_RE, 'sonnet');
  }
  if (SONNET_RE.test(current) && !/haiku/i.test(current)) {
    return current.replace(SONNET_RE, 'haiku');
  }
  return current;
}

export function raiseSpendCapInterrupt(input: {
  projectId?: string | null;
  title: string;
  body: string;
  runId?: string | null;
  href?: string | null;
  spentUsd: number;
  hardUsd: number | null;
}): void {
  interruptsService.create({
    projectId: input.projectId ?? null,
    kind: 'spend_cap',
    severity: 'error',
    title: input.title,
    body: input.body,
    runId: input.runId ?? null,
    href: input.href ?? null,
    actions: [
      { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
    ],
    priority: 20,
    meta: { spentUsd: input.spentUsd, hardUsd: input.hardUsd },
    dedupeKey: `spend_cap:${input.runId || input.title}`,
  });
}
