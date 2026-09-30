/**
 * Kernel REST surface, mounted behind authenticateToken at /api/bots:
 * goals, commitments, episodes, per-bot runtime config and runtime status.
 */

import express from 'express';

import { missionControlDb, MC_PROVIDERS } from '@/modules/mission-control/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { normalizeBotRuntimeConfig, patchBotRuntimeConfig, readBotRuntimeConfig, type BotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
import type { BotCommitmentStatus, BotGoalStatus } from '@/modules/bots/bots.types.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { redactValue, toGateDecisionView } from '@/modules/bots/gate/gate.routes.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
import { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botGoalsDb } from '@/modules/bots/kernel/bot-goals.repository.js';
import { createCommitmentChecked } from '@/modules/bots/kernel/kernel-actions.js';
import { kernel } from '@/modules/bots/kernel/kernel.service.js';
import { validateFallbackRoutes } from '@/modules/bots/exec/runtime-validation.js';
import { runsDb } from '@/modules/runs/index.js';

export const botKernelRouter = express.Router();

const param = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));
const GOAL_STATUSES: BotGoalStatus[] = ['active', 'paused', 'achieved', 'abandoned'];
const COMMITMENT_STATUSES: BotCommitmentStatus[] = ['open', 'fired', 'done', 'cancelled'];
const EPISODE_STATUSES = ['running', 'succeeded', 'failed', 'interrupted'];
const PHASES = ['perceive', 'act', 'reflect'] as const;

const notFound = (what: string): AppError => new AppError(`${what} not found`, { code: 'BOT_NOT_FOUND', statusCode: 404 });
const invalid = (message: string): AppError => new AppError(message, { code: 'BOT_KERNEL_INVALID', statusCode: 400 });

function requireBot(req: express.Request): string {
  const botId = param(req.params.botId);
  if (!missionControlDb.getSection(botId)) throw notFound('Bot');
  return botId;
}

function body(req: express.Request): Record<string, unknown> {
  const value = req.body as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown, field: string, max = 2_000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string`);
  return value.trim().slice(0, max);
}

function parseLimit(value: unknown, fallback: number, max = 200): number {
  const n = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}

// ---- runtime status (registered before /:botId routes) -------------------------

botKernelRouter.get(
  '/runtime/status',
  asyncHandler(async (_req, res) => {
    res.json(kernel.status());
  }),
);

// ---- goals --------------------------------------------------------------------

botKernelRouter.get(
  '/:botId/goals',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const status = typeof req.query.status === 'string' ? (req.query.status as BotGoalStatus) : undefined;
    if (status && !GOAL_STATUSES.includes(status)) throw invalid(`status must be one of ${GOAL_STATUSES.join(', ')}`);
    res.json({ goals: botGoalsDb.list(botId, status) });
  }),
);

botKernelRouter.post(
  '/:botId/goals',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const input = body(req);
    const statement = optionalString(input.statement, 'statement');
    if (!statement) throw invalid('statement is required');
    const status = input.status as BotGoalStatus | undefined;
    if (status !== undefined && !GOAL_STATUSES.includes(status)) throw invalid(`status must be one of ${GOAL_STATUSES.join(', ')}`);
    const horizon = input.horizon === null ? null : optionalString(input.horizon, 'horizon', 200);
    const goal = botGoalsDb.create({
      botId,
      statement,
      successCriteria: optionalString(input.success_criteria, 'success_criteria'),
      horizon,
      status,
      sortOrder: typeof input.sort_order === 'number' ? input.sort_order : undefined,
    });
    res.status(201).json({ goal });
  }),
);

botKernelRouter.patch(
  '/:botId/goals/:goalId',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const existing = botGoalsDb.get(param(req.params.goalId));
    if (!existing || existing.bot_id !== botId) throw notFound('Goal');
    const input = body(req);
    const status = input.status as BotGoalStatus | undefined;
    if (status !== undefined && !GOAL_STATUSES.includes(status)) throw invalid(`status must be one of ${GOAL_STATUSES.join(', ')}`);
    if (input.statement !== undefined && !optionalString(input.statement, 'statement')) throw invalid('statement cannot be empty');
    const progress = input.progress;
    if (progress !== undefined && (typeof progress !== 'object' || progress === null || Array.isArray(progress))) {
      throw invalid('progress must be an object');
    }
    const goal = botGoalsDb.update(existing.goal_id, {
      statement: optionalString(input.statement, 'statement'),
      successCriteria: optionalString(input.success_criteria, 'success_criteria'),
      horizon: input.horizon === null ? null : optionalString(input.horizon, 'horizon', 200),
      status,
      progress: progress as Record<string, unknown> | undefined,
      sortOrder: typeof input.sort_order === 'number' ? input.sort_order : undefined,
    });
    res.json({ goal });
  }),
);

botKernelRouter.delete(
  '/:botId/goals/:goalId',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const existing = botGoalsDb.get(param(req.params.goalId));
    if (!existing || existing.bot_id !== botId) throw notFound('Goal');
    botGoalsDb.delete(existing.goal_id);
    res.json({ success: true });
  }),
);

// ---- commitments ----------------------------------------------------------------

botKernelRouter.get(
  '/:botId/commitments',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const status = typeof req.query.status === 'string' ? (req.query.status as BotCommitmentStatus) : undefined;
    if (status && !COMMITMENT_STATUSES.includes(status)) throw invalid(`status must be one of ${COMMITMENT_STATUSES.join(', ')}`);
    res.json({ commitments: botCommitmentsDb.list(botId, status) });
  }),
);

botKernelRouter.post(
  '/:botId/commitments',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const input = body(req);
    const result = createCommitmentChecked(botId, { ...input, item_ref: input.item_id ?? input.item_ref });
    if (!result.ok) throw invalid(result.error);
    res.status(201).json({ commitment: result.commitment });
  }),
);

function commitmentTransition(action: 'complete' | 'cancel'): express.RequestHandler {
  return asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const existing = botCommitmentsDb.get(param(req.params.commitmentId));
    if (!existing || existing.bot_id !== botId) throw notFound('Commitment');
    const commitment = action === 'complete' ? botCommitmentsDb.complete(existing.commitment_id) : botCommitmentsDb.cancel(existing.commitment_id);
    res.json({ commitment });
  });
}

botKernelRouter.post('/:botId/commitments/:commitmentId/complete', commitmentTransition('complete'));
botKernelRouter.post('/:botId/commitments/:commitmentId/cancel', commitmentTransition('cancel'));

// ---- episodes ---------------------------------------------------------------------

botKernelRouter.get(
  '/:botId/episodes',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !EPISODE_STATUSES.includes(status)) throw invalid(`status must be one of ${EPISODE_STATUSES.join(', ')}`);
    const limit = parseLimit(req.query.limit, 50);
    // Filter after the query so `limit` counts matching episodes, not raw rows.
    const episodes = status
      ? botEpisodesDb.list(botId, 500).filter((episode) => episode.status === status).slice(0, limit)
      : botEpisodesDb.list(botId, limit);
    res.json({ episodes });
  }),
);

// Registered before `/episodes/:episodeId` so "search" is not read as an id.
botKernelRouter.get(
  '/:botId/episodes/search',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q.trim()) throw invalid('q is required');
    res.json({ hits: botEpisodesDb.search(botId, q, parseLimit(req.query.limit, 10, 50)) });
  }),
);

botKernelRouter.get(
  '/:botId/episodes/:episodeId',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const episode = botEpisodesDb.get(param(req.params.episodeId));
    if (!episode || episode.bot_id !== botId) throw notFound('Episode');
    const runs = episode.run_ids
      .map((runId) => runsDb.getById(runId))
      .filter((run): run is NonNullable<typeof run> => Boolean(run))
      .map((run) => ({
        run_id: run.run_id,
        status: run.status,
        trigger: run.trigger,
        provider: run.provider,
        model: run.model,
        started_at: run.started_at,
        finished_at: run.finished_at,
        cost_usd: run.cost_usd_estimate,
        error_summary: run.error_summary,
      }));
    res.json({
      episode,
      // Same display redaction as /:botId/gate-decisions: never echo raw tool args or payload secrets.
      events: botEventsDb.listForEpisode(episode.episode_id).map((event) => ({ ...event, payload: redactValue(event.payload) as Record<string, unknown> })),
      gate_decisions: botGateDecisionsDb.listForBot(botId, 500)
        .filter((decision) => decision.episode_id === episode.episode_id)
        .map(toGateDecisionView),
      runs,
    });
  }),
);

// ---- per-bot runtime config ---------------------------------------------------------

botKernelRouter.get(
  '/:botId/runtime',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    res.json({ runtime: readBotRuntimeConfig(botId) ?? {} });
  }),
);

function validateRouting(routing: unknown): void {
  if (routing === null) return;
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) throw invalid('routing must be an object');
  for (const [phase, route] of Object.entries(routing as Record<string, unknown>)) {
    if (phase === 'fallback') {
      // The failover chain is a list, not a phase route; exec owns its rules.
      const error = validateFallbackRoutes(route);
      if (error) throw invalid(error);
      continue;
    }
    if (!(PHASES as readonly string[]).includes(phase)) throw invalid(`Unknown routing phase "${phase}"`);
    if (route === null) continue;
    const provider = route && typeof route === 'object' ? (route as Record<string, unknown>).provider : undefined;
    if (typeof provider !== 'string' || !(MC_PROVIDERS as readonly string[]).includes(provider)) {
      throw invalid(`routing.${phase}.provider must be one of ${MC_PROVIDERS.join(', ')}`);
    }
  }
}

botKernelRouter.patch(
  '/:botId/runtime',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const input = body(req);
    if (input.routing !== undefined) validateRouting(input.routing);
    if (input.routing && typeof input.routing === 'object' && !Array.isArray(input.routing)) {
      // Merge per phase: a phase set to null removes that override, omitted phases are kept.
      const routing: Record<string, unknown> = { ...(readBotRuntimeConfig(botId)?.routing ?? {}) };
      for (const [phase, route] of Object.entries(input.routing as Record<string, unknown>)) {
        if (route === null) delete routing[phase];
        else routing[phase] = route;
      }
      input.routing = routing;
    }
    // Reuse the normalizer so a bad backend/enforcement value is rejected, not silently dropped.
    const normalized = normalizeBotRuntimeConfig(input);
    const patch: { [K in keyof BotRuntimeConfig]?: BotRuntimeConfig[K] | null } = {};
    for (const key of Object.keys(normalized) as (keyof BotRuntimeConfig)[]) {
      (patch as Record<string, unknown>)[key] = normalized[key];
    }
    for (const key of ['identity', 'routing', 'backend', 'backend_config', 'gateway', 'enforcement'] as const) {
      if (input[key] === null) (patch as Record<string, unknown>)[key] = null;
      else if (input[key] !== undefined && !(key in normalized)) throw invalid(`Invalid value for ${key}`);
    }
    const runtime = patchBotRuntimeConfig(botId, patch);
    if (!runtime) throw notFound('Bot');
    res.json({ runtime });
  }),
);
