import express from 'express';

import { buildIdeatePrompt, studioService } from '@/modules/studio/studio.service.js';
import type { StudioSelectedElement, StudioTokensPatch } from '@/modules/studio/studio.types.js';
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

function intValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

function parseSelectedElement(value: unknown): StudioSelectedElement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const tag = stringValue(row.tag);
  if (!tag) return undefined;
  const classes = Array.isArray(row.classes)
    ? row.classes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : undefined;
  const text = typeof row.text === 'string' ? row.text.slice(0, 500) : undefined;
  const pathValue = typeof row.path === 'string' ? row.path.slice(0, 500) : undefined;
  return {
    tag,
    classes,
    text,
    path: pathValue,
  };
}

function parseTokenPatch(value: unknown): StudioTokensPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('Design tokens must be an object', {
      code: 'STUDIO_TOKENS_INVALID',
      statusCode: 400,
    });
  }
  return value as StudioTokensPatch;
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
      tokens: body.tokens && typeof body.tokens === 'object' && !Array.isArray(body.tokens)
        ? body.tokens as StudioTokensPatch
        : undefined,
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
    res.json({ success: true, prompt: buildIdeatePrompt(prototype), prototype });
  }),
);

router.post(
  '/:projectId/prototypes/:id/turns',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prototype = await studioService.appendTurn(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      {
        message: stringValue(body.message),
        selectedElement: parseSelectedElement(body.selectedElement),
      },
    );
    res.status(202).json({ success: true, prototype });
  }),
);

router.post(
  '/:projectId/prototypes/:id/variants',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prototype = await studioService.generateVariants(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      {
        message: stringValue(body.message) || undefined,
        count: intValue(body.count),
        selectedElement: parseSelectedElement(body.selectedElement),
      },
    );
    res.status(202).json({ success: true, prototype });
  }),
);

router.post(
  '/:projectId/prototypes/:id/variants/:variantId/promote',
  asyncHandler(async (req, res) => {
    const prototype = await studioService.promoteVariant(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      stringValue(req.params.variantId),
    );
    res.status(201).json({ success: true, prototype });
  }),
);

router.post(
  '/:projectId/prototypes/:id/versions/:versionId/revert',
  asyncHandler(async (req, res) => {
    const prototype = await studioService.revertToVersion(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      stringValue(req.params.versionId),
    );
    res.json({ success: true, prototype });
  }),
);

router.get(
  '/:projectId/prototypes/:id/tokens',
  asyncHandler(async (req, res) => {
    const tokens = await studioService.getTokens(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
    );
    res.json({ success: true, tokens });
  }),
);

router.put(
  '/:projectId/prototypes/:id/tokens',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch = body.tokens !== undefined ? body.tokens : body;
    const regenerate = body.regenerate === undefined ? true : body.regenerate !== false;
    const prototype = await studioService.updateTokens(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      {
        tokens: parseTokenPatch(patch),
        regenerate,
      },
    );
    const status = prototype.status === 'generating' ? 202 : 200;
    res.status(status).json({ success: true, tokens: prototype.tokens, prototype });
  }),
);

export default router;
