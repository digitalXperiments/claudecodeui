import { systemNotificationsDb } from '@/modules/database/index.js';
import {
  buildProducePrompt,
  buildResolvePrompt,
  sectionForPhase,
  parseJsonFromAgentText,
  runMissionControlAgent,
} from '@/modules/mission-control/mission-control-agent.service.js';
import {
  broadcastMissionControlSectionUpdated,
  missionControlDb,
} from '@/modules/mission-control/mission-control.repository.js';
import type {
  McDraftItem,
  McItem,
  McSection,
} from '@/modules/mission-control/mission-control.types.js';
import { AppError } from '@/shared/utils.js';
import { resolveProviderAuthFailure } from '@/shared/provider-auth-failure.js';
import {
  collectTrelloCardRefs,
  normalizeTrelloDraftFields,
  trelloDedupeKeyAliases,
} from '@/modules/mission-control/trello-dedupe.js';

import { drainWorkQueue, markWorkReady, refreshQueuedWork } from './mission-control-dispatch.service.js';
import { emitItemFeedback, summarizeBodyEdit, type ItemFeedbackKind } from './mission-control-feedback.service.js';

/**
 * Normalize produce JSON into a candidate list. Accepts a bare array, a single
 * draft object, or a common wrapper ({ items | drafts | results }).
 */
export function draftCandidates(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const key of ['items', 'drafts', 'results', 'data'] as const) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
    // Single draft object (has draft-ish keys) rather than an empty wrapper.
    if (
      typeof o.title === 'string' ||
      typeof o.dedupeKey === 'string' ||
      typeof o.dedupe_key === 'string'
    ) {
      return [raw];
    }
    return [];
  }
  return [];
}

export function coerceDrafts(raw: unknown): McDraftItem[] {
  const arr = draftCandidates(raw);
  const drafts: McDraftItem[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const rawDedupeKey =
      typeof e.dedupeKey === 'string'
        ? e.dedupeKey.trim()
        : typeof e.dedupe_key === 'string'
          ? e.dedupe_key.trim()
          : '';
    if (!title || !rawDedupeKey) continue;
    const body =
      e.body && typeof e.body === 'object' && !Array.isArray(e.body)
        ? (e.body as Record<string, unknown>)
        : {};
    // Collapse shortLink vs full Trello id into one stable dedupe key.
    const normalized = normalizeTrelloDraftFields({
      dedupeKey: rawDedupeKey,
      body,
      source: typeof e.source === 'object' && e.source && !Array.isArray(e.source)
        ? (e.source as Record<string, unknown>)
        : { dedupeKey: rawDedupeKey },
    });
    drafts.push({
      title,
      summary: typeof e.summary === 'string' ? e.summary : '',
      body: normalized.body,
      dedupeKey: normalized.dedupeKey,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0,
      source: normalized.source,
    });
  }
  return drafts;
}

/**
 * True only for the built-in Action Centre "Slack" reply-drafting section
 * (and any section deliberately modeled the same way), never for a generic
 * section that merely happens to use Slack as a produce/resolve tool (e.g.
 * "Jira Drafts" pulling Slack threads to triage into tickets). A substring
 * match on title/tool names used to gate this and silently discarded every
 * draft from any such section — the `draft_reply` action kind is the actual,
 * purpose-built signature of the reply-drafting workflow.
 */
function isSlackSection(section: McSection): boolean {
  return section.actions.some((action) => action.kind === 'draft_reply');
}

/**
 * Slack is intentionally stricter than generic Mission Control sections:
 * both classification decisions must be explicit, positive model output.
 * This keeps broad channel chatter out even when a provider returns otherwise
 * valid-looking draft metadata.
 */
function isSlackReplyRequiredDraft(draft: McDraftItem): boolean {
  const source = typeof draft.body.source === 'string'
    ? draft.body.source.trim().toLowerCase()
    : '';
  return source === 'slack'
    && draft.body.directedToMe === true
    && draft.body.needsMyReply === true;
}

export function filterSectionDrafts(section: McSection, drafts: McDraftItem[]): McDraftItem[] {
  return isSlackSection(section)
    ? drafts.filter(isSlackReplyRequiredDraft)
    : drafts;
}

/**
 * Slack items arrive review-ready: produce composes the first draft from the
 * thread plus Obsidian context, and the user refines it with Redraft before
 * sending. Keep a usable model draft (normalizing its timestamp), drop an
 * empty one so the card does not render a blank draft box, and never accept
 * operatorContext from the model — that field is the human's guidance channel.
 */
export function prepareDraftForSection(section: McSection, draft: McDraftItem): McDraftItem {
  const body = { ...draft.body };
  delete body.workSession;
  delete body.workQueuedAt;
  if (!isSlackSection(section)) return { ...draft, body };
  delete body.operatorContext;

  const replyDraft = typeof body.draft === 'string' ? body.draft.trim() : '';
  if (!replyDraft) {
    delete body.draft;
    delete body.draftedAt;
    return { ...draft, body };
  }
  body.draft = replyDraft;
  const draftedAt = typeof body.draftedAt === 'string' ? Date.parse(body.draftedAt) : Number.NaN;
  body.draftedAt = Number.isNaN(draftedAt)
    ? new Date().toISOString()
    : new Date(draftedAt).toISOString();
  return { ...draft, body };
}

async function resolveMissionControlInterrupts(itemId: string, resolution: string): Promise<void> {
  try {
    const { interruptsService } = await import('@/modules/interrupt-queue/index.js');
    interruptsService.resolveMissionControlItem(itemId, 'mission-control', resolution);
  } catch (error) {
    // The item action has already succeeded; do not turn a notification cleanup
    // failure into a failed approval/deny operation.
    console.warn('[MissionControl] failed to resolve linked interrupt', error);
  }
}

function notifyPendingItems(section: McSection, count: number, itemIds: string[] = []): void {
  const actionableItemIds = [...new Set(itemIds)].filter((itemId) => {
    const item = missionControlDb.getItem(itemId);
    return item?.status === 'pending' || item?.status === 'failed';
  });
  const actionableCount = itemIds.length > 0 ? actionableItemIds.length : count;
  if (actionableCount <= 0) return;
  try {
    systemNotificationsDb.create({
      kind: 'action_required',
      severity: 'info',
      title: `${section.title}: ${actionableCount} item${actionableCount === 1 ? '' : 's'} need review`,
      body: `Mission Control produced ${actionableCount} new draft${actionableCount === 1 ? '' : 's'}.`,
      source: 'mission-control',
      href: `/bots/b/${encodeURIComponent(section.section_id)}/overview`,
      meta: { sectionId: section.section_id },
      dedupeKey: `mc-section-${section.section_id}-pending`,
    });
  } catch (error) {
    console.warn('[MissionControl] failed to create notification', error);
  }
  // One interrupt per new item (deduped) so the queue can approve/deny.
  void import('@/modules/interrupt-queue/index.js')
    .then(({ interruptsService }) => {
      for (const itemId of actionableItemIds) {
        interruptsService.create({
          projectId: section.project_id ?? null,
          kind: 'approval_pending',
          severity: 'warning',
          title: `${section.title}: review needed`,
          body: 'A Mission Control draft is waiting for approval.',
          href: `/bots/b/${encodeURIComponent(section.section_id)}/overview`,
          actions: [
            { id: 'approve_mc_item', label: 'Approve', style: 'primary' },
            { id: 'deny_mc_item', label: 'Deny', style: 'destructive' },
            { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
          ],
          meta: { sectionId: section.section_id, itemId },
          dedupeKey: `mc_item:${itemId}`,
        });
      }
    })
    .catch((error) => {
      console.warn('[MissionControl] failed to create interrupt(s)', error);
    });
}

/** Mark the latest section phase and emit one canonical roster update event. */
export function finishMissionControlSectionRun(sectionId: string, error: string | null = null): void {
  const section = missionControlDb.getSection(sectionId);
  if (section) {
    missionControlDb.markSectionRun(sectionId, { error });
    return;
  }
  // Architect previews use an ephemeral section-shaped object rather than a
  // persisted row, but still need to refresh the live Bot Studio activity rail.
  broadcastMissionControlSectionUpdated({
    sectionId,
    lastRunAt: new Date().toISOString(),
    lastError: error,
    enabled: true,
  });
}

/** The kernel episode that proposed an item (recorded in `source_json.episodeId`), if any. */
function itemEpisodeId(item: McItem): string | undefined {
  const id = item.source?.episodeId;
  return typeof id === 'string' && id ? id : undefined;
}

/** Kernel-created items record their episode in `source_json` (no new columns). */
function withEpisodeRef(draft: McDraftItem, episodeId: string | undefined): McDraftItem {
  if (!episodeId) return draft;
  return { ...draft, source: { ...(draft.source ?? { dedupeKey: draft.dedupeKey }), episodeId } };
}

/**
 * Run a section's produce step (scheduled or manual): parse draft items and
 * move each new one into the pipeline (auto-resolve, work queue, or review).
 */
export type ProduceRunResult = {
  created: number;
  /** Drafts skipped because dedupe_key already exists (any status). */
  skipped: number;
  items: McItem[];
  error?: string;
  /** Short human-readable summary for the UI banner. */
  message: string;
};

export async function runSectionProduce(
  sectionId: string,
  opts: { trigger?: string } = {},
): Promise<ProduceRunResult> {
  const trigger = opts.trigger ?? 'manual';
  const section = missionControlDb.getSection(sectionId);
  if (!section) {
    throw new AppError('Section not found', {
      code: 'MC_SECTION_NOT_FOUND',
      statusCode: 404,
    });
  }
  if (!section.produce_prompt.trim()) {
    throw new AppError('Section has no produce prompt', {
      code: 'MC_NO_PRODUCE_PROMPT',
      statusCode: 400,
    });
  }
  if (!section.enabled) {
    return {
      created: 0,
      skipped: 0,
      items: [],
      message: 'Section is disabled. Enable it to run.',
    };
  }

  try {
    const prompt = buildProducePrompt(section);
    const { text, success, errorMessage } = await runMissionControlAgent({
      section,
      prompt,
      tools: section.produce_tools,
      sourceRef: section.section_id,
      trigger,
      phase: 'produce',
    });

    // Provider/runtime failure (API unreachable, CLI crash, …): the output is
    // an error dump, not produce content. Record it on the section and create
    // nothing — there is no item to review.
    if (!success) {
      const msg =
        resolveProviderAuthFailure(section.provider, errorMessage, text)
        || errorMessage
        || text.slice(0, 500)
        || `Provider "${section.provider}" run failed`;
      finishMissionControlSectionRun(sectionId, msg);
      return {
        created: 0,
        skipped: 0,
        items: [],
        error: msg,
        message: `Produce run failed: ${msg}`,
      };
    }

    // Structured drafts
    let parsed: unknown;
    try {
      parsed = parseJsonFromAgentText(text);
    } catch (parseError) {
      const message =
        parseError instanceof Error ? parseError.message : String(parseError);

      // A dead login produces provider error text where JSON was expected. That
      // is an auth problem, not a formatting one — report it as such and create
      // no draft. Parking it as a "produce parse failed" item hid the real cause
      // and left one bogus item per scheduled run to triage by hand.
      const authFailure = resolveProviderAuthFailure(section.provider, errorMessage, text);
      if (authFailure) {
        finishMissionControlSectionRun(sectionId, authFailure);
        return {
          created: 0,
          skipped: 0,
          items: [],
          error: authFailure,
          message: `Produce run failed: ${authFailure}`,
        };
      }

      finishMissionControlSectionRun(sectionId, `Failed to parse produce output: ${message}`);
      // Park raw output as a failed item for visibility
      const failed = missionControlDb.insertItemIfNew(section, {
        title: `${section.title}: produce parse failed`,
        summary: message,
        body: { raw: text.slice(0, 50_000) },
        dedupeKey: `parse-fail:${Date.now()}`,
        confidence: 0,
      });
      if (failed) {
        missionControlDb.setItemStatus(failed.item_id, 'failed', { error: message });
      }
      return {
        created: 0,
        skipped: 0,
        items: failed ? [missionControlDb.getItem(failed.item_id)!] : [],
        error: message,
        message: `Produce finished but JSON parse failed: ${message}`,
      };
    }

    return await ingestProduceDrafts(section, parsed, { trigger });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishMissionControlSectionRun(sectionId, message);
    throw error;
  }
}

/**
 * Post-parse half of a produce run: validate drafts, dedupe against existing items,
 * insert the new ones and move them into the pipeline (auto-resolve, work queue or
 * review), then finish/drain/notify. Shared by `runSectionProduce` and the bot kernel.
 * `rawDrafts` is the parsed model output (array, single draft or `{ items }` wrapper).
 */
export async function ingestProduceDrafts(
  section: McSection,
  rawDrafts: unknown,
  opts: {
    trigger?: string;
    episodeId?: string;
    /** Called for every agent run the auto-approve resolve step starts (the kernel tracks them). */
    onRunCreated?: (run: { runId: string; appSessionId: string }) => void;
    /** Checked before each draft: a timed-out or interrupted episode must stop approving. */
    isAborted?: () => boolean;
  } = {},
): Promise<ProduceRunResult> {
  const trigger = opts.trigger ?? 'manual';
  const episodeId = opts.episodeId;
  const parsedDrafts = coerceDrafts(rawDrafts);
  const drafts = filterSectionDrafts(section, parsedDrafts);
  if (drafts.length === 0) {
    if (isSlackSection(section) && parsedDrafts.length > 0) {
      finishMissionControlSectionRun(section.section_id);
      return {
        created: 0,
        skipped: 0,
        items: [],
        message: 'Produce finished: no Slack messages addressed to you that need your reply.',
      };
    }
    const candidateCount = draftCandidates(rawDrafts).length;
    // Empty produce is a normal no-op: nothing to queue and nothing to
    // resolve/auto-approve. Only treat as an error when the model returned
    // objects that were missing required title + dedupeKey.
    if (candidateCount === 0) {
      drainWorkQueue(section.section_id);
      finishMissionControlSectionRun(section.section_id);
      return {
        created: 0,
        skipped: 0,
        items: [],
        message: 'Produce finished: nothing new to review.',
      };
    }
    const msg =
      'Produce finished but returned 0 valid drafts (each item needs title + dedupeKey).';
    finishMissionControlSectionRun(section.section_id, msg);
    return {
      created: 0,
      skipped: 0,
      items: [],
      error: msg,
      message: msg,
    };
  }

  const createdItems: McItem[] = [];
  let skipped = 0;

  for (const draft of drafts) {
    if (opts.isAborted?.()) break;
    // Strict dedupe: never re-open dismissed/denied/resolved/failed items.
    // Trello: also skip when an alias id (shortLink vs full id) already exists.
    const trelloRefs = collectTrelloCardRefs({
      dedupeKey: draft.dedupeKey,
      body: draft.body,
      source: draft.source,
    });
    if (trelloRefs.length > 0) {
      const existing =
        missionControlDb.findItemByDedupeAliases(
          section.section_id,
          trelloDedupeKeyAliases(trelloRefs),
        ) ?? missionControlDb.findItemByTrelloRefs(section.section_id, trelloRefs);
      if (existing) {
        refreshQueuedWork(section, existing, prepareDraftForSection(section, draft).body);
        skipped++;
        continue;
      }
    }
    const item = missionControlDb.insertItemIfNew(section, withEpisodeRef(prepareDraftForSection(section, draft), episodeId));
    if (!item) {
      const existing = missionControlDb.findItemByDedupeAliases(section.section_id, [draft.dedupeKey]);
      if (existing) refreshQueuedWork(section, existing, prepareDraftForSection(section, draft).body);
      skipped++;
      continue;
    }
    let current = item;
    const hasResolve = Boolean(section.resolve_prompt.trim());
    if (!hasResolve && section.work_profile) {
      // No resolve stage: the item goes straight to the work gate.
      current = markWorkReady(section, item.item_id);
    } else if (section.auto_approve) {
      // Automatic resolve (or record-only when there is no resolve prompt).
      // Only approve-kind actions ever run without a human.
      const approve = current.actions.find((a) => a.kind === 'approve' && a.terminal !== false);
      if (approve) {
        const next = await applyItemAction(current.item_id, approve.id, undefined, {
          trigger,
          actor: 'auto',
          // The resolve run belongs to the episode that proposed the item, so the gateway sees its taint.
          episodeId: itemEpisodeId(current) ?? episodeId,
          onRunCreated: opts.onRunCreated,
        });
        // auto-approve should never hard-delete; if it did, skip the item
        if (!next) continue;
        current = next;
      }
    }
    createdItems.push(current);
  }

  finishMissionControlSectionRun(section.section_id);
  drainWorkQueue(section.section_id);
  const needsHuman = createdItems.filter((entry) => entry.status === 'pending' || entry.status === 'awaiting_work' || entry.status === 'failed');
  notifyPendingItems(section, needsHuman.length, needsHuman.map((entry) => entry.item_id));

  const parts: string[] = [];
  if (createdItems.length) parts.push(`${createdItems.length} new`);
  if (skipped) parts.push(`${skipped} skipped (already seen)`);
  if (section.auto_approve && createdItems.length) parts.push('auto-approve ran');
  const message =
    parts.length > 0
      ? `Produce finished: ${parts.join(', ')}.`
      : 'Produce finished with no new drafts.';

  return {
    created: createdItems.length,
    skipped,
    items: createdItems,
    message,
  };
}

function feedbackKindForAction(kind: string): ItemFeedbackKind {
  if (kind === 'approve' || kind === 'dismiss' || kind === 'delete') return kind;
  if (kind === 'deny' || kind === 'reject') return 'deny';
  return 'action';
}

/**
 * Apply a review action. Returns the updated item, or `null` when the item
 * was hard-deleted (kind `delete`) so the dedupe key is free for a re-run.
 */
export async function applyItemAction(
  itemId: string,
  actionId: string,
  editedBody?: Record<string, unknown>,
  opts: {
    trigger?: string;
    actor?: 'human' | 'auto';
    /** Run the resolve step as part of this kernel episode (auto-approve only; see `itemEpisodeId`). */
    episodeId?: string;
    onRunCreated?: (run: { runId: string; appSessionId: string }) => void;
  } = {},
): Promise<McItem | null> {
  const item = missionControlDb.getItem(itemId);
  if (!item) {
    throw new AppError('Item not found', {
      code: 'MC_ITEM_NOT_FOUND',
      statusCode: 404,
    });
  }

  const action = item.actions.find((a) => a.id === actionId);
  if (!action) {
    throw new AppError(`Action ${actionId} not on item`, {
      code: 'MC_BAD_ACTION',
      statusCode: 400,
    });
  }

  // Hard delete frees the section+dedupe_key unique constraint so produce can
  // recreate the draft. Allowed on terminal rows too (dismissed/resolved/…).
  if (action.kind === 'delete') {
    if (item.status === 'resolving' || item.status === 'working') {
      throw new AppError(`Item is 'resolving', not deletable yet`, {
        code: 'MC_ITEM_NOT_ACTIONABLE',
        statusCode: 400,
      });
    }
    const removed = missionControlDb.deleteItem(itemId);
    if (!removed) {
      throw new AppError('Item not found', {
        code: 'MC_ITEM_NOT_FOUND',
        statusCode: 404,
      });
    }
    await resolveMissionControlInterrupts(itemId, actionId);
    emitItemFeedback({ itemId, sectionId: item.section_id, kind: 'delete', actor: opts.actor, actionId, actionKind: action.kind, item });
    return null;
  }

  // Resolve actions run before the work stage; Dismiss closes any waiting item.
  const dismissible = ['pending', 'failed', 'awaiting_work', 'in_qa'].includes(item.status);
  const resolvable = (item.status === 'pending' || item.status === 'failed') && !item.work_ready_at;
  if (action.kind === 'dismiss' ? !dismissible : !resolvable) {
    throw new AppError(`Item is '${item.status}', not actionable`, {
      code: 'MC_ITEM_NOT_ACTIONABLE',
      statusCode: 400,
    });
  }

  const feedback = { itemId, sectionId: item.section_id, actor: opts.actor, actionId, actionKind: action.kind, item };
  if (editedBody) {
    const editSummary = summarizeBodyEdit(item.body, editedBody);
    if (editSummary) emitItemFeedback({ ...feedback, kind: 'edit', text: editSummary });
  }
  emitItemFeedback({ ...feedback, kind: feedbackKindForAction(action.kind) });

  if (action.kind === 'dismiss') {
    const dismissed = missionControlDb.setItemStatus(itemId, 'dismissed', {
      resolvedAt: new Date().toISOString(),
    });
    await resolveMissionControlInterrupts(itemId, actionId);
    finishMissionControlSectionRun(item.section_id);
    return dismissed;
  }

  const section = missionControlDb.getSection(item.section_id);
  if (!section) {
    throw new AppError('Section not found for item', {
      code: 'MC_SECTION_NOT_FOUND',
      statusCode: 404,
    });
  }

  const body = editedBody ?? item.body;
  missionControlDb.setItemStatus(itemId, 'resolving', { body });

  if (section.dry_run) {
    // Dry run never starts work, even when the bot has a work stage.
    const resolved = missionControlDb.setItemStatus(itemId, 'resolved', {
      result: { dryRun: true },
      resolvedAt: new Date().toISOString(),
      error: null,
    });
    await resolveMissionControlInterrupts(itemId, actionId);
    finishMissionControlSectionRun(section.section_id);
    return resolved;
  }

  if (!section.resolve_prompt.trim()) {
    // Approve without resolve prompt records the approved body, then hands
    // off to the work stage when the bot has one.
    const approved = { approved: true, body };
    const next = section.work_profile
      ? markWorkReady(section, itemId, { result: approved })
      : missionControlDb.setItemStatus(itemId, 'resolved', {
        result: approved,
        resolvedAt: new Date().toISOString(),
        error: null,
      });
    await resolveMissionControlInterrupts(itemId, actionId);
    finishMissionControlSectionRun(section.section_id);
    drainWorkQueue(section.section_id);
    return next;
  }

  try {
    const prompt = buildResolvePrompt(section, action.id, action.label, body);
    const { text, success, errorMessage } = await runMissionControlAgent({
      section,
      prompt,
      tools: section.resolve_tools,
      sourceRef: itemId,
      trigger: opts.trigger ?? 'manual',
      phase: 'resolve',
      // Auto-approve only: a human approving an item is their own decision, not the episode's.
      ...(opts.actor === 'auto' && (opts.episodeId ?? itemEpisodeId(item))
        ? { episodeId: opts.episodeId ?? itemEpisodeId(item) }
        : {}),
      ...(opts.onRunCreated ? { onRunCreated: opts.onRunCreated } : {}),
    });

    // Provider/runtime failure: mark the item failed (retryable) instead of
    // resolving it with an error dump as the result.
    if (!success) {
      const error =
          resolveProviderAuthFailure(sectionForPhase(section, 'resolve').provider, errorMessage, text)
          || errorMessage
          || text.slice(0, 500)
          || `Provider "${sectionForPhase(section, 'resolve').provider}" run failed`;
      const failed = missionControlDb.setItemStatus(itemId, 'failed', { error });
      finishMissionControlSectionRun(section.section_id, error);
      return failed;
    }

    let result: Record<string, unknown> = { raw: text };
    try {
      const parsed = parseJsonFromAgentText(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      } else {
        result = { value: parsed };
      }
    } catch {
      // Only unparseable output can be a bare provider error dump. A resolve
      // result that *parsed* is the model's answer, even if it happens to
      // discuss expired sessions — checking that would fail items for
      // legitimately auth-themed content.
      const authFailure = resolveProviderAuthFailure(sectionForPhase(section, 'resolve').provider, errorMessage, text);
      if (authFailure) {
        const failed = missionControlDb.setItemStatus(itemId, 'failed', { error: authFailure });
        finishMissionControlSectionRun(section.section_id, authFailure);
        return failed;
      }
      result = { raw: text };
    }

    if (typeof result.error === 'string') {
      const failed = missionControlDb.setItemStatus(itemId, 'failed', {
        error: result.error,
        result,
        resolvedAt: null,
      });
      finishMissionControlSectionRun(section.section_id, result.error);
      return failed;
    }

    if (action.terminal === false) {
      const pending = missionControlDb.setItemStatus(itemId, 'pending', {
        body: { ...body, ...result },
        error: null,
      });
      finishMissionControlSectionRun(section.section_id);
      return pending;
    }

    // Resolve succeeded: hand off to the work stage (its result becomes work
    // context) or finish the item.
    const next = section.work_profile
      ? markWorkReady(section, itemId, { result })
      : missionControlDb.setItemStatus(itemId, 'resolved', {
        result,
        resolvedAt: new Date().toISOString(),
        error: null,
      });
    await resolveMissionControlInterrupts(itemId, actionId);
    finishMissionControlSectionRun(section.section_id);
    drainWorkQueue(section.section_id);
    return next;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = missionControlDb.setItemStatus(itemId, 'failed', {
      error: message,
    });
    finishMissionControlSectionRun(section.section_id, message);
    return failed;
  }
}

export type RetryItemResult = {
  success: boolean;
  item: McItem;
  error?: string;
  message?: string;
};

/**
 * Re-run the section's produce step for a single item and refresh that item in
 * place. Runs the same produce prompt as the section, finds the draft that
 * matches this item (by dedupe key, then title), and resets the item to
 * `pending` with the fresh body. A provider/runtime failure marks the item
 * `failed` (retryable).
 */
export async function retryItem(itemId: string): Promise<RetryItemResult> {
  const item = missionControlDb.getItem(itemId);
  if (!item) {
    throw new AppError('Item not found', {
      code: 'MC_ITEM_NOT_FOUND',
      statusCode: 404,
    });
  }
  if (item.status !== 'pending' && item.status !== 'failed') {
    throw new AppError(`Item is '${item.status}', not retryable`, {
      code: 'MC_ITEM_NOT_ACTIONABLE',
      statusCode: 400,
    });
  }
  const section = missionControlDb.getSection(item.section_id);
  if (!section) {
    throw new AppError('Section not found for item', {
      code: 'MC_SECTION_NOT_FOUND',
      statusCode: 404,
    });
  }

  let text: string;
  let success: boolean;
  let errorMessage: string | null;
  try {
    const run = await runMissionControlAgent({
      section,
      prompt: buildProducePrompt(section),
      tools: section.produce_tools,
      sourceRef: itemId,
      trigger: 'replay',
      phase: 'retry',
    });
    text = run.text;
    success = run.success;
    errorMessage = run.errorMessage;
  } catch (error) {
    // Runtime unavailable / run-in-progress: surface on the item so it stays
    // retryable instead of throwing a 500 at the user.
    const message = error instanceof Error ? error.message : String(error);
    const failed = missionControlDb.setItemStatus(itemId, 'failed', { error: message });
    finishMissionControlSectionRun(section.section_id, message);
    return { success: false, item: failed, error: message };
  }

  if (!success) {
    const msg =
      resolveProviderAuthFailure(section.provider, errorMessage, text)
      || errorMessage
      || text.slice(0, 500)
      || `Provider "${section.provider}" run failed`;
    const failed = missionControlDb.setItemStatus(itemId, 'failed', { error: msg });
    finishMissionControlSectionRun(section.section_id, msg);
    return { success: false, item: failed, error: msg };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonFromAgentText(text);
  } catch {
    // Unparseable output: nothing to match against, keep the item as-is.
    finishMissionControlSectionRun(section.section_id, 'Retry produced unparseable output');
    return {
      success: false,
      item: missionControlDb.getItem(itemId)!,
      error: 'Retry produced unparseable output',
    };
  }

  const drafts = filterSectionDrafts(section, coerceDrafts(parsed));
  const match = drafts.find(
    (draft) => draft.dedupeKey === item.dedupe_key || draft.title === item.title,
  );
  if (!match) {
    finishMissionControlSectionRun(section.section_id, 'Retry produced no matching item');
    return {
      success: false,
      item: missionControlDb.getItem(itemId)!,
      error: 'Retry produced no matching item',
    };
  }

  // Reset status to pending with the fresh body (clear the error, drop any
  // stale resolved_at) before patching title/summary/confidence.
  const preparedMatch = prepareDraftForSection(section, match);
  missionControlDb.setItemStatus(itemId, 'pending', {
    body: preparedMatch.body,
    error: null,
    resolvedAt: null,
  });
  const updated = missionControlDb.updateItem(itemId, {
    title: preparedMatch.title,
    summary: preparedMatch.summary || item.summary,
    confidence: preparedMatch.confidence,
  });
  const refreshed = missionControlDb.getItem(itemId) ?? updated ?? item;
  finishMissionControlSectionRun(section.section_id);
  return {
    success: true,
    item: refreshed,
    message: 'Item retried: refreshed from a fresh produce run.',
  };
}

/** Read-only instruction appended to resolve prompts during previews. */
const PREVIEW_READ_ONLY_NOTE =
  '\n\nIMPORTANT: This is a READ-ONLY preview. Do NOT perform any external action, send anything, post anything, or modify files. Return ONLY the JSON object that would result from this action.';

export type PreviewItemResolutionResult =
  | { success: true; preview: Record<string, unknown>; type: 'static' | 'agent' }
  | { success: false; error: string };

/**
 * Preview what resolving an item with a given action would produce, WITHOUT
 * mutating the item.
 *
 * - Sections with no resolve prompt (or dry runs) resolve instantly: the
 *   preview is the body that would be approved (`type: 'static'`).
 * - Otherwise the resolve agent runs in read-only mode and the parsed JSON is
 *   returned (`type: 'agent'`).
 */
export async function previewItemResolution(
  itemId: string,
  actionId?: string,
  editedBody?: Record<string, unknown>,
): Promise<PreviewItemResolutionResult> {
  const item = missionControlDb.getItem(itemId);
  if (!item) {
    throw new AppError('Item not found', {
      code: 'MC_ITEM_NOT_FOUND',
      statusCode: 404,
    });
  }
  if (item.status === 'resolving' || item.status === 'expired') {
    throw new AppError(`Item is '${item.status}', not actionable`, {
      code: 'MC_ITEM_NOT_ACTIONABLE',
      statusCode: 400,
    });
  }
  const section = missionControlDb.getSection(item.section_id);
  if (!section) {
    throw new AppError('Section not found for item', {
      code: 'MC_SECTION_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sectionActions = section.actions ?? [];
  const action = actionId
    ? item.actions.find((a) => a.id === actionId)
        ?? sectionActions.find((a) => a.id === actionId)
    : item.actions.find((a) => a.kind === 'approve' && a.terminal !== false)
        ?? sectionActions.find((a) => a.kind === 'approve' && a.terminal !== false);
  if (!action) {
    throw new AppError(
      actionId ? `Action ${actionId} not on item` : 'No previewable approve action on item',
      {
        code: 'MC_BAD_ACTION',
        statusCode: 400,
      },
    );
  }

  const body = editedBody ?? item.body;

  // No agent needed: resolving would just approve the body (or dry-run).
  if (!section.resolve_prompt.trim() || section.dry_run) {
    finishMissionControlSectionRun(section.section_id);
    return { success: true, preview: { approved: true, body }, type: 'static' };
  }

  let text: string;
  let success: boolean;
  let errorMessage: string | null;
  try {
    const prompt =
      buildResolvePrompt(section, action.id, action.label, body) + PREVIEW_READ_ONLY_NOTE;
    const run = await runMissionControlAgent({
      section,
      prompt,
      tools: section.resolve_tools,
      sourceRef: itemId,
      trigger: 'preview',
      phase: 'resolve',
    });
    text = run.text;
    success = run.success;
    errorMessage = run.errorMessage;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishMissionControlSectionRun(section.section_id, message);
    return { success: false, error: message };
  }

  if (!success) {
    const message =
      resolveProviderAuthFailure(sectionForPhase(section, 'resolve').provider, errorMessage, text)
      || errorMessage
      || text.slice(0, 500)
      || `Provider "${sectionForPhase(section, 'resolve').provider}" run failed`;
    finishMissionControlSectionRun(section.section_id, message);
    return { success: false, error: message };
  }

  try {
    const parsed = parseJsonFromAgentText(text);
    const preview =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    finishMissionControlSectionRun(section.section_id);
    return { success: true, preview, type: 'agent' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishMissionControlSectionRun(section.section_id, message);
    return { success: false, error: `Preview output could not be parsed: ${message}` };
  }
}
