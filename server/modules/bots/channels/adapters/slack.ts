/** Slack: chat.postMessage with a bot token, or an incoming webhook. Buttons are URL buttons (signed links). */

import {
  checkBaseUrl,
  checkKeys,
  checkSecretRef,
  truncate,
  type AdapterContext,
  type ChannelAdapter,
  type OutboundMessage,
  type SendResult,
} from '@/modules/bots/channels/adapters/types.js';

export function buildSlackPayload(message: OutboundMessage): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: truncate(message.title, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(message.body, 2900) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${message.botTitle}${message.urgency >= 0.8 ? ' · urgent' : ''}` }] },
  ];
  if (message.actions.length > 0) {
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
  return { text: `${message.title}: ${truncate(message.body, 300)}`, blocks };
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
    const payload = buildSlackPayload(message);
    if (channel.config.webhook_url_ref) {
      const url = ctx.resolveSecret(String(channel.config.webhook_url_ref));
      const response = await postJson(ctx, url, payload);
      return response.ok ? { ok: true } : { ok: false, detail: `slack webhook http ${response.status}` };
    }
    const token = ctx.resolveSecret(String(channel.config.token_ref));
    const response = await postJson(
      ctx,
      'https://slack.com/api/chat.postMessage',
      { channel: String(channel.config.channel_id), ...payload },
      { Authorization: `Bearer ${token}` },
    );
    if (!response.ok) return { ok: false, detail: `slack http ${response.status}` };
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return body.ok ? { ok: true } : { ok: false, detail: `slack error: ${body.error ?? 'unknown'}` };
  },
};
