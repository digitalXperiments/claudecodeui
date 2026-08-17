import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { KILO_FALLBACK_MODELS } from '@/modules/providers/list/kilo/kilo-models.provider.js';

test('Kilo Code is registered as a complete ACP-backed provider', () => {
  const provider = providerRegistry.resolveProvider('kilo');

  assert.equal(provider.id, 'kilo');
  assert.equal(provider.models !== undefined, true);
  assert.equal(provider.mcp !== undefined, true);
  assert.equal(provider.auth !== undefined, true);
  assert.equal(provider.skills !== undefined, true);
  assert.equal(provider.sessions !== undefined, true);
  assert.equal(provider.sessionSynchronizer !== undefined, true);
});

test('Kilo Code keeps an offline model fallback with provider-qualified ids', () => {
  assert.equal(KILO_FALLBACK_MODELS.DEFAULT, 'kilo/stealth/claude-sonnet-4.6');
  assert.ok(KILO_FALLBACK_MODELS.OPTIONS.some((option) => option.value.startsWith('kilo/')));
});

test('Kilo ACP messages are normalized with the Kilo provider identity', () => {
  const provider = providerRegistry.resolveProvider('kilo');
  const messages = provider.sessions.normalizeMessage({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello from kilo' },
  }, 'kilo-session');

  assert.equal(messages[0]?.provider, 'kilo');
  assert.equal(messages[0]?.kind, 'stream_delta');
  assert.equal(messages[0]?.content, 'hello from kilo');
});
