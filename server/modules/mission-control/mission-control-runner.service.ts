import { systemNotificationsDb } from '@/modules/database/index.js';
import {
  buildProducePrompt,
  buildResolvePrompt,
  parseJsonFromAgentText,
  runMissionControlAgent,
} from '@/modules/mission-control/mission-control-agent.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import type {
  McAction,
  McDraftItem,
  McItem,
  McSection,
} from '@/modules/mission-control/mission-control.types.js';
import { kanbanDb, COLUMN_BACKLOG } from '@/modules/kanban/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Normalize produce JSON into a candidate list. Accepts a bare array, a single
 * draft object, or a common wrapper ({ items | drafts | results }).
 */
function draftCandidates(raw: unknown): unknown[] {
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

function coerceDrafts(raw: unknown): McDraftItem[] {
  const arr = draftCandidates(raw);
  const drafts: McDraftItem[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    const dedupeKey =
      typeof e.dedupeKey === 'string'
        ? e.dedupeKey.trim()
        : typeof e.dedupe_key === 'string'
          ? e.dedupe_key.trim()
          : '';
    if (!title || !dedupeKey) continue;
    const body =
      e.body && typeof e.body === 'object' && !Array.isArray(e.body)
        ? (e.body as Record<string, unknown>)
        : {};
    drafts.push({
      title,
      summary: typeof e.summary === 'string' ? e.summary : '',
      body,
      dedupeKey,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0,
      source: { dedupeKey },
    });
  }
  return drafts;
}

function notifyPendingItems(section: McSection, count: number): void {
  if (count <= 0) return;
  try {
    systemNotificationsDb.create({
      kind: 'action_required',
      severity: 'info',
      title: `${section.title}: ${count} item${count === 1 ? '' : 's'} need review`,
      body: `Mission Control produced ${count} new draft${count === 1 ? '' : 's'}.`,
      source: 'mission-control',
      href: null,
      meta: { sectionId: section.section_id },
      dedupeKey: `mc-section-${section.section_id}-pending`,
    });
  } catch (error) {
    console.warn('[MissionControl] failed to create notification', error);
  }
}

/**
 * Run a section's produce step (scheduled or manual).
 * - review mode: parse draft items into the queue
 * - fire_and_forget: store one resolved result item with agent output
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

export async function runSectionProduce(sectionId: string): Promise<ProduceRunResult> {
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

  try {
    const prompt = buildProducePrompt(section);
    const { text, success, errorMessage } = await runMissionControlAgent({
      section,
      prompt,
      tools: section.produce_tools,
    });

    // Provider/runtime failure (API unreachable, CLI crash, …): the output is
    // an error dump, not produce content. Record it on the section and create
    // nothing — there is no item to review.
    if (!success) {
      const msg =
        errorMessage || text.slice(0, 500) || `Provider "${section.provider}" run failed`;
      missionControlDb.markSectionRun(sectionId, { error: msg });
      return {
        created: 0,
        skipped: 0,
        items: [],
        error: msg,
        message: `Produce run failed: ${msg}`,
      };
    }

    if (section.mode === 'fire_and_forget') {
      const now = new Date();
      const dedupeKey = `run:${section.section_id}:${now.toISOString()}`;
      const firstLine =
        text
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.length > 0) || 'Run completed';
      const title = `${section.title} · ${now.toLocaleString()}`;
      const item = missionControlDb.insertItemIfNew(section, {
        title,
        summary: firstLine.slice(0, 240),
        body: {
          output: text,
          mode: 'fire_and_forget',
          ranAt: now.toISOString(),
        },
        dedupeKey,
        confidence: 1,
        source: { kind: 'fire_and_forget', ranAt: now.toISOString() },
      });
      if (item) {
        missionControlDb.setItemStatus(item.item_id, 'resolved', {
          result: { output: text, ranAt: now.toISOString() },
          resolvedAt: now.toISOString(),
        });
      }
      missionControlDb.markSectionRun(sectionId, { error: null });
      const resolved = item ? [missionControlDb.getItem(item.item_id)!] : [];
      return {
        created: resolved.length,
        skipped: 0,
        items: resolved,
        message: 'Fire-and-forget run logged.',
      };
    }

    // Review mode: structured drafts
    let parsed: unknown;
    try {
      parsed = parseJsonFromAgentText(text);
    } catch (parseError) {
      const message =
        parseError instanceof Error ? parseError.message : String(parseError);
      missionControlDb.markSectionRun(sectionId, {
        error: `Failed to parse produce output: ${message}`,
      });
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

    const drafts = coerceDrafts(parsed);
    if (drafts.length === 0) {
      const candidateCount = draftCandidates(parsed).length;
      // Empty produce is a normal no-op: nothing to queue and nothing to
      // resolve/auto-approve. Only treat as an error when the model returned
      // objects that were missing required title + dedupeKey.
      if (candidateCount === 0) {
        missionControlDb.markSectionRun(sectionId, { error: null });
        return {
          created: 0,
          skipped: 0,
          items: [],
          message: 'Produce finished: nothing new to review.',
        };
      }
      const msg =
        'Produce finished but returned 0 valid drafts (each item needs title + dedupeKey).';
      missionControlDb.markSectionRun(sectionId, { error: msg });
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
      // Strict dedupe: never re-open dismissed/denied/resolved/failed items.
      const item = missionControlDb.insertItemIfNew(section, draft);
      if (!item) {
        skipped++;
        continue;
      }
      let current = item;
      if (section.auto_approve) {
        const approve = current.actions.find((a) => a.kind === 'approve');
        if (approve) {
          const next = await applyItemAction(current.item_id, approve.id, undefined);
          // auto-approve should never hard-delete; if it did, skip the item
          if (!next) continue;
          current = next;
        }
      }
      createdItems.push(current);
    }

    missionControlDb.markSectionRun(sectionId, { error: null });
    notifyPendingItems(section, section.auto_approve ? 0 : createdItems.length);

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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    missionControlDb.markSectionRun(sectionId, { error: message });
    throw error;
  }
}

/**
 * Apply a review action. Returns the updated item, or `null` when the item
 * was hard-deleted (kind `delete`) so the dedupe key is free for a re-run.
 */
/** Best-effort pull of a tracking reference (e.g. a JIRA key + URL) from a
 * resolve result, so the bridged card links back to the created ticket. */
function extractTicketRef(result: Record<string, unknown> | null): {
  label: string | null;
  url: string | null;
} {
  if (!result) {
    return { label: null, url: null };
  }
  const pick = (keys: string[]): string | null => {
    for (const key of keys) {
      const value = result[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  };
  return {
    label: pick(['key', 'issueKey', 'issue_key', 'ticket', 'ticketKey', 'id']),
    url: pick(['url', 'link', 'browseUrl', 'permalink', 'self']),
  };
}

/**
 * Mission Control → Kanban bridge. When an approved item resolves and its
 * section opts in, create a backlog card on the single global board, pre-linked
 * to the created ticket and (optionally) pre-assigned a default agent. The card
 * starts with no project — the user attaches one, then moving it to In Progress
 * auto-runs. Idempotent via `result.kanbanTaskId`; never fails the approval.
 */
function maybeBridgeToKanban(
  section: McSection,
  action: McAction,
  item: McItem,
): McItem {
  if (!section.create_kanban_task || action.kind !== 'approve' || item.status !== 'resolved') {
    return item;
  }
  const alreadyBridged =
    item.result && typeof item.result.kanbanTaskId === 'string' && item.result.kanbanTaskId;
  if (alreadyBridged) {
    return item;
  }
  try {
    const board = kanbanDb.getOrCreateGlobalBoard();
    const { label, url } = extractTicketRef(item.result);
    const lines: string[] = [];
    if (item.summary) {
      lines.push(item.summary);
    }
    const tracking = [label, url].filter(Boolean).join(' — ');
    if (tracking) {
      lines.push(`Tracking: ${tracking}`);
    }
    lines.push(`From Mission Control · ${section.title}`);

    const task = kanbanDb.createTask({
      boardId: board.board_id,
      // No project yet — the user attaches one before moving to In Progress.
      projectId: '',
      title: item.title,
      description: lines.join('\n\n'),
      columnId: COLUMN_BACKLOG,
      assigneeProvider: section.kanban_assignee_provider,
      reviewProvider: section.kanban_review_provider,
    });

    return missionControlDb.setItemStatus(item.item_id, 'resolved', {
      result: { ...(item.result ?? {}), kanbanTaskId: task.task_id },
    });
  } catch (error) {
    console.error(
      '[mission-control] kanban bridge failed:',
      error instanceof Error ? error.message : error,
    );
    return item;
  }
}

export async function applyItemAction(
  itemId: string,
  actionId: string,
  editedBody?: Record<string, unknown>,
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
    if (item.status === 'resolving') {
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
    return null;
  }

  if (item.status !== 'pending' && item.status !== 'failed') {
    throw new AppError(`Item is '${item.status}', not actionable`, {
      code: 'MC_ITEM_NOT_ACTIONABLE',
      statusCode: 400,
    });
  }

  if (action.kind === 'dismiss') {
    return missionControlDb.setItemStatus(itemId, 'dismissed', {
      resolvedAt: new Date().toISOString(),
    });
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
    const resolved = missionControlDb.setItemStatus(itemId, 'resolved', {
      result: { dryRun: true },
      resolvedAt: new Date().toISOString(),
      error: null,
    });
    return maybeBridgeToKanban(section, action, resolved);
  }

  if (!section.resolve_prompt.trim()) {
    // Approve without resolve prompt just marks resolved with body.
    const resolved = missionControlDb.setItemStatus(itemId, 'resolved', {
      result: { approved: true, body },
      resolvedAt: new Date().toISOString(),
      error: null,
    });
    return maybeBridgeToKanban(section, action, resolved);
  }

  try {
    const prompt = buildResolvePrompt(section, action.id, action.label, body);
    const { text, success, errorMessage } = await runMissionControlAgent({
      section,
      prompt,
      tools: section.resolve_tools,
    });

    // Provider/runtime failure: mark the item failed (retryable) instead of
    // resolving it with an error dump as the result.
    if (!success) {
      return missionControlDb.setItemStatus(itemId, 'failed', {
        error: errorMessage || text.slice(0, 500) || `Provider "${section.provider}" run failed`,
      });
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
      result = { raw: text };
    }

    if (typeof result.error === 'string') {
      return missionControlDb.setItemStatus(itemId, 'failed', {
        error: result.error,
        result,
        resolvedAt: null,
      });
    }

    if (action.terminal === false) {
      return missionControlDb.setItemStatus(itemId, 'pending', {
        body: { ...body, ...result },
        error: null,
      });
    }

    const resolved = missionControlDb.setItemStatus(itemId, 'resolved', {
      result,
      resolvedAt: new Date().toISOString(),
      error: null,
    });
    return maybeBridgeToKanban(section, action, resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return missionControlDb.setItemStatus(itemId, 'failed', {
      error: message,
    });
  }
}
