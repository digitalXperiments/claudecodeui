import { EventEmitter } from 'node:events';
import os from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { resolveAcpCliCommand } from '@/shared/acp-cli-path.js';
import {
  buildShellCommand,
  claudeModelMatchesAlias,
  createShellPromptInputState,
  diffShellRuntime,
  readSafeShellRuntimeValue,
  trackShellPromptInput,
  isAgentShellRequestWithExistingSession,
  resizeShellForReconnect,
  shouldStartFreshShellSession,
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
    "claude --permission-mode 'plan'",
  );
  assert.equal(
    build({ provider: 'claude', permissionMode: 'bypassPermissions' }),
    "claude --permission-mode 'bypassPermissions'",
  );
  assert.equal(build({ provider: 'claude', permissionMode: 'default' }), 'claude');
  assert.equal(
    build({ provider: 'claude', hasSession: true, sessionId: 'abc', permissionMode: 'auto' }),
    `claude --resume "abc" --permission-mode 'auto' || claude --permission-mode 'auto'`,
  );
});

test('claude launches with the chatbar model and effort', () => {
  assert.equal(
    build({ provider: 'claude', model: 'opus[1m]', effort: 'high' }),
    "claude --model 'opus[1m]' --effort 'high'",
  );
  assert.equal(
    build({ provider: 'claude', hasSession: true, sessionId: 'abc', model: 'sonnet', permissionMode: 'plan' }),
    `claude --resume "abc" --permission-mode 'plan' --model 'sonnet' || claude --permission-mode 'plan' --model 'sonnet'`,
  );
  // The provider default and unknown efforts add no flags.
  assert.equal(build({ provider: 'claude', model: 'default', effort: 'default' }), 'claude');
  assert.equal(build({ provider: 'claude', effort: 'turbo' }), 'claude');
});

test('opencode launches with the chatbar provider/model', () => {
  assert.equal(
    build({ provider: 'opencode', permissionMode: 'plan', model: 'anthropic/claude-sonnet-4-5' }),
    "opencode --agent plan -m 'anthropic/claude-sonnet-4-5'",
  );
  assert.equal(
    build({ provider: 'opencode', hasSession: true, sessionId: 'ses_1', model: 'openai/gpt-5' }),
    `opencode --session "ses_1" -m 'openai/gpt-5'`,
  );
});

test('antigravity explains why the shell cannot resume Chat sessions', () => {
  assert.match(build({ provider: 'antigravity', hasSession: true, sessionId: 'abc' }), /^echo "/);
});

test('shell runtime diff never echoes the launch preferences back to chat', () => {
  const session = {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    fastMode: false,
    permissionMode: 'default',
  } as Parameters<typeof diffShellRuntime>[0];
  assert.equal(
    diffShellRuntime(session, { model: 'gpt-5.6-sol', effort: 'high', fastMode: false, permissionMode: 'default' }),
    null,
  );
  // A later /model in the TUI is reported once.
  assert.deepEqual(diffShellRuntime(session, { model: 'gpt-5.6-luna', effort: 'high' }), { model: 'gpt-5.6-luna' });
  assert.equal(diffShellRuntime(session, { model: 'gpt-5.6-luna' }), null);
  assert.deepEqual(diffShellRuntime(session, { permissionMode: 'bypassPermissions' }), { permissionMode: 'bypassPermissions' });
});

test('shell runtime diff records unset or aliased launch values silently first', () => {
  const session = {
    provider: 'claude',
    model: 'opus',
    effort: 'default',
    permissionMode: 'default',
  } as Parameters<typeof diffShellRuntime>[0];
  // `opus` resolves to a concrete id and `default` effort to a real level.
  assert.equal(diffShellRuntime(session, { model: 'claude-opus-5-5', effort: 'medium' }), null);
  assert.deepEqual(
    diffShellRuntime(session, { model: 'claude-sonnet-5', effort: 'high' }),
    { model: 'claude-sonnet-5', effort: 'high' },
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
    'codex resume "c1" -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="on-request" || codex -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="on-request"',
  );
  assert.equal(
    build({ provider: 'codex', hasSession: true, sessionId: 'c1', permissionMode: 'acceptEdits' }),
    'codex resume "c1" -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="on-request" || codex -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="on-request"',
  );
  assert.equal(
    build({ provider: 'codex', fastMode: true }),
    'codex -c service_tier="fast"',
  );
  assert.equal(
    build({ provider: 'codex', hasSession: true, sessionId: 'c1', fastMode: false }),
    'codex resume "c1" -c service_tier="default" || codex -c service_tier="default"',
  );
  assert.equal(
    build({ provider: 'codex', permissionMode: 'auto' }),
    'codex -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="on-request"',
  );
  assert.equal(
    build({ provider: 'codex', model: 'gpt-5.6-luna', effort: 'high', fastMode: true }),
    `codex -m 'gpt-5.6-luna' -c model_reasoning_effort='high' -c service_tier="fast"`,
  );
});

test('grok launches with the chatbar model and reasoning effort', () => {
  const command = build({
    provider: 'grok',
    permissionMode: 'default',
    model: 'grok-4.7-build-fast',
    effort: 'xhigh',
  });
  assert.match(command, /grok /);
  assert.match(command, /--model 'grok-4\.7-build-fast'/);
  assert.match(command, /--reasoning-effort 'xhigh'/);
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

test('cline launches its interactive TUI and resumes with --id', () => {
  const clineBin = os.platform() === 'win32' ? 'cline' : `'${resolveAcpCliCommand('cline')}'`;
  assert.equal(build({ provider: 'cline' }), `${clineBin} --tui`);
  assert.equal(
    build({ provider: 'cline', hasSession: true, sessionId: 'cl1' }),
    `${clineBin} --tui --id "cl1"`,
  );
});

test('qwen maps interactive resume and approval modes', () => {
  const qwenBin = os.platform() === 'win32' ? 'qwen' : `'${resolveAcpCliCommand('qwen')}'`;
  assert.equal(build({ provider: 'qwencode' }), qwenBin);
  assert.equal(build({ provider: 'qwencode', permissionMode: 'plan' }), `${qwenBin} --approval-mode 'plan'`);
  assert.equal(build({ provider: 'qwencode', permissionMode: 'auto' }), `${qwenBin} --approval-mode 'auto'`);
  assert.equal(build({ provider: 'qwencode', permissionMode: 'bypassPermissions' }), `${qwenBin} --yolo`);
  assert.equal(
    build({ provider: 'qwencode', hasSession: true, sessionId: 'q1', permissionMode: 'auto' }),
    `${qwenBin} --resume "q1" --approval-mode 'auto'`,
  );
});

test('pi restricts tools in plan mode only', () => {
  assert.equal(
    build({ provider: 'pi', permissionMode: 'plan' }),
    'pi --tools read,grep,find,ls',
  );
  assert.equal(build({ provider: 'pi', permissionMode: 'bypassPermissions' }), 'pi');
});

test('omp restricts tools in plan mode and yolos on bypass', () => {
  assert.equal(
    build({ provider: 'omp', permissionMode: 'plan' }),
    'omp --tools read,grep,glob',
  );
  assert.equal(
    build({ provider: 'omp', permissionMode: 'bypassPermissions' }),
    'omp --approval-mode yolo',
  );
  assert.equal(
    build({ provider: 'omp', hasSession: true, sessionId: 'o1', permissionMode: 'bypassPermissions' }),
    'omp --resume "o1" --approval-mode yolo',
  );
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
  for (const provider of ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'qwencode', 'pi', 'omp']) {
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

test('ordinary Agent CLI navigation reconnects instead of restarting its PTY', () => {
  assert.equal(shouldStartFreshShellSession(false, false), false);
  assert.equal(shouldStartFreshShellSession(true, false), true);
  assert.equal(shouldStartFreshShellSession(false, true), true);
});

test('reconnecting an Agent CLI forces a TUI repaint before restoring its requested size', () => {
  const sizes: Array<[number, number]> = [];
  resizeShellForReconnect(
    { resize: (cols, rows) => sizes.push([cols, rows]) },
    100,
    30,
    true,
  );

  assert.deepEqual(sizes, [[99, 30], [100, 30]]);
});

test('reconnecting a plain shell resizes only to its requested size', () => {
  const sizes: Array<[number, number]> = [];
  resizeShellForReconnect(
    { resize: (cols, rows) => sizes.push([cols, rows]) },
    100,
    30,
    false,
  );

  assert.deepEqual(sizes, [[100, 30]]);
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

test('model / effort values that could break out of the shell command are dropped', () => {
  const hostile = ['$(touch x)', '`touch x`', "x'; touch x; '", 'a b', 'gpt"; touch x; "'];
  for (const value of hostile) {
    for (const provider of ['claude', 'codex', 'grok', 'opencode']) {
      const command = build({ provider, model: value, effort: value });
      assert.ok(!command.includes('touch'), `${provider} kept ${value}: ${command}`);
      assert.ok(!command.includes('$('), `${provider} kept ${value}: ${command}`);
      assert.ok(!command.includes('`'), `${provider} kept ${value}: ${command}`);
    }
  }
  // Legitimate ids still pass, quoted.
  assert.equal(
    build({ provider: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh' }),
    "codex -m 'gpt-5.6-luna' -c model_reasoning_effort='xhigh'",
  );
  assert.equal(readSafeShellRuntimeValue('us.anthropic.claude-opus-5:1@v2+x'), 'us.anthropic.claude-opus-5:1@v2+x');
  assert.equal(readSafeShellRuntimeValue('opus[1m]'), 'opus[1m]');
  assert.equal(readSafeShellRuntimeValue('$(id)'), '');
  assert.equal(readSafeShellRuntimeValue('default'), '');
});

test('claude model flips under opusplan are not reported; an explicit /model is', () => {
  const session = {
    provider: 'claude',
    model: 'opusplan',
    effort: 'default',
    permissionMode: 'default',
  } as Parameters<typeof diffShellRuntime>[0];
  assert.equal(diffShellRuntime(session, { model: 'claude-opus-5-5' }), null);
  // Plan mode off → sonnet answers: same alias family, not a user choice.
  assert.equal(diffShellRuntime(session, { model: 'claude-sonnet-5' }), null);
  assert.equal(diffShellRuntime(session, { model: 'claude-opus-5-5' }), null);
  // The user ran `/model haiku` in the TUI.
  assert.deepEqual(
    diffShellRuntime(session, { model: 'claude-haiku-5', modelCommandAt: 1_000 }),
    { model: 'claude-haiku-5' },
  );
  // The same command is not reported twice.
  assert.equal(diffShellRuntime(session, { model: 'claude-haiku-5', modelCommandAt: 1_000 }), null);
  // A `/model opus` that stays in the launch family is still reported.
  const opus = { provider: 'claude', model: 'opus' } as Parameters<typeof diffShellRuntime>[0];
  assert.equal(diffShellRuntime(opus, { model: 'claude-opus-5-5' }), null);
  assert.deepEqual(
    diffShellRuntime(opus, { model: 'claude-opus-5-5', modelCommandAt: 2_000 }),
    { model: 'claude-opus-5-5' },
  );
  assert.equal(claudeModelMatchesAlias('claude-opus-5-5', 'opus[1m]'), true);
  assert.equal(claudeModelMatchesAlias('claude-sonnet-5', 'opus'), false);
  assert.equal(claudeModelMatchesAlias('claude-sonnet-5', undefined), true);
});

test('prompt tracker reconstructs submitted lines from raw keystrokes', () => {
  const state = createShellPromptInputState();
  trackShellPromptInput(state, 'fix the bug');
  trackShellPromptInput(state, 'x\x7f');
  trackShellPromptInput(state, ' in parser\r');
  trackShellPromptInput(state, '\x1b[A\x1b[B');
  trackShellPromptInput(state, '\x1b[200~line one\nline two\x1b[201~\r');
  trackShellPromptInput(state, 'discard me\x03');
  trackShellPromptInput(state, 'first\x1b\rsecond\r');
  assert.deepEqual(state.submittedPrompts, [
    'fix the bug in parser',
    'line one\nline two',
    'first\nsecond',
  ]);
});
