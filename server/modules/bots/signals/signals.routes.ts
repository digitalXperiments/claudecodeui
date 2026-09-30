/**
 * Bot signal HTTP surface.
 *  - `botHooksPublicRouter`: mount WITHOUT auth at /api/hooks/bots. Authenticated by HMAC.
 *  - `botTriggersRouter`: mount behind authenticateToken at /api/bots.
 */

import express from 'express';

import { secretsService } from '@/modules/secrets/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { firstHeader, verifyWebhookSignature } from '@/modules/webhooks/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import type { BotTrigger } from '@/modules/bots/bots.types.js';
import { botTriggersDb } from '@/modules/bots/signals/bot-triggers.repository.js';
import { compileNaturalSchedule } from '@/modules/bots/signals/nl-schedule.js';
import { botSignals } from '@/modules/bots/signals/signals.service.js';
import { botTriggers } from '@/modules/bots/signals/triggers.service.js';

export const MAX_HOOK_BODY_BYTES = 1024 * 1024;
const PAYLOAD_TEXT_CAP = 20_000;

const param = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));

// ---- public per-bot webhook -------------------------------------------------

export const botHooksPublicRouter = express.Router();

/**
 * Works whether mounted before or after the global JSON parser: the global
 * parser stashes `req.rawBody`; otherwise `express.raw` supplies a Buffer body.
 */
botHooksPublicRouter.post(
  '/:triggerId',
  express.raw({ type: () => true, limit: MAX_HOOK_BODY_BYTES }),
  asyncHandler(async (req, res) => {
    const triggerId = param(req.params.triggerId);
    const trigger = botTriggersDb.get(triggerId);
    // Identical response for unknown / disabled / wrong-kind triggers: no enumeration.
    if (!trigger || trigger.kind !== 'webhook' || !trigger.enabled) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const withRaw = req as express.Request & { rawBody?: Buffer };
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : (withRaw.rawBody ?? Buffer.alloc(0));
    if (raw.length > MAX_HOOK_BODY_BYTES) {
      res.status(413).json({ error: 'Payload too large (max 1MB)' });
      return;
    }

    let secret: string;
    try {
      secret = secretsService.resolve(String(trigger.config.secret_ref ?? ''));
    } catch {
      res.status(503).json({ error: 'Webhook secret is not available' });
      return;
    }
    if (!verifyWebhookSignature(secret, raw, firstHeader(req, 'x-webhook-signature'))) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const text = raw.toString('utf8');
    let body: unknown = text.length > PAYLOAD_TEXT_CAP ? `${text.slice(0, PAYLOAD_TEXT_CAP)}…` : text;
    if (text.length <= PAYLOAD_TEXT_CAP) {
      try {
        body = JSON.parse(text);
      } catch {
        // keep as text
      }
    }
    const deliveryId =
      firstHeader(req, 'x-webhook-id') || firstHeader(req, 'x-github-delivery') || firstHeader(req, 'x-delivery-id');
    const { event, duplicate } = botSignals.ingest({
      botId: trigger.bot_id,
      triggerId: trigger.trigger_id,
      source: 'webhook',
      kind: 'webhook',
      dedupeKey: deliveryId ? `hook:${trigger.trigger_id}:${deliveryId}` : undefined,
      trust: 'external',
      payload: {
        body,
        content_type: firstHeader(req, 'content-type') || null,
        webhook_event: firstHeader(req, 'x-github-event') || firstHeader(req, 'x-webhook-event') || null,
      },
    });
    res.status(202).json({ ok: true, event_id: event.event_id, duplicate });
  }),
);

// ---- authenticated trigger management ---------------------------------------

export const botTriggersRouter = express.Router();

function requireBot(botId: string): void {
  if (!missionControlDb.getSection(botId)) {
    throw new AppError(`Bot not found: ${botId}`, { code: 'BOT_NOT_FOUND', statusCode: 404 });
  }
}

function requireTrigger(botId: string, triggerId: string): BotTrigger {
  requireBot(botId);
  const trigger = botTriggersDb.get(triggerId);
  if (!trigger || trigger.bot_id !== botId) {
    throw new AppError(`Trigger not found: ${triggerId}`, { code: 'BOT_TRIGGER_NOT_FOUND', statusCode: 404 });
  }
  return trigger;
}

/** Declared before `/:botId/...` routes so the literal path is never read as a bot id. */
botTriggersRouter.post('/triggers/compile-schedule', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = compileNaturalSchedule(
    typeof body.text === 'string' ? body.text : '',
    typeof body.timezone === 'string' ? body.timezone : undefined,
  );
  if ('error' in result) {
    res.status(400).json({ success: false, error: result.error });
    return;
  }
  res.json({ success: true, ...result });
});

botTriggersRouter.get(
  '/:botId/triggers',
  asyncHandler(async (req, res) => {
    const botId = param(req.params.botId);
    requireBot(botId);
    res.json({ triggers: botTriggers.list(botId) });
  }),
);

botTriggersRouter.post(
  '/:botId/triggers',
  asyncHandler(async (req, res) => {
    const botId = param(req.params.botId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.kind !== 'string') throw new AppError('kind is required', { code: 'BOT_TRIGGER_INVALID', statusCode: 400 });
    const trigger = botTriggers.create({
      botId,
      kind: body.kind,
      config: body.config as Record<string, unknown> | undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });
    res.status(201).json({ trigger });
  }),
);

botTriggersRouter.patch(
  '/:botId/triggers/:id',
  asyncHandler(async (req, res) => {
    const botId = param(req.params.botId);
    const trigger = requireTrigger(botId, param(req.params.id));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = botTriggers.update(trigger.trigger_id, {
      config: body.config as Record<string, unknown> | undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    });
    res.json({ trigger: updated });
  }),
);

botTriggersRouter.delete(
  '/:botId/triggers/:id',
  asyncHandler(async (req, res) => {
    const trigger = requireTrigger(param(req.params.botId), param(req.params.id));
    botTriggers.delete(trigger.trigger_id);
    res.json({ ok: true });
  }),
);

/** Fires a clearly-labelled sample event through the real ingest path (the bot will wake). */
botTriggersRouter.post(
  '/:botId/triggers/:id/test',
  asyncHandler(async (req, res) => {
    const trigger = requireTrigger(param(req.params.botId), param(req.params.id));
    const scheduled = ['cron', 'interval', 'nl_schedule'].includes(trigger.kind);
    const { event } = botSignals.ingest({
      botId: trigger.bot_id,
      triggerId: trigger.trigger_id,
      source: `trigger:${trigger.kind}`,
      kind: scheduled ? 'schedule' : trigger.kind,
      trust: 'internal',
      payload: { sample: true, trigger_kind: trigger.kind, fired_at: new Date().toISOString() },
    });
    res.status(202).json({ event });
  }),
);

botTriggersRouter.get(
  '/:botId/events',
  asyncHandler(async (req, res) => {
    const botId = param(req.params.botId);
    requireBot(botId);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ events: botSignals.listRecent(botId, limit) });
  }),
);

/** Operator manual wake: a trust=operator `manual` event. */
botTriggersRouter.post(
  '/:botId/wake',
  asyncHandler(async (req, res) => {
    const botId = param(req.params.botId);
    requireBot(botId);
    const note = typeof (req.body as Record<string, unknown> | undefined)?.note === 'string'
      ? String((req.body as Record<string, unknown>).note).slice(0, 4000)
      : '';
    const { event } = botSignals.ingest({
      botId,
      source: 'operator',
      kind: 'manual',
      trust: 'operator',
      payload: { note },
    });
    res.status(202).json({ event });
  }),
);
