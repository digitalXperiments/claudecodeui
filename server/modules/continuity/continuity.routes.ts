import express, { type Request, type Response } from 'express';

import { sessionsDb } from '@/modules/database/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import {
  createCheckpoint,
  getLatestCheckpoint,
  listScratchpad,
  resolveLineageRootSessionId,
  setScratchpad,
} from './continuity-checkpoints.js';
import { getContinuityHealth, simulateRecovery } from './continuity-health.service.js';
import { continuityRepository } from './continuity.repository.js';
import { CONTINUITY_PROVIDERS, continuityService } from './continuity.service.js';
import { listProviderTiers, pickEquivalentModel, resolveModelTier } from './continuity-tiers.js';
import type { ContinuityPolicyInput } from './continuity.types.js';

const router = express.Router();

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

function historyLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return HISTORY_DEFAULT_LIMIT;
  return Math.min(HISTORY_MAX_LIMIT, Math.max(1, parsed));
}

function sessionId(value: unknown): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  const session = parsed ? sessionsDb.getSessionById(parsed) : null;
  if (!session || session.is_internal) {
    throw new AppError('Interactive session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  }
  return parsed;
}

// Feature 1: Live Provider Health Matrix
router.get('/continuity/health', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse(await getContinuityHealth()));
}));

// Feature 1: Recovery Audit History
router.get('/continuity/history', asyncHandler(async (req: Request, res: Response) => {
  const limit = historyLimit(req.query.limit);
  res.json(createApiSuccessResponse({
    limit,
    recoveries: continuityRepository.listRecentRecoveries(limit),
  }));
}));

// Feature 1: Hand-off / Limit Simulation
router.post('/continuity/simulate', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sourceProvider = body.sourceProvider;
  if (typeof sourceProvider !== 'string' || !CONTINUITY_PROVIDERS.includes(sourceProvider as LLMProvider)) {
    throw new AppError('sourceProvider must be a provider continuity supports.', {
      code: 'INVALID_CONTINUITY_PROVIDER',
      statusCode: 400,
    });
  }
  const policy = body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy)
    ? body.policy as ContinuityPolicyInput
    : undefined;
  const simulation = await simulateRecovery({
    sessionId: sessionId(body.sessionId),
    policy,
    sourceProvider: sourceProvider as LLMProvider,
    detectedReason: typeof body.detectedReason === 'string' ? body.detectedReason : undefined,
    retryAt: typeof body.retryAt === 'string' ? body.retryAt : null,
    attempt: typeof body.attempt === 'number' ? body.attempt : undefined,
  });
  res.json(createApiSuccessResponse({ simulation }));
}));

// Feature 5: Provider Model & Capability Tiers
router.get('/continuity/tiers', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse({ tiers: listProviderTiers() }));
}));

router.post('/continuity/tiers/match', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sourceProvider = typeof body.sourceProvider === 'string' ? body.sourceProvider : 'claude';
  const sourceModel = typeof body.sourceModel === 'string' ? body.sourceModel : undefined;
  const targetProvider = typeof body.targetProvider === 'string' ? body.targetProvider : 'codex';
  const sourceTier = resolveModelTier(sourceProvider, sourceModel);
  const match = pickEquivalentModel(targetProvider, sourceTier);
  res.json(createApiSuccessResponse({ sourceTier, targetModel: match.model, tierMatch: match.tierMatch }));
}));

// Feature 4: Pre-flight Quota Guard check
router.post('/continuity/preflight', asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sid = sessionId(body.sessionId);
  const provider = typeof body.provider === 'string' ? (body.provider as LLMProvider) : 'claude';
  const result = await continuityService.checkPreflight(sid, provider);
  res.json(createApiSuccessResponse(result));
}));

// Feature 3: Boomerang Mode check & trigger
router.get('/continuity/sessions/:sessionId/boomerang', asyncHandler(async (req: Request, res: Response) => {
  const sid = sessionId(req.params.sessionId);
  const status = await continuityService.checkBoomerang(sid);
  res.json(createApiSuccessResponse(status));
}));

router.post('/continuity/sessions/:sessionId/boomerang', asyncHandler(async (req: Request, res: Response) => {
  const sid = sessionId(req.params.sessionId);
  const result = await continuityService.executeBoomerang(sid);
  res.json(createApiSuccessResponse(result));
}));

// Feature 6: Checkpoints & Scratchpad
router.get('/continuity/sessions/:sessionId/checkpoints', asyncHandler(async (req: Request, res: Response) => {
  const sid = sessionId(req.params.sessionId);
  const rootSessionId = await resolveLineageRootSessionId(sid);
  const latestCheckpoint = getLatestCheckpoint(sid);
  const scratchpad = listScratchpad(rootSessionId);
  res.json(createApiSuccessResponse({ latestCheckpoint, scratchpad, rootSessionId }));
}));

router.post('/continuity/sessions/:sessionId/checkpoints', asyncHandler(async (req: Request, res: Response) => {
  const sid = sessionId(req.params.sessionId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rootSessionId = await resolveLineageRootSessionId(sid);
  const session = sessionsDb.getSessionById(sid)!;
  const checkpoint = createCheckpoint({
    sessionId: sid,
    lineageRootSessionId: rootSessionId,
    provider: session.provider as LLMProvider,
    runId: typeof body.runId === 'string' ? body.runId : null,
    summary: typeof body.summary === 'string' ? body.summary : 'Manual user checkpoint',
    nextSteps: Array.isArray(body.nextSteps) ? body.nextSteps.map(String) : [],
    openQuestions: Array.isArray(body.openQuestions) ? body.openQuestions.map(String) : [],
    filesTouched: Array.isArray(body.filesTouched) ? body.filesTouched.map(String) : [],
    commands: Array.isArray(body.commands) ? body.commands.map(String) : [],
    doNotRepeat: Array.isArray(body.doNotRepeat) ? body.doNotRepeat.map(String) : [],
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
  });
  res.json(createApiSuccessResponse({ checkpoint }));
}));

router.post('/continuity/sessions/:sessionId/scratchpad', asyncHandler(async (req: Request, res: Response) => {
  const sid = sessionId(req.params.sessionId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rootSessionId = await resolveLineageRootSessionId(sid);
  const key = String(body.key ?? '');
  const value = String(body.value ?? '');
  if (!key) throw new AppError('key is required.', { code: 'INVALID_SCRATCHPAD_KEY', statusCode: 400 });
  const entry = setScratchpad({
    lineageRootSessionId: rootSessionId,
    key,
    value,
    ttlSeconds: typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
  });
  res.json(createApiSuccessResponse({ entry }));
}));

// Session Policy & Defaults
router.get('/continuity/sessions/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  res.json(createApiSuccessResponse(continuityService.getState(sessionId(req.params.sessionId))));
}));

router.get('/continuity/defaults', asyncHandler(async (_req: Request, res: Response) => {
  res.json(createApiSuccessResponse({ defaults: continuityService.getDefaults() }));
}));

router.put('/continuity/defaults', asyncHandler(async (req: Request, res: Response) => {
  const defaults = continuityService.putDefaults((req.body ?? {}) as ContinuityPolicyInput);
  res.json(createApiSuccessResponse({ defaults }));
}));

router.put('/continuity/sessions/:sessionId', asyncHandler(async (req: Request, res: Response) => {
  const policy = continuityService.putPolicy(
    sessionId(req.params.sessionId),
    (req.body ?? {}) as ContinuityPolicyInput,
  );
  res.json(createApiSuccessResponse({ policy, recovery: continuityRepository.getLatestForSession(policy.sessionId) }));
}));

router.post('/continuity/recoveries/:recoveryId/actions', asyncHandler(async (req: Request, res: Response) => {
  const recoveryId = typeof req.params.recoveryId === 'string' ? req.params.recoveryId.trim() : '';
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = body.action;
  if (action !== 'resume_now' && action !== 'switch_now' && action !== 'cancel') {
    throw new AppError('action must be resume_now, switch_now, or cancel.', {
      code: 'INVALID_CONTINUITY_ACTION',
      statusCode: 400,
    });
  }
  try {
    const recovery = continuityService.act(
      recoveryId,
      action,
      typeof body.targetProvider === 'string' ? body.targetProvider as LLMProvider : undefined,
    );
    res.json(createApiSuccessResponse({ recovery }));
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : String(error), {
      code: 'CONTINUITY_ACTION_FAILED',
      statusCode: 409,
    });
  }
}));

export default router;
