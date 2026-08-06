import express from 'express';

import { apiKeysDb, userDb } from '@/modules/database/index.js';
import { IS_PLATFORM } from '@/constants/config.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { webhooksDb } from '@/modules/webhooks/webhooks.repository.js';
import { startWebhookDelivery } from '@/modules/webhooks/webhooks-runner.service.js';
import {
  extractApiKey,
  firstHeader,
  parseIngestRequest,
  verifyWebhookSignature,
  wantsWait,
} from '@/modules/webhooks/webhooks-ingest.util.js';

const router = express.Router();

/**
 * External auth for webhook ingest — same idea as /api/agent.
 */
function validateWebhookApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        res.status(500).json({ success: false, error: 'Platform mode: No user found' });
        return;
      }
      (req as express.Request & { user?: unknown }).user = user;
      next();
      return;
    } catch (error) {
      console.error('[Webhooks] platform auth error', error);
      res.status(500).json({ success: false, error: 'Platform mode: Failed to fetch user' });
      return;
    }
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    res.status(401).json({ success: false, error: 'API key required' });
    return;
  }

  const user = apiKeysDb.validateApiKey(apiKey);
  if (!user) {
    res.status(401).json({ success: false, error: 'Invalid or inactive API key' });
    return;
  }

  (req as express.Request & { user?: unknown }).user = user;
  next();
}

router.use(validateWebhookApiKey);

async function handleIngest(req: express.Request, res: express.Response): Promise<void> {
  const payload = parseIngestRequest(req);
  if (!payload.source) {
    throw new AppError('source is required (body, query, or x-webhook-source header)', {
      code: 'WEBHOOK_SOURCE_REQUIRED',
      statusCode: 400,
    });
  }

  const sourceRow = webhooksDb.getSourceBySlug(payload.source);
  if (!sourceRow) {
    throw new AppError(`Unknown webhook source: ${payload.source}`, {
      code: 'WEBHOOK_SOURCE_NOT_FOUND',
      statusCode: 404,
    });
  }

  // HMAC verification: sources with a secret require a valid signature over the
  // raw request body. Sources without a secret stay backwards compatible.
  if (sourceRow.secret && sourceRow.secret.trim()) {
    const signature = firstHeader(req, 'x-webhook-signature');
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!verifyWebhookSignature(sourceRow.secret, rawBody, signature)) {
      throw new AppError('Invalid webhook signature', {
        code: 'WEBHOOK_SIGNATURE_INVALID',
        statusCode: 401,
      });
    }
  }

  if (!sourceRow.enabled) {
    throw new AppError(`Webhook source "${payload.source}" is disabled`, {
      code: 'WEBHOOK_DISABLED',
      statusCode: 400,
    });
  }

  if (!payload.text?.trim() && (payload.payload == null || payload.payload === '')) {
    throw new AppError('text or payload is required', {
      code: 'WEBHOOK_CONTENT_REQUIRED',
      statusCode: 400,
    });
  }

  const started = await startWebhookDelivery({ source: sourceRow, payload });

  if (wantsWait(req)) {
    const outcome = await started.completion;
    res.status(outcome.success ? 200 : 500).json({
      success: outcome.success,
      deliveryId: started.deliveryId,
      appSessionId: started.appSessionId,
      source: started.source,
      status: outcome.success ? 'done' : 'failed',
      text: outcome.text.slice(0, 4000),
      error: outcome.errorMessage,
    });
    return;
  }

  res.status(202).json({
    success: true,
    deliveryId: started.deliveryId,
    appSessionId: started.appSessionId,
    source: started.source,
    status: 'accepted',
  });
}

router.post('/', asyncHandler(handleIngest));
// GET for simple tools that only support query URLs (short notes / tests).
router.get('/', asyncHandler(handleIngest));

export default router;
