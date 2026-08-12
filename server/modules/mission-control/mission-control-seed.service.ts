import { appConfigDb } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import type { CreateMcSectionInput, McSection } from '@/modules/mission-control/mission-control.types.js';
import { syncMissionControlSchedules } from '@/modules/mission-control/mission-control-scheduler.service.js';
import {
  getTrelloSeedConfigPath,
  loadTrelloSeedConfig,
  type TrelloSeedBoardConfig,
} from '@/modules/mission-control/mission-control-seed.config.js';
import {
  buildSwipeDigestSectionInput,
  buildXArticlesSectionInput,
  SWIPE_DIGEST_PROMPT_VERSION,
  SWIPE_DIGEST_SECTION_TITLE,
  X_ARTICLES_PROMPT_VERSION,
  X_ARTICLES_SECTION_TITLE,
} from '@/modules/mission-control/x-articles-seed.js';
import { ensureArticleStudioWorkspace } from '@/modules/mission-control/article-studio.service.js';

/** Stable title used for idempotent seeding (do not rename casually). */
export const TRELLO_TASKS_SECTION_TITLE = 'Trello Tasks';

/**
 * Bump when produce_prompt semantics change so ensure*() can refresh existing rows.
 */
export const TRELLO_TASKS_PROMPT_VERSION = 5;

// ---------------------------------------------------------------------------
// Built-in seed suppressions
//
// On every boot we re-ensure a few first-party sections. Without a tombstone,
// deleting them in the UI only lasts until the next restart. Persist the
// user's opt-out in app_config so ensure*() skips re-creation.
// ---------------------------------------------------------------------------

/** app_config key: JSON string array of stable seed keys the user deleted. */
export const MC_SEED_SUPPRESSIONS_KEY = 'mc_seed_suppressions';

/** Stable keys (not titles) so renames of display titles stay coherent. */
export const MC_SEED_KEYS = {
  xArticles: 'x-articles',
  swipeDigest: 'swipe-digest',
  trelloTasks: 'trello-tasks',
} as const;

export type McSeedKey = (typeof MC_SEED_KEYS)[keyof typeof MC_SEED_KEYS];

const SEED_TITLE_TO_KEY = new Map<string, McSeedKey>([
  [X_ARTICLES_SECTION_TITLE.trim().toLowerCase(), MC_SEED_KEYS.xArticles],
  [SWIPE_DIGEST_SECTION_TITLE.trim().toLowerCase(), MC_SEED_KEYS.swipeDigest],
  [TRELLO_TASKS_SECTION_TITLE.trim().toLowerCase(), MC_SEED_KEYS.trelloTasks],
]);

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function readSuppressedSeeds(): Set<string> {
  const raw = appConfigDb.get(MC_SEED_SUPPRESSIONS_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
  } catch {
    return new Set();
  }
}

function writeSuppressedSeeds(keys: Set<string>): void {
  appConfigDb.set(MC_SEED_SUPPRESSIONS_KEY, JSON.stringify([...keys].sort()));
}

/** Resolve a section title to a built-in seed key, if any. */
export function seedKeyForSectionTitle(title: string): McSeedKey | null {
  return SEED_TITLE_TO_KEY.get(normalizeTitle(title)) ?? null;
}

export function isSeedSuppressed(seedKey: McSeedKey): boolean {
  return readSuppressedSeeds().has(seedKey);
}

/** Remember that the user deleted this built-in section (no-op for custom titles). */
export function suppressSeedByTitle(title: string): void {
  const key = seedKeyForSectionTitle(title);
  if (!key) return;
  const next = readSuppressedSeeds();
  if (next.has(key)) return;
  next.add(key);
  writeSuppressedSeeds(next);
}

/**
 * Forget a suppression — used when the user manually re-creates a section with
 * the matching title, so boot-time ensure can maintain it again.
 */
export function clearSeedSuppressionByTitle(title: string): void {
  const key = seedKeyForSectionTitle(title);
  if (!key) return;
  const next = readSuppressedSeeds();
  if (!next.has(key)) return;
  next.delete(key);
  writeSuppressedSeeds(next);
}

export type EnsureSectionResult = {
  created: boolean;
  updated: boolean;
  /** Null when the seed is suppressed and no row exists. */
  section: McSection | null;
  suppressed: boolean;
};

/**
 * Produce agent (Grok Build) pulls open Trello cards via Composio and emits MC
 * drafts that include an implementer `prompt`. On auto-approve, Mission Control
 * bridges to the global Kanban backlog (no project/agent pre-assigned).
 */
function buildTrelloTasksProducePrompt(board: TrelloSeedBoardConfig): string {
  const projectPathExample = board.suggestedProjectPathExample ?? '/path/to/project';
  return `You are Mission Control produce for ${board.client} client work tracked in Trello.
Prompt version: ${TRELLO_TASKS_PROMPT_VERSION}

## Critical success criteria
The **${board.priorityListName}** list on board **${board.boardName}** holds active work. You MUST emit **one draft per card on that list that is still incomplete** (except cards already ingested — dedupeKey handles that). Emitting only 1–3 items when many incomplete cards exist is a **FAILURE**.

## Tools (required)
Use **Composio** for Trello (toolkit: trello). Typical sequence:
1. TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD with idBoard="${board.boardShortLink}" (or "${board.boardId}"), filter="open", cards="open", card_fields including id,name,desc,closed,due,dueComplete,dateLastActivity,shortUrl,url,idList,labels,idMembers,badges
2. If lists payload is too large, use TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD_BY_FILTER idBoard=same filter="open", then TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD without cards to map idList→name.
3. Optionally hydrate a card with TRELLO_GET_CARDS_BY_ID_CARD / comments only when desc is empty and you need context — **do not** wait to enrich every card deeply before emitting.

Obsidian prior-context search is **optional and only for a few high-value cards** if time remains. Never block the array on Obsidian.

If Composio/Trello fails, return [] (do not invent cards).

## Board + list (ONLY this list)
- Name: ${board.boardName}
- shortLink: ${board.boardShortLink}
- id: ${board.boardId}
- URL: ${board.boardUrl}
- **ONLY list:** **${board.priorityListName}** (list id: ${board.priorityListId})

Ignore every other list on the board (Important Tickets for Reference, done columns, etc.). Do not emit cards from those lists.

## What counts as incomplete (INCLUDE only these)
INCLUDE a card when ALL of:
- It lives on list **${board.priorityListName}** (match name or list id above)
- closed === false (not archived)
- **NOT marked complete in Trello** — require \`dueComplete === false\` (and badges.dueComplete !== true). The green check / "complete" mark on a card means DONE: **skip it**.

Do **not** skip solely because:
- checklist is empty
- due date is in the past (past due + not marked complete = still incomplete)
- card looks "document-y" or audit-y (still real work if not marked complete)

EXCLUDE when ANY of:
- not on **${board.priorityListName}**
- closed/archived
- **dueComplete === true** (or badges.dueComplete true) — already completed, even if still sitting on the priority list
- name is empty / template junk only

## Coverage rules (mandatory)
1. Emit **every incomplete** card on **${board.priorityListName}** only (up to 40). Incomplete = open + not dueComplete.
2. Do **not** cherry-pick "most important" only — full incomplete coverage of that list.
3. Keep bodies **compact** so the full JSON array fits: body.prompt ≤ ~250 words; summary ≤ 2 sentences; skip long comment dumps (max 3 short comment lines).
4. Obsidian: skip on this pass if it risks truncating the array.

## Per-card fields
Each card → one draft:
- "title": use the card name mostly as-is (you may lightly clean). Prefer "Client — goal" when the card name already has a client prefix.
- "summary": 1–2 sentences of outcome.
- "body": {
    "trelloCardId": string,
    "trelloUrl": string,
    "trelloBoard": "${board.boardName}",
    "listName": string,
    "client": string (from title prefix; internal → "${board.client}"),
    "suggestedProjectPath": string|null (e.g. ${projectPathExample}),
    "description": card desc trimmed (truncate to ~800 chars if huge),
    "dueComplete": boolean,
    "comments": [] or short strings,
    "checklists": remaining open items only (or []),
    "labels": string[],
    "priorContext": "" (unless you already have it),
    "whatNeedsToBeDone": one short paragraph,
    "actionItems": 2–6 short steps,
    "prompt": compact implementer brief (goal, acceptance, steps, verify, Trello URL; note ${board.client} MCP for platform work if applicable),
    "ticket": trelloCardId,
    "url": trelloUrl
  }
- "dedupeKey": "trello:card:<FULL_24_CHAR_CARD_ID>" — MUST use the card's full \`id\` field (24 hex chars), NEVER the shortLink alone. Also put full id in body.trelloCardId and shortUrl/url in body.trelloUrl so shortLink can be recovered.
- "confidence": 0.7–0.95

## Output
Return ONLY a JSON array of drafts (or []). No prose, no tool narration, no code fences.
If ${board.priorityListName} has N open cards and you only return 1, you failed — go back and include the rest.`;
}

export function buildTrelloTasksSectionInput(board: TrelloSeedBoardConfig): CreateMcSectionInput {
  return {
    title: TRELLO_TASKS_SECTION_TITLE,
    icon: '📋',
    sort_order: 10,
    enabled: true,
    scope: 'global',
    project_id: null,
    mode: 'review',
    schedule_cron: '15 9-19 * * 1-5',
    provider: 'grok',
    model: null,
    permission_mode: 'bypassPermissions',
    dry_run: false,
    // Auto-bridge to Kanban so you assign project/agents and run from the board.
    // Note: resolved items disappear from the "Actionable" filter — check Kanban
    // backlog or switch Mission Control filter to "All".
    auto_approve: true,
    produce_prompt: buildTrelloTasksProducePrompt(board),
    produce_tools: ['Composio', 'obsidian'],
    resolve_prompt: '',
    resolve_tools: [],
    create_kanban_task: true,
    kanban_assignee_provider: null,
    kanban_review_provider: null,
    kanban_mcp_tools: board.kanbanMcpTools ?? ['Composio'],
  };
}

/**
 * Ensure the Trello Tasks section exists and its produce prompt stays in sync
 * with the user's board config (refreshes produce_prompt/tools when stale).
 * No-op when `~/.cloudcli/mission-control/trello-seed.json` isn't present —
 * this feature is opt-in and never ships with baked-in board data.
 */
export function ensureTrelloTasksSection(): EnsureSectionResult {
  const board = loadTrelloSeedConfig();
  if (!board) {
    return { created: false, updated: false, section: null, suppressed: false };
  }

  const input = buildTrelloTasksSectionInput(board);
  const existing = missionControlDb
    .listSections()
    .find((s) => s.title.trim().toLowerCase() === TRELLO_TASKS_SECTION_TITLE.toLowerCase());

  if (!existing) {
    if (isSeedSuppressed(MC_SEED_KEYS.trelloTasks)) {
      return { created: false, updated: false, section: null, suppressed: true };
    }
    const section = missionControlDb.createSection(input);
    try {
      syncMissionControlSchedules();
    } catch {
      // Scheduler may not be running in tests.
    }
    return { created: true, updated: false, section, suppressed: false };
  }

  // Section is present again — drop any stale tombstone from a prior delete.
  clearSeedSuppressionByTitle(TRELLO_TASKS_SECTION_TITLE);

  const versionMarker = `Prompt version: ${TRELLO_TASKS_PROMPT_VERSION}`;
  const stale =
    !existing.produce_prompt.includes(versionMarker) ||
    existing.provider !== 'grok' ||
    !existing.create_kanban_task ||
    JSON.stringify(existing.produce_tools) !== JSON.stringify(input.produce_tools) ||
    JSON.stringify(existing.kanban_mcp_tools ?? []) !== JSON.stringify(input.kanban_mcp_tools ?? []);

  if (!stale) {
    return { created: false, updated: false, section: existing, suppressed: false };
  }

  const section = missionControlDb.updateSection(existing.section_id, {
    produce_prompt: input.produce_prompt,
    produce_tools: input.produce_tools,
    provider: 'grok',
    auto_approve: true,
    create_kanban_task: true,
    kanban_mcp_tools: input.kanban_mcp_tools,
    resolve_prompt: '',
    resolve_tools: [],
    schedule_cron: input.schedule_cron,
    enabled: true,
  });

  try {
    syncMissionControlSchedules();
  } catch {
    // ignore in tests
  }

  return { created: false, updated: true, section, suppressed: false };
}

/**
 * Seed one article-studio section, keeping the versioned prompt current while
 * leaving everything the user tunes from the UI alone.
 *
 * The section is bound to the studio project so the agent runs *inside* the
 * working directory and picks up CLAUDE.md, the voice spec, the pattern library
 * and `.claude/skills/`. `project_id` is re-pointed on refresh: if the studio
 * moves, the section has to follow it or the writing system silently vanishes.
 */
function ensureArticleSection(
  title: string,
  seedKey: McSeedKey,
  versionMarker: string,
  input: CreateMcSectionInput,
): EnsureSectionResult {
  const existing = missionControlDb
    .listSections()
    .find((s) => s.title.trim().toLowerCase() === title.toLowerCase());

  if (!existing) {
    if (isSeedSuppressed(seedKey)) {
      return { created: false, updated: false, section: null, suppressed: true };
    }
    const section = missionControlDb.createSection(input);
    try {
      syncMissionControlSchedules();
    } catch {
      // Scheduler may not be running in tests.
    }
    return { created: true, updated: false, section, suppressed: false };
  }

  // Section is present again — drop any stale tombstone from a prior delete.
  clearSeedSuppressionByTitle(title);

  const stale =
    !existing.produce_prompt.includes(versionMarker) ||
    existing.scope !== input.scope ||
    existing.project_id !== input.project_id ||
    JSON.stringify(existing.produce_tools) !== JSON.stringify(input.produce_tools) ||
    JSON.stringify(existing.actions ?? []) !== JSON.stringify(input.actions ?? existing.actions ?? []);

  if (!stale) {
    return { created: false, updated: false, section: existing, suppressed: false };
  }

  // Refresh prompt-shaped fields and the studio binding only. Provider, model,
  // cron and enabled stay as the user set them.
  const section = missionControlDb.updateSection(existing.section_id, {
    scope: input.scope,
    project_id: input.project_id,
    produce_prompt: input.produce_prompt,
    produce_tools: input.produce_tools,
    resolve_prompt: input.resolve_prompt,
    resolve_tools: input.resolve_tools,
    ...(input.actions ? { actions: input.actions } : {}),
    auto_approve: false,
    create_kanban_task: false,
  });

  // updateSection returns null only when the row vanished between the read and
  // the write; fall back to the row we already have rather than throwing on boot.
  return {
    created: false,
    updated: section !== null,
    section: section ?? existing,
    suppressed: false,
  };
}

/** Ensure the X Articles drafting section exists and points at the studio. */
export function ensureXArticlesSection(projectId: string): EnsureSectionResult {
  return ensureArticleSection(
    X_ARTICLES_SECTION_TITLE,
    MC_SEED_KEYS.xArticles,
    `Prompt version: ${X_ARTICLES_PROMPT_VERSION}`,
    buildXArticlesSectionInput(projectId),
  );
}

/** Ensure the Swipe Digest section exists and points at the studio. */
export function ensureSwipeDigestSection(projectId: string): EnsureSectionResult {
  return ensureArticleSection(
    SWIPE_DIGEST_SECTION_TITLE,
    MC_SEED_KEYS.swipeDigest,
    `Prompt version: ${SWIPE_DIGEST_PROMPT_VERSION}`,
    buildSwipeDigestSectionInput(projectId),
  );
}

/**
 * Scaffold the article studio directory, register it as a project, and seed
 * both article sections against it (unless the user deleted them).
 *
 * Filesystem work makes this async, so it is kept out of the synchronous
 * `ensureMissionControlSeedSections` path and awaited separately at boot.
 */
export async function ensureArticleStudioSections(
  workspacePath?: string,
): Promise<{ workspacePath: string; projectId: string; sections: McSection[] }> {
  const workspace = await ensureArticleStudioWorkspace(workspacePath);
  const sections = [
    ensureXArticlesSection(workspace.projectId).section,
    ensureSwipeDigestSection(workspace.projectId).section,
  ].filter((section): section is McSection => section !== null);
  return {
    workspacePath: workspace.workspacePath,
    projectId: workspace.projectId,
    sections,
  };
}

/**
 * Seed all built-in Mission Control sections. Safe to call on every boot.
 *
 * Article studio sections are seeded by `ensureArticleStudioSections` instead —
 * they need filesystem scaffolding first.
 */
export function ensureMissionControlSeedSections(): McSection[] {
  const out: McSection[] = [];
  const trello = ensureTrelloTasksSection();
  if (trello.section) out.push(trello.section);
  return out;
}

export { getTrelloSeedConfigPath };
export type { TrelloSeedBoardConfig };
