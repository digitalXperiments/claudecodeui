import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import {
  applyItemAction,
  runSectionProduce,
} from '@/modules/mission-control/mission-control-runner.service.js';
import { syncMissionControlSchedules } from '@/modules/mission-control/mission-control-scheduler.service.js';
import {
  DEFAULT_MC_ACTIONS,
  isMcProvider,
  type CreateMcSectionInput,
  type McAction,
  type McItemStatus,
  type McSectionMode,
  type McSectionScope,
  type UpdateMcSectionInput,
} from '@/modules/mission-control/mission-control.types.js';
import {
  importFromMissionControlDb,
  resolveDefaultLegacyDbPath,
} from '@/modules/mission-control/mission-control-import.service.js';

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
    ...(body.actions !== undefined ? { actions: parseActions(body.actions) } : {}),
  };
}

// GET /summary — badge counts
router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    res.json({
      pendingCount: missionControlDb.countPending(),
      sectionCount: missionControlDb.listSections().length,
    });
  }),
);

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
    const section = missionControlDb.createSection(input);
    syncMissionControlSchedules();
    res.status(201).json({ section });
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
    const ok = missionControlDb.deleteSection(paramId(req.params.id));
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
    const item = await applyItemAction(paramId(req.params.id), actionId, body);
    res.json({ item, pendingCount: missionControlDb.countPending() });
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
