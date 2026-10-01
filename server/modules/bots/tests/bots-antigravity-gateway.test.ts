import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { updateAppFeatures } from '@/modules/app-features/index.js';
import {
  botGatewayMcpRoutes,
  describeGatewayEnforcement,
  getBotGatewayMcpToken,
  getGatewayEnforcement,
  gatewaySessions,
  getProviderGatewayAdapter,
  registerBotGatewayMcp,
  setGatewayGate,
  setGatewayUpstreamPool,
} from '@/modules/bots/gateway/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { mcpCatalogService } from '@/modules/providers/index.js';
import { buildRuntimeOptions, missionControlDb } from '@/modules/mission-control/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withDatabase(run: (botId: string) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousHome = process.env.CLOUDCLI_BOTS_HOME;
  const scratch = await makeScratchDir('bots-agy-gateway-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_BOTS_HOME = path.join(scratch, 'bots');
  await initializeDatabase();
  try {
    const bot = missionControlDb.createSection({ title: 'Antigravity bot', produce_prompt: 'Triage the inbox' });
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

test('antigravity is enforced exactly when the built-in tool gate is installed', () => {
  assert.equal(getGatewayEnforcement('antigravity'), 'advisory');
  assert.equal(getGatewayEnforcement('antigravity', { builtinToolGate: false }), 'advisory');
  assert.equal(getGatewayEnforcement('antigravity', { builtinToolGate: true }), 'enforced');
  assert.match(describeGatewayEnforcement('antigravity', { builtinToolGate: true }), /only the gateway/i);
  assert.match(describeGatewayEnforcement('antigravity', { builtinToolGate: true }), /not gated/);
  assert.match(describeGatewayEnforcement('antigravity', {}), /no built-in tool gate/);
  // The neighbours are untouched.
  assert.equal(getGatewayEnforcement('opencode', { builtinToolGate: true }), 'advisory');
  assert.equal(getGatewayEnforcement('claude', { builtinToolGate: true }), 'enforced');
});

test('antigravity applyRunOptions forces ask mode and the gateway-only strict selection', () => {
  const options: Record<string, unknown> = { permissionMode: 'bypassPermissions', mcpServers: ['mail'] };
  getProviderGatewayAdapter('antigravity')!.applyRunOptions!(options);
  assert.equal(options.permissionMode, 'default');
  assert.deepEqual(options.mcpServers, ['cloudcli-tool-gateway']);
  assert.equal(options.strictMcpSelection, true);
  assert.equal(options.botGatewayStrict, true);
});

test('buildRuntimeOptions: flag off leaves an antigravity bot alone; flag on makes it gateway-only and asking', async () => {
  await withDatabase((botId) => {
    const section = { ...missionControlDb.getSection(botId)!, provider: 'antigravity' as const, permission_mode: 'bypassPermissions' };
    const tools = ['mail', 'wiki'];

    const off = buildRuntimeOptions(section, tools);
    assert.deepEqual(off.mcpServers, tools);
    assert.equal(off.permissionMode, 'bypassPermissions');
    assert.equal(off.botGatewayStrict, undefined);
    assert.equal(off.strictMcpSelection, undefined);

    updateAppFeatures({ botsRuntimeV2: true });
    const on = buildRuntimeOptions(section, tools);
    assert.deepEqual(on.mcpServers, ['cloudcli-tool-gateway']);
    assert.equal(on.permissionMode, 'default');
    assert.equal(on.botGatewayStrict, true);
    assert.equal(on.strictMcpSelection, true);
  });
});

test('the binding secret is required for antigravity sessions and checked by the route', async () => {
  await withDatabase(async (botId) => {
    const binding = gatewaySessions.bind('agy-session', { botId, servers: [], provider: 'antigravity' });
    assert.equal(binding.secretRequired, true);
    setGatewayGate(null);

    const app = express();
    app.use(express.json());
    app.use('/api/bot-gateway-mcp', botGatewayMcpRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bot-gateway-mcp`;
    const post = (secret: string | null) => fetch(`${base}/tools/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getBotGatewayMcpToken()}`,
        'x-bot-gateway-session-id': 'agy-session',
        ...(secret ? { 'x-bot-gateway-binding-secret': secret } : {}),
      },
      body: '{}',
    });
    try {
      assert.equal((await post(null)).status, 401, 'session id alone cannot speak for an antigravity run');
      assert.equal((await post('guess')).status, 401);
      assert.equal((await post(binding.secret)).status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('registerBotGatewayMcp binds the gateway to antigravity (recorded only, projected per run)', async () => {
  await withDatabase(async () => {
    const savedUpsert = mcpCatalogService.upsert;
    const savedDb = process.env.DATABASE_PATH;
    let captured: { name: string; providers?: string[]; envVars?: string[] } | null = null;
    mcpCatalogService.upsert = (async (input: { name: string; providers?: string[]; envVars?: string[] }) => {
      captured = input;
      return input as never;
    }) as typeof mcpCatalogService.upsert;
    try {
      // The open connection keeps working; dropping DATABASE_PATH makes this look like the real install.
      delete process.env.DATABASE_PATH;
      const result = await registerBotGatewayMcp();
      assert.equal(result.skipped, undefined);
      assert.ok(captured, 'the catalog entry was upserted');
      assert.equal((captured as { name: string }).name, 'cloudcli-tool-gateway');
      assert.ok((captured as { providers: string[] }).providers.includes('antigravity'));
      assert.ok((captured as { envVars: string[] }).envVars.includes('CLOUDCLI_BOT_GATEWAY_BINDING_SECRET'));
    } finally {
      mcpCatalogService.upsert = savedUpsert;
      process.env.DATABASE_PATH = savedDb;
    }
  });
});
