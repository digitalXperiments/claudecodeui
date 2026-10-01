/**
 * Per-bot "Abilities" REST surface, mounted by `botExecRouter` (behind authenticateToken at /api/bots):
 *   GET    /:botId/abilities                       one summary for the UI
 *   GET    /:botId/browser                         profile status
 *   DELETE /:botId/browser                         sign the bot out everywhere (delete the profile)
 *   POST   /:botId/browser/sign-in                 open the bot's profile for a manual login
 *   POST   /:botId/browser/sign-in/:sessionId/finish
 *   POST   /:botId/browser/sign-in/:sessionId/extend   "I need more time" (+30 min, 2 h in total)
 */
import express from 'express';

import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import { buildAbilitiesSummary } from './abilities.js';
import { browserProfileStatus, deleteBrowserProfile, extendSignIn, finishSignIn, startSignIn } from './browser-signin.js';

export const botAbilitiesRouter = express.Router();

const param = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));

function requireBot(req: express.Request): string {
  const botId = param(req.params.botId);
  if (!missionControlDb.getSection(botId)) throw new AppError('Bot not found', { code: 'BOT_NOT_FOUND', statusCode: 404 });
  return botId;
}

function body(req: express.Request): Record<string, unknown> {
  const value = req.body as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

botAbilitiesRouter.get(
  '/:botId/abilities',
  asyncHandler(async (req, res) => {
    const summary = await buildAbilitiesSummary(requireBot(req));
    if (!summary) throw new AppError('Bot not found', { code: 'BOT_NOT_FOUND', statusCode: 404 });
    res.json(summary);
  }),
);

botAbilitiesRouter.get(
  '/:botId/browser',
  asyncHandler(async (req, res) => {
    res.json({ browser: await browserProfileStatus(requireBot(req)) });
  }),
);

botAbilitiesRouter.delete(
  '/:botId/browser',
  asyncHandler(async (req, res) => {
    res.json(await deleteBrowserProfile(requireBot(req)));
  }),
);

botAbilitiesRouter.post(
  '/:botId/browser/sign-in',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    res.status(201).json(await startSignIn(botId, { url: body(req).url }));
  }),
);

botAbilitiesRouter.post(
  '/:botId/browser/sign-in/:sessionId/finish',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    res.json(await finishSignIn(botId, param(req.params.sessionId)));
  }),
);

botAbilitiesRouter.post(
  '/:botId/browser/sign-in/:sessionId/extend',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    res.json(await extendSignIn(botId, param(req.params.sessionId)));
  }),
);
