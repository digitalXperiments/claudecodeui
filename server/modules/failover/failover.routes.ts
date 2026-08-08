import express from 'express';

import { failoverService } from '@/modules/failover/failover.service.js';
import type { CreateFailoverPlaybookInput } from '@/modules/failover/failover.types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { CloudError } from '@/shared/run-events.js';

const router = express.Router();

function stringValue(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function optionalString(value: unknown): string | undefined { const valueAsString = stringValue(value); return valueAsString || undefined; }

function mapError(error: unknown): never {
  if (error instanceof CloudError) {
    const statusCode = error.code === 'RUN_NOT_FOUND' ? 404 : error.code === 'PLAYBOOK_NO_CANDIDATE' ? 409 : 400;
    throw new AppError(error.message, { code: error.code, statusCode });
  }
  throw error;
}

function parseBody(body: Record<string, unknown>): CreateFailoverPlaybookInput {
  const name = stringValue(body.name);
  const strategy = body.strategy as CreateFailoverPlaybookInput['strategy'];
  if (!name || !strategy) throw new AppError('name and strategy are required', { code: 'PLAYBOOK_NO_CANDIDATE', statusCode: 400 });
  return {
    name,
    projectId: body.projectId === null ? null : optionalString(body.projectId),
    enabled: body.enabled !== false,
    match: body.match && typeof body.match === 'object' ? body.match as CreateFailoverPlaybookInput['match'] : {},
    strategy,
    approval: body.approval === 'interrupt' ? 'interrupt' : 'auto',
  };
}

router.get('/failover-playbooks', asyncHandler(async (req, res) => {
  res.json({ success: true, playbooks: failoverService.list(optionalString(req.query.projectId)) });
}));

router.post('/failover-playbooks', asyncHandler(async (req, res) => {
  try {
    res.status(201).json({ success: true, playbook: failoverService.create(parseBody((req.body ?? {}) as Record<string, unknown>)) });
  } catch (error) { mapError(error); }
}));

router.get('/failover-playbooks/:playbookId', asyncHandler(async (req, res) => {
  const playbook = failoverService.get(stringValue(req.params.playbookId));
  if (!playbook) throw new AppError('Playbook not found', { code: 'PLAYBOOK_NO_CANDIDATE', statusCode: 404 });
  res.json({ success: true, playbook });
}));

router.put('/failover-playbooks/:playbookId', asyncHandler(async (req, res) => {
  try {
    res.json({ success: true, playbook: failoverService.update(stringValue(req.params.playbookId), parseBody((req.body ?? {}) as Record<string, unknown>)) });
  } catch (error) { mapError(error); }
}));

router.delete('/failover-playbooks/:playbookId', asyncHandler(async (req, res) => {
  if (!failoverService.delete(stringValue(req.params.playbookId))) throw new AppError('Playbook not found', { code: 'PLAYBOOK_NO_CANDIDATE', statusCode: 404 });
  res.json({ success: true });
}));

router.post('/runs/:runId/failover', asyncHandler(async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await failoverService.trigger(stringValue(req.params.runId), {
      playbookId: optionalString(body.playbookId),
      approved: body.approved === true,
    });
    res.status(result.status === 'approval_pending' ? 202 : 201).json({ success: true, ...result });
  } catch (error) { mapError(error); }
}));

export default router;
