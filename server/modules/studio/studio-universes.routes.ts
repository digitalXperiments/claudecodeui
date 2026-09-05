import express from 'express';

import { studioUniversesService } from '@/modules/studio/studio-universes.service.js';
import type { CreateUniverseApproachInput } from '@/modules/studio/studio-universes.types.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

// Mounted at `/:projectId/universes` with `mergeParams: true` by studio.routes.ts.
const router = express.Router({ mergeParams: true });

// Kept in sync with AGENT_RELAY_PROVIDERS (server/modules/agent-relay/agent-relay.types.ts),
// which the agent-relay module does not export through its barrel. submitBatch
// re-validates the provider against Agent Relay's own allowlist regardless —
// this is only a fast, friendly 400 before dispatching a batch.
const KNOWN_PROVIDERS: LLMProvider[] = [
  'claude', 'codex', 'cursor', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'qwencode', 'pi', 'omp', 'antigravity',
];

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function intValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function isValidPreviewPort(port: number | undefined): boolean {
  return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535);
}

function parseProvider(value: unknown, label: string): LLMProvider {
  if (typeof value !== 'string' || !KNOWN_PROVIDERS.includes(value as LLMProvider)) {
    throw new AppError(`"${label}" needs a valid provider (one of: ${KNOWN_PROVIDERS.join(', ')}).`, {
      code: 'STUDIO_UNIVERSE_PROVIDER_INVALID',
      statusCode: 400,
    });
  }
  return value as LLMProvider;
}

function parseApproach(value: unknown, index: number): CreateUniverseApproachInput {
  const row = (value ?? {}) as Record<string, unknown>;
  const label = stringValue(row.label) || `Approach ${index === 0 ? 'A' : 'B'}`;
  return {
    label,
    approach: stringValue(row.approach),
    provider: parseProvider(row.provider, label),
    model: stringValue(row.model),
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = stringValue(req.params.projectId);
    res.json({ success: true, universes: await studioUniversesService.list(projectId) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = stringValue(req.params.projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawApproaches = Array.isArray(body.approaches) ? body.approaches : [];
    if (rawApproaches.length !== 2) {
      throw new AppError('Provide exactly two named alternative approaches.', {
        code: 'STUDIO_UNIVERSE_APPROACHES_INVALID',
        statusCode: 400,
      });
    }
    const approaches = rawApproaches.map((entry, index) => parseApproach(entry, index)) as [
      CreateUniverseApproachInput,
      CreateUniverseApproachInput,
    ];
    const universe = await studioUniversesService.create(
      {
        projectId,
        goal: stringValue(body.goal),
        approaches,
        timeoutMs: intValue(body.timeoutMs),
      },
      typeof body.sourceSessionId === 'string' ? body.sourceSessionId : null,
    );
    res.status(201).json({ success: true, universe });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const universe = await studioUniversesService.get(stringValue(req.params.projectId), stringValue(req.params.id));
    res.json({ success: true, universe });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await studioUniversesService.remove(stringValue(req.params.projectId), stringValue(req.params.id));
    res.json({ success: true });
  }),
);

router.post(
  '/:id/variants/:variantId/cancel',
  asyncHandler(async (req, res) => {
    const universe = await studioUniversesService.cancelVariant(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      stringValue(req.params.variantId),
    );
    res.json({ success: true, universe });
  }),
);

router.get(
  '/:id/variants/:variantId/diff',
  asyncHandler(async (req, res) => {
    const includePatch = req.query.patch !== 'false';
    const diff = await studioUniversesService.diffVariant(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      stringValue(req.params.variantId),
      includePatch,
    );
    res.json({ success: true, diff });
  }),
);

router.post(
  '/:id/variants/:variantId/apply',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const universe = await studioUniversesService.applyVariant(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      stringValue(req.params.variantId),
      {
        commit: boolValue(body.commit),
        message: typeof body.message === 'string' ? body.message : undefined,
      },
    );
    res.status(201).json({ success: true, universe });
  }),
);

router.post(
  '/:id/variants/:variantId/preview/start',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const command = stringValue(body.command);
    if (!command) {
      throw new AppError('A start command is required to launch a preview.', {
        code: 'STUDIO_UNIVERSE_PREVIEW_COMMAND_REQUIRED',
        statusCode: 400,
      });
    }
    const port = intValue(body.port);
    if (!isValidPreviewPort(port)) {
      throw new AppError('Preview port must be an integer between 1 and 65535.', {
        code: 'STUDIO_UNIVERSE_PREVIEW_PORT_INVALID',
        statusCode: 400,
      });
    }
    const universe = await studioUniversesService.startPreview(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      stringValue(req.params.variantId),
      { command, port },
    );
    res.status(201).json({ success: true, universe });
  }),
);

router.post(
  '/:id/variants/:variantId/preview/stop',
  asyncHandler(async (req, res) => {
    const universe = await studioUniversesService.stopPreview(
      stringValue(req.params.projectId),
      stringValue(req.params.id),
      stringValue(req.params.variantId),
    );
    res.json({ success: true, universe });
  }),
);

export default router;
