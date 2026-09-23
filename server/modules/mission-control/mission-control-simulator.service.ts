import { parseJsonFromAgentText } from '@/modules/mission-control/mission-control-agent.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import {
  coerceDrafts,
  draftCandidates,
  filterSectionDrafts,
  prepareDraftForSection,
} from '@/modules/mission-control/mission-control-runner.service.js';
import type { McDraftItem, McSection, McSectionMode } from '@/modules/mission-control/mission-control.types.js';
import { collectTrelloCardRefs, trelloDedupeKeyAliases } from '@/modules/mission-control/trello-dedupe.js';
import { AppError } from '@/shared/utils.js';

export type SimulatedDraft = {
  title: string;
  summary: string;
  body: Record<string, unknown>;
  dedupeKey: string | null;
  confidence: number;
  outcome: 'would_create' | 'would_log' | 'already_seen' | 'repeated_in_output';
  nextStep: 'review' | 'auto_approve' | 'resolved' | null;
  reason?: string;
};

export type TickSimulation = {
  mode: McSectionMode;
  status: 'ready' | 'disabled' | 'missing_prompt';
  message: string;
  counts: {
    candidates: number;
    invalid: number;
    filtered: number;
    wouldCreate: number;
    skipped: number;
  };
  drafts: SimulatedDraft[];
};

function emptySimulation(section: McSection, status: TickSimulation['status'], message: string): TickSimulation {
  return {
    mode: section.mode,
    status,
    message,
    counts: { candidates: 0, invalid: 0, filtered: 0, wouldCreate: 0, skipped: 0 },
    drafts: [],
  };
}

function nextStepFor(section: McSection): SimulatedDraft['nextStep'] {
  return section.auto_approve && section.actions.some((action) => action.kind === 'approve')
    ? 'auto_approve'
    : 'review';
}

function findExistingDraft(sectionId: string, draft: McDraftItem, trelloRefs: string[]) {
  const aliases = trelloRefs.length ? trelloDedupeKeyAliases(trelloRefs) : [];
  return missionControlDb.findItemByDedupeAliases(sectionId, [draft.dedupeKey, ...aliases])
    ?? (trelloRefs.length ? missionControlDb.findItemByTrelloRefs(sectionId, trelloRefs) : null);
}

/** Preview the produce pipeline with sample model output, without invoking a provider or writing items. */
export function simulateSectionTick(sectionId: string, output: string): TickSimulation {
  const section = missionControlDb.getSection(sectionId);
  if (!section) {
    throw new AppError('Bot not found', { code: 'MC_SECTION_NOT_FOUND', statusCode: 404 });
  }
  if (typeof output !== 'string' || !output.trim()) {
    throw new AppError('Sample output is required', { code: 'MC_SIMULATION_OUTPUT_REQUIRED', statusCode: 400 });
  }
  if (output.length > 100_000) {
    throw new AppError('Sample output is too long', { code: 'MC_SIMULATION_OUTPUT_TOO_LONG', statusCode: 413 });
  }
  if (!section.produce_prompt.trim()) {
    return emptySimulation(section, 'missing_prompt', 'A real tick would stop because this bot has no produce brief.');
  }
  if (!section.enabled) {
    return emptySimulation(section, 'disabled', 'A real tick would skip because this bot is paused.');
  }

  if (section.mode === 'fire_and_forget') {
    const firstLine = output.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Run completed';
    return {
      mode: section.mode,
      status: 'ready',
      message: 'A real tick would log one resolved result.',
      counts: { candidates: 1, invalid: 0, filtered: 0, wouldCreate: 1, skipped: 0 },
      drafts: [{
        title: `${section.title} · simulated result`,
        summary: firstLine.slice(0, 240),
        body: { output },
        dedupeKey: null,
        confidence: 1,
        outcome: 'would_log',
        nextStep: 'resolved',
      }],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonFromAgentText(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError(`Sample output could not be parsed as draft JSON: ${detail}`, {
      code: 'MC_SIMULATION_INVALID_OUTPUT',
      statusCode: 400,
    });
  }

  const candidates = draftCandidates(parsed);
  const coerced = coerceDrafts(parsed);
  const accepted = filterSectionDrafts(section, coerced);
  if (candidates.length > 100) {
    throw new AppError('Sample output has too many drafts (maximum 100)', {
      code: 'MC_SIMULATION_TOO_MANY_DRAFTS',
      statusCode: 400,
    });
  }

  const seenKeys = new Set<string>();
  const seenTrelloRefs = new Set<string>();
  const drafts: SimulatedDraft[] = accepted.map((unprepared) => {
    const draft = prepareDraftForSection(section, unprepared);
    const trelloRefs = collectTrelloCardRefs({
      dedupeKey: draft.dedupeKey,
      body: draft.body,
      source: draft.source,
    });
    const existing = findExistingDraft(sectionId, draft, trelloRefs);
    const repeated = seenKeys.has(draft.dedupeKey)
      || trelloRefs.some((ref) => seenTrelloRefs.has(ref.toLowerCase()));
    seenKeys.add(draft.dedupeKey);
    for (const ref of trelloRefs) seenTrelloRefs.add(ref.toLowerCase());

    const base = {
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
      dedupeKey: draft.dedupeKey,
      confidence: draft.confidence ?? 0,
    };
    if (existing) {
      return {
        ...base,
        outcome: 'already_seen' as const,
        nextStep: null,
        reason: `Matches an existing ${existing.status} item`,
      };
    }
    if (repeated) {
      return {
        ...base,
        outcome: 'repeated_in_output' as const,
        nextStep: null,
        reason: 'Repeats a source key in this sample',
      };
    }
    return { ...base, outcome: 'would_create' as const, nextStep: nextStepFor(section) };
  });
  const wouldCreate = drafts.filter((draft) => draft.outcome === 'would_create').length;
  const skipped = drafts.length - wouldCreate;
  return {
    mode: section.mode,
    status: 'ready',
    message: candidates.length === 0
      ? 'A real tick would produce no items.'
      : accepted.length === 0
        ? 'No valid drafts passed this bot’s produce rules.'
        : `${wouldCreate} new item${wouldCreate === 1 ? '' : 's'}; ${skipped} already seen or repeated.`,
    counts: {
      candidates: candidates.length,
      invalid: candidates.length - coerced.length,
      filtered: coerced.length - accepted.length,
      wouldCreate,
      skipped,
    },
    drafts,
  };
}
