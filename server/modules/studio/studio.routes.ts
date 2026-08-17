import express from 'express';

import { buildIdeatePrompt, studioService } from '@/modules/studio/studio.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json({ success: true, seats: studioService.getSeats() });
  }),
);

router.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const seats = studioService.saveSeats(body.seats);
    res.json({ success: true, seats });
  }),
);

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

router.get(
  '/:projectId/prototypes',
  asyncHandler(async (req, res) => {
    const projectId = stringValue(req.params.projectId);
    res.json({ success: true, prototypes: await studioService.list(projectId) });
  }),
);

router.post(
  '/:projectId/prototypes',
  asyncHandler(async (req, res) => {
    const projectId = stringValue(req.params.projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prototype = await studioService.create({
      projectId,
      title: stringValue(body.title) || undefined,
      brief: stringValue(body.brief),
      skills: stringList(body.skills),
    });
    res.status(201).json({ success: true, prototype });
  }),
);

router.get(
  '/:projectId/prototypes/:id',
  asyncHandler(async (req, res) => {
    const prototype = await studioService.get(stringValue(req.params.projectId), stringValue(req.params.id));
    res.json({ success: true, prototype });
  }),
);

router.put(
  '/:projectId/prototypes/:id',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prototype = await studioService.update(stringValue(req.params.projectId), stringValue(req.params.id), {
      title: typeof body.title === 'string' ? body.title : undefined,
      brief: typeof body.brief === 'string' ? body.brief : undefined,
      skills: stringList(body.skills),
      html: typeof body.html === 'string' ? body.html : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      handoff: typeof body.handoff === 'string' ? body.handoff : undefined,
    });
    res.json({ success: true, prototype });
  }),
);

router.delete(
  '/:projectId/prototypes/:id',
  asyncHandler(async (req, res) => {
    await studioService.remove(stringValue(req.params.projectId), stringValue(req.params.id));
    res.json({ success: true });
  }),
);

router.post(
  '/:projectId/prototypes/:id/swarm',
  asyncHandler(async (req, res) => {
    const result = await studioService.launchSwarm(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
    );
    res.status(201).json({ success: true, ...result });
  }),
);

router.get(
  '/:projectId/prototypes/:id/ideate-prompt',
  asyncHandler(async (req, res) => {
    const prototype = await studioService.get(stringValue(req.params.projectId), stringValue(req.params.id));
    if (!prototype) {
      throw new AppError('Prototype not found', { code: 'STUDIO_NOT_FOUND', statusCode: 404 });
    }
    res.json({ success: true, prompt: buildIdeatePrompt(prototype), prototype });
  }),
);

export default router;
