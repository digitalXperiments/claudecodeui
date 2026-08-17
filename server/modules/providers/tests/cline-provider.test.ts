import assert from 'node:assert/strict';
import test from 'node:test';

import { CLINE_FALLBACK_MODELS } from '@/modules/providers/list/cline/cline-models.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';

test('Cline is registered as an ACP-backed provider', () => {
  const provider = providerRegistry.resolveProvider('cline');

  assert.equal(provider.id, 'cline');
  assert.ok(provider.models);
  assert.ok(provider.mcp);
  assert.ok(provider.auth);
  assert.ok(provider.skills);
  assert.ok(provider.sessions);
  assert.ok(provider.sessionSynchronizer);
});

test('Cline keeps a usable offline model fallback', () => {
  assert.equal(CLINE_FALLBACK_MODELS.DEFAULT, 'anthropic/claude-sonnet-4.6');
  assert.ok(CLINE_FALLBACK_MODELS.OPTIONS.length > 0);
});

test('Cline ACP messages are normalized with the Cline provider identity', () => {
  const provider = providerRegistry.resolveProvider('cline');
  const messages = provider.sessions.normalizeMessage({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello from cline' },
  }, 'cline-session');

  assert.equal(messages[0]?.provider, 'cline');
  assert.equal(messages[0]?.kind, 'stream_delta');
  assert.equal(messages[0]?.content, 'hello from cline');
});
