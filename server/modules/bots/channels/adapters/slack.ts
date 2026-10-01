/**
 * Slack: chat.postMessage with a bot token, or an incoming webhook. Buttons are URL buttons (signed
 * links) and only go out when the links are reachable (public https). Otherwise the message is sent
 * WITHOUT buttons plus a line "Open CloudCLI to approve"; a failed send with buttons is retried once
 * without them, so a message is never dropped.
 */

import {
  checkBaseUrl,
  checkKeys,
  checkSecretRef,
  isPublicHttpsUrl,
  OPEN_CLOUDCLI_LINE,
  truncate,
  type AdapterContext,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from '@/modules/bots/channels/adapters/types.js';

/** URL buttons only work when the signed links can be opened from the device reading the message. */
export const slackCanShowButtons = (message: OutboundMessage): boolean =>
  message.actions.length > 0 && message.actions.every((action) => isPublicHttpsUrl(action.url));

export function buildSlackPayload(message: OutboundMessage, buttons: boolean = slackCanShowButtons(message)): { text: string; blocks: unknown[] } {
  const buttonless = message.actions.length > 0 && !buttons;
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: truncate(message.title, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(message.body, 2900) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${message.botTitle}${message.urgency >= 0.8 ? ' · urgent' : ''}${buttonless ? ` · ${OPEN_CLOUDCLI_LINE}` : ''}` }] },
  ];
  if (buttons && message.actions.length > 0) {
    blocks.push({
      type: 'actions',
      elements: message.actions.slice(0, 5).map((action) => ({
        type: 'button',
        text: { type: 'plain_text', text: truncate(action.label, 70) },
        url: action.url,
        ...(action.style === 'primary' ? { style: 'primary' } : action.style === 'destructive' ? { style: 'danger' } : {}),
      })),
    });
  }
  return { text: `${message.title}: ${truncate(message.body, 300)}${buttonless ? ` (${OPEN_CLOUDCLI_LINE})` : ''}`, blocks };
}

async function postJson(ctx: AdapterContext, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return ctx.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(payload),
  });
}

export const slackAdapter: ChannelAdapter = {
  kind: 'slack',
  validateConfig(config) {
    const error =
      checkKeys(config, ['token_ref', 'channel_id', 'webhook_url_ref', 'action_base_url'])
      ?? checkSecretRef(config, 'token_ref', false)
      ?? checkSecretRef(config, 'webhook_url_ref', false)
      ?? checkBaseUrl(config);
    if (error) return error;
    const hasBot = Boolean(config.token_ref) && typeof config.channel_id === 'string' && config.channel_id.trim() !== '';
    if (!hasBot && !config.webhook_url_ref) return 'slack needs token_ref + channel_id, or webhook_url_ref';
    return null;
  },
  async send(channel, message, ctx): Promise<SendResult> {
    const attempt = async (buttons: boolean): Promise<SendResult> => {
      try {
        return await sendOnce(channel.config, buildSlackPayload(message, buttons), ctx);
      } catch (error) {
        return { ok: false, detail: `slack error: ${error instanceof Error ? error.message : String(error)}` };
      }
    };
    const withButtons = slackCanShowButtons(message);
    const first = await attempt(withButtons);
    if (first.ok || !withButtons) return first;
    const retry = await attempt(false);
    return retry.ok ? { ok: true, detail: `sent without buttons after: ${first.detail}` } : { ok: false, detail: `${first.detail}; retry without buttons: ${retry.detail}` };
  },
};

async function sendOnce(config: Record<string, unknown>, payload: { text: string; blocks: unknown[] }, ctx: AdapterContext): Promise<SendResult> {
  if (config.webhook_url_ref) {
    const url = ctx.resolveSecret(String(config.webhook_url_ref));
    const response = await postJson(ctx, url, payload);
    return response.ok ? { ok: true } : { ok: false, detail: `slack webhook http ${response.status}` };
  }
  const token = ctx.resolveSecret(String(config.token_ref));
  const response = await postJson(
    ctx,
    'https://slack.com/api/chat.postMessage',
    { channel: String(config.channel_id), ...payload },
    { Authorization: `Bearer ${token}` },
  );
  if (!response.ok) return { ok: false, detail: `slack http ${response.status}` };
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return body.ok ? { ok: true } : { ok: false, detail: `slack error: ${body.error ?? 'unknown'}` };
}
