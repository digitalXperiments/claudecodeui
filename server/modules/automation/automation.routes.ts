import express from 'express';

import { automationService } from '@/modules/automation/automation.service.js';
import type { CreateAutomationRecipeInput, WorkflowGraph } from '@/modules/automation/automation.types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { CloudError } from '@/shared/run-events.js';

const router = express.Router();

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function optionalString(value: unknown): string | undefined {
  const result = stringValue(value);
  return result || undefined;
}

function mapError(error: unknown): never {
  if (error instanceof CloudError) {
    const statusCode =
      error.code === 'AUTOMATION_CYCLE'
        ? 409
        : error.message.includes('not found')
          ? 404
          : 400;
    throw new AppError(error.message, { code: error.code, statusCode });
  }
  throw error;
}

function parseRecipeBody(body: Record<string, unknown>): CreateAutomationRecipeInput {
  const name = stringValue(body.name);
  const trigger = body.trigger as CreateAutomationRecipeInput['trigger'];
  const actions = Array.isArray(body.actions)
    ? (body.actions as CreateAutomationRecipeInput['actions'])
    : [];
  const graph =
    body.graph === null
      ? null
      : body.graph && typeof body.graph === 'object'
        ? (body.graph as WorkflowGraph)
        : undefined;
  if (!name || !trigger)
    throw new AppError('name and trigger are required', {
      code: 'AUTOMATION_INVALID_RECIPE',
      statusCode: 400,
    });
  if ((!actions || actions.length === 0) && !(graph && Array.isArray(graph.steps) && graph.steps.length)) {
    throw new AppError('actions or graph.steps are required', {
      code: 'AUTOMATION_INVALID_RECIPE',
      statusCode: 400,
    });
  }
  return {
    name,
    enabled: body.enabled !== false,
    projectId: body.projectId === null ? null : optionalString(body.projectId),
    trigger,
    conditions: Array.isArray(body.conditions)
      ? (body.conditions as CreateAutomationRecipeInput['conditions'])
      : [],
    actions,
    graph: graph === undefined ? undefined : graph,
    retry:
      body.retry && typeof body.retry === 'object'
        ? (body.retry as CreateAutomationRecipeInput['retry'])
        : undefined,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : null,
  };
}

router.get(
  '/automation/recipes',
  asyncHandler(async (req, res) => {
    res.json({ success: true, recipes: automationService.list(optionalString(req.query.projectId)) });
  }),
);

router.post(
  '/automation/recipes',
  asyncHandler(async (req, res) => {
    try {
      res
        .status(201)
        .json({
          success: true,
          recipe: automationService.create(
            parseRecipeBody((req.body ?? {}) as Record<string, unknown>),
          ),
        });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.get(
  '/automation/recipes/:recipeId',
  asyncHandler(async (req, res) => {
    const recipe = automationService.get(stringValue(req.params.recipeId));
    if (!recipe)
      throw new AppError('Recipe not found', { code: 'AUTOMATION_NOT_FOUND', statusCode: 404 });
    res.json({ success: true, recipe });
  }),
);

router.get(
  '/automation/recipes/:recipeId/runs',
  asyncHandler(async (req, res) => {
    const recipeId = stringValue(req.params.recipeId);
    const recipe = automationService.get(recipeId);
    if (!recipe)
      throw new AppError('Recipe not found', { code: 'AUTOMATION_NOT_FOUND', statusCode: 404 });
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20),
    );
    res.json({ success: true, runs: automationService.listRuns(recipeId, limit) });
  }),
);

router.put(
  '/automation/recipes/:recipeId',
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        recipe: automationService.update(
          stringValue(req.params.recipeId),
          parseRecipeBody((req.body ?? {}) as Record<string, unknown>),
        ),
      });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.delete(
  '/automation/recipes/:recipeId',
  asyncHandler(async (req, res) => {
    const deleted = automationService.delete(stringValue(req.params.recipeId));
    if (!deleted)
      throw new AppError('Recipe not found', { code: 'AUTOMATION_NOT_FOUND', statusCode: 404 });
    res.json({ success: true });
  }),
);

router.post(
  '/automation/recipes/:recipeId/run',
  asyncHandler(async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const results = await automationService.fire({
        type: 'manual',
        recipeId: stringValue(req.params.recipeId),
        projectId: optionalString(body.projectId),
        payload:
          body.payload && typeof body.payload === 'object'
            ? (body.payload as Record<string, unknown>)
            : {},
      });
      res.status(202).json({ success: true, results });
    } catch (error) {
      mapError(error);
    }
  }),
);

/** Adapter entry point used by webhook/kanban producers without coupling them to recipe storage. */
router.post(
  '/automation/fire',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = stringValue(body.type) as Parameters<typeof automationService.fire>[0]['type'];
    if (!type)
      throw new AppError('type is required', {
        code: 'AUTOMATION_TRIGGER_REQUIRED',
        statusCode: 400,
      });
    const results = await automationService.fire({
      type,
      event: optionalString(body.event),
      projectId: optionalString(body.projectId),
      payload:
        body.payload && typeof body.payload === 'object'
          ? (body.payload as Record<string, unknown>)
          : {},
    });
    res.status(202).json({ success: true, results });
  }),
);

export default router;
