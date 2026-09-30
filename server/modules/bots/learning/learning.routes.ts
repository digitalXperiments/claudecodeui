/**
 * Learning REST surface, mounted behind authenticateToken at /api/bots:
 * proposals, skills, operator profile, evals suite, shadow evaluation, export and purge.
 */
import express from 'express';

import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { evalsBridge } from '@/modules/bots/learning/evals-bridge.js';
import { learning } from '@/modules/bots/learning/learning.service.js';
import { learningError } from '@/modules/bots/learning/learning.util.js';
import { operatorProfile } from '@/modules/bots/learning/operator-profile.service.js';
import { privacy, type PurgeSelection } from '@/modules/bots/learning/privacy.service.js';
import { reflector } from '@/modules/bots/learning/reflector.js';
import { shadow } from '@/modules/bots/learning/shadow.js';
import { skills } from '@/modules/bots/learning/skills.service.js';

export const botLearningRouter = express.Router();

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

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// ---- operator profile (registered before /:botId routes) ------------------------------------

botLearningRouter.get('/operator-profile', asyncHandler(async (_req, res) => {
  res.json({ entries: operatorProfile.list() });
}));

botLearningRouter.put('/operator-profile/:key', asyncHandler(async (req, res) => {
  const value = optionalString(body(req).value);
  if (value === undefined) throw learningError('value is required');
  res.json({ entry: operatorProfile.set(param(req.params.key), value) });
}));

botLearningRouter.delete('/operator-profile/:key', asyncHandler(async (req, res) => {
  const removed = operatorProfile.delete(param(req.params.key));
  if (!removed) throw learningError('Profile key not found', 404, 'BOT_PROFILE_NOT_FOUND');
  res.json({ deleted: true });
}));

// ---- proposals -------------------------------------------------------------------------------

botLearningRouter.get('/:botId/proposals', asyncHandler(async (req, res) => {
  const botId = requireBot(req);
  res.json({ proposals: learning.list(botId, { status: optionalString(req.query.status) || undefined }) });
}));

function ownedProposal(req: express.Request): string {
  const botId = requireBot(req);
  const proposalId = param(req.params.proposalId);
  if (learning.get(proposalId)?.bot_id !== botId) throw learningError('Proposal not found', 404, 'BOT_PROPOSAL_NOT_FOUND');
  return proposalId;
}

botLearningRouter.post('/:botId/proposals/:proposalId/approve', asyncHandler(async (req, res) => {
  const proposalId = ownedProposal(req);
  res.json({ proposal: learning.approve(proposalId, { editedBody: optionalString(body(req).editedBody) }) });
}));

botLearningRouter.post('/:botId/proposals/:proposalId/reject', asyncHandler(async (req, res) => {
  res.json({ proposal: learning.reject(ownedProposal(req)) });
}));

botLearningRouter.post('/:botId/reflect', asyncHandler(async (req, res) => {
  const botId = requireBot(req);
  res.json({ proposals: await reflector.reflectBot(botId) });
}));

// ---- skills ----------------------------------------------------------------------------------

botLearningRouter.get('/:botId/skills', asyncHandler(async (req, res) => {
  res.json({ skills: skills.list(requireBot(req)) });
}));

botLearningRouter.post('/:botId/skills/from-run', asyncHandler(async (req, res) => {
  const botId = requireBot(req);
  const input = body(req);
  const skill = await skills.fromRun(botId, { runId: optionalString(input.runId), episodeId: optionalString(input.episodeId) });
  res.status(201).json({ skill });
}));

botLearningRouter.post('/:botId/skills/link', asyncHandler(async (req, res) => {
  const skill = skills.linkCatalogSkill(requireBot(req), optionalString(body(req).path) ?? '');
  res.status(201).json({ skill });
}));

botLearningRouter.get('/:botId/skills/:name', asyncHandler(async (req, res) => {
  res.json(skills.get(requireBot(req), param(req.params.name)));
}));

botLearningRouter.put('/:botId/skills/:name', asyncHandler(async (req, res) => {
  const input = body(req);
  const content = optionalString(input.content);
  if (content === undefined) throw learningError('content is required');
  const skill = skills.save(requireBot(req), {
    name: param(req.params.name),
    content,
    description: optionalString(input.description),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
  });
  res.json({ skill });
}));

botLearningRouter.post('/:botId/skills/:name/enable', asyncHandler(async (req, res) => {
  res.json({ skill: skills.enable(requireBot(req), param(req.params.name)) });
}));

botLearningRouter.post('/:botId/skills/:name/disable', asyncHandler(async (req, res) => {
  res.json({ skill: skills.disable(requireBot(req), param(req.params.name)) });
}));

botLearningRouter.delete('/:botId/skills/:name', asyncHandler(async (req, res) => {
  if (!skills.remove(requireBot(req), param(req.params.name))) throw learningError('Skill not found', 404, 'BOT_SKILL_NOT_FOUND');
  res.json({ deleted: true });
}));

// ---- evals + shadow --------------------------------------------------------------------------

botLearningRouter.post('/:botId/evals/suite', asyncHandler(async (req, res) => {
  res.json({ suite: evalsBridge.buildSuite(requireBot(req)) });
}));

botLearningRouter.post('/:botId/shadow', asyncHandler(async (req, res) => {
  const botId = requireBot(req);
  const input = body(req);
  const candidateInput = (input.candidate && typeof input.candidate === 'object' ? input.candidate : input) as Record<string, unknown>;
  const memories = Array.isArray(candidateInput.memories) ? candidateInput.memories.filter((m): m is string => typeof m === 'string') : undefined;
  const episodes = typeof input.episodes === 'number' ? input.episodes : undefined;
  const job = shadow.startJob(botId, { produce_prompt: optionalString(candidateInput.produce_prompt), memories }, { episodes });
  res.status(202).json({ jobId: job.jobId, status: job.status });
}));

botLearningRouter.get('/:botId/shadow/:jobId', asyncHandler(async (req, res) => {
  const botId = requireBot(req);
  const job = shadow.getJob(param(req.params.jobId));
  if (!job || job.botId !== botId) throw learningError('Shadow job not found', 404, 'BOT_SHADOW_NOT_FOUND');
  res.json({ job });
}));

// ---- privacy ---------------------------------------------------------------------------------

botLearningRouter.get('/:botId/export', asyncHandler(async (req, res) => {
  const botId = requireBot(req);
  res.setHeader('Content-Disposition', `attachment; filename="bot-${botId}-export.json"`);
  res.json(privacy.exportBot(botId));
}));

botLearningRouter.post('/:botId/purge', asyncHandler(async (req, res) => {
  const botId = requireBot(req);
  const input = body(req);
  const selection: PurgeSelection = {};
  for (const key of ['memories', 'episodes', 'events', 'threads', 'proposals', 'skills'] as const) {
    if (input[key] === true) selection[key] = true;
  }
  if (Object.keys(selection).length === 0) throw learningError('Select at least one of memories, episodes, events, threads, proposals, skills');
  res.json({ purged: privacy.purgeBot(botId, selection) });
}));
