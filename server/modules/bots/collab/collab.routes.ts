/**
 * Collaboration REST surface, mounted behind authenticateToken at /api/bots:
 *   /teams (CRUD, members, coordinator, wake)
 *   /space-roots
 *   /:botId/spaces (CRUD)
 *   /:botId/peers
 * Team routes are registered before the `/:botId/...` routes.
 */

import express from 'express';

import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { botTeamsDb } from '@/modules/bots/collab/bot-teams.repository.js';
import { recentPeerTraffic } from '@/modules/bots/collab/peers.js';
import { listSpacesRoots } from '@/modules/bots/collab/spaces.paths.js';
import { spaces } from '@/modules/bots/collab/spaces.service.js';
import { teams } from '@/modules/bots/collab/teams.service.js';

export const botCollabRouter = express.Router();

const param = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));

function body(req: express.Request): Record<string, unknown> {
  const value = req.body as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requireBot(req: express.Request): string {
  const botId = param(req.params.botId);
  if (!missionControlDb.getSection(botId)) throw new AppError('Bot not found', { code: 'BOT_NOT_FOUND', statusCode: 404 });
  return botId;
}

// ---- teams --------------------------------------------------------------------------------

botCollabRouter.get(
  '/teams',
  asyncHandler(async (_req, res) => {
    res.json({ teams: teams.list() });
  }),
);

botCollabRouter.post(
  '/teams',
  asyncHandler(async (req, res) => {
    res.status(201).json({ team: teams.create(body(req)) });
  }),
);

botCollabRouter.get(
  '/teams/:teamId',
  asyncHandler(async (req, res) => {
    res.json({ team: teams.get(param(req.params.teamId)) });
  }),
);

botCollabRouter.patch(
  '/teams/:teamId',
  asyncHandler(async (req, res) => {
    res.json({ team: teams.update(param(req.params.teamId), body(req)) });
  }),
);

botCollabRouter.delete(
  '/teams/:teamId',
  asyncHandler(async (req, res) => {
    teams.remove(param(req.params.teamId));
    res.json({ deleted: true });
  }),
);

botCollabRouter.post(
  '/teams/:teamId/members',
  asyncHandler(async (req, res) => {
    const input = body(req);
    res.status(201).json({ team: teams.addMember(param(req.params.teamId), input.bot_id, input.role) });
  }),
);

botCollabRouter.delete(
  '/teams/:teamId/members/:botId',
  asyncHandler(async (req, res) => {
    res.json({ team: teams.removeMember(param(req.params.teamId), param(req.params.botId)) });
  }),
);

botCollabRouter.put(
  '/teams/:teamId/coordinator',
  asyncHandler(async (req, res) => {
    res.json({ team: teams.setCoordinator(param(req.params.teamId), body(req).bot_id) });
  }),
);

botCollabRouter.post(
  '/teams/:teamId/wake',
  asyncHandler(async (req, res) => {
    const { team, coordinatorBotId } = teams.wake(param(req.params.teamId), body(req).note);
    res.status(202).json({ woken: true, team_id: team.team_id, coordinator_bot_id: coordinatorBotId });
  }),
);

// ---- spaces -------------------------------------------------------------------------------

botCollabRouter.get(
  '/space-roots',
  asyncHandler(async (_req, res) => {
    res.json({ roots: listSpacesRoots() });
  }),
);

botCollabRouter.get(
  '/:botId/spaces',
  asyncHandler(async (req, res) => {
    res.json({ spaces: spaces.list(requireBot(req)) });
  }),
);

botCollabRouter.post(
  '/:botId/spaces',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const input = body(req);
    res.status(201).json({ space: spaces.create(botId, { title: input.title, kind: input.kind, root: input.root, content: input.content }) });
  }),
);

botCollabRouter.get(
  '/:botId/spaces/:spaceId',
  asyncHandler(async (req, res) => {
    res.json(spaces.get(requireBot(req), param(req.params.spaceId)));
  }),
);

botCollabRouter.put(
  '/:botId/spaces/:spaceId',
  asyncHandler(async (req, res) => {
    const input = body(req);
    const mode = input.mode === undefined ? 'replace' : input.mode;
    if (mode !== 'replace' && mode !== 'append') throw new AppError('mode must be replace or append', { code: 'BOT_SPACE_INVALID', statusCode: 400 });
    res.json({ space: spaces.write(requireBot(req), param(req.params.spaceId), input.content, mode) });
  }),
);

botCollabRouter.delete(
  '/:botId/spaces/:spaceId',
  asyncHandler(async (req, res) => {
    if (!spaces.remove(requireBot(req), param(req.params.spaceId))) {
      throw new AppError('Space not found', { code: 'BOT_SPACE_NOT_FOUND', statusCode: 404 });
    }
    res.json({ deleted: true });
  }),
);

// ---- peers --------------------------------------------------------------------------------

botCollabRouter.get(
  '/:botId/peers',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const limit = Number(typeof req.query.limit === 'string' ? req.query.limit : NaN);
    res.json({
      teams: botTeamsDb.listForBot(botId),
      traffic: recentPeerTraffic(botId, Number.isFinite(limit) ? limit : 50),
    });
  }),
);
