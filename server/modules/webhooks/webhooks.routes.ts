import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import { webhooksDb } from '@/modules/webhooks/webhooks.repository.js';
import {
  isWebhookProvider,
  type CreateWebhookSourceInput,
  type UpdateWebhookSourceInput,
  type WebhookScope,
} from '@/modules/webhooks/webhooks.types.js';
import { startWebhookDelivery } from '@/modules/webhooks/webhooks-runner.service.js';

const router = express.Router();

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function paramId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError('Expected an array of strings', {
      code: 'WEBHOOK_INVALID_ARRAY',
      statusCode: 400,
    });
  }
  return value
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseBody(
  body: Record<string, unknown>,
  partial: boolean,
): CreateWebhookSourceInput | UpdateWebhookSourceInput {
  const source = readOptionalString(body.source);
  const name = readOptionalString(body.name);

  if (!partial) {
    if (!source?.trim()) {
      throw new AppError('source is required', {
        code: 'WEBHOOK_SOURCE_REQUIRED',
        statusCode: 400,
      });
    }
    if (!name?.trim()) {
      throw new AppError('name is required', {
        code: 'WEBHOOK_NAME_REQUIRED',
        statusCode: 400,
      });
    }
  }

  let provider = body.provider;
  if (provider !== undefined && provider !== null && provider !== '') {
    if (!isWebhookProvider(provider)) {
      throw new AppError(`Invalid provider: ${String(provider)}`, {
        code: 'WEBHOOK_INVALID_PROVIDER',
        statusCode: 400,
      });
    }
  }

  let scope: WebhookScope | undefined;
  if (body.scope !== undefined) {
    scope = body.scope === 'project' ? 'project' : 'global';
  }

  const projectId =
    body.project_id === null
      ? null
      : body.project_id !== undefined
        ? readString(body.project_id) || null
        : undefined;

  if (scope === 'project' && !projectId && !partial) {
    throw new AppError('project_id is required when scope is project', {
      code: 'WEBHOOK_PROJECT_REQUIRED',
      statusCode: 400,
    });
  }

  return {
    ...(source !== undefined ? { source: source.trim() } : {}),
    ...(name !== undefined ? { name: name.trim() } : {}),
    ...(body.description !== undefined ? { description: readString(body.description) } : {}),
    ...(body.enabled !== undefined ? { enabled: readBoolean(body.enabled, true) } : {}),
    ...(provider !== undefined && isWebhookProvider(provider) ? { provider } : {}),
    ...(body.model !== undefined
      ? { model: body.model === null ? null : readString(body.model) || null }
      : {}),
    ...(body.prompt !== undefined ? { prompt: readString(body.prompt) } : {}),
    ...(body.permission_mode !== undefined
      ? { permission_mode: readString(body.permission_mode) || 'bypassPermissions' }
      : {}),
    ...(body.mcp_tools !== undefined ? { mcp_tools: parseStringArray(body.mcp_tools) } : {}),
    ...(body.skills !== undefined ? { skills: parseStringArray(body.skills) } : {}),
    ...(body.profile_id !== undefined
      ? {
          profile_id:
            body.profile_id === null ? null : readString(body.profile_id) || null,
        }
      : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(projectId !== undefined ? { project_id: projectId } : {}),
  };
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const sources = webhooksDb.listSources();
    res.json({ success: true, sources });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = parseBody(body, false) as CreateWebhookSourceInput;

    try {
      const source = webhooksDb.createSource(input);
      res.status(201).json({ success: true, source });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE') || message.toLowerCase().includes('unique')) {
        throw new AppError(`Source slug already exists: ${input.source}`, {
          code: 'WEBHOOK_SOURCE_DUPLICATE',
          statusCode: 409,
        });
      }
      throw error;
    }
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = paramId(req.params.id);
    const source = webhooksDb.getSourceById(id);
    if (!source) {
      throw new AppError('Webhook source not found', {
        code: 'WEBHOOK_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ success: true, source });
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = paramId(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = parseBody(body, true) as UpdateWebhookSourceInput;

    try {
      const source = webhooksDb.updateSource(id, input);
      if (!source) {
        throw new AppError('Webhook source not found', {
          code: 'WEBHOOK_NOT_FOUND',
          statusCode: 404,
        });
      }
      res.json({ success: true, source });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE') || message.toLowerCase().includes('unique')) {
        throw new AppError('Source slug already exists', {
          code: 'WEBHOOK_SOURCE_DUPLICATE',
          statusCode: 409,
        });
      }
      throw error;
    }
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = paramId(req.params.id);
    const ok = webhooksDb.deleteSource(id);
    if (!ok) {
      throw new AppError('Webhook source not found', {
        code: 'WEBHOOK_NOT_FOUND',
        statusCode: 404,
      });
    }
    res.json({ success: true });
  }),
);

router.get(
  '/:id/deliveries',
  asyncHandler(async (req, res) => {
    const id = paramId(req.params.id);
    const source = webhooksDb.getSourceById(id);
    if (!source) {
      throw new AppError('Webhook source not found', {
        code: 'WEBHOOK_NOT_FOUND',
        statusCode: 404,
      });
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    const deliveries = webhooksDb.listDeliveries(id, limit);
    res.json({ success: true, deliveries });
  }),
);

/** Fire a sample payload for the authenticated UI user (no external API key). */
router.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const id = paramId(req.params.id);
    const source = webhooksDb.getSourceById(id);
    if (!source) {
      throw new AppError('Webhook source not found', {
        code: 'WEBHOOK_NOT_FOUND',
        statusCode: 404,
      });
    }
    if (!source.enabled) {
      throw new AppError('Webhook source is disabled', {
        code: 'WEBHOOK_DISABLED',
        statusCode: 400,
      });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const text =
      typeof body.text === 'string' && body.text.trim()
        ? body.text
        : 'Test webhook delivery from CloudCLI Settings.';
    const title = typeof body.title === 'string' ? body.title : 'Webhook test';

    const started = await startWebhookDelivery({
      source,
      payload: {
        source: source.source,
        text,
        title,
        payload: {},
        meta: { test: true },
        raw: { text, title, test: true },
      },
    });

    res.status(202).json({
      success: true,
      deliveryId: started.deliveryId,
      appSessionId: started.appSessionId,
      source: started.source,
      status: 'accepted',
    });
  }),
);

export default router;
