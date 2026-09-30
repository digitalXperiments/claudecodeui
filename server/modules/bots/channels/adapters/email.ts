/**
 * Email is deliberately deferred: no SMTP dependency is added. Bots that need to email the operator
 * use their own mail MCP tools (through the gateway and the Action Gate).
 */

import type { ChannelAdapter } from '@/modules/bots/channels/adapters/types.js';

export const EMAIL_DEFERRED_MESSAGE = "email channel not available yet — route email through the bot's own mail MCP tools";

export const emailAdapter: ChannelAdapter = {
  kind: 'email',
  validateConfig: () => EMAIL_DEFERRED_MESSAGE,
  async send() {
    return { ok: false, detail: EMAIL_DEFERRED_MESSAGE };
  },
};
