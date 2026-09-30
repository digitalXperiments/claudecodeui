import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import type { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  handleChatPrewarm,
  handleChatSend,
  resetChatPrewarmState,
  type ChatWebSocketDependencies,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

type PrewarmCall = { providerSessionId: string; options: Record<string, unknown> };

async function withChatDb(fn: (root: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousKill = process.env.CLOUDCLI_CLAUDE_PREWARM;
  const root = await makeScratchDir('chat-prewarm-');
  closeConnection();
  process.env.DATABASE_PATH = `${root}/auth.db`;
  delete process.env.CLOUDCLI_CLAUDE_PREWARM;
  await initializeDatabase();
  resetChatPrewarmState();
  try {
    await fn(root);
  } finally {
    resetChatPrewarmState();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousKill === undefined) delete process.env.CLOUDCLI_CLAUDE_PREWARM;
    else process.env.CLOUDCLI_CLAUDE_PREWARM = previousKill;
    await rm(root, { recursive: true, force: true });
  }
}

function createClaudeSession(sessionId: string, root: string, providerSessionId: string | null = `prov-${sessionId}`): void {
  sessionsDb.createAppSession(sessionId, 'claude', root, { permissionMode: 'acceptEdits' });
  if (providerSessionId) {
    sessionsDb.assignProviderSessionId(sessionId, providerSessionId);
  }
}

function makeDependencies(calls: PrewarmCall[], extra: Partial<ChatWebSocketDependencies> = {}) {
  const spawned: Array<Record<string, unknown>> = [];
  const dependencies = {
    spawnFns: {
      claude: async (_content: string, options: Record<string, unknown>) => {
        spawned.push(options);
      },
      codex: async () => undefined,
    },
    abortFns: {},
    getPendingApprovalsForSession: () => [],
    prewarmFns: {
      claude: async (providerSessionId: string, options: Record<string, unknown>) => {
        calls.push({ providerSessionId, options });
        return true;
      },
    },
    ...extra,
  } as unknown as ChatWebSocketDependencies;
  return { dependencies, spawned };
}

const composerOptions = (overrides: Record<string, unknown> = {}) => ({
  model: 'sonnet',
  effort: 'high',
  toolsSettings: { allowedTools: ['Read'], disallowedTools: [], skipPermissions: false },
  skipPermissions: false,
  sessionSummary: 'Summary',
  isolatedWorkspace: false,
  ...overrides,
});

test('chat.prewarm builds the same runtime options chat.send will use', async () => {
  await withChatDb(async (root) => {
    createClaudeSession('s-match', root);
    const calls: PrewarmCall[] = [];
    const { dependencies, spawned } = makeDependencies(calls);

    assert.equal(await handleChatPrewarm({ sessionId: 's-match', expectedProvider: 'claude', options: composerOptions() }, dependencies), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].providerSessionId, 'prov-s-match');

    await handleChatSend(
      new FakeConnection() as unknown as WebSocket,
      null,
      { sessionId: 's-match', content: 'hi', options: { ...composerOptions(), images: [] } },
      dependencies,
    );
    assert.equal(spawned.length, 1);
    // Identical except per-turn values (images are re-validated per send).
    assert.deepEqual(calls[0].options, spawned[0]);
    assert.equal(calls[0].options.permissionMode, 'acceptEdits', 'persisted session mode is applied');
    assert.equal(calls[0].options.appSessionId, 's-match');
    assert.equal(calls[0].options.sessionId, 'prov-s-match');
    assert.equal(calls[0].options.resume, true);
    assert.equal(sessionsDb.getSessionById('s-match')?.permission_mode, 'acceptEdits');
  });
});

test('chat.prewarm does not persist a requested permission mode', async () => {
  await withChatDb(async (root) => {
    createClaudeSession('s-mode', root);
    const calls: PrewarmCall[] = [];
    const { dependencies } = makeDependencies(calls);
    await handleChatPrewarm({ sessionId: 's-mode', options: composerOptions({ permissionMode: 'plan' }) }, dependencies);
    assert.equal(calls[0].options.permissionMode, 'plan');
    assert.equal(sessionsDb.getSessionById('s-mode')?.permission_mode, 'acceptEdits');
  });
});

test('chat.prewarm is a silent no-op for ineligible sessions', async () => {
  await withChatDb(async (root) => {
    createClaudeSession('s-new', root, null);
    sessionsDb.createAppSession('s-codex', 'codex', root);
    sessionsDb.assignProviderSessionId('s-codex', 'prov-codex');
    createClaudeSession('s-shell', root);
    createClaudeSession('s-iso', root);
    createClaudeSession('s-ok', root);
    const calls: PrewarmCall[] = [];
    const connection = new FakeConnection();
    const { dependencies } = makeDependencies(calls, {
      isShellSessionActive: (id: string) => id === 's-shell',
    });

    assert.equal(await handleChatPrewarm({ options: composerOptions() }, dependencies), false);
    assert.equal(await handleChatPrewarm({ sessionId: 'missing', options: composerOptions() }, dependencies), false);
    assert.equal(await handleChatPrewarm({ sessionId: 's-new', options: composerOptions() }, dependencies), false, 'no provider session yet');
    assert.equal(await handleChatPrewarm({ sessionId: 's-codex', options: composerOptions() }, dependencies), false, 'non-claude');
    assert.equal(await handleChatPrewarm({ sessionId: 's-shell', options: composerOptions() }, dependencies), false, 'Agent CLI owns it');
    assert.equal(await handleChatPrewarm({ sessionId: 's-iso', options: composerOptions({ isolatedWorkspace: true }) }, dependencies), false, 'send would use a new worktree');
    assert.equal(await handleChatPrewarm({ sessionId: 's-ok', expectedProvider: 'codex', options: composerOptions() }, dependencies), false, 'context mismatch');
    assert.equal(await handleChatPrewarm({ sessionId: 's-ok', expectedProjectId: 'other-project', options: composerOptions() }, dependencies), false, 'project mismatch');

    const release = chatRunRegistry.reservePendingSend('s-ok');
    assert.equal(await handleChatPrewarm({ sessionId: 's-ok', options: composerOptions() }, dependencies), false, 'pending send');
    release();

    assert.equal(calls.length, 0);
    assert.equal(connection.frames.length, 0, 'never replies');
  });
});

test('chat.prewarm is skipped while a run is running', async () => {
  await withChatDb(async (root) => {
    createClaudeSession('s-running', root);
    const calls: PrewarmCall[] = [];
    let finish: () => void = () => {};
    const { dependencies } = makeDependencies(calls, {
      spawnFns: {
        claude: (_content: string, _options: Record<string, unknown>, writer: { send: (m: unknown) => void }) =>
          new Promise<void>((resolve) => {
            finish = () => {
              writer.send({ kind: 'complete', provider: 'claude', sessionId: null, exitCode: 0 });
              resolve();
            };
          }),
      } as unknown as ChatWebSocketDependencies['spawnFns'],
    });
    const send = handleChatSend(
      new FakeConnection() as unknown as WebSocket,
      null,
      { sessionId: 's-running', content: 'work', options: composerOptions() },
      dependencies,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(chatRunRegistry.isProcessing('s-running'), true);
    assert.equal(await handleChatPrewarm({ sessionId: 's-running', options: composerOptions() }, dependencies), false);
    finish();
    await send;
    assert.equal(calls.length, 0);
  });
});

test('chat.prewarm kill switch and dedupe window', async () => {
  await withChatDb(async (root) => {
    createClaudeSession('s-dedupe', root);
    const calls: PrewarmCall[] = [];
    const { dependencies } = makeDependencies(calls);

    process.env.CLOUDCLI_CLAUDE_PREWARM = '0';
    assert.equal(await handleChatPrewarm({ sessionId: 's-dedupe', options: composerOptions() }, dependencies), false);
    assert.equal(calls.length, 0);
    delete process.env.CLOUDCLI_CLAUDE_PREWARM;

    await handleChatPrewarm({ sessionId: 's-dedupe', options: composerOptions() }, dependencies);
    await handleChatPrewarm({ sessionId: 's-dedupe', options: composerOptions() }, dependencies);
    assert.equal(calls.length, 1, 'identical repeat within the window is ignored');

    await handleChatPrewarm({ sessionId: 's-dedupe', options: composerOptions({ model: 'opus' }) }, dependencies);
    assert.equal(calls.length, 2, 'changed options are not a repeat');

    // Past the window the same request goes through again.
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      await handleChatPrewarm({ sessionId: 's-dedupe', options: composerOptions({ model: 'opus' }) }, dependencies);
    } finally {
      Date.now = realNow;
    }
    assert.equal(calls.length, 3);
  });
});

test('chat.prewarm swallows runtime failures', async () => {
  await withChatDb(async (root) => {
    createClaudeSession('s-fail', root);
    const { dependencies } = makeDependencies([], {
      prewarmFns: {
        claude: async () => {
          throw new Error('boom');
        },
      },
    });
    assert.equal(await handleChatPrewarm({ sessionId: 's-fail', options: composerOptions() }, dependencies), false);
  });
});
