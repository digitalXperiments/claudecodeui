import { EventEmitter } from 'node:events';
import os from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { resolveAcpCliCommand } from '@/shared/acp-cli-path.js';
import {
  buildShellCommand,
  isAgentShellRequestWithExistingSession,
  waitForChatbarRunIfNeeded,
  type ShellIncomingMessage,
  type ShellWebSocketDependencies,
} from '@/modules/websocket/services/shell-websocket.service.js';

const dependencies = {
  resolveProviderSessionId: (sessionId: string) => sessionId,
  stripAnsiSequences: (content: string) => content,
  normalizeDetectedUrl: (url: string) => url,
  extractUrlsFromText: () => [],
  shouldAutoOpenUrlFromOutput: () => false,
} satisfies ShellWebSocketDependencies;

class TestShellSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly frames: string[] = [];

  send(frame: string): void {
    this.frames.push(frame);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

function build(message: ShellIncomingMessage): string {
  return buildShellCommand({ type: 'init', ...message }, dependencies);
}

test('claude maps non-default modes onto --permission-mode', () => {
  assert.equal(
    build({ provider: 'claude', permissionMode: 'plan' }),
    'claude --permission-mode plan',
  );
  assert.equal(
    build({ provider: 'claude', permissionMode: 'bypassPermissions' }),
    'claude --permission-mode bypassPermissions',
  );
  assert.equal(build({ provider: 'claude', permissionMode: 'default' }), 'claude');
  assert.equal(
    build({ provider: 'claude', hasSession: true, sessionId: 'abc', permissionMode: 'auto' }),
    'claude --resume "abc" --permission-mode auto || claude --permission-mode auto',
  );
});

test('kimi maps modes onto its start-in-mode flags', () => {
  assert.equal(build({ provider: 'kimi', permissionMode: 'plan' }), 'kimi --plan');
  assert.equal(build({ provider: 'kimi', permissionMode: 'auto' }), 'kimi --auto');
  assert.equal(build({ provider: 'kimi', permissionMode: 'bypassPermissions' }), 'kimi --yolo');
  assert.equal(build({ provider: 'kimi', permissionMode: 'default' }), 'kimi');
  assert.equal(
    build({ provider: 'kimi', hasSession: true, sessionId: 's1', permissionMode: 'plan' }),
    'kimi --session="s1" --plan',
  );
});

test('codex maps modes onto -c sandbox/approval overrides', () => {
  assert.equal(
    build({ provider: 'codex', permissionMode: 'bypassPermissions' }),
    'codex -c sandbox_mode="danger-full-access" -c approval_policy="never"',
  );
  assert.equal(
    build({ provider: 'codex', hasSession: true, sessionId: 'c1', permissionMode: 'auto' }),
    'codex resume "c1" -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="never" || codex -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="never"',
  );
  assert.equal(
    build({ provider: 'codex', hasSession: true, sessionId: 'c1', permissionMode: 'acceptEdits' }),
    'codex resume "c1" -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="never" || codex -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="never"',
  );
});

test('cursor only exposes -f for bypassPermissions', () => {
  assert.equal(build({ provider: 'cursor', permissionMode: 'bypassPermissions' }), 'cursor-agent -f');
  assert.equal(build({ provider: 'cursor', permissionMode: 'default' }), 'cursor-agent');
});

test('opencode mirrors resolveOpenCodePermissionOptions', () => {
  assert.equal(build({ provider: 'opencode', permissionMode: 'plan' }), 'opencode --agent plan');
  assert.equal(build({ provider: 'opencode', permissionMode: 'auto' }), 'opencode --auto');
  assert.equal(
    build({ provider: 'opencode', permissionMode: 'bypassPermissions' }),
    'opencode --auto',
  );
  const acceptEdits = build({ provider: 'opencode', permissionMode: 'acceptEdits' });
  assert.ok(acceptEdits.includes('OPENCODE_PERMISSION'));
  assert.ok(acceptEdits.includes('opencode'));
});

test('kilo maps ACP permission modes onto KILO_PERMISSION or --auto', () => {
  // The shell command resolves the kilo binary (PATH first, then ~/.kilo/bin)
  // so a PTY without the user's shell profile still finds it.
  const kiloBin = os.platform() === 'win32' ? 'kilo' : `'${resolveAcpCliCommand('kilo')}'`;
  assert.equal(build({ provider: 'kilo', permissionMode: 'auto' }), `${kiloBin} --auto`);
  assert.equal(build({ provider: 'kilo', permissionMode: 'bypassPermissions' }), `${kiloBin} --auto`);
  const acceptEdits = build({ provider: 'kilo', permissionMode: 'acceptEdits' });
  assert.ok(acceptEdits.includes('KILO_PERMISSION'));
  assert.ok(acceptEdits.includes('kilo'));
  assert.equal(
    build({ provider: 'kilo', hasSession: true, sessionId: 'k1', permissionMode: 'plan' }),
    `KILO_PERMISSION='{"edit":"ask","bash":"ask","webfetch":"ask","external_directory":"ask"}' ${kiloBin} --session "k1"`,
  );
});

test('pi restricts tools in plan mode only', () => {
  assert.equal(
    build({ provider: 'pi', permissionMode: 'plan' }),
    'pi --tools read,grep,find,ls',
  );
  assert.equal(build({ provider: 'pi', permissionMode: 'bypassPermissions' }), 'pi');
});

// Grok is intentionally not covered here: buildGrokShellCommand resolves a
// managed GROK_HOME on disk (ensureManagedGrokHome), which is a filesystem
// side effect outside the repo.

test('invalid or missing modes add no flags', () => {
  assert.equal(build({ provider: 'claude' }), 'claude');
  assert.equal(build({ provider: 'claude', permissionMode: 'not-a-mode' }), 'claude');
  assert.equal(build({ provider: 'kimi', permissionMode: 'acceptEdits' }), 'kimi');
});

test('plain shells ignore the permission mode', () => {
  assert.equal(
    build({ isPlainShell: true, initialCommand: 'bash', permissionMode: 'plan' }),
    'bash',
  );
});

test('identifies every provider-backed shell with an existing session', () => {
  for (const provider of ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'grok', 'kimi', 'pi']) {
    assert.equal(
      isAgentShellRequestWithExistingSession({
        provider,
        hasSession: true,
        sessionId: `${provider}-session`,
      }),
      true,
      provider,
    );
  }
});

test('does not identify plain shells or requests without an existing session', () => {
  assert.equal(
    isAgentShellRequestWithExistingSession({
      provider: 'claude',
      isPlainShell: true,
      hasSession: true,
      sessionId: 'plain-session',
    }),
    false,
  );
  assert.equal(
    isAgentShellRequestWithExistingSession({
      provider: 'plain-shell',
      hasSession: true,
      sessionId: 'plain-session',
    }),
    false,
  );
  assert.equal(
    isAgentShellRequestWithExistingSession({
      provider: 'claude',
      initialCommand: 'bash',
      hasSession: false,
    }),
    false,
  );
  assert.equal(
    isAgentShellRequestWithExistingSession({ provider: 'claude', hasSession: false }),
    false,
  );
  assert.equal(
    isAgentShellRequestWithExistingSession({ provider: 'claude', hasSession: true }),
    false,
  );
});

test('waits for an active Chatbar run and then permits Shell continuation', async () => {
  const socket = new TestShellSocket();
  let active = true;
  let releaseIdle: (() => void) | undefined;
  const idle = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });
  let waitCalled = false;

  const result = waitForChatbarRunIfNeeded(
    socket as unknown as WebSocket,
    { provider: 'claude', hasSession: true, sessionId: 'app-session-1' },
    {
      ...dependencies,
      isChatbarRunActive: () => active,
      waitForChatbarRunIdle: async () => {
        waitCalled = true;
        await idle;
        active = false;
      },
    },
  );

  assert.equal(waitCalled, true);
  assert.equal(socket.frames.length, 1);
  const waitingFrame = JSON.parse(socket.frames[0]) as { type: string; data: string };
  assert.equal(waitingFrame.type, 'output');
  assert.match(waitingFrame.data, /\x1b\[33m\[Shell waiting\]/);

  let continued = false;
  void result.then(() => {
    continued = true;
  });
  await Promise.resolve();
  assert.equal(continued, false);

  releaseIdle?.();
  assert.equal(await result, true);
  assert.equal(continued, true);
});

test('fails closed when the Shell socket closes or no idle hook exists', async () => {
  const closedSocket = new TestShellSocket();
  let releaseIdle: (() => void) | undefined;
  const idle = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });
  const closedResult = waitForChatbarRunIfNeeded(
    closedSocket as unknown as WebSocket,
    { provider: 'codex', hasSession: true, sessionId: 'app-session-2' },
    {
      ...dependencies,
      isChatbarRunActive: () => true,
      waitForChatbarRunIdle: () => idle,
    },
  );
  closedSocket.close();
  assert.equal(await closedResult, false);
  releaseIdle?.();

  const noWaitHookSocket = new TestShellSocket();
  const noWaitHookResult = await waitForChatbarRunIfNeeded(
    noWaitHookSocket as unknown as WebSocket,
    { provider: 'pi', hasSession: true, sessionId: 'app-session-3' },
    {
      ...dependencies,
      isChatbarRunActive: () => true,
    },
  );
  assert.equal(noWaitHookResult, false);
  assert.equal(noWaitHookSocket.frames.length, 1);
});
