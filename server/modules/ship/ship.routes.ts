import express from 'express';

import { shipService } from '@/modules/ship/ship.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { CloudError } from '@/shared/run-events.js';

const router = express.Router();

function param(value: unknown): string {
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mapShipError(error: unknown): never {
  if (error instanceof CloudError) {
    const statusCode = error.code === 'WORKSPACE_NOT_FOUND' || error.code === 'RUN_NOT_FOUND'
      ? 404
      : error.code === 'SHIP_PR_FAILED'
        ? 502
        : 400;
    throw new AppError(error.message, { code: error.code, statusCode });
  }
  throw error;
}

router.post(
  '/workspaces/:workspaceId/ship/test',
  asyncHandler(async (req, res) => {
    try {
      const report = await shipService.runTests(param(req.params.workspaceId));
      res.json({ success: true, report });
    } catch (error) {
      mapShipError(error);
    }
  }),
);

router.post(
  '/workspaces/:workspaceId/ship/pr',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const reviewers = Array.isArray(body.reviewers)
        ? body.reviewers.filter((value): value is string => typeof value === 'string')
        : undefined;
      const provider = body.provider === 'gitlab' ? 'gitlab' : body.provider === 'github' ? 'github' : undefined;
      const pullRequest = await shipService.createPullRequest(param(req.params.workspaceId), {
        title: optionalString(body.title),
        body: optionalString(body.body),
        baseBranch: optionalString(body.baseBranch),
        draft: typeof body.draft === 'boolean' ? body.draft : undefined,
        reviewers,
        provider,
        tokenRef: optionalString(body.tokenRef),
      });
      res.status(201).json({ success: true, pullRequest });
    } catch (error) {
      mapShipError(error);
    }
  }),
);

router.get(
  '/workspaces/:workspaceId/ship/ci',
  asyncHandler(async (req, res) => {
    try {
      const status = await shipService.getCiStatus(param(req.params.workspaceId), optionalString(req.query.pr));
      res.json({ success: true, status });
    } catch (error) {
      mapShipError(error);
    }
  }),
);

router.post(
  '/runs/:runId/ship/fix-ci',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const failureSummary = optionalString(body.failureSummary);
    if (!failureSummary) {
      throw new AppError('failureSummary is required', { code: 'SHIP_FAILURE_SUMMARY_REQUIRED', statusCode: 400 });
    }
    try {
      const run = shipService.openFixRun({ parentRunId: param(req.params.runId), failureSummary });
      res.status(202).json({ success: true, run });
    } catch (error) {
      mapShipError(error);
    }
  }),
);

export default router;
