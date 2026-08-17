/**
 * HTTP routes for the canonical run spine (PRD §6.7).
 * Mounted by the orchestrator at /api/runs.
 */

import express from 'express';

import { runService } from '@/modules/runs/runs.service.js';
import { evaluateSpend } from '@/modules/runs/spend-governor.service.js';
import type { GlobalStatsFilter } from '@/modules/runs/runs.types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import {
  CloudError,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from '@/shared/run-events.js';

const router = express.Router();

const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'starting',
  'running',
  'waiting_permission',
  'waiting_approval',
  'succeeded',
  'failed',
  'aborted',
  'timed_out',
];

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readPathParam(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return '';
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStatusFilter(value: unknown): RunStatus[] | undefined {
  const raw = readOptionalString(value);
  if (!raw) return undefined;
  const statuses = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const status of statuses) {
    if (!RUN_STATUSES.includes(status as RunStatus)) {
      throw new AppError(`Invalid status: ${status}`, {
        code: 'RUN_INVALID_STATUS',
        statusCode: 400,
      });
    }
  }
  return statuses as RunStatus[];
}

/** Map spine errors onto HTTP responses. */
function rethrowAsHttpError(error: unknown): never {
  if (error instanceof CloudError) {
    if (error.code === 'RUN_NOT_FOUND') {
      throw new AppError(error.message, { code: error.code, statusCode: 404 });
    }
    if (error.code === 'RUN_ALREADY_TERMINAL') {
      throw new AppError(error.message, { code: error.code, statusCode: 409 });
    }
  }
  throw error;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = readStatusFilter(req.query.status);
    const { runs, nextCursor } = runService.list({
      projectId: readOptionalString(req.query.projectId),
      status,
      source: readOptionalString(req.query.source),
      from: readOptionalString(req.query.from),
      to: readOptionalString(req.query.to),
      cursor: readOptionalString(req.query.cursor),
      limit: readOptionalNumber(req.query.limit),
    });
    res.json({ success: true, runs, nextCursor });
  }),
);

/** Must be registered before `/:runId` so "live-usage" is not captured as a run id. */
router.get(
  '/live-usage',
  asyncHandler(async (req, res) => {
    const sessionId = readOptionalString(req.query.sessionId);
    if (!sessionId) {
      throw new AppError('sessionId is required', {
        code: 'RUN_SESSION_ID_REQUIRED',
        statusCode: 400,
      });
    }
    const usage = runService.usageForSession(sessionId);
    const verdict = evaluateSpend(usage.costUsd);
    res.json({ success: true, usage, verdict });
  }),
);

/** Must be registered before `/:runId` so "stats" is not captured as a run id. */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const projectId = readOptionalString(req.query.projectId);
    if (!projectId) {
      throw new AppError('projectId is required', {
        code: 'RUN_PROJECT_ID_REQUIRED',
        statusCode: 400,
      });
    }
    const stats = runService.projectStats(projectId);
    res.json({ success: true, stats });
  }),
);

/** Read an ISO-8601 date bound; 400 when present but unparseable. */
function readDateBound(value: unknown, name: string): string | undefined {
  const raw = readOptionalString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new AppError(`Invalid ${name} date: ${raw}`, {
      code: 'RUN_INVALID_STATS_RANGE',
      statusCode: 400,
    });
  }
  // Canonicalize to full-precision ISO-8601. globalStats compares agent_runs
  // bounds as strings, so an accepted-but-abbreviated input like "2026-08-05"
  // would otherwise compare by prefix length and silently skew the window.
  return new Date(parsed).toISOString();
}

/**
 * Global cross-project usage stats for the Stats dashboard.
 * Registered before `/:runId`; from/to are inclusive ISO-8601 bounds.
 */
router.get(
  '/stats/global',
  asyncHandler(async (req, res) => {
    const providerRaw = readOptionalString(req.query.provider);
    const filter: GlobalStatsFilter = {
      from: readDateBound(req.query.from, 'from'),
      to: readDateBound(req.query.to, 'to'),
      ...(providerRaw !== undefined ? { provider: providerRaw } : {}),
    };
    const stats = runService.globalStats(filter);
    res.json({ success: true, stats });
  }),
);

router.get(
  '/budget',
  asyncHandler(async (req, res) => {
    const projectId = readOptionalString(req.query.projectId);
    if (!projectId) {
      throw new AppError('projectId is required', {
        code: 'RUN_PROJECT_ID_REQUIRED',
        statusCode: 400,
      });
    }
    const budget = runService.getBudget(projectId);
    res.json({ success: true, budget });
  }),
);

router.put(
  '/budget',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const projectId =
      readOptionalString(body.projectId) ?? readOptionalString(req.query.projectId);
    if (!projectId) {
      throw new AppError('projectId is required', {
        code: 'RUN_PROJECT_ID_REQUIRED',
        statusCode: 400,
      });
    }

    const readNullableNumber = (value: unknown): number | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null || value === '') return null;
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : null;
    };

    const budget = runService.putBudget({
      projectId,
      monthlyTokenBudget: readNullableNumber(body.monthlyTokenBudget),
      monthlyCostUsdBudget: readNullableNumber(body.monthlyCostUsdBudget),
      stuckMinutes: readNullableNumber(body.stuckMinutes),
    });
    res.json({ success: true, budget });
  }),
);

router.get(
  '/:runId',
  asyncHandler(async (req, res) => {
    const runId = readPathParam(req.params.runId);
    const run = runService.get(runId);
    if (!run) {
      throw new AppError(`Run not found: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ success: true, run });
  }),
);

router.get(
  '/:runId/events',
  asyncHandler(async (req, res) => {
    const runId = readPathParam(req.params.runId);
    try {
      const events = runService.listEvents(runId, {
        afterSeq: readOptionalNumber(req.query.afterSeq),
        limit: readOptionalNumber(req.query.limit),
      });
      res.json({ success: true, events });
    } catch (error) {
      rethrowAsHttpError(error);
    }
  }),
);

router.post(
  '/:runId/abort',
  asyncHandler(async (req, res) => {
    const runId = readPathParam(req.params.runId);
    const run = runService.get(runId);
    if (!run) {
      throw new AppError(`Run not found: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        statusCode: 404,
      });
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new AppError(`Run ${runId} is already terminal (${run.status})`, {
        code: 'RUN_ALREADY_TERMINAL',
        statusCode: 409,
      });
    }
    try {
      runService.markTerminal(runId, { status: 'aborted', errorSummary: 'aborted by user' });
    } catch (error) {
      rethrowAsHttpError(error);
    }
    res.json({ success: true, run: runService.get(runId) });
  }),
);

export default router;
