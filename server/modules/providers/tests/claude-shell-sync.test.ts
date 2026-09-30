import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  claudeProjectDirectory,
  parseClaudeShellRuntime,
  resolveClaudeShellTranscript,
  syncClaudeShellSession,
} from '@/modules/providers/list/claude/claude-shell-sync.js';

type Harness = { projectsRoot: string; projectPath: string; projectDir: string };

async function withHarness(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-shell-sync-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const projectsRoot = path.join(tempDirectory, 'projects');
  const projectPath = path.join(tempDirectory, 'workspace demo');
  const projectDir = claudeProjectDirectory(projectPath, projectsRoot);
  await mkdir(projectPath, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  try {
    await runTest({ projectsRoot, projectPath, projectDir });
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

const SHELL_PROMPT = 'explain the "session" watcher';

async function writeTranscript(
  projectDir: string,
  sessionId: string,
  cwd: string,
  prompt: string = SHELL_PROMPT,
): Promise<string> {
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await writeFile(filePath, `${JSON.stringify({ type: 'user', sessionId, cwd, message: { content: prompt } })}\n`);
  return filePath;
}

test('reads model, effort and permission mode written since the PTY started', () => {
  const lines = [
    { timestamp: '2026-09-23T10:00:00.000Z', type: 'assistant', effort: 'low', message: { model: 'claude-old' } },
    { timestamp: '2026-09-23T10:05:00.000Z', type: 'user', permissionMode: 'plan' },
    { timestamp: '2026-09-23T10:05:01.000Z', type: 'assistant', effort: 'high', message: { model: 'claude-opus-5-5' } },
    { timestamp: '2026-09-23T10:05:02.000Z', type: 'assistant', isSidechain: true, message: { model: 'claude-haiku' } },
    { timestamp: '2026-09-23T10:05:03.000Z', type: 'assistant', message: { model: '<synthetic>' } },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  assert.deepEqual(
    parseClaudeShellRuntime(lines, { since: Date.parse('2026-09-23T10:01:00.000Z') }),
    { permissionMode: 'plan', model: 'claude-opus-5-5', effort: 'high' },
  );
  assert.equal(parseClaudeShellRuntime(lines, { since: Date.parse('2026-09-23T11:00:00.000Z') }), null);
});

test('a transcript the shell created is adopted onto the unmapped app session', async () => {
  await withHarness(async ({ projectsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'claude', projectPath);
    await writeTranscript(projectDir, 'claude-tui-1', projectPath);

    const result = await syncClaudeShellSession({
      appSessionId: 'app-1',
      projectPath,
      startedAt: Date.now() - 1_000,
      projectsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.deepEqual(result, { appSessionId: 'app-1', providerSessionId: 'claude-tui-1', adopted: true });
    assert.equal(sessionsDb.getSessionById('app-1')?.provider_session_id, 'claude-tui-1');
    // The watcher-style placeholder row was merged away.
    assert.equal(sessionsDb.getSessionById('claude-tui-1'), null);
  });
});

test('two shell-created transcripts are ambiguous and left unbound', async () => {
  await withHarness(async ({ projectsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'claude', projectPath);
    await writeTranscript(projectDir, 'claude-a', projectPath);
    await writeTranscript(projectDir, 'claude-b', projectPath);

    const result = await syncClaudeShellSession({
      appSessionId: 'app-1',
      projectPath,
      startedAt: Date.now() - 1_000,
      projectsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(sessionsDb.getSessionById('app-1')?.provider_session_id, null);
  });
});

test('an existing mapping is reported for an upsert but never overwritten', async () => {
  await withHarness(async ({ projectsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'claude', projectPath);
    sessionsDb.assignProviderSessionId('app-1', 'claude-mapped');
    await writeTranscript(projectDir, 'claude-other', projectPath);

    const result = await syncClaudeShellSession({
      appSessionId: 'app-1',
      projectPath,
      startedAt: Date.now() - 1_000,
      projectsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.deepEqual(result, { appSessionId: 'app-1', providerSessionId: 'claude-mapped', adopted: false });
    assert.equal(sessionsDb.getSessionById('app-1')?.provider_session_id, 'claude-mapped');
  });
});

test('transcripts created before the PTY started are ignored', async () => {
  await withHarness(async ({ projectsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'claude', projectPath);
    await writeTranscript(projectDir, 'claude-old', projectPath);

    const result = await syncClaudeShellSession({
      appSessionId: 'app-1',
      projectPath,
      startedAt: Date.now() + 60_000,
      projectsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(
      resolveClaudeShellTranscript({ appSessionId: 'app-1', projectPath, startedAt: Date.now() + 60_000, projectsRoot }),
      null,
    );
  });
});

test('an explicit /model is reported once an assistant reply follows it', () => {
  const lines = [
    { timestamp: '2026-09-23T10:05:00.000Z', type: 'assistant', message: { model: 'claude-opus-5-5' } },
    {
      timestamp: '2026-09-23T10:05:01.000Z',
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/model</command-name>\n<command-args>haiku</command-args>',
    },
  ].map((entry) => JSON.stringify(entry));
  assert.deepEqual(parseClaudeShellRuntime(lines.join('\n')), { model: 'claude-opus-5-5' });
  const followed = [
    ...lines,
    JSON.stringify({ timestamp: '2026-09-23T10:05:05.000Z', type: 'assistant', message: { model: 'claude-haiku-5' } }),
  ].join('\n');
  assert.deepEqual(parseClaudeShellRuntime(followed), {
    model: 'claude-haiku-5',
    modelCommandAt: Date.parse('2026-09-23T10:05:01.000Z'),
  });
});

test('an external Claude CLI session in the same project is not adopted', async () => {
  await withHarness(async ({ projectsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'claude', projectPath);
    // Another terminal ran `claude` in this project while the PTY was alive.
    await writeTranscript(projectDir, 'claude-external', projectPath, 'what does the build script do');

    const result = await syncClaudeShellSession({
      appSessionId: 'app-1',
      projectPath,
      startedAt: Date.now() - 1_000,
      projectsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(sessionsDb.getSessionById('app-1')?.provider_session_id, null);
    // Its disk-indexed row is left alone.
    assert.equal(sessionsDb.getSessionById('claude-external')?.provider_session_id, 'claude-external');
  });
});

test('a concurrent Chatbar run in the same project is not adopted', async () => {
  await withHarness(async ({ projectsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-shell', 'claude', projectPath);
    // A chat run in another session whose provider id is not mapped yet.
    sessionsDb.createAppSession('app-chat', 'claude', projectPath);
    await writeTranscript(projectDir, 'claude-chat-run', projectPath, 'summarize the open pull requests');

    const unmatched = await syncClaudeShellSession({
      appSessionId: 'app-shell',
      projectPath,
      startedAt: Date.now() - 1_000,
      projectsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });
    assert.equal(unmatched, null);

    // Once the shell's own transcript exists, only that one is adopted.
    await writeTranscript(projectDir, 'claude-tui', projectPath);
    const adopted = await syncClaudeShellSession({
      appSessionId: 'app-shell',
      projectPath,
      startedAt: Date.now() - 1_000,
      projectsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });
    assert.deepEqual(adopted, { appSessionId: 'app-shell', providerSessionId: 'claude-tui', adopted: true });
    assert.equal(sessionsDb.getSessionById('app-chat')?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById('claude-chat-run')?.provider_session_id, 'claude-chat-run');
  });
});

test('no typed prompt means no adoption', async () => {
  await withHarness(async ({ projectsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'claude', projectPath);
    await writeTranscript(projectDir, 'claude-tui-1', projectPath);

    for (const submittedPrompts of [undefined, [], ['hi'], ['/model']]) {
      const result = await syncClaudeShellSession({
        appSessionId: 'app-1',
        projectPath,
        startedAt: Date.now() - 1_000,
        projectsRoot,
        submittedPrompts,
      });
      assert.equal(result, null);
    }
    assert.equal(sessionsDb.getSessionById('app-1')?.provider_session_id, null);
  });
});

test('a placeholder row indexed before the PTY spawned is never merged away', async () => {
  await withHarness(async ({ projectsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'claude', projectPath);
    const filePath = await writeTranscript(projectDir, 'claude-preexisting', projectPath);
    // Indexed (and born) well before this PTY spawned, e.g. via the watcher.
    sessionsDb.createSession(
      'claude-preexisting',
      'claude',
      projectPath,
      'Earlier session',
      new Date(Date.now() - 10 * 60_000).toISOString(),
      new Date(Date.now() - 10 * 60_000).toISOString(),
      filePath,
    );

    const result = await syncClaudeShellSession({
      appSessionId: 'app-1',
      projectPath,
      startedAt: Date.now() + 5_000,
      projectsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(sessionsDb.getSessionById('claude-preexisting')?.provider_session_id, 'claude-preexisting');
    assert.equal(sessionsDb.getSessionById('app-1')?.provider_session_id, null);
  });
});
