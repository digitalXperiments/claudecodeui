import express from 'express';

import { stackService } from '@/modules/stack/stack.service.js';
import type { StackConfig } from '@/modules/stack/stack.types.js';
import { asyncHandler } from '@/shared/utils.js';

const router = express.Router();
const projectId = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';

function bodyConfig(body: unknown): StackConfig {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const candidate = record.config && typeof record.config === 'object' ? record.config : record;
  return candidate as StackConfig;
}

router.get('/projects/:projectId/stack', asyncHandler(async (req, res) => {
  const document = await stackService.get(projectId(req.params.projectId));
  res.json({ success: true, ...document });
}));

router.put('/projects/:projectId/stack', asyncHandler(async (req, res) => {
  const document = await stackService.put(projectId(req.params.projectId), bodyConfig(req.body));
  res.json({ success: true, ...document });
}));

router.post('/projects/:projectId/stack/apply', asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const result = await stackService.apply(projectId(req.params.projectId), body.config ? bodyConfig(body) : undefined);
  res.json({ success: true, ...result });
}));

router.post('/projects/:projectId/stack/doctor', asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const report = await stackService.doctor(projectId(req.params.projectId), { createInterrupts: body.createInterrupts !== false });
  res.status(report.ok ? 200 : 422).json({ success: report.ok, ...report });
}));

router.post('/projects/:projectId/stack/export', asyncHandler(async (req, res) => {
  const result = await stackService.export(projectId(req.params.projectId));
  res.json({ success: true, ...result });
}));

export default router;
