import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { getSectionVersionHistory, recordSectionVersion } from '@/modules/mission-control/mission-control-versions.service.js';
import { listBotMemories, proposeBotMemory, reviewBotMemory } from '@/modules/mission-control/mission-control-memory.service.js';
import { listBotExceptions } from '@/modules/mission-control/mission-control-exceptions.service.js';
import { runsDb } from '@/modules/runs/index.js';
import {
  applyItemAction,
  previewItemResolution,
  retryItem,
  runSectionProduce,
} from '@/modules/mission-control/mission-control-runner.service.js';
import { simulateSectionTick } from '@/modules/mission-control/mission-control-simulator.service.js';
import { matchProjectsForItem, workThisItem } from '@/modules/mission-control/mission-control-work.service.js';
import { syncMissionControlSchedules } from '@/modules/mission-control/mission-control-scheduler.service.js';
import {
  DEFAULT_MC_ACTIONS,
  isMcProvider,
  type CreateMcSectionInput,
  type McAction,
  type McItemStatus,
  type McProvider,
  type McToolPolicy,
  type McSectionMode,
  type McSectionScope,
  type UpdateMcSectionInput,
} from '@/modules/mission-control/mission-control.types.js';
import {
  importFromMissionControlDb,
  resolveDefaultLegacyDbPath,
} from '@/modules/mission-control/mission-control-import.service.js';
import { generateArticleAssets } from '@/modules/mission-control/article-assets.service.js';
import {
  clearSeedSuppressionByTitle,
  suppressSeedByTitle,
} from '@/modules/mission-control/mission-control-seed.service.js';
import {
  runSectionWorkshop,
  type SectionWorkshopMessage,
  type SectionWorkshopDraft,
} from '@/modules/mission-control/mission-control-section-workshop.service.js';

const router = express.Router();

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function paramId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function parseActions(value: unknown): McAction[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError('actions must be an array', {
      code: 'MC_INVALID_ACTIONS',
      statusCode: 400,
    });
  }
  if (value.length === 0) return [...DEFAULT_MC_ACTIONS];
  return value.map((raw) => {
    const a = raw as Record<string, unknown>;
    const id = readString(a.id).trim();
    const label = readString(a.label).trim() || id;
    if (!id) {
      throw new AppError('Each action requires an id', {
        code: 'MC_INVALID_ACTIONS',
        statusCode: 400,
      });
    }
    return {
      id,
      label,
      kind: readString(a.kind).trim() || 'approve',
      style: (['primary', 'secondary', 'destructive'].includes(String(a.style))
        ? String(a.style)
        : 'secondary') as McAction['style'],
      terminal: a.terminal === false ? false : true,
    };
  });
}

function parseTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError('tools must be an array of strings', {
      code: 'MC_INVALID_TOOLS',
      statusCode: 400,
    });
  }
  return value
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseToolPolicy(value: unknown): McToolPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('tool_policy must be an object of tool policies', {
      code: 'MC_INVALID_TOOL_POLICY',
      statusCode: 400,
    });
  }
  const policy: McToolPolicy = {};
  for (const [server, rawTools] of Object.entries(value)) {
    if (!rawTools || typeof rawTools !== 'object' || Array.isArray(rawTools)) {
      throw new AppError('tool_policy entries must be objects', {
        code: 'MC_INVALID_TOOL_POLICY',
        statusCode: 400,
      });
    }
    policy[server] = {};
    for (const [tool, decision] of Object.entries(rawTools)) {
      if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') {
        throw new AppError('tool_policy decisions must be allow, ask, or deny', {
          code: 'MC_INVALID_TOOL_POLICY',
          statusCode: 400,
        });
      }
      policy[server][tool] = decision;
    }
  }
  return policy;
}

function parseSectionBody(body: Record<string, unknown>, partial: boolean): CreateMcSectionInput | UpdateMcSectionInput {
  const title = readOptionalString(body.title);
  if (!partial && (!title || !title.trim())) {
    throw new AppError('title is required', {
      code: 'MC_TITLE_REQUIRED',
      statusCode: 400,
    });
  }

  let provider = body.provider;
  if (provider !== undefined && provider !== null && provider !== '') {
    if (!isMcProvider(provider)) {
      throw new AppError(`Invalid provider: ${String(provider)}`, {
        code: 'MC_INVALID_PROVIDER',
        statusCode: 400,
      });
    }
  }

  let scope: McSectionScope | undefined;
  if (body.scope !== undefined) {
    scope = body.scope === 'project' ? 'project' : 'global';
  }

  let mode: McSectionMode | undefined;
  if (body.mode !== undefined) {
    mode = body.mode === 'fire_and_forget' ? 'fire_and_forget' : 'review';
  }

  const projectId =
    body.project_id === null
      ? null
      : body.project_id !== undefined
        ? readString(body.project_id) || null
        : undefined;
  const workProjectId =
    body.work_project_id === null
      ? null
      : body.work_project_id !== undefined
        ? readString(body.work_project_id) || null
        : undefined;

  if (scope === 'project' && !projectId && !partial) {
    throw new AppError('project_id is required when scope is project', {
      code: 'MC_PROJECT_REQUIRED',
      statusCode: 400,
    });
  }

  return {
    ...(title !== undefined ? { title: title.trim() } : {}),
    ...(body.icon !== undefined ? { icon: readString(body.icon) } : {}),
    ...(typeof body.sort_order === 'number' ? { sort_order: body.sort_order } : {}),
    ...(body.enabled !== undefined ? { enabled: readBoolean(body.enabled, true) } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
    ...(workProjectId !== undefined ? { work_project_id: workProjectId } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(body.schedule_cron !== undefined
      ? { schedule_cron: readString(body.schedule_cron) || null }
      : {}),
    ...(provider !== undefined && isMcProvider(provider) ? { provider } : {}),
    ...(body.model !== undefined
      ? { model: body.model === null ? null : readString(body.model) || null }
      : {}),
    ...(body.permission_mode !== undefined
      ? { permission_mode: readString(body.permission_mode) || 'bypassPermissions' }
      : {}),
    ...(body.dry_run !== undefined ? { dry_run: readBoolean(body.dry_run, false) } : {}),
    ...(body.auto_approve !== undefined
      ? { auto_approve: readBoolean(body.auto_approve, false) }
      : {}),
    ...(body.produce_prompt !== undefined
      ? { produce_prompt: readString(body.produce_prompt) }
      : {}),
    ...(body.produce_tools !== undefined
      ? { produce_tools: parseTools(body.produce_tools) }
      : {}),
    ...(body.resolve_prompt !== undefined
      ? { resolve_prompt: readString(body.resolve_prompt) }
      : {}),
    ...(body.resolve_tools !== undefined
      ? { resolve_tools: parseTools(body.resolve_tools) }
      : {}),
    ...(body.tool_policy !== undefined ? { tool_policy: parseToolPolicy(body.tool_policy) } : {}),
    ...(body.actions !== undefined ? { actions: parseActions(body.actions) } : {}),
    ...(body.create_kanban_task !== undefined
      ? { create_kanban_task: readBoolean(body.create_kanban_task, false) }
      : {}),
    ...(body.kanban_assignee_provider !== undefined
      ? { kanban_assignee_provider: parseKanbanProvider(body.kanban_assignee_provider) }
      : {}),
    ...(body.kanban_review_provider !== undefined
      ? { kanban_review_provider: parseKanbanProvider(body.kanban_review_provider) }
      : {}),
    ...(body.kanban_mcp_tools !== undefined
      ? { kanban_mcp_tools: parseTools(body.kanban_mcp_tools) }
      : {}),
  };
}

/** Optional agent provider for bridged kanban cards; null clears it. */
function parseKanbanProvider(value: unknown): McProvider | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (!isMcProvider(value)) {
    throw new AppError(`Invalid kanban agent: ${String(value)}`, {
      code: 'MC_INVALID_PROVIDER',
      statusCode: 400,
    });
  }
  return value;
}

// GET /summary — badge counts
router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    res.json(missionControlDb.getSummary());
  }),
);

// POST /draft-section — conversational section architect
router.post(
  '/draft-section',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages: SectionWorkshopMessage[] = [];
    for (const entry of rawMessages) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const role = row.role === 'assistant' ? 'assistant' : row.role === 'user' ? 'user' : null;
      const content = readString(row.content).trim();
      if (role && content) messages.push({ role, content });
    }
    const rawDraft = body.currentDraft;
    const currentDraft = rawDraft && typeof rawDraft === 'object' && !Array.isArray(rawDraft)
      ? rawDraft as Partial<SectionWorkshopDraft>
      : undefined;
    const availableMcpServers = Array.isArray(body.availableMcpServers)
      ? body.availableMcpServers
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 100)
      : [];
    const result = await runSectionWorkshop({
      provider: readOptionalString(body.provider),
      model: readOptionalString(body.model),
      projectId: readOptionalString(body.projectId),
      projectName: readOptionalString(body.projectName),
      messages,
      currentDraft,
      availableMcpServers,
    });
    res.json({ success: true, ...result });
  }),
);

// GET /sections
router.get('/exceptions', asyncHandler(async (_req, res) => { res.json({ exceptions: listBotExceptions() }); }));

// GET /sections
router.get(
  '/sections',
  asyncHandler(async (_req, res) => {
    res.json({ sections: missionControlDb.listSections() });
  }),
);

// POST /sections
router.post(
  '/sections',
  asyncHandler(async (req, res) => {
    const input = parseSectionBody(req.body ?? {}, false) as CreateMcSectionInput;
    // Manual re-create of a built-in title lifts the boot-time tombstone so
    // ensure*() can maintain prompts/bindings for that seed again.
    clearSeedSuppressionByTitle(input.title);
    const section = missionControlDb.createSection(input);
    syncMissionControlSchedules();
    res.status(201).json({ section });
  }),
);

// POST /sections/bulk — update enabled state for a roster selection.
router.post(
  '/sections/bulk',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawIds = body.ids;
    const ids = rawIds === 'all'
      ? 'all' as const
      : Array.isArray(rawIds)
        ? rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : null;
    const patch = body.patch;
    if (!ids || !patch || typeof patch !== 'object' || Array.isArray(patch) || typeof (patch as Record<string, unknown>).enabled !== 'boolean') {
      throw new AppError('ids and patch.enabled are required', {
        code: 'MC_INVALID_BULK_PATCH',
        statusCode: 400,
      });
    }
    const enabled = (patch as Record<string, unknown>).enabled as boolean;
    const updated = missionControlDb.updateSectionsEnabled(ids, enabled);
    syncMissionControlSchedules();
    res.json({ updated });
  }),
);

// GET /sections/:id
router.get(
  '/sections/:id',
  asyncHandler(async (req, res) => {
    const section = missionControlDb.getSection(paramId(req.params.id));
    if (!section) {
      throw new AppError('Section not found', {
        code: 'MC_SECTION_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ section });
  }),
);

// GET /sections/:id/runs — bounded produce/resolve tick history.
router.get('/sections/:id/memories', asyncHandler(async (req, res) => {
  const sectionId = paramId(req.params.id);
  if (!missionControlDb.getSection(sectionId)) throw new AppError('Section not found', { code: 'MC_SECTION_NOT_FOUND', statusCode: 404 });
  res.json({ memories: listBotMemories(sectionId) });
}));

router.post('/sections/:id/memories', asyncHandler(async (req, res) => {
  const sectionId = paramId(req.params.id);
  if (!missionControlDb.getSection(sectionId)) throw new AppError('Section not found', { code: 'MC_SECTION_NOT_FOUND', statusCode: 404 });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const memory = proposeBotMemory(sectionId, readString(body.content), typeof body.sourceItemId === 'string' ? body.sourceItemId : null);
  res.status(201).json({ memory });
}));

router.patch('/sections/:id/memories/:memoryId', asyncHandler(async (req, res) => {
  const sectionId = paramId(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = body.status;
  if (status !== 'proposed' && status !== 'approved' && status !== 'rejected') throw new AppError('Invalid memory status', { code: 'MC_BAD_MEMORY_STATUS', statusCode: 400 });
  const memory = reviewBotMemory(sectionId, paramId(req.params.memoryId), status, typeof body.content === 'string' ? body.content : undefined);
  const section = missionControlDb.getSection(sectionId);
  if (section) recordSectionVersion(section, 'edited');
  res.json({ memory });
}));

// GET /sections/:id/runs — bounded produce/resolve tick history.
router.get(
  '/sections/:id/versions',
  asyncHandler(async (req, res) => {
    const section = missionControlDb.getSection(paramId(req.params.id));
    if (!section) throw new AppError('Section not found', { code: 'MC_SECTION_NOT_FOUND', statusCode: 404 });
    res.json(getSectionVersionHistory(section));
  }),
);

// GET /sections/:id/runs — bounded produce/resolve tick history.
router.get(
  '/sections/:id/runs',
  asyncHandler(async (req, res) => {
    const sectionId = paramId(req.params.id);
    const section = missionControlDb.getSection(sectionId);
    if (!section) {
      throw new AppError('Section not found', {
        code: 'MC_SECTION_NOT_FOUND',
        statusCode: 404,
      });
    }
    const itemIds = missionControlDb.listItemIdsBySection(sectionId);
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const runs = runsDb.listBySourceRefs('mission_control', [sectionId, ...itemIds], rawLimit);
    res.json({
      runs: runs.map((run) => {
        const phase = run.meta.phase;
        const kind = phase === 'resolve' || phase === 'retry' || phase === 'architect'
          ? phase
          : 'produce';
        const itemId = typeof run.meta.item_id === 'string'
          ? run.meta.item_id
          : run.source_ref && run.source_ref !== sectionId ? run.source_ref : null;
        const start = run.started_at ?? run.created_at;
        const end = run.finished_at ?? new Date().toISOString();
        const durationMs = Math.max(0, Date.parse(end) - Date.parse(start));
        return {
          run_id: run.run_id,
          status: run.status,
          trigger: run.trigger,
          started_at: run.started_at,
          finished_at: run.finished_at,
          duration_ms: Number.isFinite(durationMs) ? durationMs : null,
          error_summary: run.error_summary,
          kind,
          item_id: itemId,
          tokens: run.token_total ?? (run.token_input !== null && run.token_output !== null
            ? run.token_input + run.token_output
            : null),
          cost_usd: run.cost_usd_estimate,
        };
      }),
    });
  }),
);

// PUT /sections/:id
router.put(
  '/sections/:id',
  asyncHandler(async (req, res) => {
    const input = parseSectionBody(req.body ?? {}, true) as UpdateMcSectionInput;
    const section = missionControlDb.updateSection(paramId(req.params.id), input);
    if (!section) {
      throw new AppError('Section not found', {
        code: 'MC_SECTION_NOT_FOUND',
        statusCode: 404,
      });
    }
    syncMissionControlSchedules();
    res.json({ section });
  }),
);

// DELETE /sections/:id
router.delete(
  '/sections/:id',
  asyncHandler(async (req, res) => {
    const sectionId = paramId(req.params.id);
    const existing = missionControlDb.getSection(sectionId);
    if (!existing) {
      throw new AppError('Section not found', {
        code: 'MC_SECTION_NOT_FOUND',
        statusCode: 404,
      });
    }
    // Built-in seeds re-run on every boot; record the opt-out first so the
    // next ensure*() does not resurrect the row we are about to delete.
    suppressSeedByTitle(existing.title);
    const ok = missionControlDb.deleteSection(sectionId);
    if (!ok) {
      throw new AppError('Section not found', {
        code: 'MC_SECTION_NOT_FOUND',
        statusCode: 404,
      });
    }
    syncMissionControlSchedules();
    res.json({ success: true });
  }),
);

// POST /sections/:id/run — produce now
router.post(
  '/sections/:id/run',
  asyncHandler(async (req, res) => {
    const result = await runSectionProduce(paramId(req.params.id));
    res.json(result);
  }),
);

// POST /sections/:id/simulate — inspect sample produce output without a provider run or writes
router.post(
  '/sections/:id/simulate',
  asyncHandler(async (req, res) => {
    const result = simulateSectionTick(paramId(req.params.id), req.body?.output);
    res.json(result);
  }),
);

// GET /items
router.get(
  '/items',
  asyncHandler(async (req, res) => {
    const sectionId =
      typeof req.query.sectionId === 'string' ? req.query.sectionId : undefined;
    let status: McItemStatus | McItemStatus[] | undefined;
    if (typeof req.query.status === 'string' && req.query.status) {
      status = req.query.status.split(',') as McItemStatus[];
    }
    const limit =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const items = missionControlDb.listItems({ sectionId, status, limit });
    res.json({ items, pendingCount: missionControlDb.countPending() });
  }),
);

// GET /items/:id
router.get(
  '/items/:id',
  asyncHandler(async (req, res) => {
    const item = missionControlDb.getItem(paramId(req.params.id));
    if (!item) {
      throw new AppError('Item not found', {
        code: 'MC_ITEM_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ item });
  }),
);

// POST /items/:id/actions
router.post(
  '/items/:id/actions',
  asyncHandler(async (req, res) => {
    const actionId = readString(req.body?.actionId).trim();
    if (!actionId) {
      throw new AppError('actionId is required', {
        code: 'MC_ACTION_REQUIRED',
        statusCode: 400,
      });
    }
    const body =
      req.body?.body && typeof req.body.body === 'object' && !Array.isArray(req.body.body)
        ? (req.body.body as Record<string, unknown>)
        : undefined;
    const itemId = paramId(req.params.id);
    const item = await applyItemAction(itemId, actionId, body);
    const pendingCount = missionControlDb.countPending();
    if (item === null) {
      // Hard delete — row is gone; free dedupe key for a re-run.
      res.json({ deleted: true, itemId, item: null, pendingCount });
      return;
    }
    res.json({ deleted: false, item, pendingCount });
  }),
);

// GET /items/:id/work/projects — explain the project match before opening chat
router.get(
  '/items/:id/work/projects',
  asyncHandler(async (req, res) => {
    const itemId = paramId(req.params.id);
    const item = missionControlDb.getItem(itemId);
    if (!item) {
      throw new AppError('Item not found', { code: 'MC_ITEM_NOT_FOUND', statusCode: 404 });
    }
    if (item.status !== 'pending' && item.status !== 'failed') {
      throw new AppError(`Item is '${item.status}', not actionable`, {
        code: 'MC_ITEM_NOT_ACTIONABLE',
        statusCode: 400,
      });
    }
    const section = missionControlDb.getSection(item.section_id);
    res.json({ candidates: matchProjectsForItem(item, section) });
  }),
);

// POST /items/:id/work — open a scoped chat in the selected project
router.post(
  '/items/:id/work',
  asyncHandler(async (req, res) => {
    const projectId = readOptionalString(req.body?.projectId);
    const result = workThisItem(paramId(req.params.id), projectId);
    res.status(201).json({
      item: result.item,
      sessionId: result.sessionId,
      provider: result.provider,
      projectId: result.projectId,
      projectPath: result.projectPath,
      prompt: result.prompt,
      matchReason: result.matchReason,
      candidates: result.candidates,
      pendingCount: missionControlDb.countPending(),
    });
  }),
);

// POST /items/:id/retry — re-run produce for just this item
router.post(
  '/items/:id/retry',
  asyncHandler(async (req, res) => {
    const itemId = paramId(req.params.id);
    const result = await retryItem(itemId);
    res.json(result);
  }),
);

// POST /items/:id/preview — show what resolving this item would produce
router.post(
  '/items/:id/preview',
  asyncHandler(async (req, res) => {
    const actionId = readString(req.body?.actionId).trim() || undefined;
    const body =
      req.body?.body && typeof req.body.body === 'object' && !Array.isArray(req.body.body)
        ? (req.body.body as Record<string, unknown>)
        : undefined;
    const result = await previewItemResolution(paramId(req.params.id), actionId, body);
    res.json(result);
  }),
);

// POST /items/:id/assets — render the images an X article draft needs
router.post(
  '/items/:id/assets',
  asyncHandler(async (req, res) => {
    const itemId = paramId(req.params.id);
    const item = missionControlDb.getItem(itemId);
    if (!item) {
      throw new AppError('Item not found', {
        code: 'MC_ITEM_NOT_FOUND',
        statusCode: 404,
      });
    }

    let result;
    try {
      result = await generateArticleAssets(item.body, { force: req.body?.force === true });
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : String(error), {
        code: 'MC_ASSETS_UNSUPPORTED_BODY',
        statusCode: 400,
      });
    }

    // Persist the patched body without disturbing the item's review status.
    const updated = missionControlDb.setItemStatus(itemId, item.status, { body: result.body });
    res.json({
      item: updated,
      generated: result.generated,
      skipped: result.skipped,
      failed: result.failed,
      messages: result.messages,
    });
  }),
);

// POST /import — import sections from legacy Mission Control SQLite DB
router.post(
  '/import',
  asyncHandler(async (req, res) => {
    const pathFromBody = readString(req.body?.path).trim();
    const dbPath = pathFromBody || resolveDefaultLegacyDbPath();
    if (!dbPath) {
      throw new AppError(
        'No database path provided and no default Mission Control DB found',
        {
          code: 'MC_IMPORT_PATH_REQUIRED',
          statusCode: 400,
        },
      );
    }
    const result = importFromMissionControlDb(dbPath);
    res.json(result);
  }),
);

// GET /import/default-path — where we'd look for the legacy DB
router.get(
  '/import/default-path',
  asyncHandler(async (_req, res) => {
    const path = resolveDefaultLegacyDbPath();
    res.json({ path, found: Boolean(path) });
  }),
);

export default router;
