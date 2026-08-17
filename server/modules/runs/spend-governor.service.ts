/**
 * Live spend governor — soft downgrade / hard pause on the run you are looking at.
 *
 * Monthly project budgets already block a *new* swarm. This watches the
 * in-flight swarm or chat and either cheapens the next seat or stops it.
 */

import { getAppFeatures } from '@/modules/app-features/app-features.service.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';

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
 * Cheapen the next Claude seat when the soft cap has tripped.
 * Other providers stay put — they are already the cheaper shop.
 */
export function downgradeModelForSoftCap(model: string | null | undefined): string | null {
  const current = (model ?? '').trim();
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
