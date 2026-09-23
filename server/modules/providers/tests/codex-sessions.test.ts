import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one Codex rollout transcript. `firstUserMessage` mirrors the
 * `event_msg`/`user_message` payload the runtime records for the prompt the
 * user typed; omitting it produces a transcript with no user turn.
 */
const writeCodexTranscript = async (
  homeDir: string,
  codexSessionId: string,
  workspacePath: string,
  firstUserMessage?: string,
): Promise<string> => {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '07');
  await mkdir(sessionsDir, { recursive: true });

  const lines: string[] = [
    JSON.stringify({ type: 'session_meta', payload: { id: codexSessionId, cwd: workspacePath } }),
  ];
  if (firstUserMessage !== undefined) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: firstUserMessage } }));
  }

  const filePath = path.join(sessionsDir, `rollout-${codexSessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('Codex synchronizer titles app-created sessions from the first user message', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-app-1', workspacePath, 'Fix the login redirect bug');
    await withIsolatedDatabase(async () => {
      // The app allocates its own id and later maps the provider id onto it,
      // exactly as a message sent from cloudcli does.
      sessionsDb.createAppSession('app-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-1', 'codex-app-1');

      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the login redirect bug');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer skips sub-agent rollout files', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-subagent-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Codex >=0.144 spawn_agent threads write their own rollout files into the
    // same sessions tree, marked via thread_source/source in session_meta.
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, 'rollout-codex-subagent-1.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'codex-subagent-1',
          cwd: workspacePath,
          thread_source: 'subagent',
          parent_thread_id: 'codex-parent-1',
          source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent-1', depth: 1 } } },
        },
      })}\n`,
      'utf8'
    );
    await writeCodexTranscript(tempRoot, 'codex-parent-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      assert.equal(processed, 1);
      assert.ok(sessionsDb.getSessionById('codex-parent-1'));
      assert.equal(sessionsDb.getSessionById('codex-subagent-1'), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer leaves indexed sessions untitled when no name is available', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // A CLI-created session has no app row; its first user message must NOT be
    // used as the title, preserving the existing indexing behavior.
    await writeCodexTranscript(tempRoot, 'codex-indexed-1', workspacePath, 'This prompt should be ignored');
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-indexed-1')?.custom_name, 'Untitled Codex Session');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const rolloutLine = (timestamp: string, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp, type, payload });

async function fetchCodexHistoryFromLines(
  lines: string[],
  options?: Parameters<CodexSessionsProvider['fetchHistory']>[1],
) {
  const scratchRoot = path.join(process.cwd(), 'tmp', 'cloudcli');
  await mkdir(scratchRoot, { recursive: true });
  const tempRoot = await mkdtemp(path.join(scratchRoot, 'codex-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const jsonlPath = path.join(tempRoot, 'rollout.jsonl');
  await writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');
  try {
    let result: Awaited<ReturnType<CodexSessionsProvider['fetchHistory']>> | undefined;
    await withIsolatedDatabase(async () => {
      const sessionId = sessionsDb.createSession('codex-history-1', 'codex', workspacePath, undefined, undefined, undefined, jsonlPath);
      result = await new CodexSessionsProvider().fetchHistory(sessionId, options);
    });
    return result!;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('Codex history renders code-mode item_completed tools once with live-matching ids', { concurrency: false }, async () => {
  const turn = 'turn-1';
  const lines = [
    rolloutLine('2026-09-22T10:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: turn }),
    rolloutLine('2026-09-22T10:00:00.100Z', 'event_msg', {
      type: 'item_completed', turn_id: turn,
      item: { type: 'UserMessage', id: 'user-item-1', content: [{ type: 'text', text: 'Fix the bug', text_elements: [] }] },
    }),
    rolloutLine('2026-09-22T10:00:01.000Z', 'response_item', {
      type: 'custom_tool_call', status: 'completed', call_id: 'call_exec_1', name: 'exec',
      input: 'const r = await tools.exec_command({ cmd: "ls" }); text(r);',
      internal_chat_message_metadata_passthrough: { turn_id: turn },
    }),
    rolloutLine('2026-09-22T10:00:01.500Z', 'event_msg', {
      type: 'item_completed', turn_id: turn,
      item: {
        type: 'CommandExecution', id: 'exec-cmd-1', command: ['/bin/zsh', '-lc', 'ls -la'],
        parsed_cmd: [{ type: 'list_files', cmd: 'ls -la' }], status: 'completed',
        exit_code: 0, aggregated_output: 'file.txt\n', stdout: 'file.txt\n',
      },
    }),
    rolloutLine('2026-09-22T10:00:01.600Z', 'event_msg', {
      type: 'item_completed', turn_id: turn,
      item: {
        type: 'CommandExecution', id: 'exec-cmd-2', command: ['/bin/zsh', '-lc', 'false'],
        status: 'failed', exit_code: 1, aggregated_output: 'boom',
      },
    }),
    rolloutLine('2026-09-22T10:00:02.000Z', 'response_item', {
      type: 'custom_tool_call_output', call_id: 'call_exec_1',
      output: [{ type: 'input_text', text: 'Script completed' }],
    }),
    rolloutLine('2026-09-22T10:00:03.000Z', 'response_item', {
      type: 'custom_tool_call', status: 'completed', call_id: 'call_exec_2', name: 'exec',
      input: 'await tools.apply_patch("*** Begin Patch")',
      internal_chat_message_metadata_passthrough: { turn_id: turn },
    }),
    rolloutLine('2026-09-22T10:00:03.500Z', 'event_msg', {
      type: 'item_completed', turn_id: turn,
      item: {
        type: 'FileChange', id: 'exec-file-1', status: 'completed',
        changes: { '/repo/src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@', move_path: null } },
        stdout: 'Success. Updated the following files:\nM /repo/src/a.ts\n',
      },
    }),
    rolloutLine('2026-09-22T10:00:03.600Z', 'event_msg', {
      type: 'item_completed', turn_id: turn,
      item: {
        type: 'McpToolCall', id: 'exec-mcp-1', server: 'obsidian', tool: 'obsidian_get_file',
        arguments: { filename: 'Notes.md' }, status: 'completed',
        result: { content: [{ type: 'text', text: 'note body' }] },
      },
    }),
    rolloutLine('2026-09-22T10:00:03.700Z', 'event_msg', {
      type: 'item_completed', turn_id: turn,
      item: { type: 'Reasoning', id: 'reasoning-1', summary_text: ['thinking'], raw_content: [] },
    }),
    rolloutLine('2026-09-22T10:00:03.800Z', 'event_msg', {
      type: 'item_completed', turn_id: turn,
      item: { type: 'AgentMessage', id: 'agent-1', content: [{ type: 'Text', text: 'Done' }], phase: 'final_answer' },
    }),
    rolloutLine('2026-09-22T10:00:04.000Z', 'response_item', {
      type: 'custom_tool_call_output', call_id: 'call_exec_2', output: 'Script completed',
    }),
    rolloutLine('2026-09-22T10:00:05.000Z', 'response_item', {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Done' }],
    }),
    rolloutLine('2026-09-22T10:00:05.100Z', 'event_msg', { type: 'task_complete', turn_id: turn }),
    // A later turn whose exec produced no nested tool items keeps its exec row.
    rolloutLine('2026-09-22T10:01:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-2' }),
    rolloutLine('2026-09-22T10:01:01.000Z', 'response_item', {
      type: 'custom_tool_call', status: 'completed', call_id: 'call_exec_3', name: 'exec',
      input: 'text(1 + 1)', internal_chat_message_metadata_passthrough: { turn_id: 'turn-2' },
    }),
    rolloutLine('2026-09-22T10:01:02.000Z', 'response_item', {
      type: 'custom_tool_call_output', call_id: 'call_exec_3', output: '2',
    }),
  ];

  const result = await fetchCodexHistoryFromLines(lines);
  const tools = result.messages.filter((message) => message.kind === 'tool_use');

  assert.deepEqual(
    tools.map((message) => [message.toolName, message.toolId]),
    [
      ['Bash', 'exec-cmd-1'],
      ['Bash', 'exec-cmd-2'],
      ['FileChanges', 'exec-file-1'],
      ['obsidian_get_file', 'exec-mcp-1'],
      ['exec', 'call_exec_3'],
    ],
  );
  const [ls, failing, fileChange, mcp, keptExec] = tools;
  assert.deepEqual(ls.toolInput, { command: 'ls -la' });
  assert.deepEqual(ls.toolResult, { content: 'file.txt\n', isError: false });
  assert.deepEqual(failing.toolResult, { content: 'boom', isError: true });
  assert.deepEqual(fileChange.toolInput, {
    changes: [{ path: '/repo/src/a.ts', kind: 'update', diff: '@@ -1 +1 @@' }],
    file_path: '/repo/src/a.ts',
  });
  assert.equal(fileChange.toolResult?.isError, false);
  assert.deepEqual(mcp.toolInput, { filename: 'Notes.md' });
  assert.equal(mcp.toolResult?.content, JSON.stringify({ content: [{ type: 'text', text: 'note body' }] }));
  assert.deepEqual(keptExec.toolResult, { content: '2', isError: false });

  // UserMessage becomes the user row (no legacy user_message event exists);
  // AgentMessage/Reasoning items are not duplicated.
  const users = result.messages.filter((message) => message.kind === 'text' && message.role === 'user');
  assert.deepEqual(users.map((message) => message.content), ['Fix the bug']);
  const assistants = result.messages.filter((message) => message.kind === 'text' && message.role === 'assistant');
  assert.deepEqual(assistants.map((message) => message.content), ['Done']);
  assert.equal(result.messages.some((message) => message.kind === 'thinking'), false);
});

test('Codex history prefers legacy user_message events over UserMessage items', { concurrency: false }, async () => {
  const result = await fetchCodexHistoryFromLines([
    rolloutLine('2026-09-01T10:00:00.000Z', 'event_msg', { type: 'user_message', message: 'Hello', kind: 'plain' }),
    rolloutLine('2026-09-01T10:00:00.001Z', 'event_msg', {
      type: 'item_completed', turn_id: 't',
      item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Hello' }] },
    }),
  ]);
  const users = result.messages.filter((message) => message.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].content, 'Hello');
});

test('Codex history total counts the same rows offset/limit page over (tool results included)', { concurrency: false }, async () => {
  const lines = [
    rolloutLine('2026-09-02T10:00:00.000Z', 'event_msg', { type: 'user_message', message: 'run it', kind: 'plain' }),
    rolloutLine('2026-09-02T10:00:01.000Z', 'response_item', {
      type: 'function_call', call_id: 'call_a', name: 'shell', arguments: JSON.stringify({ command: ['ls'] }),
    }),
    rolloutLine('2026-09-02T10:00:02.000Z', 'response_item', {
      type: 'function_call_output', call_id: 'call_a', output: 'file.txt',
    }),
    rolloutLine('2026-09-02T10:00:03.000Z', 'response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }],
    }),
  ];

  const full = await fetchCodexHistoryFromLines(lines);
  assert.ok(full.messages.some((message) => message.kind === 'tool_result'), 'fixture must include a tool_result row');
  assert.equal(full.total, full.messages.length);

  // Paging the tail by `total` rows must reach the start of history exactly.
  const tail = await fetchCodexHistoryFromLines(lines, { limit: 2, offset: 0 });
  const head = await fetchCodexHistoryFromLines(lines, { limit: 2, offset: full.total - 2 });
  assert.equal(tail.total, full.total);
  assert.equal(head.hasMore, false);
  assert.equal(head.messages.length + (full.total - 2), full.total);
});
