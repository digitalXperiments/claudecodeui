/**
 * Channel HTTP surface.
 *  - `botActionsPublicRouter`: mount WITHOUT auth at /api/bot-actions. The signed token is the capability.
 *  - `botChannelsRouter` and `botThreadRouter`: mount behind authenticateToken at /api/bots.
 */

import express from 'express';

import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { botOutboundLogDb } from '@/modules/bots/channels/bot-outbound-log.repository.js';
import { generateBrief, sendBrief } from '@/modules/bots/channels/brief.service.js';
import { channelsService } from '@/modules/bots/channels/channels.service.js';
import { deliverOnChannel } from '@/modules/bots/channels/notify.service.js';
import { describeActionBaseUrl, verifyActionToken } from '@/modules/bots/channels/signed-links.js';
import { thread } from '@/modules/bots/channels/thread.service.js';

const param = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));
const queryText = (value: unknown): string => (typeof value === 'string' ? value : '');

// ---- public signed action links -----------------------------------------------------

export const botActionsPublicRouter = express.Router();

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;margin:0;padding:24px;background:#f6f6f7;color:#1b1b1f}main{max-width:480px;margin:10vh auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.12)}h1{font-size:1.2rem;margin:0 0 8px}pre{white-space:pre-wrap;word-break:break-word;background:#f0f0f2;border-radius:8px;padding:12px;font:13px ui-monospace,monospace}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#2f6feb;color:#fff;cursor:pointer}button.destructive{background:#d1242f}button.secondary{background:#57606a}.muted{color:#57606a}</style></head><body><main>${inner}</main></body></html>`;
}

function sendPage(res: express.Response, status: number, title: string, inner: string): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    })
    .send(page(title, inner));
}

const FAILURE_COPY: Record<string, { status: number; text: string }> = {
  malformed: { status: 400, text: 'This link is not valid.' },
  bad_signature: { status: 400, text: 'This link is not valid.' },
  expired: { status: 410, text: 'This link has expired.' },
  used: { status: 410, text: 'This request was already answered.' },
  missing: { status: 404, text: 'This request no longer exists.' },
  unknown_action: { status: 400, text: 'This link is not valid.' },
};

// GET has no side effects: link unfurlers and security scanners prefetch URLs.
botActionsPublicRouter.get('/:token', (req, res) => {
  const verdict = verifyActionToken(param(req.params.token));
  if (!verdict.ok) {
    const failure = FAILURE_COPY[verdict.reason] ?? FAILURE_COPY.malformed;
    sendPage(res, failure.status, 'Bot action', `<h1>Bot action</h1><p class="muted">${escapeHtml(failure.text)}</p>`);
    return;
  }
  const { interrupt, payload } = verdict;
  const action = interrupt.actions.find((candidate) => candidate.id === payload.actionKey)!;
  sendPage(
    res,
    200,
    interrupt.title,
    `<h1>${escapeHtml(interrupt.title)}</h1><pre>${escapeHtml(interrupt.body)}</pre>` +
      `<form method="post" action=""><button type="submit" class="${escapeHtml(action.style ?? '')}">${escapeHtml(action.label)}</button></form>`,
  );
});

botActionsPublicRouter.post('/:token', (req, res) => {
  const verdict = verifyActionToken(param(req.params.token));
  if (!verdict.ok) {
    const failure = FAILURE_COPY[verdict.reason] ?? FAILURE_COPY.malformed;
    sendPage(res, failure.status, 'Bot action', `<h1>Bot action</h1><p class="muted">${escapeHtml(failure.text)}</p>`);
    return;
  }
  const { interrupt, payload } = verdict;
  try {
    interruptsService.act(payload.interruptId, { key: payload.actionKey, actor: 'channel' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The action could not be applied.';
    sendPage(res, 409, 'Bot action', `<h1>Not applied</h1><p class="muted">${escapeHtml(message)}</p>`);
    return;
  }
  const action = interrupt.actions.find((candidate) => candidate.id === payload.actionKey);
  sendPage(res, 200, 'Done', `<h1>Done</h1><p>${escapeHtml(action?.label ?? payload.actionKey)}: ${escapeHtml(interrupt.title)}</p>`);
});

// ---- authenticated: channels + brief ------------------------------------------------

export const botChannelsRouter = express.Router();

botChannelsRouter.get('/channels', (req, res) => {
  const botId = queryText(req.query.botId);
  if (botId && !missionControlDb.getSection(botId)) {
    throw new AppError(`Bot not found: ${botId}`, { code: 'BOT_NOT_FOUND', statusCode: 404 });
  }
  res.json({
    channels: botId ? channelsService.list(botId) : channelsService.list(null),
    ...(botId ? { effective: channelsService.listEffective(botId) } : {}),
    // Where approval links point, so the Channels page can say why a phone cannot open them.
    public_base_url: describeActionBaseUrl(),
  });
});

botChannelsRouter.post('/channels', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.kind !== 'string') throw new AppError('kind is required', { code: 'BOT_CHANNEL_INVALID', statusCode: 400 });
  const channel = channelsService.create({
    botId: typeof body.botId === 'string' && body.botId ? body.botId : null,
    kind: body.kind,
    config: body.config,
    policy: body.policy,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  });
  res.status(201).json({ channel });
});

botChannelsRouter.patch('/channels/:id', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const channel = channelsService.update(param(req.params.id), {
    config: body.config,
    policy: body.policy,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  });
  res.json({ channel });
});

botChannelsRouter.delete('/channels/:id', (req, res) => {
  if (!channelsService.remove(param(req.params.id))) {
    throw new AppError('Channel not found', { code: 'BOT_CHANNEL_NOT_FOUND', statusCode: 404 });
  }
  res.json({ success: true });
});

botChannelsRouter.post(
  '/channels/:id/test',
  asyncHandler(async (req, res) => {
    const channel = channelsService.get(param(req.params.id));
    if (!channel) throw new AppError('Channel not found', { code: 'BOT_CHANNEL_NOT_FOUND', statusCode: 404 });
    const result = await deliverOnChannel(
      channel,
      { botId: channel.bot_id, title: 'CloudCLI test message', body: 'If you can read this, the channel works.', urgency: 0.5 },
      'test',
    );
    res.status(result.ok ? 200 : 502).json({ success: result.ok, ...(result.detail ? { detail: result.detail } : {}) });
  }),
);

botChannelsRouter.get('/outbound-log', (req, res) => {
  const botId = queryText(req.query.botId);
  res.json({ entries: botOutboundLogDb.listRecent(botId || null, Math.min(500, Number(req.query.limit) || 100)) });
});

botChannelsRouter.get('/brief', (req, res) => {
  res.json({ brief: generateBrief({ since: queryText(req.query.since) || undefined }) });
});

botChannelsRouter.post(
  '/brief/send',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(await sendBrief({ since: typeof body.since === 'string' ? body.since : undefined }));
  }),
);

// ---- authenticated: thread ----------------------------------------------------------

export const botThreadRouter = express.Router();

function requireBot(botId: string): void {
  if (!missionControlDb.getSection(botId)) {
    throw new AppError(`Bot not found: ${botId}`, { code: 'BOT_NOT_FOUND', statusCode: 404 });
  }
}

botThreadRouter.get('/:botId/thread', (req, res) => {
  const botId = param(req.params.botId);
  requireBot(botId);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json({ messages: thread.list(botId, { limit, before: queryText(req.query.before) || undefined }) });
});

botThreadRouter.post('/:botId/thread', (req, res) => {
  const botId = param(req.params.botId);
  requireBot(botId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  res.status(201).json({ message: thread.postOperatorMessage(botId, body.body, 'inapp') });
});
