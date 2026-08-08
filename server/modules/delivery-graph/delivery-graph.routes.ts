import express from 'express';

import { asyncHandler, AppError } from '@/shared/utils.js';
import { isKanbanProvider } from '@/modules/kanban/index.js';
import { applyDeliveryGraph, generateDeliveryGraph, importTaskMasterTasks } from '@/modules/delivery-graph/delivery-graph.service.js';
import type { DeliveryGraph } from '@/modules/delivery-graph/delivery-graph.types.js';

const router = express.Router();

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const result = stringValue(value);
  return result || undefined;
}

function optionalProvider(value: unknown): string | undefined {
  const result = optionalString(value);
  if (result && !isKanbanProvider(result)) {
    throw new AppError(`Invalid provider: ${result}`, {
      code: 'KANBAN_INVALID_PROVIDER',
      statusCode: 400,
    });
  }
  return result;
}

function requireProjectId(value: unknown): string {
  const projectId = stringValue(value);
  if (!projectId) {
    throw new AppError('projectId is required', { code: 'PROJECT_ID_REQUIRED', statusCode: 400 });
  }
  return projectId;
}

router.post(
  '/projects/:projectId/delivery-graph/generate',
  asyncHandler(async (req, res) => {
    const projectId = requireProjectId(req.params.projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prdPath = stringValue(body.prdPath);
    if (!prdPath) {
      throw new AppError('prdPath is required', { code: 'DELIVERY_GRAPH_PATH_REQUIRED', statusCode: 400 });
    }
    const provider = optionalProvider(body.provider);
    // `model` is accepted for forward compatibility with provider-backed
    // generation. The v1 deterministic parser does not need a model call.
    const generated = await generateDeliveryGraph({ projectId, prdPath, provider });
    res.json({
      success: true,
      graph: generated.graph,
      sourcePath: generated.sourcePath,
      generator: generated.generator,
      provider: provider ?? null,
      model: optionalString(body.model) ?? null,
    });
  }),
);

router.post(
  '/projects/:projectId/delivery-graph/apply',
  asyncHandler(async (req, res) => {
    const projectId = requireProjectId(req.params.projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const graph = body.graph as DeliveryGraph | undefined;
    if (!graph) {
      throw new AppError('graph is required', { code: 'DELIVERY_GRAPH_REQUIRED', statusCode: 400 });
    }
    const result = applyDeliveryGraph({
      projectId,
      graph,
      boardId: optionalString(body.boardId),
      startReady: body.startReady === true,
    });
    res.status(201).json({ success: true, ...result });
  }),
);

router.post(
  '/projects/:projectId/taskmaster/import',
  asyncHandler(async (req, res) => {
    const projectId = requireProjectId(req.params.projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const boardId = stringValue(body.boardId);
    if (!boardId) {
      throw new AppError('boardId is required', { code: 'KANBAN_BOARD_ID_REQUIRED', statusCode: 400 });
    }
    const report = await importTaskMasterTasks({
      projectId,
      boardId,
      requestedPath: optionalString(body.path),
      dryRun: body.dryRun === true,
      assigneeProvider: optionalProvider(body.assigneeProvider),
      reviewProvider: optionalProvider(body.reviewProvider),
    });
    res.status(report.dryRun ? 200 : 201).json({ success: true, report });
  }),
);

export default router;
