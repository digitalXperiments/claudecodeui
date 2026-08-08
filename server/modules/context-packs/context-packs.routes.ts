import express from 'express';

import {
  attachPackToRun,
  attachPackToSession,
  compileContextPack,
  getContextPack,
  listContextPackAttachments,
} from '@/modules/context-packs/context-packs.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { CloudError } from '@/shared/run-events.js';

const router = express.Router();

function value(input: unknown): string {
  return typeof input === 'string' ? input.trim() : '';
}

function optional(input: unknown): string | undefined {
  const result = value(input);
  return result || undefined;
}

function mapError(error: unknown): never {
  if (error instanceof CloudError) {
    const statusCode = error.code === 'RUN_NOT_FOUND' ? 404 : 400;
    throw new AppError(error.message, { code: error.code, statusCode });
  }
  throw error;
}

router.post(
  '/projects/:projectId/context-packs',
  asyncHandler(async (req, res) => {
    const projectId = value(req.params.projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const goal = value(body.goal);
    if (!goal) throw new AppError('goal is required', { code: 'CONTEXT_PACK_GOAL_REQUIRED', statusCode: 400 });
    const budgetTokens = typeof body.budgetTokens === 'number' ? body.budgetTokens : undefined;
    try {
      const pack = await compileContextPack({ projectId, goal, taskId: optional(body.taskId), budgetTokens, runId: optional(body.runId) });
      res.status(201).json({ success: true, pack, attachments: listContextPackAttachments(pack.pack_id) });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.get(
  '/context-packs/:packId',
  asyncHandler(async (req, res) => {
    try {
      const pack = getContextPack(value(req.params.packId));
      res.json({ success: true, pack, attachments: listContextPackAttachments(pack.pack_id) });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/runs/:runId/attach-pack',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const packId = value(body.packId);
    if (!packId) throw new AppError('packId is required', { code: 'CONTEXT_PACK_ID_REQUIRED', statusCode: 400 });
    try {
      const attachment = attachPackToRun(packId, value(req.params.runId));
      res.status(201).json({ success: true, attachment });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/sessions/:sessionId/attach-pack',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const packId = value(body.packId);
    if (!packId) throw new AppError('packId is required', { code: 'CONTEXT_PACK_ID_REQUIRED', statusCode: 400 });
    try {
      const attachment = attachPackToSession(packId, value(req.params.sessionId));
      res.status(201).json({ success: true, attachment });
    } catch (error) {
      mapError(error);
    }
  }),
);

export default router;
