import express from 'express';

import { interruptsService } from '@/modules/interrupt-queue/interrupts.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { CloudError } from '@/shared/run-events.js';

const router = express.Router();

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function actor(req: express.Request): string | null {
  const user = (req as express.Request & { user?: { id?: string | number; userId?: string | number } }).user;
  return user?.id != null ? String(user.id) : user?.userId != null ? String(user.userId) : null;
}

function mapError(error: unknown): never {
  if (error instanceof CloudError) {
    // 410 Gone for expired approval gates: approve/deny on a stale interrupt
    // must fail cleanly instead of pretending success.
    const statusCode =
      error.code === 'INTERRUPT_NOT_FOUND' ? 404 : error.code === 'INTERRUPT_EXPIRED' ? 410 : 409;
    throw new AppError(error.message, { code: error.code, statusCode });
  }
  throw error;
}

router.get('/', asyncHandler(async (req, res) => {
  const rawStatus = text(req.query.status);
  const status = rawStatus ? rawStatus.split(',').map((value) => value.trim()) as never : undefined;
  const interrupts = interruptsService.list({
    projectId: text(req.query.projectId),
    status,
    limit: Number(req.query.limit) || 50,
  });
  const projectId = text(req.query.projectId);
  res.json({
    success: true,
    interrupts,
    count: interruptsService.countOpen(projectId),
    unread: interruptsService.countUnread(projectId),
  });
}));

router.get('/count', asyncHandler(async (req, res) => {
  const projectId = text(req.query.projectId);
  res.json({
    success: true,
    count: interruptsService.countOpen(projectId),
    unread: interruptsService.countUnread(projectId),
  });
}));

/**
 * Batch viewport mark-as-read (IntersectionObserver batches on the client).
 * Read state only clears the unread badge; items remain actionable.
 */
router.post('/read', asyncHandler(async (req, res) => {
  const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!rawIds) throw new AppError('ids must be an array', { code: 'INTERRUPT_INVALID_INPUT', statusCode: 400 });
  const ids = rawIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0);
  const { updated, unread } = interruptsService.markRead(ids);
  res.json({ success: true, updated, unread });
}));

/** Plan-my-day checklist (PRD §7.7) — open interrupts ordered by priority. */
router.post('/plan-my-day', asyncHandler(async (req, res) => {
  const projectId = text(req.body?.projectId) ?? text(req.query.projectId);
  const plan = interruptsService.planMyDay(projectId);
  res.json({ success: true, ...plan, count: plan.interrupts.length });
}));

router.get('/plan-my-day', asyncHandler(async (req, res) => {
  const plan = interruptsService.planMyDay(text(req.query.projectId));
  res.json({ success: true, ...plan, count: plan.interrupts.length });
}));

router.post('/:interruptId/actions/:actionKey', asyncHandler(async (req, res) => {
  try {
    const interrupt = await interruptsService.actAndWait(String(req.params.interruptId), {
      key: String(req.params.actionKey),
      actor: actor(req),
      body: req.body && typeof req.body === 'object' ? req.body : undefined,
    });
    res.json({ success: true, interrupt, count: interruptsService.countOpen() });
  } catch (error) { mapError(error); }
}));

router.post('/:interruptId/snooze', asyncHandler(async (req, res) => {
  try {
    const until = text(req.body?.until);
    if (!until) throw new AppError('until is required', { code: 'INTERRUPT_INVALID_INPUT', statusCode: 400 });
    const interrupt = interruptsService.snooze(String(req.params.interruptId), until, actor(req));
    res.json({ success: true, interrupt, count: interruptsService.countOpen() });
  } catch (error) { mapError(error); }
}));

export default router;
