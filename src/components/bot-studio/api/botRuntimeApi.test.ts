import assert from 'node:assert/strict';
import test from 'node:test';

type Call = { url: string; method: string; body: unknown };

const calls: Call[] = [];
let respond: (call: Call) => { status?: number; body: unknown } = () => ({ body: {} });

// authenticatedFetch reads localStorage and calls global fetch; stub both before loading the module.
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
};
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const call: Call = {
    url: String(url),
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  };
  calls.push(call);
  const { status = 200, body } = respond(call);
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const { botRuntimeApi, buildQuery, errorMessageFromPayload } = await import('./botRuntimeApi');

function reset(next: typeof respond = () => ({ body: {} })): void {
  calls.length = 0;
  respond = next;
}

test('buildQuery skips empty values and encodes the rest', () => {
  assert.equal(buildQuery({}), '');
  assert.equal(buildQuery({ a: undefined, b: '', c: null }), '');
  assert.equal(buildQuery({ q: 'a b&c', limit: 5, flag: false }), '?q=a+b%26c&limit=5&flag=false');
});

test('errorMessageFromPayload understands every envelope the bots routers produce', () => {
  assert.equal(errorMessageFromPayload({ success: false, error: { code: 'X', message: 'Nested' } }, 400), 'Nested');
  assert.equal(errorMessageFromPayload({ error: 'Plain' }, 400), 'Plain');
  assert.equal(errorMessageFromPayload({ message: 'Top' }, 400), 'Top');
  assert.equal(errorMessageFromPayload({}, 503), 'Request failed (503)');
  assert.equal(errorMessageFromPayload(null, 500), 'Request failed (500)');
});

test('requests hit the documented paths and unwrap the envelope keys', async () => {
  reset((call) => {
    if (call.url.endsWith('/goals')) return { body: { goals: [{ goal_id: 'g1' }] } };
    if (call.url.includes('/budget/status')) return { body: { status: { wake_allowed: true } } };
    if (call.url.endsWith('/channels?botId=b%2F1')) return { body: { channels: [], effective: [] } };
    return { body: {} };
  });
  assert.deepEqual(await botRuntimeApi.goals.list('b/1'), [{ goal_id: 'g1' }]);
  assert.equal(calls[0].url, '/api/bots/b%2F1/goals');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(await botRuntimeApi.budget.status('b1'), { wake_allowed: true });
  assert.deepEqual(await botRuntimeApi.channels.list('b/1'), { channels: [], effective: [] });
  await botRuntimeApi.goals.list('b1', 'active');
  assert.equal(calls[calls.length - 1].url, '/api/bots/b1/goals?status=active');
});

test('mutations send JSON bodies with the right verb', async () => {
  reset((call) => {
    if (call.url.endsWith('/rules')) return { body: { rule: { rule_id: 'r1' }, warnings: ['w'] } };
    return { body: { budget: { bot_id: 'b1' } } };
  });
  const created = await botRuntimeApi.gate.createRule({ decision: 'deny', match: { tool: 'x' } });
  assert.deepEqual(created, { rule: { rule_id: 'r1' }, warnings: ['w'] });
  assert.deepEqual(calls[0], { url: '/api/bots/rules', method: 'POST', body: { decision: 'deny', match: { tool: 'x' } } });
  await botRuntimeApi.budget.put('b1', { daily_usd: 5 });
  assert.deepEqual(calls[1], { url: '/api/bots/b1/budget', method: 'PUT', body: { daily_usd: 5 } });
  await botRuntimeApi.gate.deleteRule('r 1');
  assert.deepEqual(calls[2], { url: '/api/bots/rules/r%201', method: 'DELETE', body: undefined });
  await botRuntimeApi.thread.send('b1', 'hello');
  assert.deepEqual(calls[3], { url: '/api/bots/b1/thread', method: 'POST', body: { body: 'hello' } });
  await botRuntimeApi.gate.decisions('b1', { decision: 'ask', outcome: 'pending', limit: 10 });
  assert.equal(calls[4].url, '/api/bots/b1/gate-decisions?decision=ask&outcome=pending&limit=10');
  await botRuntimeApi.gate.classify('send_email', 'gmail');
  assert.equal(calls[5].url, '/api/bots/risk/classify?server=gmail&tool=send_email');
});

test('server errors surface as readable Error messages', async () => {
  reset(() => ({ status: 400, body: { success: false, error: { code: 'BOT_GATE_INVALID', message: 'A global allow rule cannot cover floor risks' } } }));
  await assert.rejects(botRuntimeApi.gate.createRule({ decision: 'allow' }), /cannot cover floor risks/);
  reset(() => ({ status: 404, body: {} }));
  await assert.rejects(botRuntimeApi.goals.list('ghost'), /Request failed \(404\)/);
});

test('channel test resolves a delivery failure instead of throwing', async () => {
  reset(() => ({ status: 502, body: { success: false, detail: 'chat not found' } }));
  assert.deepEqual(await botRuntimeApi.channels.test('c1'), { success: false, detail: 'chat not found' });
  reset(() => ({ status: 404, body: { success: false, error: { message: 'Channel not found' } } }));
  await assert.rejects(botRuntimeApi.channels.test('c1'), /Channel not found/);
});

test('provisional exec credentials tolerate string or object entries', async () => {
  reset(() => ({ body: { credentials: ['GITHUB_TOKEN', { name: 'SLACK_TOKEN' }] } }));
  assert.deepEqual(await botRuntimeApi.exec.listCredentials('b1'), [{ name: 'GITHUB_TOKEN' }, { name: 'SLACK_TOKEN' }]);
  reset(() => ({ body: {} }));
  assert.deepEqual(await botRuntimeApi.exec.listCredentials('b1'), []);
});
