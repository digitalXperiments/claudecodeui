/**
 * Execution-substrate REST surface, mounted behind authenticateToken at /api/bots.
 * Mount it BEFORE botKernelRouter: its PATCH /:botId/runtime guard rejects unimplemented backends
 * ('docker'/'ssh') before the kernel's handler would store them.
 */
import express from 'express';

import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import { patchBotRuntimeConfig, readBotRuntimeConfig } from '../bots-runtime-config.js';
import { gatewayUpstreamPool } from '../gateway/upstream-pool.js';

import { botAbilitiesRouter } from './abilities.routes.js';
import { botCredentials, isValidCredentialKey, normalizeServerKey } from './bot-credentials.js';
import { readHostInfo } from './host.js';
import { cleanFallbackRoutes, validateFallbackRoutes, validateRuntimeConfigInput } from './runtime-validation.js';
import { activeTeachSession, startTeach, stopTeach } from './teach.js';

export const botExecRouter = express.Router();

// Per-bot abilities summary and browser sign-in (see abilities.routes.ts).
botExecRouter.use(botAbilitiesRouter);

const param = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));
const invalid = (message: string): AppError => new AppError(message, { code: 'BOT_EXEC_INVALID', statusCode: 400 });

function requireBot(req: express.Request): string {
  const botId = param(req.params.botId);
  if (!missionControlDb.getSection(botId)) throw new AppError('Bot not found', { code: 'BOT_NOT_FOUND', statusCode: 404 });
  return botId;
}

function body(req: express.Request): Record<string, unknown> {
  const value = req.body as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function credentialTarget(req: express.Request): { botId: string; server: string; key: string } {
  const botId = requireBot(req);
  const server = param(req.params.server);
  const key = param(req.params.key);
  if (!normalizeServerKey(server)) throw invalid('server is required');
  if (!isValidCredentialKey(key)) throw invalid('key must be an env var or header name (letters, digits, "_", "-", ".") without "__"');
  return { botId, server, key };
}

// ---- host ----------------------------------------------------------------------------------

botExecRouter.get(
  '/runtime/host',
  asyncHandler(async (_req, res) => {
    res.json({ host: await readHostInfo() });
  }),
);

// ---- runtime config guard --------------------------------------------------------------------

botExecRouter.patch('/:botId/runtime', (req, _res, next) => {
  const error = validateRuntimeConfigInput(body(req));
  if (error) {
    next(invalid(error));
    return;
  }
  next();
});

// ---- provider failover chain ---------------------------------------------------------------

botExecRouter.get(
  '/:botId/routing/fallback',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    res.json({ fallback: readBotRuntimeConfig(botId)?.routing?.fallback ?? [] });
  }),
);

botExecRouter.put(
  '/:botId/routing/fallback',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const input = body(req).fallback;
    if (!Array.isArray(input)) throw invalid('fallback must be an array');
    const error = validateFallbackRoutes(input);
    if (error) throw invalid(error);
    const routing = { ...(readBotRuntimeConfig(botId)?.routing ?? {}) };
    const fallback = cleanFallbackRoutes(input);
    if (fallback.length > 0) routing.fallback = fallback;
    else delete routing.fallback;
    const runtime = patchBotRuntimeConfig(botId, { routing });
    res.json({ fallback: runtime?.routing?.fallback ?? [] });
  }),
);

// ---- per-bot credentials -------------------------------------------------------------------

botExecRouter.get(
  '/:botId/credentials',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    // Names and timestamps only: values never leave the vault through this API.
    res.json({ credentials: botCredentials.list(botId) });
  }),
);

botExecRouter.put(
  '/:botId/credentials/:server/:key',
  asyncHandler(async (req, res) => {
    const { botId, server, key } = credentialTarget(req);
    const value = body(req).value;
    if (typeof value !== 'string' || value.length === 0) throw invalid('value must be a non-empty string');
    if (value.length > 16_384) throw invalid('value is too long');
    const credential = botCredentials.put(botId, server, key, value);
    // Live connections hold the old value; drop them so the next call reconnects with the new one.
    await gatewayUpstreamPool.invalidateBot?.(botId);
    res.json({ credential });
  }),
);

botExecRouter.delete(
  '/:botId/credentials/:server/:key',
  asyncHandler(async (req, res) => {
    const { botId, server, key } = credentialTarget(req);
    const deleted = botCredentials.delete(botId, server, key);
    if (!deleted) throw new AppError('Credential not found', { code: 'BOT_CREDENTIAL_NOT_FOUND', statusCode: 404 });
    await gatewayUpstreamPool.invalidateBot?.(botId);
    res.json({ deleted: true });
  }),
);

// ---- teach mode ------------------------------------------------------------------------------

botExecRouter.get(
  '/:botId/teach',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    res.json({ active: activeTeachSession(botId) });
  }),
);

botExecRouter.post(
  '/:botId/teach/start',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const input = body(req);
    res.json({ teach: await startTeach(botId, { url: input.url, useBotProfile: input.useBotProfile }) });
  }),
);

botExecRouter.post(
  '/:botId/teach/stop',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const input = body(req);
    const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined);
    const numbers = (value: unknown): number[] | undefined => (Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : undefined);
    const result = await stopTeach(botId, {
      name: typeof input.name === 'string' ? input.name : undefined,
      description: typeof input.description === 'string' ? input.description : undefined,
      successCheck: typeof input.successCheck === 'string' ? input.successCheck : undefined,
      safeFields: strings(input.safeFields),
      safeSteps: numbers(input.safeSteps),
      dryRun: input.dryRun === true,
    });
    res.json({ teach: result });
  }),
);
