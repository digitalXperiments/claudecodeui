import assert from 'node:assert/strict';
import test from 'node:test';

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];

(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0,
};
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const { createSetupApi } = await import('./setupPlan');

test('every setup call hits the documented endpoint for the new bot', async () => {
  let enabled: string | null = null;
  const api = createSetupApi({ enableBot: async (id) => { enabled = id; } });
  await api.createTrigger('b 1', { kind: 'webhook', config: { secret_ref: 'S' }, enabled: true });
  await api.createGoal('b 1', { statement: 'Ship', sort_order: 0 });
  await api.createRule('b 1', { scope: 'bot', decision: 'allow', match: { tool: 'reply' } });
  await api.putBudget('b 1', { daily_usd: 5 });
  await api.setPerceive('b 1', { provider: 'claude', model: 'haiku' });
  await api.setFallback('b 1', [{ provider: 'codex' }]);
  await api.setLearning('b 1', 0.9);
  await api.createChannel('b 1', { kind: 'slack', config: {}, policy: {}, enabled: false });
  await api.enableBot('b 1');
  assert.deepEqual(calls, [
    { url: '/api/bots/b%201/triggers', method: 'POST', body: { kind: 'webhook', config: { secret_ref: 'S' }, enabled: true } },
    { url: '/api/bots/b%201/goals', method: 'POST', body: { statement: 'Ship', sort_order: 0 } },
    { url: '/api/bots/rules', method: 'POST', body: { scope: 'bot', decision: 'allow', match: { tool: 'reply' }, botId: 'b 1' } },
    { url: '/api/bots/b%201/budget', method: 'PUT', body: { daily_usd: 5 } },
    { url: '/api/bots/b%201/runtime', method: 'PATCH', body: { routing: { perceive: { provider: 'claude', model: 'haiku' } } } },
    { url: '/api/bots/b%201/routing/fallback', method: 'PUT', body: { fallback: [{ provider: 'codex' }] } },
    { url: '/api/bots/b%201/runtime', method: 'PATCH', body: { learning: { auto_promote_memory_min_confidence: 0.9 } } },
    { url: '/api/bots/channels', method: 'POST', body: { kind: 'slack', config: {}, policy: {}, enabled: false, botId: 'b 1' } },
  ]);
  assert.equal(enabled, 'b 1');
});
