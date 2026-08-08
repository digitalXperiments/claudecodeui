/**
 * Isolated workspace REST surface (PRD §5.6).
 *
 * Project paths are resolved from the project registry; callers cannot choose
 * an arbitrary filesystem path for a registered project. Workspace values are
 * also filtered through the service's path policy before any filesystem or
 * git operation runs.
 */

import express from 'express';

import { projectsDb } from '@/modules/database/index.js';
import { workspaceService } from '@/modules/workspaces/workspace.service.js';
import {
  MERGE_STRATEGIES,
  WORKSPACE_MODES,
  type MergeStrategy,
  type WorkspaceMode,
} from '@/modules/workspaces/workspace.types.js';
import { CloudError } from '@/shared/run-events.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

function readPathParam(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return '';
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function requireProjectPath(projectId: string): string {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new AppError(`Project not found: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }
  return projectPath;
}

function mapWorkspaceError(error: unknown): never {
  if (error instanceof CloudError) {
    const statusCode =
      error.code === 'WORKSPACE_NOT_FOUND'
        ? 404
        : error.code === 'WORKSPACE_DIRTY_CONFLICT'
          ? 409
          : 400;
    throw new AppError(error.message, { code: error.code, statusCode });
  }
  throw error;
}

function readWorkspaceMode(value: unknown): WorkspaceMode | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!WORKSPACE_MODES.includes(value as WorkspaceMode)) {
    throw new AppError(`Invalid workspace mode: ${String(value)}`, {
      code: 'WORKSPACE_INVALID_MODE',
      statusCode: 400,
    });
  }
  return value as WorkspaceMode;
}

function readMergeStrategy(value: unknown): MergeStrategy | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!MERGE_STRATEGIES.includes(value as MergeStrategy)) {
    throw new AppError(`Invalid merge strategy: ${String(value)}`, {
      code: 'WORKSPACE_INVALID_MERGE_STRATEGY',
      statusCode: 400,
    });
  }
  return value as MergeStrategy;
}

// --- Project workspaces ---------------------------------------------------

router.post(
  '/projects/:projectId/workspaces',
  asyncHandler(async (req, res) => {
    const projectId = readPathParam(req.params.projectId);
    const projectPath = requireProjectPath(projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const workspace = await workspaceService.create({
        projectId,
        projectPath,
        baseBranch: readOptionalString(body.baseBranch),
        branchName: readOptionalString(body.branchName),
        taskId: readOptionalString(body.taskId),
        runId: readOptionalString(body.runId),
        mode: readWorkspaceMode(body.mode),
      });
      res.status(201).json({ success: true, workspace });
    } catch (error) {
      mapWorkspaceError(error);
    }
  }),
);

router.get(
  '/projects/:projectId/workspaces',
  asyncHandler(async (req, res) => {
    const projectId = readPathParam(req.params.projectId);
    requireProjectPath(projectId);
    const rawStatus = readOptionalString(req.query.status);
    const status = rawStatus
      ? rawStatus
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
    res.json({ success: true, workspaces: workspaceService.list(projectId, { status }) });
  }),
);

// --- Workspace lifecycle --------------------------------------------------

router.get(
  '/workspaces/:workspaceId',
  asyncHandler(async (req, res) => {
    const workspaceId = readPathParam(req.params.workspaceId);
    const workspace = workspaceService.get(workspaceId);
    if (!workspace) {
      throw new AppError(`Workspace not found: ${workspaceId}`, {
        code: 'WORKSPACE_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ success: true, workspace });
  }),
);

router.get(
  '/workspaces/:workspaceId/status',
  asyncHandler(async (req, res) => {
    try {
      const status = await workspaceService.refreshStatus(readPathParam(req.params.workspaceId));
      res.json({ success: true, status });
    } catch (error) {
      mapWorkspaceError(error);
    }
  }),
);

router.get(
  '/workspaces/:workspaceId/diff',
  asyncHandler(async (req, res) => {
    const base = readOptionalString(req.query.base);
    if (base !== undefined && base !== 'merge-base' && base !== 'base_sha') {
      throw new AppError(`Invalid diff base: ${base}`, {
        code: 'WORKSPACE_INVALID_DIFF_BASE',
        statusCode: 400,
      });
    }
    try {
      const diff = await workspaceService.getDiff(readPathParam(req.params.workspaceId), {
        base: base as 'merge-base' | 'base_sha' | undefined,
      });
      res.json({ success: true, diff });
    } catch (error) {
      mapWorkspaceError(error);
    }
  }),
);

router.post(
  '/workspaces/:workspaceId/merge',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await workspaceService.mergeToBase(readPathParam(req.params.workspaceId), {
        strategy: readMergeStrategy(body.strategy),
        deleteAfter: readOptionalBoolean(body.deleteAfter),
      });
      res.json({ success: true, result });
    } catch (error) {
      mapWorkspaceError(error);
    }
  }),
);

router.post(
  '/workspaces/:workspaceId/discard',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      await workspaceService.discard(readPathParam(req.params.workspaceId), {
        deleteBranch: readOptionalBoolean(body.deleteBranch),
      });
      res.json({ success: true, workspace: workspaceService.get(readPathParam(req.params.workspaceId)) });
    } catch (error) {
      mapWorkspaceError(error);
    }
  }),
);

router.post(
  '/workspaces/:workspaceId/cleanup',
  asyncHandler(async (req, res) => {
    try {
      await workspaceService.cleanup(readPathParam(req.params.workspaceId));
      res.json({ success: true, workspace: workspaceService.get(readPathParam(req.params.workspaceId)) });
    } catch (error) {
      mapWorkspaceError(error);
    }
  }),
);

export default router;
