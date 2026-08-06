import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import {
  MCP_HEALTH_DEDUPE_PREFIX,
  probeMcpServerHealth,
  probeUrlReachable,
  resolveExecutableOnPath,
  type McpServerHealthReport,
} from '@/modules/auth-health/mcp-health.service.js';
import {
  planMcpHealthNotifications,
  RENOTIFY_COOLDOWN_MS,
  type AuthHealthOpenNotification,
} from '@/modules/auth-health/auth-health.service.js';

const NOW = 1_800_000_000_000;

async function withHttpServer(
  runTest: (baseUrl: string, server: Server) => void | Promise<void>,
): Promise<void> {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test http server did not bind');
  }
  try {
    await runTest(`http://127.0.0.1:${address.port}`, server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('resolveExecutableOnPath finds real commands and rejects missing ones', async () => {
  assert.equal(await resolveExecutableOnPath('ls'), true);
  assert.equal(await resolveExecutableOnPath('definitely-not-a-real-command-xyz'), false);
  assert.equal(await resolveExecutableOnPath(''), false);
  assert.equal(await resolveExecutableOnPath('/definitely/not/a/real/path/binary'), false);
});

test('probeUrlReachable accepts reachable endpoints and rejects broken ones', async () => {
  await withHttpServer(async (baseUrl) => {
    assert.equal(await probeUrlReachable(baseUrl), true);
    assert.equal(await probeUrlReachable(`${baseUrl}/any/path`), true);
  });

  assert.equal(await probeUrlReachable('http://127.0.0.1:1/unreachable'), false);
  assert.equal(await probeUrlReachable('not a url'), false);
  assert.equal(await probeUrlReachable('ftp://example.com'), false);
});

test('probeMcpServerHealth stdio requires a command that exists on PATH', async () => {
  assert.deepEqual(
    await probeMcpServerHealth({ provider: 'claude', name: 'srv', scope: 'user', transport: 'stdio' }),
    { healthy: false, status: 'missing_command', error: 'No launch command configured for this stdio MCP server.' },
  );
  assert.deepEqual(
    await probeMcpServerHealth({ provider: 'claude', name: 'srv', scope: 'user', transport: 'stdio', command: 'missing-command-xyz' }),
    { healthy: false, status: 'command_not_found', error: 'Launch command "missing-command-xyz" was not found on PATH.' },
  );
  assert.deepEqual(
    await probeMcpServerHealth({ provider: 'claude', name: 'srv', scope: 'user', transport: 'stdio', command: 'ls' }),
    { healthy: true, status: 'ok', error: null },
  );
});

test('probeMcpServerHealth http requires a reachable url', async () => {
  assert.deepEqual(
    await probeMcpServerHealth({ provider: 'claude', name: 'srv', scope: 'user', transport: 'http' }),
    { healthy: false, status: 'missing_url', error: 'No endpoint URL configured for this MCP server.' },
  );
  const unreachable = await probeMcpServerHealth({
    provider: 'claude',
    name: 'srv',
    scope: 'user',
    transport: 'http',
    url: 'http://127.0.0.1:1/unreachable',
  });
  assert.equal(unreachable.healthy, false);
  assert.equal(unreachable.status, 'unreachable_url');
  assert.match(unreachable.error ?? '', /did not respond/);

  await withHttpServer(async (baseUrl) => {
    const reachable = await probeMcpServerHealth({
      provider: 'claude',
      name: 'srv',
      scope: 'user',
      transport: 'sse',
      url: baseUrl,
    });
    assert.deepEqual(reachable, { healthy: true, status: 'ok', error: null });
  });
});

function mcpReport(patch: Partial<McpServerHealthReport>): McpServerHealthReport {
  return {
    provider: 'claude',
    name: 'memory',
    scope: 'user',
    transport: 'stdio',
    healthy: true,
    status: 'ok',
    error: null,
    checkedAt: new Date(NOW).toISOString(),
    ...patch,
  };
}

function openMcpAlert(provider: string, name: string, notificationId = `note-${provider}-${name}`): AuthHealthOpenNotification {
  return {
    notification_id: notificationId,
    meta: { dedupeKey: `${MCP_HEALTH_DEDUPE_PREFIX}${provider}:${name}` },
  };
}

test('unhealthy MCP server with no open alert creates a notification', () => {
  const actions = planMcpHealthNotifications(
    [mcpReport({ healthy: false, status: 'command_not_found', error: 'Launch command "x" was not found on PATH.' })],
    [],
    new Map(),
    NOW,
  );

  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action.type, 'create');
  if (action.type !== 'create') return;
  assert.equal(action.provider, 'claude');
  assert.equal(action.input.dedupeKey, 'mcp-health:claude:memory');
  assert.equal(action.input.kind, 'action_required');
  assert.equal(action.input.severity, 'warning');
  assert.equal(action.input.source, 'auth-health');
  assert.deepEqual(action.input.meta, { provider: 'claude', mcpServer: 'memory' });
  assert.match(action.input.title, /MCP server "memory" is unhealthy \(claude\)/);
  assert.match(action.input.body ?? '', /was not found on PATH/);
});

test('unhealthy MCP server with an open alert is a no-op', () => {
  const actions = planMcpHealthNotifications(
    [mcpReport({ healthy: false })],
    [openMcpAlert('claude', 'memory')],
    new Map(),
    NOW,
  );
  assert.deepEqual(actions, []);
});

test('unhealthy MCP server inside the cooldown is a no-op', () => {
  const lastNotified = new Map([[`${MCP_HEALTH_DEDUPE_PREFIX}claude:memory`, NOW - 60 * 60 * 1000]]);
  const actions = planMcpHealthNotifications(
    [mcpReport({ healthy: false })],
    [],
    lastNotified,
    NOW,
  );
  assert.deepEqual(actions, []);
});

test('unhealthy MCP server past the cooldown re-creates the notification', () => {
  const lastNotified = new Map([[`${MCP_HEALTH_DEDUPE_PREFIX}claude:memory`, NOW - RENOTIFY_COOLDOWN_MS - 1]]);
  const actions = planMcpHealthNotifications(
    [mcpReport({ healthy: false })],
    [],
    lastNotified,
    NOW,
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'create');
});

test('recovered MCP server with an open alert dismisses it silently', () => {
  const actions = planMcpHealthNotifications(
    [mcpReport({ healthy: true })],
    [openMcpAlert('claude', 'memory', 'note-42')],
    new Map(),
    NOW,
  );
  assert.deepEqual(actions, [
    {
      type: 'dismiss',
      provider: 'claude',
      dedupeKey: 'mcp-health:claude:memory',
      notificationId: 'note-42',
    },
  ]);
});

test('healthy MCP server with no open alert is a no-op', () => {
  const actions = planMcpHealthNotifications([mcpReport({ healthy: true })], [], new Map(), NOW);
  assert.deepEqual(actions, []);
});

test('mixed MCP reports plan per server independently', () => {
  const actions = planMcpHealthNotifications(
    [
      mcpReport({ name: 'memory', healthy: false }), // unhealthy, alert open → no-op
      mcpReport({ name: 'git', healthy: false }), // unhealthy, no alert → create
      mcpReport({ name: 'web', healthy: true }), // recovered, alert open → dismiss
    ],
    [openMcpAlert('claude', 'memory'), openMcpAlert('claude', 'web', 'note-web')],
    new Map(),
    NOW,
  );
  assert.deepEqual(
    actions.map((a) => (a.type === 'create' ? ['create', a.input.meta?.mcpServer] : ['dismiss', a.dedupeKey])),
    [
      ['create', 'git'],
      ['dismiss', 'mcp-health:claude:web'],
    ],
  );
});
