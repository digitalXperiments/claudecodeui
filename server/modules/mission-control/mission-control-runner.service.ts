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
import { isKanbanEnabled } from '@/modules/app-features/app-features.service.js';
import { kanbanDb, COLUMN_BACKLOG } from '@/modules/kanban/index.js';
import { AppError } from '@/shared/utils.js';
import { resolveProviderAuthFailure } from '@/shared/provider-auth-failure.js';
import {
  collectTrelloCardRefs,
  normalizeTrelloDraftFields,
  trelloDedupeKeyAliases,
} from '@/modules/mission-control/trello-dedupe.js';

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
      href: null,
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
          href: '/mission-control',
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
      sourceRef: section.section_id,
      trigger: 'manual',
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

      // A dead login produces provider error text where JSON was expected. That
      // is an auth problem, not a formatting one — report it as such and create
      // no draft. Parking it as a "produce parse failed" item hid the real cause
      // and left one bogus item per scheduled run to triage by hand.
      const authFailure = resolveProviderAuthFailure(section.provider, errorMessage, text);
      if (authFailure) {
        missionControlDb.markSectionRun(sectionId, { error: authFailure });
        return {
          created: 0,
          skipped: 0,
          items: [],
          error: authFailure,
          message: `Produce run failed: ${authFailure}`,
        };
      }

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
          skipped++;
          continue;
        }
      }
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
    notifyPendingItems(
      section,
      section.auto_approve ? 0 : createdItems.length,
      section.auto_approve ? [] : createdItems.map((item) => item.item_id),
    );

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

/** Keys that are agent-instruction fields (used as prompt, not re-dumped as body). */
const PROMPT_BODY_KEYS = [
  'prompt',
  'agentPrompt',
  'agent_prompt',
  'implementationPrompt',
  'implementation_prompt',
  'instructions',
] as const;

/**
 * Prefer a pre-authored agent prompt from the produce body when present.
 * Produce agents sometimes put the implementer instructions in a known field.
 */
function extractBodyPrompt(body: Record<string, unknown>): string | null {
  for (const key of PROMPT_BODY_KEYS) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value == null) return `${pad}—`;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return `${pad}—`;
    // Multi-line strings: keep as-is, indented.
    if (trimmed.includes('\n')) {
      return trimmed
        .split('\n')
        .map((line) => `${pad}${line}`)
        .join('\n');
    }
    return `${pad}${trimmed}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${pad}${String(value)}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}(none)`;
    // Array of primitives → bullets; array of objects → nested blocks.
    if (value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      return value.map((v) => `${pad}- ${String(v)}`).join('\n');
    }
    return value
      .map((entry, i) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const nested = formatRecord(entry as Record<string, unknown>, indent + 1);
          return `${pad}- [${i + 1}]\n${nested}`;
        }
        return `${pad}- ${JSON.stringify(entry)}`;
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    return formatRecord(value as Record<string, unknown>, indent);
  }
  return `${pad}${JSON.stringify(value)}`;
}

function formatRecord(record: Record<string, unknown>, indent = 0): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return `${'  '.repeat(indent)}(empty)`;
  return keys
    .map((key) => {
      const label = humanizeKey(key);
      const val = record[key];
      if (
        val != null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        Object.keys(val as object).length > 0
      ) {
        return `${'  '.repeat(indent)}**${label}:**\n${formatRecord(val as Record<string, unknown>, indent + 1)}`;
      }
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
        return `${'  '.repeat(indent)}**${label}:**\n${formatValue(val, indent + 1)}`;
      }
      if (typeof val === 'string' && val.includes('\n')) {
        return `${'  '.repeat(indent)}**${label}:**\n${formatValue(val, indent + 1)}`;
      }
      const single = formatValue(val, 0).trim();
      return `${'  '.repeat(indent)}**${label}:** ${single}`;
    })
    .join('\n');
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

/** Drop bridge bookkeeping and body echoes already covered by item fields. */
function slimApprovalResult(
  result: Record<string, unknown>,
  itemBody: Record<string, unknown>,
): Record<string, unknown> {
  const slim: Record<string, unknown> = { ...result };
  delete slim.kanbanTaskId;
  // Bare approve / dry-run flags add no implementer value.
  if (slim.approved === true) delete slim.approved;
  if (slim.dryRun === true) delete slim.dryRun;
  // resolve-without-prompt stores a copy of the item body under result.body.
  if (slim.body === itemBody || deepEqualJson(slim.body, itemBody)) {
    delete slim.body;
  } else if (isNonEmptyRecord(slim.body)) {
    // Still strip prompt keys so they only appear in the prompt field.
    const bodyCopy = { ...(slim.body as Record<string, unknown>) };
    for (const key of PROMPT_BODY_KEYS) {
      delete bodyCopy[key];
    }
    if (isNonEmptyRecord(bodyCopy)) {
      slim.body = bodyCopy;
    } else {
      delete slim.body;
    }
  }
  return slim;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Build an exhaustive human-readable description for a bridged kanban card.
 * Pulls summary, body fields, ticket tracking, approval result, source, and
 * metadata so the card stands alone without opening Mission Control.
 */
export function buildKanbanBridgeDescription(
  item: McItem,
  section: McSection,
): string {
  const sections: string[] = [];
  const { label, url } = extractTicketRef(item.result);

  if (item.summary?.trim()) {
    sections.push(`## Summary\n\n${item.summary.trim()}`);
  }

  const body = item.body ?? {};
  const bodyForDisplay = { ...body };
  for (const key of PROMPT_BODY_KEYS) {
    delete bodyForDisplay[key];
  }
  if (isNonEmptyRecord(bodyForDisplay)) {
    sections.push(`## Details\n\n${formatRecord(bodyForDisplay)}`);
  }

  const trackingLines: string[] = [];
  if (label) trackingLines.push(`- **Ticket:** ${label}`);
  if (url) trackingLines.push(`- **URL:** ${url}`);
  if (trackingLines.length > 0) {
    sections.push(`## Tracking\n\n${trackingLines.join('\n')}`);
  }

  if (isNonEmptyRecord(item.result)) {
    const resultForDisplay = slimApprovalResult(item.result, item.body);
    if (isNonEmptyRecord(resultForDisplay)) {
      sections.push(`## Approval result\n\n${formatRecord(resultForDisplay)}`);
    }
  }

  if (isNonEmptyRecord(item.source)) {
    sections.push(`## Source\n\n${formatRecord(item.source)}`);
  }

  const meta: string[] = [
    `- **Mission Control section:** ${section.title}`,
    `- **Item id:** ${item.item_id}`,
    `- **Dedupe key:** ${item.dedupe_key || '—'}`,
  ];
  // Stable machine-readable markers so the bridge can find this card later
  // even if the agent used a shortLink on a previous run.
  const trelloRefs = collectTrelloCardRefs({
    dedupeKey: item.dedupe_key,
    body: item.body,
    source: item.source,
    result: item.result,
  });
  for (const ref of trelloRefs) {
    meta.push(`- **Trello ref:** \`${ref}\``);
  }
  if (item.dedupe_key) {
    meta.push(`- **External key:** \`${item.dedupe_key}\``);
  }
  if (typeof item.confidence === 'number' && item.confidence > 0) {
    meta.push(`- **Confidence:** ${item.confidence}`);
  }
  if (item.provider) {
    meta.push(`- **Produced by:** ${item.provider}${item.model ? ` / ${item.model}` : ''}`);
  }
  if (item.created_at) {
    meta.push(`- **Created:** ${item.created_at}`);
  }
  sections.push(`## Metadata\n\n${meta.join('\n')}`);

  return sections.join('\n\n').trim();
}

/**
 * Generate the implementer prompt at card-create time so the kanban agent has
 * a ready-to-run instruction when the card is moved to In Progress.
 *
 * Prefer an explicit prompt field from the produce body when present; otherwise
 * compose a structured brief from title, summary, details, and ticket context.
 */
export function buildKanbanBridgePrompt(item: McItem, section: McSection): string {
  const fromBody = extractBodyPrompt(item.body ?? {});
  const { label, url } = extractTicketRef(item.result);
  const tracking = [label, url].filter(Boolean).join(' — ');

  if (fromBody) {
    const parts = [
      fromBody,
      '',
      '---',
      `Task: ${item.title}`,
    ];
    if (item.summary?.trim()) {
      parts.push(`Summary: ${item.summary.trim()}`);
    }
    if (tracking) {
      parts.push(`Tracking: ${tracking}`);
    }
    parts.push(`Source: Mission Control · ${section.title}`);
    return parts.join('\n').trim();
  }

  const parts: string[] = [
    'You are the implementation agent for a Kanban task created from Mission Control.',
    '',
    '## Goal',
    item.title.trim(),
  ];

  if (item.summary?.trim()) {
    parts.push('', '## Summary', item.summary.trim());
  }

  const body = item.body ?? {};
  const bodyForPrompt = { ...body };
  for (const key of PROMPT_BODY_KEYS) {
    delete bodyForPrompt[key];
  }
  if (isNonEmptyRecord(bodyForPrompt)) {
    parts.push('', '## Requirements / context', formatRecord(bodyForPrompt));
  }

  if (tracking) {
    parts.push('', '## Tracking', tracking);
  }

  if (isNonEmptyRecord(item.result)) {
    const slim = slimApprovalResult(item.result, item.body);
    if (isNonEmptyRecord(slim)) {
      parts.push('', '## Approval / ticket context', formatRecord(slim));
    }
  }

  parts.push(
    '',
    '## Your job',
    '1. Read the goal and requirements carefully; treat them as the source of truth.',
    '2. Inspect the project codebase and implement the change end-to-end.',
    '3. Cover edge cases called out in the requirements; do not leave TODOs for core behavior.',
    '4. Run relevant checks/tests when available and fix failures you introduce.',
    '5. Leave a short summary of what changed and how to verify it.',
    '',
    `Origin: Mission Control · ${section.title}`,
  );

  return parts.join('\n').trim();
}

/**
 * Mission Control → Kanban bridge. When an approved item resolves and its
 * section opts in, create a backlog card on the single global board, pre-linked
 * to the created ticket and (optionally) pre-assigned a default agent. The card
 * starts with no project — the user attaches one, then moving it to In Progress
 * auto-runs. Description is exhaustive (summary, body, ticket, source, meta);
 * prompt is generated at create time so the implementer can run immediately.
 * Idempotent via `result.kanbanTaskId`; never fails the approval.
 */
function maybeBridgeToKanban(
  section: McSection,
  action: McAction,
  item: McItem,
): McItem {
  if (!isKanbanEnabled()) {
    return item;
  }
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
    // Reuse an existing Kanban card if this Trello card was bridged before
    // under a different MC item / shortLink vs full-id alias.
    const trelloRefs = collectTrelloCardRefs({
      dedupeKey: item.dedupe_key,
      body: item.body,
      source: item.source,
      result: item.result,
    });
    const markers = [
      ...trelloRefs,
      ...trelloDedupeKeyAliases(trelloRefs),
      item.dedupe_key,
    ].filter((m): m is string => typeof m === 'string' && m.length > 0);

    if (markers.length > 0) {
      const existingTask = kanbanDb.findTaskByTextMarkers(board.board_id, markers);
      if (existingTask) {
        return missionControlDb.setItemStatus(item.item_id, 'resolved', {
          result: {
            ...(item.result ?? {}),
            kanbanTaskId: existingTask.task_id,
            kanbanReused: true,
          },
        });
      }
    }

    const description = buildKanbanBridgeDescription(item, section);
    const prompt = buildKanbanBridgePrompt(item, section);

    const kanbanMcp = Array.isArray(section.kanban_mcp_tools)
      ? section.kanban_mcp_tools.filter((t) => typeof t === 'string' && t.trim().length > 0)
      : [];
    // Prefer section project scope when present; otherwise leave empty for the user.
    const bridgeProjectId =
      section.scope === 'project' && section.project_id?.trim() ? section.project_id.trim() : '';
    const task = kanbanDb.createTask({
      boardId: board.board_id,
      projectId: bridgeProjectId,
      title: item.title,
      description,
      prompt,
      columnId: COLUMN_BACKLOG,
      assigneeProvider: section.kanban_assignee_provider,
      reviewProvider: section.kanban_review_provider,
      ...(kanbanMcp.length > 0
        ? {
            tools: {
              mcpServers: kanbanMcp,
            },
          }
        : {}),
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
    await resolveMissionControlInterrupts(itemId, actionId);
    return null;
  }

  if (item.status !== 'pending' && item.status !== 'failed') {
    throw new AppError(`Item is '${item.status}', not actionable`, {
      code: 'MC_ITEM_NOT_ACTIONABLE',
      statusCode: 400,
    });
  }

  if (action.kind === 'dismiss') {
    const dismissed = missionControlDb.setItemStatus(itemId, 'dismissed', {
      resolvedAt: new Date().toISOString(),
    });
    await resolveMissionControlInterrupts(itemId, actionId);
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
    const resolved = missionControlDb.setItemStatus(itemId, 'resolved', {
      result: { dryRun: true },
      resolvedAt: new Date().toISOString(),
      error: null,
    });
    const bridged = maybeBridgeToKanban(section, action, resolved);
    await resolveMissionControlInterrupts(itemId, actionId);
    return bridged;
  }

  if (!section.resolve_prompt.trim()) {
    // Approve without resolve prompt just marks resolved with body.
    const resolved = missionControlDb.setItemStatus(itemId, 'resolved', {
      result: { approved: true, body },
      resolvedAt: new Date().toISOString(),
      error: null,
    });
    const bridged = maybeBridgeToKanban(section, action, resolved);
    await resolveMissionControlInterrupts(itemId, actionId);
    return bridged;
  }

  try {
    const prompt = buildResolvePrompt(section, action.id, action.label, body);
    const { text, success, errorMessage } = await runMissionControlAgent({
      section,
      prompt,
      tools: section.resolve_tools,
      sourceRef: itemId,
      trigger: 'manual',
    });

    // Provider/runtime failure: mark the item failed (retryable) instead of
    // resolving it with an error dump as the result.
    if (!success) {
      return missionControlDb.setItemStatus(itemId, 'failed', {
        error:
          resolveProviderAuthFailure(section.provider, errorMessage, text)
          || errorMessage
          || text.slice(0, 500)
          || `Provider "${section.provider}" run failed`,
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
      // Only unparseable output can be a bare provider error dump. A resolve
      // result that *parsed* is the model's answer, even if it happens to
      // discuss expired sessions — checking that would fail items for
      // legitimately auth-themed content.
      const authFailure = resolveProviderAuthFailure(section.provider, errorMessage, text);
      if (authFailure) {
        return missionControlDb.setItemStatus(itemId, 'failed', { error: authFailure });
      }
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
    const bridged = maybeBridgeToKanban(section, action, resolved);
    await resolveMissionControlInterrupts(itemId, actionId);
    return bridged;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return missionControlDb.setItemStatus(itemId, 'failed', {
      error: message,
    });
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
 * `failed` (retryable). No kanban bridge is triggered.
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
    });
    text = run.text;
    success = run.success;
    errorMessage = run.errorMessage;
  } catch (error) {
    // Runtime unavailable / run-in-progress: surface on the item so it stays
    // retryable instead of throwing a 500 at the user.
    const message = error instanceof Error ? error.message : String(error);
    const failed = missionControlDb.setItemStatus(itemId, 'failed', { error: message });
    return { success: false, item: failed, error: message };
  }

  if (!success) {
    const msg =
      resolveProviderAuthFailure(section.provider, errorMessage, text)
      || errorMessage
      || text.slice(0, 500)
      || `Provider "${section.provider}" run failed`;
    const failed = missionControlDb.setItemStatus(itemId, 'failed', { error: msg });
    return { success: false, item: failed, error: msg };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonFromAgentText(text);
  } catch {
    // Unparseable output: nothing to match against, keep the item as-is.
    return {
      success: false,
      item: missionControlDb.getItem(itemId)!,
      error: 'Retry produced unparseable output',
    };
  }

  const drafts = coerceDrafts(parsed);
  const match = drafts.find(
    (draft) => draft.dedupeKey === item.dedupe_key || draft.title === item.title,
  );
  if (!match) {
    return {
      success: false,
      item: missionControlDb.getItem(itemId)!,
      error: 'Retry produced no matching item',
    };
  }

  // Reset status to pending with the fresh body (clear the error, drop any
  // stale resolved_at) before patching title/summary/confidence.
  missionControlDb.setItemStatus(itemId, 'pending', {
    body: match.body,
    error: null,
    resolvedAt: null,
  });
  const updated = missionControlDb.updateItem(itemId, {
    title: match.title,
    summary: match.summary || item.summary,
    confidence: match.confidence,
  });
  return {
    success: true,
    item: updated ?? missionControlDb.getItem(itemId)!,
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
 * mutating the item or running the kanban bridge.
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
  if (item.status !== 'pending' && item.status !== 'failed') {
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
    });
    text = run.text;
    success = run.success;
    errorMessage = run.errorMessage;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }

  if (!success) {
    const message =
      resolveProviderAuthFailure(section.provider, errorMessage, text)
      || errorMessage
      || text.slice(0, 500)
      || `Provider "${section.provider}" run failed`;
    return { success: false, error: message };
  }

  try {
    const parsed = parseJsonFromAgentText(text);
    const preview =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    return { success: true, preview, type: 'agent' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Preview output could not be parsed: ${message}` };
  }
}
