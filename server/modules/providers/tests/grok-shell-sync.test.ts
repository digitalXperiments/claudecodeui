import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  readGrokSessionRuntime,
  readLatestGrokSessionRuntime,
  syncGrokShellSession,
} from '@/modules/providers/list/grok/grok-shell-sync.js';

type Harness = {
  sessionsRoot: string;
  projectPath: string;
  projectDir: string;
  cleanup: () => Promise<void>;
};

async function withHarness(runTest: (harness: Harness) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'grok-shell-sync-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const sessionsRoot = path.join(tempDirectory, 'sessions');
  const projectPath = path.join(tempDirectory, 'workspace demo');
  const projectDir = path.join(sessionsRoot, encodeURIComponent(path.resolve(projectPath)));
  await mkdir(projectDir, { recursive: true });

  try {
    await runTest({ sessionsRoot, projectPath, projectDir, cleanup: async () => {} });
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

const SHELL_PROMPT = 'refactor the parser module';

async function touchSessionDir(projectDir: string, sessionId: string, mtime: Date, prompt = SHELL_PROMPT): Promise<void> {
  const dir = path.join(projectDir, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'chat_history.jsonl'),
    `${JSON.stringify({ type: 'user', content: `<user_query>${prompt}</user_query>` })}\n`,
  );
  await utimes(dir, mtime, mtime);
}

test('shell-created session is adopted onto the app session mapping', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'grok', projectPath);

    const startedAt = Date.now() - 60_000;
    await touchSessionDir(projectDir, 'grok-tui-1', new Date());

    const result = await syncGrokShellSession({
      appSessionId: 'app-1',
      projectPath,
      startedAt,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.deepEqual(result, {
      appSessionId: 'app-1',
      providerSessionId: 'grok-tui-1',
      adopted: true,
    });
    assert.equal(sessionsDb.getSessionById('app-1')?.provider_session_id, 'grok-tui-1');
  });
});

test('already-mapped session touched by the shell is reported without remap', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-2', 'grok', projectPath);
    sessionsDb.assignProviderSessionId('app-2', 'grok-shared');

    const startedAt = Date.now() - 60_000;
    await touchSessionDir(projectDir, 'grok-shared', new Date());

    const result = await syncGrokShellSession({
      appSessionId: 'app-2',
      projectPath,
      startedAt,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.deepEqual(result, {
      appSessionId: 'app-2',
      providerSessionId: 'grok-shared',
      adopted: false,
    });
    assert.equal(sessionsDb.getSessionById('app-2')?.provider_session_id, 'grok-shared');
  });
});

test('a session owned by another app row is never stolen', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-victim', 'grok', projectPath);
    sessionsDb.assignProviderSessionId('app-victim', 'grok-busy');
    sessionsDb.createAppSession('app-3', 'grok', projectPath);

    const startedAt = Date.now() - 60_000;
    // Only the foreign-owned session was touched.
    await touchSessionDir(projectDir, 'grok-busy', new Date());

    const result = await syncGrokShellSession({
      appSessionId: 'app-3',
      projectPath,
      startedAt,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(sessionsDb.getSessionById('app-3')?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionById('app-victim')?.provider_session_id, 'grok-busy');
  });
});

test('stale session dirs from before the PTY started are ignored', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-4', 'grok', projectPath);

    const startedAt = Date.now();
    await touchSessionDir(projectDir, 'grok-old', new Date(startedAt - 3_600_000));

    const result = await syncGrokShellSession({
      appSessionId: 'app-4',
      projectPath,
      startedAt,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(sessionsDb.getSessionById('app-4')?.provider_session_id, null);
  });
});

test('two unowned sessions touched in the window are left unbound (ambiguity skipped)', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-5', 'grok', projectPath);

    const startedAt = Date.now() - 60_000;
    // A chat run and a shell both touched the project's session dir; the
    // other conversation's DB row may not exist yet, so neither dir can be
    // proven to be the shell's.
    await touchSessionDir(projectDir, 'grok-other', new Date(Date.now() - 1000));
    await touchSessionDir(projectDir, 'grok-shell', new Date());

    const result = await syncGrokShellSession({
      appSessionId: 'app-5',
      projectPath,
      startedAt,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(sessionsDb.getSessionById('app-5')?.provider_session_id, null);
  });
});

test('an existing mapping is never overwritten when its session was not touched', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-6', 'grok', projectPath);
    sessionsDb.assignProviderSessionId('app-6', 'grok-mapped');

    const startedAt = Date.now() - 60_000;
    // Only an unknown session was touched (e.g. a concurrent chat's).
    await touchSessionDir(projectDir, 'grok-unknown', new Date());

    const result = await syncGrokShellSession({
      appSessionId: 'app-6',
      projectPath,
      startedAt,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(sessionsDb.getSessionById('app-6')?.provider_session_id, 'grok-mapped');
  });
});

test('the single unowned session is adopted when the rest are foreign-owned', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-owner', 'grok', projectPath);
    sessionsDb.assignProviderSessionId('app-owner', 'grok-busy');
    sessionsDb.createAppSession('app-7', 'grok', projectPath);

    const startedAt = Date.now() - 60_000;
    await touchSessionDir(projectDir, 'grok-busy', new Date(Date.now() - 1000));
    await touchSessionDir(projectDir, 'grok-new', new Date());

    const result = await syncGrokShellSession({
      appSessionId: 'app-7',
      projectPath,
      startedAt,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.deepEqual(result, {
      appSessionId: 'app-7',
      providerSessionId: 'grok-new',
      adopted: true,
    });
    assert.equal(sessionsDb.getSessionById('app-7')?.provider_session_id, 'grok-new');
  });
});

test('an external grok session in the same project without the shell prompt is not adopted', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('app-1', 'grok', projectPath);
    await touchSessionDir(projectDir, 'grok-external', new Date(), 'something typed elsewhere');

    const result = await syncGrokShellSession({
      appSessionId: 'app-1',
      projectPath,
      startedAt: Date.now() - 60_000,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.equal(result, null);
    assert.equal(sessionsDb.getSessionById('app-1')?.provider_session_id, null);
  });
});

test('shell session without an app session is indexed as its own sidebar row', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    const startedAt = Date.now() - 60_000;
    const dir = path.join(projectDir, 'grok-orphan');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        info: { id: 'grok-orphan', cwd: projectPath },
        session_summary: 'Work done from the shell',
      }),
    );
    await utimes(dir, new Date(), new Date());

    const result = await syncGrokShellSession({
      appSessionId: null,
      projectPath,
      startedAt,
      sessionsRoot,
      submittedPrompts: [SHELL_PROMPT],
    });

    assert.ok(result);
    assert.equal(result.providerSessionId, 'grok-orphan');
    assert.equal(result.adopted, true);
    const row = sessionsDb.getSessionByProviderSessionId('grok-orphan', 'grok');
    assert.ok(row);
    assert.equal(row.session_id, result.appSessionId);
  });
});

test('reads the model and effort the TUI wrote into summary.json', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    const dir = path.join(projectDir, 'grok-runtime');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        current_model_id: 'grok-4.7-build-fast',
        reasoning_effort: 'xhigh',
      }),
    );

    assert.deepEqual(
      readGrokSessionRuntime(projectPath, 'grok-runtime', sessionsRoot),
      { model: 'grok-4.7-build-fast', effort: 'xhigh' },
    );
  });
});

test('a summary written before the shell started is not reported', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    const dir = path.join(projectDir, 'grok-old');
    await mkdir(dir, { recursive: true });
    const summaryPath = path.join(dir, 'summary.json');
    await writeFile(summaryPath, JSON.stringify({ current_model_id: 'grok-4.5' }));
    const old = new Date(Date.now() - 60_000);
    await utimes(summaryPath, old, old);

    assert.equal(
      readGrokSessionRuntime(projectPath, 'grok-old', sessionsRoot, { since: Date.now() - 1_000 }),
      null,
    );
    assert.equal(
      readLatestGrokSessionRuntime(projectPath, sessionsRoot, { since: Date.now() - 1_000 }),
      null,
    );
  });
});

test('latest-summary fallback skips sessions owned by another app row', async () => {
  await withHarness(async ({ sessionsRoot, projectPath, projectDir }) => {
    sessionsDb.createAppSession('other-app', 'grok', projectPath);
    sessionsDb.assignProviderSessionId('other-app', 'grok-foreign');
    for (const [id, model] of [['grok-mine', 'grok-4.6'], ['grok-foreign', 'grok-4.7']] as const) {
      const dir = path.join(projectDir, id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ current_model_id: model }));
    }
    const newer = new Date(Date.now() + 5_000);
    await utimes(path.join(projectDir, 'grok-foreign', 'summary.json'), newer, newer);

    assert.deepEqual(
      readLatestGrokSessionRuntime(projectPath, sessionsRoot, { since: Date.now() - 10_000, appSessionId: 'app-1' }),
      { model: 'grok-4.6', effort: null, providerSessionId: 'grok-mine' },
    );
  });
});
