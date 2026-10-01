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

const { BotApiError, botRuntimeApi, buildQuery, errorMessageFromPayload } = await import('./botRuntimeApi');

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

test('exec credentials list as server/key entries and write per server + key', async () => {
  const entry = { server: 'JIRA', key: 'JIRA_TOKEN', name: 'JIRA__JIRA_TOKEN', updated_at: 't', last_used_at: null };
  reset(() => ({ body: { credentials: [entry] } }));
  assert.deepEqual(await botRuntimeApi.exec.listCredentials('b1'), [entry]);
  reset(() => ({ body: {} }));
  assert.deepEqual(await botRuntimeApi.exec.listCredentials('b1'), []);

  reset(() => ({ body: { credential: entry } }));
  assert.deepEqual(await botRuntimeApi.exec.setCredential('b1', 'jira cloud', 'x-api-key', 's3cret'), entry);
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/credentials/jira%20cloud/x-api-key', method: 'PUT', body: { value: 's3cret' } });
  reset(() => ({ body: { deleted: true } }));
  await botRuntimeApi.exec.removeCredential('b1', 'jira', 'JIRA_TOKEN');
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/credentials/jira/JIRA_TOKEN', method: 'DELETE', body: undefined });
});

test('exec teach endpoints unwrap the { teach } envelope', async () => {
  reset(() => ({ body: { active: null } }));
  assert.equal(await botRuntimeApi.exec.teachStatus('b1'), null);
  assert.equal(calls.at(-1)?.url, '/api/bots/b1/teach');
  reset(() => ({ body: { teach: { sessionId: 's1', startedAt: 't', startUrl: null, profile: 'bot', note: 'n' } } }));
  assert.equal((await botRuntimeApi.exec.startTeach('b1', { url: 'https://example.com', useBotProfile: true })).sessionId, 's1');
  assert.deepEqual(calls.at(-1)?.body, { url: 'https://example.com', useBotProfile: true });
  reset(() => ({ body: { teach: { skill: { name: 'x', enabled: false, origin: 'teach' }, name: 'x', content: '', steps: [], inputs: [], captured: { actions: 0, skipped: 0 }, capturedKinds: [] } } }));
  assert.equal((await botRuntimeApi.exec.stopTeach('b1', { dryRun: true })).skill?.name, 'x');
  assert.equal(calls.at(-1)?.url, '/api/bots/b1/teach/stop');
});

test('exec host unwraps and the failover chain round-trips', async () => {
  reset(() => ({ body: { host: { platform: 'darwin', sleepPrevented: null, publicUrlConfigured: false, uptime: 1, hostUptime: 2 } } }));
  assert.equal((await botRuntimeApi.exec.host()).sleepPrevented, null);
  assert.equal(calls.at(-1)?.url, '/api/bots/runtime/host');
  reset(() => ({ body: { fallback: [{ provider: 'codex' }] } }));
  assert.deepEqual(await botRuntimeApi.exec.getFallback('b1'), [{ provider: 'codex' }]);
  assert.equal(calls.at(-1)?.url, '/api/bots/b1/routing/fallback');
  assert.deepEqual(await botRuntimeApi.exec.setFallback('b1', [{ provider: 'codex', model: 'm' }]), [{ provider: 'codex' }]);
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/routing/fallback', method: 'PUT', body: { fallback: [{ provider: 'codex', model: 'm' }] } });
});

test('enforcement preview needs no bot and unwraps the envelope', async () => {
  reset(() => ({ body: { enforcement: { provider: 'codex', level: 'advisory', detail: 'd', builtin_tool_gate: false } } }));
  assert.equal((await botRuntimeApi.runtime.enforcementPreview('codex')).level, 'advisory');
  assert.deepEqual(calls.at(-1), { url: '/api/bots/enforcement/preview?provider=codex', method: 'GET', body: undefined });
});

test('enforcement preview can ask about an autonomy, and setAutonomy patches the runtime config', async () => {
  reset(() => ({ body: { enforcement: { provider: 'claude', level: 'off', detail: 'no gate', builtin_tool_gate: true } } }));
  assert.equal((await botRuntimeApi.runtime.enforcementPreview('claude', 'bypass')).level, 'off');
  assert.equal(calls.at(-1)?.url, '/api/bots/enforcement/preview?provider=claude&autonomy=bypass');
  reset(() => ({ body: { runtime: { autonomy: 'auto' } } }));
  assert.equal((await botRuntimeApi.runtime.setAutonomy('b 1', 'auto')).autonomy, 'auto');
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b%201/runtime', method: 'PATCH', body: { autonomy: 'auto' } });
});

test('abilities unwraps a wrapped or a bare payload', async () => {
  const abilities = { autonomy: 'ask', provider: 'claude', enforcement: { level: 'enforced' }, apps: [], plain: { canDoAlone: [], asksFirst: [], neverDoes: [] }, skills_count: 0, spaces_count: 0, credentials: [], browser: { profile_exists: false } };
  reset(() => ({ body: abilities }));
  assert.equal((await botRuntimeApi.abilities.get('b1')).autonomy, 'ask');
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/abilities', method: 'GET', body: undefined });
  reset(() => ({ body: { abilities } }));
  assert.equal((await botRuntimeApi.abilities.get('b1')).provider, 'claude');
});

test('browser sign-in hits the documented paths and a 409 keeps its status for friendly wording', async () => {
  reset(() => ({ body: { sessionId: 's/1', viewHint: '/browser' } }));
  const result = await botRuntimeApi.browser.signIn('b1', 'https://mail.example.com/');
  assert.equal(result.sessionId, 's/1');
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/browser/sign-in', method: 'POST', body: { url: 'https://mail.example.com/' } });
  reset();
  await botRuntimeApi.browser.finishSignIn('b1', 's/1');
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/browser/sign-in/s%2F1/finish', method: 'POST', body: {} });
  reset(() => ({ body: { browser: { profile_exists: true, size_bytes: 10 } } }));
  assert.equal((await botRuntimeApi.browser.status('b1')).profile_exists, true);
  reset();
  await botRuntimeApi.browser.signOutEverywhere('b1');
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/browser', method: 'DELETE', body: undefined });
  reset(() => ({ status: 409, body: { success: false, error: { code: 'BUSY', message: 'bot is running' } } }));
  await assert.rejects(() => botRuntimeApi.browser.signIn('b1', 'https://a.b'), (error: unknown) => error instanceof BotApiError && error.status === 409 && /bot is running/.test(error.message));
});

test('extendSignIn posts to the extend path; changeAutonomy returns the server message and setAutonomy still returns the runtime', async () => {
  reset(() => ({ body: { extended: true, expiresAt: '2026-10-01T10:30:00.000Z', atLimit: false } }));
  const extended = await botRuntimeApi.browser.extendSignIn('b1', 's/1');
  assert.equal(extended.extended, true);
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/browser/sign-in/s%2F1/extend', method: 'POST', body: {} });
  reset(() => ({ status: 409, body: { success: false, error: { code: 'SIGNIN_EXTEND_LIMIT', message: 'limit' } } }));
  await assert.rejects(() => botRuntimeApi.browser.extendSignIn('b1', 's1'), (error: unknown) => error instanceof BotApiError && error.status === 409);

  reset(() => ({ body: { runtime: { autonomy: 'ask' }, applied: 'now', stopped_run: true, message: 'Saved. Stopped.' } }));
  const change = await botRuntimeApi.runtime.changeAutonomy('b1', 'ask');
  assert.deepEqual([change.applied, change.stopped_run, change.message], ['now', true, 'Saved. Stopped.']);
  assert.deepEqual(calls.at(-1), { url: '/api/bots/b1/runtime', method: 'PATCH', body: { autonomy: 'ask' } });
  assert.equal((await botRuntimeApi.runtime.setAutonomy('b1', 'ask')).autonomy, 'ask');
});
