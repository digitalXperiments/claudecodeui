import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

import { isBotsRuntimeV2Enabled, updateAppFeatures } from '@/modules/app-features/index.js';
import { botEpisodesDb, patchBotRuntimeConfig } from '@/modules/bots/index.js';
import {
  botGatewayMcpRoutes,
  buildGatewayRunGuards,
  buildToolNameMap,
  callGatewayTool,
  createUpstreamPool,
  getBotGatewayMcpToken,
  getGatewayEnforcement,
  gatewaySessions,
  isIsolatedServer,
  isSessionTainted,
  registerBotGatewayMcp,
  unregisterBotGatewayMcp,
  listGatewayToolsForSession,
  setGatewayGate,
  setGatewayUpstreamPool,
  toExposedName,
  type GatewayCallOutcome,
  type GatewayGate,
  type GatewayGateContext,
  type GatewayGateRequest,
  type GatewayGateVerdict,
} from '@/modules/bots/gateway/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  buildRuntimeOptions,
  listBotMemories,
  MC_PROVIDERS,
  missionControlDb,
} from '@/modules/mission-control/index.js';
import { filterMcpServersForRun } from '@/shared/mcp-server-filter.js';
import { makeScratchDir } from '@/shared/scratch.js';

const SESSION = 'app-session-1';

async function withDatabase(run: (botId: string) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousHome = process.env.CLOUDCLI_BOTS_HOME;
  const scratch = await makeScratchDir('bots-gateway-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_BOTS_HOME = path.join(scratch, 'bots');
  await initializeDatabase();
  try {
    const bot = missionControlDb.createSection({ title: 'Gateway bot', produce_prompt: 'Triage the inbox' });
    await run(bot.section_id);
  } finally {
    gatewaySessions.clearForTests();
    setGatewayGate(null);
    setGatewayUpstreamPool(null);
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousHome === undefined) delete process.env.CLOUDCLI_BOTS_HOME;
    else process.env.CLOUDCLI_BOTS_HOME = previousHome;
    await rm(scratch, { recursive: true, force: true });
  }
}

interface FakeUpstream {
  calls: Array<{ server: string; tool: string; args: unknown }>;
  connects: string[];
  pool: ReturnType<typeof createUpstreamPool>;
}

/** In-process fake MCP servers (no network, no subprocess) behind the real pool. */
function createFakeUpstream(): FakeUpstream {
  const calls: FakeUpstream['calls'] = [];
  const connects: string[] = [];
  const toolsByServer: Record<string, Array<Record<string, unknown>>> = {
    mail: [
      { name: 'search_inbox', description: 'Search mail', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'send_email', description: 'Send mail', inputSchema: { type: 'object' } },
    ],
    'wiki.site': [
      { name: 'get page/1', description: 'Read a page', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    ],
    hidden: [{ name: 'secret_tool', description: 'Not bound', inputSchema: { type: 'object' } }],
  };
  const pool = createUpstreamPool({
    resolver: async (_provider, server) => (server in toolsByServer ? { name: server, transport: 'stdio', command: 'fake' } : null),
    connector: async (connection) => {
      connects.push(connection.name);
      const server = new Server({ name: connection.name, version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsByServer[connection.name] as never }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push({ server: connection.name, tool: request.params.name, args: request.params.arguments });
        return { content: [{ type: 'text', text: `ok:${request.params.name}` }] };
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(clientSide);
      return client;
    },
  });
  return { calls, connects, pool };
}

interface FakeGate extends GatewayGate {
  evaluated: Array<{ ctx: GatewayGateContext; req: GatewayGateRequest }>;
  outcomes: Array<{ decisionId: string; outcome: GatewayCallOutcome }>;
  humanAnswer: 'approved' | 'rejected' | 'expired';
  humanAsked: string[];
  /** Runs while the operator 'deliberates' (tests end the run here). */
  duringHuman?: () => void;
  verdicts: Record<string, Partial<GatewayGateVerdict>>;
}

function createFakeGate(): FakeGate {
  const gate: FakeGate = {
    evaluated: [],
    outcomes: [],
    humanAsked: [],
    humanAnswer: 'approved',
    verdicts: {},
    async evaluate(ctx, req) {
      gate.evaluated.push({ ctx: { ...ctx }, req });
      const override = gate.verdicts[req.tool] ?? {};
      return {
        decision: 'allow',
        decidedBy: 'fake',
        reason: 'fake gate',
        risk: req.annotations?.readOnlyHint ? 'read' : 'send',
        decisionId: `d${gate.evaluated.length}`,
        ...override,
      };
    },
    async awaitHuman(decisionId) {
      gate.humanAsked.push(decisionId);
      gate.duringHuman?.();
      return gate.humanAnswer;
    },
    recordOutcome(decisionId, outcome) {
      gate.outcomes.push({ decisionId, outcome });
    },
  };
  return gate;
}

const resultText = (result: { content: Array<Record<string, unknown>> }): string => String(result.content[0]?.text ?? '');

test('tool naming round-trips through the reverse map, sanitizes and caps at 64 chars', () => {
  assert.equal(toExposedName('mail', 'search_inbox'), 'mail__search_inbox');
  assert.equal(toExposedName('wiki.site', 'get page/1'), 'wiki_site__get_page_1');
  const longTool = 'x'.repeat(120);
  assert.ok(toExposedName('mail', longTool).length <= 64);

  const entries = [
    { server: 'mail', tool: 'search_inbox' },
    { server: 'wiki.site', tool: 'get page/1' },
    { server: 'wiki_site', tool: 'get_page_1' }, // sanitizes to the same exposed name as the previous entry
    { server: 'mail', tool: longTool },
    { server: 'bot', tool: 'remember' }, // must never shadow the first-party prefix
  ];
  const map = buildToolNameMap(entries);
  const exposed = new Set<string>();
  for (const entry of entries) {
    const name = map.exposedName(entry.server, entry.tool);
    assert.ok(name && /^[a-zA-Z0-9_-]{1,64}$/.test(name), `valid name for ${entry.server}/${entry.tool}`);
    assert.deepEqual(map.resolve(name), entry);
    exposed.add(name);
  }
  assert.equal(exposed.size, entries.length);
  assert.ok(!map.exposedName('bot', 'remember')!.startsWith('bot__'));
});

test('tools/list exposes only the bound servers plus first-party tools', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    setGatewayUpstreamPool(upstream.pool);
    gatewaySessions.bind(SESSION, { botId, servers: ['mail', 'wiki.site'], provider: 'claude' });

    const names = (await listGatewayToolsForSession(SESSION)).map((tool) => tool.name);
    assert.ok(names.includes('mail__search_inbox'));
    assert.ok(names.includes('mail__send_email'));
    assert.ok(names.includes('wiki_site__get_page_1'));
    assert.ok(names.includes('bot__remember'));
    assert.ok(names.includes('bot__notify_operator'));
    assert.ok(!names.some((name) => name.startsWith('hidden__')));
    assert.ok(!upstream.connects.includes('hidden'));

    assert.deepEqual(await listGatewayToolsForSession('no-such-session'), []);
    await upstream.pool.closeAll();
  });
});

test('deny never reaches the upstream server', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    const gate = createFakeGate();
    gate.verdicts.send_email = { decision: 'deny', reason: 'sending is forbidden', risk: 'send' };
    setGatewayUpstreamPool(upstream.pool);
    setGatewayGate(gate);
    gatewaySessions.bind(SESSION, { botId, servers: ['mail'], provider: 'claude' });

    const result = await callGatewayTool(SESSION, 'mail__send_email', { to: 'a@b.c' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /sending is forbidden/);
    assert.equal(upstream.calls.length, 0);
    assert.equal(gate.evaluated[0]?.req.server, 'mail');
    assert.equal(gate.evaluated[0]?.req.tool, 'send_email');
    assert.equal(gate.humanAsked.length, 0);
    await upstream.pool.closeAll();
  });
});

test('no gate configured fails closed', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    setGatewayUpstreamPool(upstream.pool);
    gatewaySessions.bind(SESSION, { botId, servers: ['mail'], provider: 'claude' });
    const result = await callGatewayTool(SESSION, 'mail__search_inbox', {});
    assert.equal(result.isError, true);
    assert.equal(upstream.calls.length, 0);
    await upstream.pool.closeAll();
  });
});

test('ask -> approve calls upstream and records the outcome; reject and expiry do not', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    const gate = createFakeGate();
    gate.verdicts.send_email = { decision: 'ask', reason: 'needs approval', risk: 'send' };
    setGatewayUpstreamPool(upstream.pool);
    setGatewayGate(gate);
    gatewaySessions.bind(SESSION, { botId, servers: ['mail'], provider: 'claude' });

    const approved = await callGatewayTool(SESSION, 'mail__send_email', { to: 'a@b.c' });
    assert.equal(approved.isError, undefined);
    assert.equal(resultText(approved), 'ok:send_email');
    assert.deepEqual(upstream.calls, [{ server: 'mail', tool: 'send_email', args: { to: 'a@b.c' } }]);
    assert.equal(gate.humanAsked.length, 1);
    assert.equal(gate.outcomes[0]?.outcome.ok, true);
    assert.equal(gatewaySessions.get(SESSION)?.tainted, true, 'any external result that carries content taints the run, not only reads');

    gate.humanAnswer = 'rejected';
    assert.equal((await callGatewayTool(SESSION, 'mail__send_email', {})).isError, true);
    gate.humanAnswer = 'expired';
    assert.equal((await callGatewayTool(SESSION, 'mail__send_email', {})).isError, true);
    assert.equal(upstream.calls.length, 1);
    await upstream.pool.closeAll();
  });
});

test('an allowed external read taints the session and the episode', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    const gate = createFakeGate();
    setGatewayUpstreamPool(upstream.pool);
    setGatewayGate(gate);
    const episode = botEpisodesDb.create({ botId });
    gatewaySessions.bind(SESSION, { botId, episodeId: episode.episode_id, servers: ['mail'], provider: 'claude' });
    assert.equal(botEpisodesDb.get(episode.episode_id)?.tainted, false);

    await callGatewayTool(SESSION, 'mail__search_inbox', { q: 'invoice' });
    assert.equal(gatewaySessions.get(SESSION)?.tainted, true);
    assert.equal(botEpisodesDb.get(episode.episode_id)?.tainted, true);

    // Later calls see the taint in the gate context.
    await callGatewayTool(SESSION, 'mail__send_email', {});
    assert.equal(gate.evaluated[0]?.ctx.tainted, false);
    assert.equal(gate.evaluated[1]?.ctx.tainted, true);
    assert.equal(gate.evaluated[1]?.ctx.operatorInstructions, 'Triage the inbox');
    await upstream.pool.closeAll();
  });
});

test('unknown sessions are rejected without touching the upstream', async () => {
  await withDatabase(async () => {
    const upstream = createFakeUpstream();
    const gate = createFakeGate();
    setGatewayUpstreamPool(upstream.pool);
    setGatewayGate(gate);
    const result = await callGatewayTool('ghost-session', 'mail__search_inbox', {});
    assert.equal(result.isError, true);
    assert.match(resultText(result), /not bound/);
    assert.equal(upstream.calls.length, 0);
    assert.equal(upstream.connects.length, 0);
    assert.equal(gate.evaluated.length, 0);

    gatewaySessions.bind(SESSION, { botId: 'b', servers: ['mail'], provider: 'claude' });
    gatewaySessions.unbind(SESSION);
    assert.equal((await callGatewayTool(SESSION, 'mail__search_inbox', {})).isError, true);

    gatewaySessions.bind(SESSION, { botId: 'b', servers: ['mail'], provider: 'claude' });
    assert.equal((await callGatewayTool(SESSION, 'hidden__secret_tool', {})).isError, true, 'unbound server tool');
  });
});

test('bot__remember creates a proposed memory; bot__notify_operator is a stub', async () => {
  await withDatabase(async (botId) => {
    gatewaySessions.bind(SESSION, { botId, servers: [], provider: 'claude' });
    const result = await callGatewayTool(SESSION, 'bot__remember', { content: 'Ram wants bullet-form Jira comments' });
    assert.equal(result.isError, undefined);
    const memories = listBotMemories(botId);
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.status, 'proposed');
    assert.equal(memories[0]?.content, 'Ram wants bullet-form Jira comments');

    const empty = await callGatewayTool(SESSION, 'bot__remember', { content: '  ' });
    assert.equal(empty.isError, true);

    const notify = await callGatewayTool(SESSION, 'bot__notify_operator', { title: 't', body: 'b' });
    assert.equal(notify.isError, true);
    assert.match(resultText(notify), /not configured/);
  });
});

test('route rejects bad tokens with 401 and serves list/call with the right one', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    setGatewayUpstreamPool(upstream.pool);
    setGatewayGate(createFakeGate());
    gatewaySessions.bind(SESSION, { botId, servers: ['mail'], provider: 'claude' });

    const app = express();
    app.use(express.json());
    app.use('/api/bot-gateway-mcp', botGatewayMcpRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bot-gateway-mcp`;
    const secret = gatewaySessions.get(SESSION)!.secret;
    const post = (route: string, token: string | null, body: unknown, bindingSecret: string | null = secret) => fetch(`${base}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-gateway-session-id': SESSION,
        ...(bindingSecret ? { 'x-bot-gateway-binding-secret': bindingSecret } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    try {
      assert.equal((await post('/tools/list', null, {})).status, 401);
      assert.equal((await post('/tools/list', 'wrong-token', {})).status, 401);
      assert.equal((await post('/tools/call', 'x'.repeat(200), { name: 'mail__search_inbox' })).status, 401);

      const token = getBotGatewayMcpToken();
      // M5: the per-binding secret is required on top of the shared token.
      assert.equal((await post('/tools/list', token, {}, null)).status, 401, 'missing binding secret');
      assert.equal((await post('/tools/call', token, { name: 'mail__search_inbox' }, 'not-the-secret')).status, 401, 'wrong binding secret');
      assert.equal(upstream.calls.length, 0, 'a wrong secret never reaches the upstream');
      const list = await (await post('/tools/list', token, {})).json() as { data: { tools: Array<{ name: string }> } };
      assert.ok(list.data.tools.some((tool) => tool.name === 'mail__search_inbox'));
      const call = await (await post('/tools/call', token, { name: 'mail__search_inbox', arguments: { q: 1 } })).json() as {
        data: { content: Array<{ text: string }> };
      };
      assert.equal(call.data.content[0]?.text, 'ok:search_inbox');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await upstream.pool.closeAll();
    }
  });
});

test('upstream pool caches tool lists and reuses one connection', async () => {
  const upstream = createFakeUpstream();
  await upstream.pool.listTools('claude', 'mail');
  await upstream.pool.listTools('claude', 'mail');
  await upstream.pool.callTool('claude', 'mail', 'search_inbox', {});
  assert.deepEqual(upstream.connects, ['mail']);
  assert.equal(upstream.pool.size(), 1);
  await assert.rejects(upstream.pool.listTools('claude', 'nope'), /not available through the gateway/);
  await upstream.pool.closeAll();
  assert.equal(upstream.pool.size(), 0);
});

test('buildRuntimeOptions: flag off is unchanged; flag on selects only the gateway strictly', async () => {
  await withDatabase((botId) => {
    const section = missionControlDb.getSection(botId)!;
    const tools = ['mail', 'wiki'];

    assert.equal(isBotsRuntimeV2Enabled(), false);
    const off = buildRuntimeOptions({ ...section, provider: 'claude' }, tools);
    assert.deepEqual(off.mcpServers, tools);
    assert.equal(off.strictMcpSelection, undefined);
    assert.deepEqual((off.toolsSettings as { allowedTools: string[] }).allowedTools, ['mcp__mail', 'mcp__mail__*', 'mcp__wiki', 'mcp__wiki__*']);

    updateAppFeatures({ botsRuntimeV2: true });
    const on = buildRuntimeOptions({ ...section, provider: 'claude' }, tools);
    assert.deepEqual(on.mcpServers, ['cloudcli-tool-gateway']);
    assert.equal(on.strictMcpSelection, true);
    assert.equal(on.botGatewayStrict, true);
    assert.deepEqual((on.toolsSettings as { allowedTools: string[] }).allowedTools, ['mcp__cloudcli-tool-gateway__*']);
    assert.deepEqual((on.toolsSettings as { disallowedTools: string[] }).disallowedTools, ['AskUserQuestion', 'ExitPlanMode']);

    const grok = buildRuntimeOptions({ ...section, provider: 'grok' }, tools);
    assert.deepEqual(grok.mcpServers, ['cloudcli-tool-gateway']);

    patchBotRuntimeConfig(botId, { gateway: false });
    const optedOut = buildRuntimeOptions({ ...section, provider: 'claude' }, tools);
    assert.deepEqual(optedOut.mcpServers, tools);
    assert.equal(optedOut.strictMcpSelection, undefined);
  });
});

test('claude strict MCP filter keeps only the named servers', () => {
  const loaded = {
    'cloudcli-tool-gateway': { command: 'gw' },
    'cloudcli-agent-relay': { command: 'relay' },
    mail: { command: 'mail' },
  };
  assert.equal(filterMcpServersForRun(loaded, {}), loaded, 'no strict flag: untouched');
  assert.equal(
    filterMcpServersForRun(loaded, { strictMcpSelection: true, mcpServers: ['mail'] }),
    loaded,
    'work-session strictMcpSelection alone must not narrow Claude (flag-off behaviour)',
  );
  assert.deepEqual(
    filterMcpServersForRun(loaded, { botGatewayStrict: true, mcpServers: ['cloudcli-tool-gateway'] }),
    { 'cloudcli-tool-gateway': { command: 'gw' } },
  );
  assert.equal(filterMcpServersForRun(loaded, { botGatewayStrict: true, mcpServers: ['absent'] }), null);
  assert.equal(filterMcpServersForRun(loaded, { botGatewayStrict: true }), null, 'strict with no selection loads nothing');
  assert.deepEqual(
    filterMcpServersForRun(loaded, { relayWorker: true, mcpServers: ['mail', 'cloudcli-agent-relay'] }),
    { mail: { command: 'mail' } },
  );
  assert.equal(filterMcpServersForRun(null, { botGatewayStrict: true, mcpServers: ['mail'] }), null);
});

test('every Mission Control provider has an enforcement level', () => {
  for (const provider of MC_PROVIDERS) {
    assert.ok(['enforced', 'advisory'].includes(getGatewayEnforcement(provider)), provider);
  }
  // Claude is enforced only with the built-in tool gate; everything else is advisory.
  assert.equal(getGatewayEnforcement('claude'), 'advisory');
  assert.equal(getGatewayEnforcement('claude', { builtinToolGate: false }), 'advisory');
  assert.equal(getGatewayEnforcement('claude', { builtinToolGate: true }), 'enforced');
  assert.equal(getGatewayEnforcement('opencode'), 'advisory');
  assert.equal(getGatewayEnforcement('opencode', { builtinToolGate: true }), 'advisory');
  assert.equal(getGatewayEnforcement('codex'), 'advisory');
  assert.equal(getGatewayEnforcement('not-a-provider'), 'advisory');
});

// ---------------------------------------------------------------------------
// Security review regressions (M3, M5, M6 and the low items)

test('M3(a): calls of every risk whose result carries content taint the session; empty results do not', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    const gate = createFakeGate();
    gate.verdicts.send_email = { risk: 'draft' };
    setGatewayUpstreamPool(upstream.pool);
    setGatewayGate(gate);
    gatewaySessions.bind(SESSION, { botId, servers: ['mail'], provider: 'claude' });
    assert.equal(gatewaySessions.get(SESSION)?.tainted, false);
    await callGatewayTool(SESSION, 'mail__send_email', {});
    assert.equal(gatewaySessions.get(SESSION)?.tainted, true, 'a draft-risk call with content taints');
    await upstream.pool.closeAll();
  });
});

test('M3(b): a session whose episode row is tainted is tainted at the first call and on every later call', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    const gate = createFakeGate();
    setGatewayUpstreamPool(upstream.pool);
    setGatewayGate(gate);
    const episode = botEpisodesDb.create({ botId });
    gatewaySessions.bind(SESSION, { botId, episodeId: episode.episode_id, servers: ['mail'], provider: 'claude' });
    botEpisodesDb.update(episode.episode_id, { tainted: true }); // the kernel marks a batch with external events
    assert.equal(gatewaySessions.get(SESSION)?.tainted, false, 'binding flag not yet refreshed');
    await callGatewayTool(SESSION, 'mail__send_email', {});
    assert.equal(gate.evaluated[0]?.ctx.tainted, true, 'first call already sees the episode taint');
    assert.equal(gatewaySessions.get(SESSION)?.tainted, true, 'and it sticks on the binding');
    assert.equal(isSessionTainted(SESSION), true);
    await upstream.pool.closeAll();
  });
});

test('M5: each binding has its own random secret, required only for providers that stamp it', async () => {
  await withDatabase(async (botId) => {
    const a = gatewaySessions.bind('s-a', { botId, servers: [], provider: 'claude' });
    const b = gatewaySessions.bind('s-b', { botId, servers: [], provider: 'claude' });
    const other = gatewaySessions.bind('s-c', { botId, servers: [], provider: 'cursor' });
    assert.match(a.secret, /^[0-9a-f]{48}$/);
    assert.notEqual(a.secret, b.secret);
    assert.equal(gatewaySessions.get('s-a')?.secret, a.secret);
    assert.equal(a.secretRequired, true);
    assert.equal(other.secretRequired, false, 'providers that cannot stamp it stay advisory');
  });
});

test('M5: the gateway stdio child forwards the secret header', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../../bot-tool-gateway-mcp.ts', import.meta.url), 'utf8');
  assert.match(source, /CLOUDCLI_BOT_GATEWAY_BINDING_SECRET/);
  assert.match(source, /'x-bot-gateway-binding-secret'/);
});

test('low: an approval that lands after the run ended is denied and never executes', async () => {
  await withDatabase(async (botId) => {
    const upstream = createFakeUpstream();
    const gate = createFakeGate();
    gate.verdicts.send_email = { decision: 'ask', reason: 'needs approval', risk: 'send' };
    gate.duringHuman = () => {
      gatewaySessions.unbind(SESSION);
    };
    setGatewayUpstreamPool(upstream.pool);
    setGatewayGate(gate);
    gatewaySessions.bind(SESSION, { botId, servers: ['mail'], provider: 'claude' });
    const result = await callGatewayTool(SESSION, 'mail__send_email', { to: 'a@b.c' });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /run ended/i);
    assert.equal(upstream.calls.length, 0);
    await upstream.pool.closeAll();
  });
});

test('low: the upstream pool is keyed by bot as well as provider and server', async () => {
  const upstream = createFakeUpstream();
  await upstream.pool.listTools('claude', 'mail', 'bot-1');
  await upstream.pool.listTools('claude', 'mail', 'bot-1');
  await upstream.pool.listTools('claude', 'mail', 'bot-2');
  assert.deepEqual(upstream.connects, ['mail', 'mail']);
  assert.equal(upstream.pool.size(), 2);
  await upstream.pool.closeAll();
});

test('M6: gateway registration is skipped for isolated servers and when CLOUDCLI_BOT_GATEWAY_REGISTER=0', async () => {
  await withDatabase(async () => {
    // withDatabase points DATABASE_PATH at a scratch dir under tmp/.
    assert.equal(isIsolatedServer(), true);
    const registered = await registerBotGatewayMcp();
    assert.match(registered.skipped ?? '', /isolated/);
    const removed = await unregisterBotGatewayMcp();
    assert.equal(removed.removed, false);
    assert.match(removed.skipped ?? '', /isolated/);

    const saved = process.env.CLOUDCLI_BOT_GATEWAY_REGISTER;
    process.env.CLOUDCLI_BOT_GATEWAY_REGISTER = '0';
    try {
      assert.match((await registerBotGatewayMcp()).skipped ?? '', /REGISTER=0/);
    } finally {
      if (saved === undefined) delete process.env.CLOUDCLI_BOT_GATEWAY_REGISTER;
      else process.env.CLOUDCLI_BOT_GATEWAY_REGISTER = saved;
    }

    const savedDb = process.env.DATABASE_PATH;
    try {
      delete process.env.DATABASE_PATH;
      assert.equal(isIsolatedServer(), false, 'no DATABASE_PATH is the default install');
      process.env.DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');
      assert.equal(isIsolatedServer(), false, 'the default path is not isolated');
    } finally {
      process.env.DATABASE_PATH = savedDb;
    }
  });
});

test('buildGatewayRunGuards hands back the bound secret and a live, per-call gate', async () => {
  await withDatabase(async (botId) => {
    const episode = botEpisodesDb.create({ botId });
    const binding = gatewaySessions.bind(SESSION, { botId, episodeId: episode.episode_id, servers: [], provider: 'claude' });
    const guards = buildGatewayRunGuards({ section_id: botId }, {
      appSessionId: SESSION, episodeId: episode.episode_id, projectPath: '/tmp/not-a-real-project',
    });
    assert.equal(guards.bindingSecret, binding.secret);
    assert.equal(typeof guards.builtinToolGate, 'function');
    assert.equal((await guards.builtinToolGate('mcp__cloudcli-tool-gateway__x', {})).behavior, 'allow');
    assert.equal((await guards.builtinToolGate('Read', { file_path: path.join(os.homedir(), '.claude.json') })).behavior, 'deny');
    gatewaySessions.unbind(SESSION);
    assert.equal(buildGatewayRunGuards({ section_id: botId }, { appSessionId: 'nope', projectPath: '/tmp/x' }).bindingSecret, undefined);
  });
});
