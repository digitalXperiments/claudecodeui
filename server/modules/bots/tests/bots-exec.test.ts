import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { updateAppFeatures } from '@/modules/app-features/index.js';
import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  configureMissionControlRuntimes,
  missionControlDb,
  runMissionControlAgent,
} from '@/modules/mission-control/index.js';
import { runsDb } from '@/modules/runs/index.js';
import { configureSecretsKeyDir, secretsService } from '@/modules/secrets/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { gatewaySessions } from '@/shared/bot-gateway-sessions.js';
import { makeScratchDir } from '@/shared/scratch.js';
import type { AnyRecord } from '@/shared/types.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { patchBotRuntimeConfig, readBotRuntimeConfig, normalizeBotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
import { resolveBotBrowserProfileDir, resolveBotHome } from '@/modules/bots/bots-home.js';
import {
  BACKEND_NOT_IMPLEMENTED,
  botCredentials,
  botExecRouter,
  parsePmsetAssertions,
  pickRoute,
  readHostInfo,
  validateRuntimeConfigInput,
} from '@/modules/bots/exec/index.js';
import {
  BROWSER_PROFILE_DIR_ENV,
  createUpstreamPool,
  defaultConnectionDecorator,
  type UpstreamConnection,
} from '@/modules/bots/gateway/upstream-pool.js';

type Writer = { send: (event: AnyRecord) => void; sendComplete: (event: AnyRecord) => void };
type Fake = (prompt: string, options: AnyRecord, writer: Writer) => void | Promise<void>;

interface Recorded {
  fn: Fake;
  calls: Array<{ prompt: string; options: AnyRecord }>;
}

/** Replies with `text`, or fails with `error` (non-zero exit) when given. `tools` are emitted as tool_use first. */
function fakeRuntime(result: { text?: string; error?: string; tools?: string[]; textBeforeError?: string }): Recorded {
  const calls: Recorded['calls'] = [];
  const fn: Fake = (prompt, options, writer) => {
    calls.push({ prompt, options });
    (result.tools ?? []).forEach((toolName, index) => {
      writer.send({ kind: 'tool_use', provider: 'claude', toolName, toolId: `t${index}`, toolInput: { any: 'thing' } });
    });
    if (result.textBeforeError) writer.send({ kind: 'text', provider: 'claude', content: result.textBeforeError });
    if (result.error !== undefined) {
      writer.send({ kind: 'error', provider: 'claude', content: result.error });
      writer.sendComplete({ exitCode: 1 });
      return;
    }
    writer.send({ kind: 'text', provider: 'claude', content: result.text ?? 'ok' });
    writer.sendComplete({ exitCode: 0 });
  };
  return { fn, calls };
}

async function withExec(
  run: (ctx: { botId: string; scratch: string }) => void | Promise<void>,
  options: { flag?: boolean; provider?: 'claude' | 'codex' } = {},
): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousHome = process.env.CLOUDCLI_BOTS_HOME;
  const previousKey = process.env.CLOUDCLI_SECRETS_KEY;
  const scratch = await makeScratchDir('bots-exec-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_BOTS_HOME = path.join(scratch, 'bots');
  process.env.CLOUDCLI_SECRETS_KEY = randomBytes(32).toString('base64');
  configureSecretsKeyDir(path.join(scratch, 'key'));
  await initializeDatabase();
  updateAppFeatures({ botsRuntimeV2: options.flag !== false });
  try {
    const bot = missionControlDb.createSection({
      title: 'Exec bot',
      produce_prompt: 'Do the thing',
      provider: options.provider ?? 'claude',
    });
    await run({ botId: bot.section_id, scratch });
  } finally {
    configureMissionControlRuntimes({});
    chatRunRegistry.clearAll();
    gatewaySessions.clearForTests();
    configureSecretsKeyDir(null);
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousHome === undefined) delete process.env.CLOUDCLI_BOTS_HOME;
    else process.env.CLOUDCLI_BOTS_HOME = previousHome;
    if (previousKey === undefined) delete process.env.CLOUDCLI_SECRETS_KEY;
    else process.env.CLOUDCLI_SECRETS_KEY = previousKey;
    await rm(scratch, { recursive: true, force: true });
  }
}

const runAgent = (botId: string, extra: Partial<Parameters<typeof runMissionControlAgent>[0]> = {}) =>
  runMissionControlAgent({ section: missionControlDb.getSection(botId)!, prompt: 'go', tools: [], ...extra });

// ---- 1. bot home -------------------------------------------------------------------------------

test('a new bot home is seeded with a README and folders; an existing home is left alone', async () => {
  await withExec(({ botId, scratch }) => {
    const home = resolveBotHome(botId);
    assert.equal(home, path.join(scratch, 'bots', botId, 'home'));
    for (const dir of ['skills', 'spaces', 'scratch']) assert.ok(fs.statSync(path.join(home, dir)).isDirectory(), dir);
    const readme = fs.readFileSync(path.join(home, 'README.md'), 'utf8');
    assert.match(readme, /skills\//);
    assert.match(readme, /spaces\//);
    assert.match(readme, /scratch\//);
    assert.match(readme, /Documents, Desktop and\s+Downloads/);

    fs.writeFileSync(path.join(home, 'README.md'), 'edited by the operator');
    fs.rmSync(path.join(home, 'scratch'), { recursive: true });
    resolveBotHome(botId);
    assert.equal(fs.readFileSync(path.join(home, 'README.md'), 'utf8'), 'edited by the operator');
    assert.equal(fs.existsSync(path.join(home, 'scratch')), false, 'an existing home is not re-seeded');

    assert.equal(resolveBotBrowserProfileDir(botId), path.join(home, 'browser-profile'));
    assert.throws(() => resolveBotHome('../escape'), /Invalid bot id/);
  });
});

test('flag on: a global bot runs in its bot home; project bots keep the project path; flag off keeps $HOME', async () => {
  await withExec(async ({ botId, scratch }) => {
    const runtime = fakeRuntime({ text: 'fine' });
    configureMissionControlRuntimes({ claude: runtime.fn } as never);

    await runAgent(botId);
    assert.equal(runtime.calls[0].options.cwd, resolveBotHome(botId));
    assert.match(String(runtime.calls[0].options.cwd), /bots/);

    const projectDir = path.join(scratch, 'project-checkout');
    fs.mkdirSync(projectDir);
    const project = projectsDb.createProjectPath(projectDir).project!;
    const projectBot = missionControlDb.createSection({ title: 'Project bot', produce_prompt: 'x', scope: 'project', project_id: project.project_id });
    await runAgent(projectBot.section_id);
    assert.equal(fs.realpathSync(String(runtime.calls[1].options.cwd)), fs.realpathSync(projectDir));

    updateAppFeatures({ botsRuntimeV2: false });
    await runAgent(botId);
    assert.equal(runtime.calls[2].options.cwd, (await import('node:os')).homedir());
  });
});

// ---- 2. routing ------------------------------------------------------------------------------

test('routing.fallback is normalized: unknown providers dropped, capped, models kept', () => {
  const config = normalizeBotRuntimeConfig({
    routing: {
      act: { provider: 'claude', model: 'opus' },
      fallback: [
        { provider: 'codex', model: 'gpt-5', effort: 'high' },
        { provider: 'not-a-provider' },
        'nonsense',
        { provider: 'grok' },
        { provider: 'kimi' },
        { provider: 'pi' },
        { provider: 'omp' },
        { provider: 'cline' },
      ],
    },
  });
  assert.deepEqual(config.routing?.fallback?.map((route) => route.provider), ['codex', 'grok', 'kimi', 'pi', 'omp']);
  assert.deepEqual(config.routing?.fallback?.[0], { provider: 'codex', model: 'gpt-5', effort: 'high' });
  assert.equal(normalizeBotRuntimeConfig({ routing: { fallback: [] } }).routing?.fallback, undefined);
  assert.equal(normalizeBotRuntimeConfig({ routing: { fallback: 'x' } }).routing?.fallback, undefined);
});

test('pickRoute: phase override, same-provider inheritance, and the section default', async () => {
  await withExec(({ botId }) => {
    const section = { ...missionControlDb.getSection(botId)!, provider: 'claude' as const, model: 'sonnet', effort: 'low' };
    assert.deepEqual(pickRoute(section, 'act'), { provider: 'claude', model: 'sonnet', effort: 'low' });
    patchBotRuntimeConfig(botId, { routing: { perceive: { provider: 'claude', model: 'haiku' }, act: { provider: 'codex' }, reflect: { provider: 'grok', effort: 'high' } } });
    assert.deepEqual(pickRoute(section, 'perceive'), { provider: 'claude', model: 'haiku', effort: 'low' });
    assert.deepEqual(pickRoute(section, 'act'), { provider: 'codex' });
    assert.deepEqual(pickRoute(section, 'work'), { provider: 'codex' });
    assert.deepEqual(pickRoute(section, 'produce'), { provider: 'codex' });
    assert.deepEqual(pickRoute(section, 'reflect'), { provider: 'grok', effort: 'high' });
  });
});

// ---- 2b. failover ----------------------------------------------------------------------------

test('failover: a rate limit retries on the fallback, each attempt is its own run with meta.fallback_from', async () => {
  await withExec(async ({ botId }) => {
    const primary = fakeRuntime({ error: 'Error: 429 rate limit exceeded, try again in 5 minutes' });
    const secondary = fakeRuntime({ text: 'recovered' });
    configureMissionControlRuntimes({ claude: primary.fn, codex: secondary.fn } as never);
    patchBotRuntimeConfig(botId, { routing: { fallback: [{ provider: 'codex', model: 'gpt-5' }] } });

    const seen: string[] = [];
    const result = await runAgent(botId, { onRunCreated: (run) => seen.push(run.runId) });
    assert.equal(result.success, true);
    assert.equal(result.text, 'recovered');
    assert.equal(seen.length, 2, 'onRunCreated fires for every attempt');
    assert.equal(result.runId, seen[1]);
    assert.deepEqual(result.attempts?.map((attempt) => [attempt.provider, attempt.success, attempt.failoverReason]), [
      ['claude', false, 'limit'],
      ['codex', true, undefined],
    ]);

    const first = runsDb.getById(seen[0])!;
    const second = runsDb.getById(seen[1])!;
    assert.equal(first.meta.fallback_from, undefined);
    assert.equal(second.provider, 'codex');
    assert.equal(second.model, 'gpt-5');
    const from = second.meta.fallback_from as Record<string, unknown>;
    assert.equal(from.run_id, seen[0]);
    assert.equal(from.provider, 'claude');
    assert.equal(from.reason, 'limit');
    assert.equal(from.attempt, 1);
    assert.equal(secondary.calls[0].options.model, 'gpt-5');
  });
});

test('failover: an auth failure falls over, and the chain stops at the first success', async () => {
  await withExec(async ({ botId }) => {
    const primary = fakeRuntime({ error: 'Error: OAuth session expired. Please run claude /login' });
    const second = fakeRuntime({ error: 'API error: 503 service unavailable (overloaded)' });
    const third = fakeRuntime({ text: 'third time' });
    const fourth = fakeRuntime({ text: 'never reached' });
    configureMissionControlRuntimes({ claude: primary.fn, codex: second.fn, grok: third.fn, kimi: fourth.fn } as never);
    patchBotRuntimeConfig(botId, { routing: { fallback: [{ provider: 'codex' }, { provider: 'grok' }, { provider: 'kimi' }] } });

    const result = await runAgent(botId);
    assert.equal(result.text, 'third time');
    assert.deepEqual(result.attempts?.map((attempt) => [attempt.provider, attempt.failoverReason]), [
      ['claude', 'auth'],
      ['codex', 'unavailable'],
      ['grok', undefined],
    ]);
    assert.equal(fourth.calls.length, 0);
  });
});

test('failover: an unavailable runtime is skipped to the next fallback', async () => {
  await withExec(async ({ botId }) => {
    const secondary = fakeRuntime({ text: 'from codex' });
    // No claude runtime installed at all.
    configureMissionControlRuntimes({ codex: secondary.fn } as never);
    patchBotRuntimeConfig(botId, { routing: { fallback: [{ provider: 'codex' }] } });
    const result = await runAgent(botId);
    assert.equal(result.text, 'from codex');
    assert.equal(result.attempts?.[0].failoverReason, 'unavailable');
  });
});

test('failover never fires on a normal task failure, a gate denial, or with the flag off', async () => {
  await withExec(async ({ botId }) => {
    const secondary = fakeRuntime({ text: 'should not run' });
    patchBotRuntimeConfig(botId, { routing: { fallback: [{ provider: 'codex' }] } });

    configureMissionControlRuntimes({ claude: fakeRuntime({ error: 'tool crashed: TypeError: boom' }).fn, codex: secondary.fn } as never);
    const normal = await runAgent(botId);
    assert.equal(normal.success, false);
    assert.equal(normal.attempts?.length, 1);

    configureMissionControlRuntimes({
      claude: fakeRuntime({ error: 'Blocked by the action gate (send): rate limit of sends reached for today' }).fn,
      codex: secondary.fn,
    } as never);
    const denied = await runAgent(botId);
    assert.equal(denied.success, false);
    assert.equal(denied.attempts?.length, 1, 'a gate denial is not a provider failure');

    configureMissionControlRuntimes({ claude: fakeRuntime({ error: '429 rate limit exceeded' }).fn, codex: secondary.fn } as never);
    updateAppFeatures({ botsRuntimeV2: false });
    const off = await runAgent(botId);
    assert.equal(off.success, false);
    assert.equal(off.attempts, undefined);
    assert.equal(secondary.calls.length, 0);
  });
});

test('failover is skipped when the failed run already executed a write-class tool', async () => {
  await withExec(async ({ botId }) => {
    const secondary = fakeRuntime({ text: 'would duplicate the send' });
    configureMissionControlRuntimes({ claude: fakeRuntime({ error: '429 rate limit exceeded' }).fn, codex: secondary.fn } as never);
    patchBotRuntimeConfig(botId, { routing: { fallback: [{ provider: 'codex' }] } });
    const result = await runAgent(botId, {
      onRunCreated: ({ runId }) => {
        const decision = botGateDecisionsDb.create({ botId, runId, server: 'mail', tool: 'send_email', risk: 'send', decision: 'allow', decidedBy: 'rule:x' });
        botGateDecisionsDb.recordOutcome(decision.decision_id, 'executed');
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.attempts?.length, 1);
    assert.equal(secondary.calls.length, 0);
  });
});

test('failover: when every fallback fails the last failure is returned with all attempts; same-agent entries are skipped', async () => {
  await withExec(async ({ botId }) => {
    const codex = fakeRuntime({ error: 'ECONNREFUSED 127.0.0.1:443' });
    configureMissionControlRuntimes({ claude: fakeRuntime({ error: '429 rate limit exceeded' }).fn, codex: codex.fn } as never);
    // The first entry repeats the primary agent exactly and is dropped.
    patchBotRuntimeConfig(botId, { routing: { fallback: [{ provider: 'claude' }, { provider: 'codex' }] } });
    const result = await runAgent(botId);
    assert.equal(result.success, false);
    assert.match(result.errorMessage ?? '', /ECONNREFUSED/);
    assert.deepEqual(result.attempts?.map((attempt) => attempt.provider), ['claude', 'codex']);
  });
});

// ---- 3. per-bot credentials --------------------------------------------------------------------

test('credentials: secrets are scoped to the bot and never list values', async () => {
  await withExec(({ botId }) => {
    const other = missionControlDb.createSection({ title: 'Other', produce_prompt: 'x' });
    botCredentials.put(botId, 'jira-cloud', 'JIRA_API_TOKEN', 'tok-secret-1');
    botCredentials.put(other.section_id, 'jira-cloud', 'JIRA_API_TOKEN', 'tok-secret-other');
    secretsService.put({ name: 'JIRA_CLOUD__JIRA_API_TOKEN', value: 'global-should-not-leak', scope: 'user' });

    const listed = botCredentials.list(botId);
    assert.deepEqual(listed.map((entry) => [entry.server, entry.key, entry.name]), [['JIRA_CLOUD', 'JIRA_API_TOKEN', 'JIRA_CLOUD__JIRA_API_TOKEN']]);
    assert.doesNotMatch(JSON.stringify(listed), /tok-secret/);
    assert.deepEqual(botCredentials.resolveOverrides(botId, 'jira-cloud'), { JIRA_API_TOKEN: 'tok-secret-1' });
    assert.deepEqual(botCredentials.resolveOverrides(other.section_id, 'Jira Cloud'), { JIRA_API_TOKEN: 'tok-secret-other' });
    assert.deepEqual(botCredentials.resolveOverrides(botId, 'mail'), {});
    assert.equal(botCredentials.delete(botId, 'jira-cloud', 'JIRA_API_TOKEN'), true);
    assert.equal(botCredentials.delete(botId, 'jira-cloud', 'JIRA_API_TOKEN'), false);
    assert.deepEqual(botCredentials.resolveOverrides(botId, 'jira-cloud'), {});
    assert.deepEqual(botCredentials.resolveOverrides(other.section_id, 'jira-cloud'), { JIRA_API_TOKEN: 'tok-secret-other' });
    assert.throws(() => botCredentials.put(botId, 'jira', 'bad__key', 'x'), /without "__"/);
  });
});

function recordingPool(resolved: Record<string, UpstreamConnection>) {
  const connections: Array<{ botId?: string; connection: UpstreamConnection }> = [];
  let current = '';
  const pool = createUpstreamPool({
    resolver: async (_provider, server) => resolved[server] ?? null,
    decorate: (connection, context) => {
      current = context.botId;
      return defaultConnectionDecorator(connection, context);
    },
    connector: async (connection) => {
      connections.push({ botId: current, connection });
      return {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
      } as never;
    },
  });
  return { pool, connections };
}

test('upstream pool applies per-bot env (stdio) and header (http) overrides, only for that bot', async () => {
  await withExec(async ({ botId }) => {
    const other = missionControlDb.createSection({ title: 'Other', produce_prompt: 'x' });
    botCredentials.put(botId, 'jira', 'JIRA_TOKEN', 'bot-a-token');
    botCredentials.put(botId, 'composio', 'x-api-key', 'bot-a-key');
    const { pool, connections } = recordingPool({
      jira: { name: 'jira', transport: 'stdio', command: 'jira-mcp', env: { JIRA_TOKEN: 'shared', JIRA_URL: 'https://j.test' } },
      composio: { name: 'composio', transport: 'http', url: 'https://c.test/mcp', headers: { 'x-api-key': 'shared', accept: '*/*' } },
    });

    await pool.listTools('claude', 'jira', botId);
    await pool.listTools('claude', 'composio', botId);
    await pool.listTools('claude', 'jira', other.section_id);
    assert.deepEqual(connections[0].connection.env, { JIRA_TOKEN: 'bot-a-token', JIRA_URL: 'https://j.test' });
    assert.deepEqual(connections[1].connection.headers, { 'x-api-key': 'bot-a-key', accept: '*/*' });
    assert.deepEqual(connections[2].connection.env, { JIRA_TOKEN: 'shared', JIRA_URL: 'https://j.test' }, 'another bot keeps the shared credentials');
    assert.equal(pool.size(), 3);

    // Rotating a credential drops that bot's live connections only.
    await pool.invalidateBot?.(botId);
    assert.equal(pool.size(), 1);
    botCredentials.put(botId, 'jira', 'JIRA_TOKEN', 'bot-a-rotated');
    await pool.listTools('claude', 'jira', botId);
    assert.equal(connections.at(-1)?.connection.env?.JIRA_TOKEN, 'bot-a-rotated');
  });
});

test('upstream pool gives the cloudcli-browser server the bot\'s persistent profile directory', async () => {
  await withExec(async ({ botId }) => {
    const { pool, connections } = recordingPool({
      'cloudcli-browser': { name: 'cloudcli-browser', transport: 'stdio', command: 'node', args: ['browser-use-mcp.js'], env: { CLOUDCLI_BROWSER_USE_MCP_TOKEN: 't' } },
      other: { name: 'other', transport: 'stdio', command: 'x' },
    });
    await pool.listTools('claude', 'cloudcli-browser', botId);
    await pool.listTools('claude', 'other', botId);
    assert.equal(connections[0].connection.env?.[BROWSER_PROFILE_DIR_ENV], resolveBotBrowserProfileDir(botId));
    assert.equal(connections[0].connection.env?.CLOUDCLI_BROWSER_USE_MCP_TOKEN, 't');
    assert.equal(connections[1].connection.env?.[BROWSER_PROFILE_DIR_ENV], undefined);
    assert.match(resolveBotBrowserProfileDir(botId), /browser-profile$/);
  });
});

// ---- 3b/7. REST ----------------------------------------------------------------------------------

async function withRouter(
  run: (ctx: { botId: string; call: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }> }) => Promise<void>,
): Promise<void> {
  await withExec(async ({ botId }) => {
    const app = express();
    app.use(express.json());
    app.use('/api/bots', botExecRouter);
    app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ error: error.message });
    });
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots`;
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      return { status: res.status, json };
    };
    try {
      await run({ botId, call });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test('credentials REST: names only, PUT stores, DELETE removes, validation and 404s', async () => {
  await withRouter(async ({ botId, call }) => {
    assert.equal((await call('GET', `/nope/credentials`)).status, 404);
    assert.deepEqual((await call('GET', `/${botId}/credentials`)).json, { credentials: [] });

    assert.equal((await call('PUT', `/${botId}/credentials/jira/JIRA_TOKEN`, {})).status, 400);
    assert.equal((await call('PUT', `/${botId}/credentials/jira/bad__key`, { value: 'x' })).status, 400);
    const put = await call('PUT', `/${botId}/credentials/jira/JIRA_TOKEN`, { value: 'super-secret-value' });
    assert.equal(put.status, 200);
    assert.doesNotMatch(JSON.stringify(put.json), /super-secret-value/);

    const listed = await call('GET', `/${botId}/credentials`);
    assert.equal(listed.json.credentials.length, 1);
    assert.equal(listed.json.credentials[0].server, 'JIRA');
    assert.equal(listed.json.credentials[0].key, 'JIRA_TOKEN');
    assert.doesNotMatch(JSON.stringify(listed.json), /super-secret-value/);
    assert.equal(botCredentials.resolveOverrides(botId, 'jira').JIRA_TOKEN, 'super-secret-value');

    assert.equal((await call('DELETE', `/${botId}/credentials/jira/JIRA_TOKEN`)).status, 200);
    assert.equal((await call('DELETE', `/${botId}/credentials/jira/JIRA_TOKEN`)).status, 404);
  });
});

test('routing fallback REST and the runtime PATCH guard (docker/ssh are not implemented)', async () => {
  await withRouter(async ({ botId, call }) => {
    assert.deepEqual((await call('GET', `/${botId}/routing/fallback`)).json, { fallback: [] });
    assert.equal((await call('PUT', `/${botId}/routing/fallback`, { fallback: [{ provider: 'nope' }] })).status, 400);
    assert.equal((await call('PUT', `/${botId}/routing/fallback`, { fallback: 'x' })).status, 400);
    const ok = await call('PUT', `/${botId}/routing/fallback`, { fallback: [{ provider: 'codex', model: 'gpt-5' }, { provider: 'grok', junk: 1 }] });
    assert.deepEqual(ok.json.fallback, [{ provider: 'codex', model: 'gpt-5' }, { provider: 'grok' }]);
    assert.deepEqual(readBotRuntimeConfig(botId)?.routing?.fallback?.length, 2);
    patchBotRuntimeConfig(botId, { routing: { ...readBotRuntimeConfig(botId)?.routing, act: { provider: 'claude' } } });
    assert.equal(readBotRuntimeConfig(botId)?.routing?.fallback?.length, 2, 'other routing keys survive');
    assert.deepEqual((await call('PUT', `/${botId}/routing/fallback`, { fallback: [] })).json.fallback, []);

    // Without the kernel router behind it the guard passes valid bodies through (404 from express),
    // and rejects unimplemented backends with the documented message.
    const docker = await call('PATCH', `/${botId}/runtime`, { backend: 'docker' });
    assert.equal(docker.status, 400);
    assert.match(docker.json.error, /not implemented — run the whole server on a remote box \(see HEADLESS\.md\)/);
    assert.equal((await call('PATCH', `/${botId}/runtime`, { backend: 'ssh' })).status, 400);
    assert.equal((await call('PATCH', `/${botId}/runtime`, { backend: 'mars' })).status, 400);
    assert.equal((await call('PATCH', `/${botId}/runtime`, { routing: { fallback: [{ provider: 'nope' }] } })).status, 400);
    assert.equal((await call('PATCH', `/${botId}/runtime`, { backend: 'local' })).status, 404);
    assert.equal((await call('PATCH', `/${botId}/runtime`, { gateway: false })).status, 404);
  });
});

test('validateRuntimeConfigInput mirrors the guard', () => {
  assert.equal(validateRuntimeConfigInput({ backend: 'local' }), null);
  assert.equal(validateRuntimeConfigInput({}), null);
  assert.equal(validateRuntimeConfigInput(null), null);
  assert.ok(validateRuntimeConfigInput({ backend: 'docker' })?.includes(BACKEND_NOT_IMPLEMENTED));
  assert.ok(validateRuntimeConfigInput({ routing: { fallback: [1] } }));
});

// ---- 7. host -----------------------------------------------------------------------------------

const PMSET_SLEEPING = `Assertion status system-wide:
   BackgroundTask                 0
   PreventUserIdleSystemSleep     0
   PreventSystemSleep             0
   PreventUserIdleDisplaySleep    0
`;

test('parsePmsetAssertions: caffeinate shows as a prevented sleep; unknown output is null', () => {
  assert.equal(parsePmsetAssertions(PMSET_SLEEPING), false);
  assert.equal(parsePmsetAssertions(PMSET_SLEEPING.replace('PreventUserIdleSystemSleep     0', 'PreventUserIdleSystemSleep     1')), true);
  assert.equal(parsePmsetAssertions(PMSET_SLEEPING.replace('PreventSystemSleep             0', 'PreventSystemSleep             1')), true);
  assert.equal(parsePmsetAssertions('garbage'), null);
});

test('readHostInfo: darwin asks pmset, other platforms report unknown, failures are unknown', async () => {
  const awake = await readHostInfo({ platform: 'darwin', run: async () => PMSET_SLEEPING.replace('PreventSystemSleep             0', 'PreventSystemSleep             1'), publicUrl: 'https://bots.example.com' });
  assert.equal(awake.platform, 'darwin');
  assert.equal(awake.sleepPrevented, true);
  assert.equal(awake.publicUrlConfigured, true);
  assert.ok(awake.uptime >= 0);
  assert.ok(awake.hostUptime > 0);

  const linux = await readHostInfo({ platform: 'linux', run: async () => { throw new Error('must not run'); }, publicUrl: null });
  assert.equal(linux.sleepPrevented, null);
  assert.equal(linux.publicUrlConfigured, false);

  const broken = await readHostInfo({ platform: 'darwin', run: async () => { throw new Error('pmset missing'); }, publicUrl: '' });
  assert.equal(broken.sleepPrevented, null);
  assert.equal(broken.publicUrlConfigured, false);
});

test('GET /runtime/host answers without a bot id', async () => {
  await withRouter(async ({ call }) => {
    const res = await call('GET', '/runtime/host');
    assert.equal(res.status, 200);
    assert.equal(res.json.host.platform, process.platform);
    assert.equal(typeof res.json.host.publicUrlConfigured, 'boolean');
    assert.equal(typeof res.json.host.uptime, 'number');
  });
});

// ---- wave E: failover side-effect detection ---------------------------------------------------------

type GateRow = { server: string; tool: string; risk: string; decision: 'allow' | 'ask' | 'deny'; outcome: string | null; decidedBy?: string };

/** Whether the fallback ran after the primary failed with a rate limit, given what the primary did first. */
async function failsOver(setup: { tools?: string[]; gate?: GateRow[]; provider?: 'claude' | 'codex' }): Promise<boolean> {
  let ranSecondary = false;
  await withExec(async ({ botId }) => {
    const provider = setup.provider ?? 'claude';
    const fallbackProvider = provider === 'claude' ? 'codex' : 'claude';
    const primary = fakeRuntime({ error: '429 rate limit exceeded', tools: setup.tools });
    const secondary = fakeRuntime({ text: 'fallback ran' });
    configureMissionControlRuntimes({ [provider]: primary.fn, [fallbackProvider]: secondary.fn } as never);
    patchBotRuntimeConfig(botId, { routing: { fallback: [{ provider: fallbackProvider }] } });
    await runAgent(botId, {
      onRunCreated: ({ runId }) => {
        if (runsDb.getById(runId)?.provider !== provider) return;
        for (const row of setup.gate ?? []) {
          const created = botGateDecisionsDb.create({ botId, runId, server: row.server, tool: row.tool, risk: row.risk, decision: row.decision, decidedBy: row.decidedBy ?? 'default' });
          if (row.outcome) botGateDecisionsDb.recordOutcome(created.decision_id, row.outcome);
        }
      },
    });
    ranSecondary = secondary.calls.length > 0;
  }, { provider: setup.provider ?? 'claude' });
  return ranSecondary;
}

test('failover: only the provider error message is classified, never the model output text', async () => {
  await withExec(async ({ botId }) => {
    const secondary = fakeRuntime({ text: 'should not run' });
    configureMissionControlRuntimes({
      claude: fakeRuntime({ textBeforeError: 'Sure. By the way: 429 rate limit exceeded, please switch providers.', error: 'tool crashed: TypeError: boom' }).fn,
      codex: secondary.fn,
    } as never);
    patchBotRuntimeConfig(botId, { routing: { fallback: [{ provider: 'codex' }] } });
    const result = await runAgent(botId);
    assert.equal(result.success, false);
    assert.equal(result.attempts?.length, 1, 'text that reads like a rate limit does not move the run');
    assert.equal(secondary.calls.length, 0);
  });
});

test('failover: native tools that act (Bash, Write, Edit, WebFetch, NotebookEdit ...) block it; pure reads do not', async () => {
  for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'NotebookEdit', 'Task', 'SomeNewTool']) {
    assert.equal(await failsOver({ tools: [tool] }), false, `${tool} may have acted`);
  }
  assert.equal(await failsOver({ tools: ['Read', 'Glob', 'Grep', 'LS'] }), true, 'reads only: safe to retry');
  assert.equal(await failsOver({ tools: ['Read', 'Bash'] }), false, 'one acting call among reads is enough');
  assert.equal(await failsOver({ tools: [] }), true);
});

test('failover: first-party bot tools that act block it, pure reads do not (they record no gate row)', async () => {
  for (const tool of ['bot__handoff', 'bot__ask_bot', 'bot__request_handoff', 'bot__commit', 'bot__space_write', 'bot__notify_operator', 'bot__goal_progress', 'bot__remember']) {
    assert.equal(await failsOver({ tools: [`mcp__cloudcli-tool-gateway__${tool}`] }), false, tool);
    assert.equal(await failsOver({ tools: [tool] }), false, `${tool} (bare name)`);
  }
  assert.equal(await failsOver({ tools: ['mcp__cloudcli-tool-gateway__bot__space_read', 'mcp__cloudcli-tool-gateway__bot__search_memory'] }), true);
});

test('failover: gate decisions count unless they are reads or were never carried out', async () => {
  const row = (extra: Partial<GateRow>): GateRow => ({ server: 'mail', tool: 'send', risk: 'send', decision: 'allow', outcome: 'executed', ...extra });
  assert.equal(await failsOver({ gate: [row({})] }), false, 'executed send');
  assert.equal(await failsOver({ gate: [row({ risk: 'draft' })] }), false, 'a draft is still a side effect now');
  assert.equal(await failsOver({ gate: [row({ server: 'builtin', tool: 'Bash', risk: 'prod_change', decidedBy: 'builtin' })] }), false, 'built-in gate decision');
  assert.equal(await failsOver({ gate: [row({ decision: 'ask', outcome: 'approved', risk: 'publish' })] }), false, 'approved by the operator');
  assert.equal(await failsOver({ gate: [row({ outcome: null })] }), false, 'allowed but the run died before the outcome was recorded');
  assert.equal(await failsOver({ gate: [row({ outcome: 'error' })] }), false, 'a call that errored mid-flight may be partial');
  assert.equal(await failsOver({ gate: [row({ risk: 'read' })] }), true, 'reads are safe');
  assert.equal(await failsOver({ gate: [row({ decision: 'deny', outcome: 'denied' })] }), true, 'denied never ran');
  assert.equal(await failsOver({ gate: [row({ decision: 'ask', outcome: 'rejected' })] }), true);
  assert.equal(await failsOver({ gate: [row({ decision: 'ask', outcome: null })] }), true, 'never approved, so never ran');
  assert.equal(await failsOver({ gate: [row({ decision: 'ask', outcome: 'expired' })] }), true);
});

test('failover: non-Claude built-in tools are ungated, so any tool use at all blocks it', async () => {
  assert.equal(await failsOver({ provider: 'codex', tools: [] }), true, 'zero tool use: safe');
  assert.equal(await failsOver({ provider: 'codex', tools: ['Read'] }), false, 'even a read-looking call: the provider is ungated');
  assert.equal(await failsOver({ provider: 'codex', tools: ['shell'] }), false);
});
