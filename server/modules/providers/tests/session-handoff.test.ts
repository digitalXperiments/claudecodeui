import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionHandoffService } from '@/modules/providers/services/session-handoff.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';

async function withIsolatedDatabase(
  runTest: (context: { projectPath: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-handoff-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const projectPath = path.join(tempDirectory, 'project');
  await mkdir(projectPath, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest({ projectPath });
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

let messageCounter = 0;

const textMessage = (
  role: 'user' | 'assistant',
  content: string,
  extra: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id: `m-${(messageCounter += 1)}`,
  sessionId: 'source-session',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role,
  content,
  ...extra,
});

const toolUseMessage = (toolName: string): NormalizedMessage => ({
  id: `m-${(messageCounter += 1)}`,
  sessionId: 'source-session',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'tool_use',
  role: 'assistant',
  toolName,
});

const toolResultMessage = (content: string): NormalizedMessage => ({
  id: `m-${(messageCounter += 1)}`,
  sessionId: 'source-session',
  timestamp: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  kind: 'tool_result',
  role: 'assistant',
  content,
});

const buildDocumentInput = (messages: NormalizedMessage[], mode: 'summary' | 'full') => ({
  sourceSession: {
    sessionId: 'source-session',
    provider: 'claude',
    projectPath: '/tmp/project',
  },
  messages,
  targetProvider: 'codex',
  targetModel: 'gpt-5-codex',
  mode,
});

test('buildHandoffDocument summary mode renders header, goal and recent turns', () => {
  const messages: NormalizedMessage[] = [
    textMessage('user', 'Fix the login bug'),
    textMessage('assistant', 'I will look at the auth code.'),
    toolUseMessage('Bash'),
    toolResultMessage('SECRET TOOL OUTPUT'),
    textMessage('user', 'Any progress?'),
    textMessage('assistant', 'COMPACT SUMMARY MARKER', { isCompactSummary: true }),
    textMessage('assistant', 'Found it, patching now.'),
  ];

  const document = sessionHandoffService.buildHandoffDocument(buildDocumentInput(messages, 'summary'));

  assert.match(document, /^# Session handoff/);
  assert.match(document, /- \*\*Source provider:\*\* claude/);
  assert.match(document, /- \*\*Source session id:\*\* source-session/);
  assert.match(document, /- \*\*Project path:\*\* \/tmp\/project/);
  assert.match(document, /- \*\*Target provider:\*\* codex/);
  assert.match(document, /- \*\*Target model:\*\* gpt-5-codex/);

  assert.match(document, /## Goal\n\nFix the login bug/);
  assert.match(document, /## Recent conversation/);
  assert.match(document, /- \*\*User:\*\* Any progress\?/);
  assert.match(document, /- \*\*Assistant:\*\* Found it, patching now\./);
  // Tool calls collapse to one-line mentions, tool results are dropped.
  assert.match(document, /- _Used tool: Bash_/);
  assert.equal(document.includes('SECRET TOOL OUTPUT'), false);
  // Compact summaries duplicate earlier content and are skipped.
  assert.equal(document.includes('COMPACT SUMMARY MARKER'), false);
});

test('buildHandoffDocument summary mode keeps only the last 15 text messages', () => {
  const messages: NormalizedMessage[] = [textMessage('user', 'the original goal')];
  for (let turn = 1; turn <= 10; turn += 1) {
    messages.push(textMessage('user', `turn-${turn} user`));
    messages.push(textMessage('assistant', `turn-${turn} assistant`));
  }

  const document = sessionHandoffService.buildHandoffDocument(buildDocumentInput(messages, 'summary'));

  // 21 text messages total; the window keeps the last 15, so turns 1-3 drop
  // out while the goal still shows up in its own section.
  assert.match(document, /## Goal\n\nthe original goal/);
  assert.equal(document.includes('turn-1 user'), false);
  assert.equal(document.includes('turn-3 user'), false);
  assert.match(document, /turn-3 assistant/);
  assert.match(document, /turn-10 assistant/);
});

test('buildHandoffDocument summary mode truncates the goal and long turns', () => {
  const longGoal = 'g'.repeat(2000);
  const longTurn = 't'.repeat(2000);
  const document = sessionHandoffService.buildHandoffDocument(buildDocumentInput([
    textMessage('user', longGoal),
    textMessage('assistant', longTurn),
  ], 'summary'));

  assert.match(document, new RegExp(`## Goal\n\n${'g'.repeat(1500)}…`));
  assert.equal(document.includes('g'.repeat(1501)), false);
  assert.match(document, new RegExp(`- \\*\\*Assistant:\\*\\* ${'t'.repeat(1200)}…`));
  assert.equal(document.includes('t'.repeat(1201)), false);
});

test('buildHandoffDocument full mode includes every text message', () => {
  const messages: NormalizedMessage[] = [textMessage('user', 'the original goal')];
  for (let turn = 1; turn <= 10; turn += 1) {
    messages.push(textMessage('user', `turn-${turn} user`));
    messages.push(textMessage('assistant', `turn-${turn} assistant`));
  }
  messages.push(textMessage('assistant', 'LONG ' + 'x'.repeat(5000)));

  const document = sessionHandoffService.buildHandoffDocument(buildDocumentInput(messages, 'full'));

  assert.match(document, /## Full transcript/);
  assert.equal(document.includes('## Goal'), false);
  assert.match(document, /turn-1 user/);
  assert.match(document, /turn-10 assistant/);
  assert.match(document, new RegExp(`LONG ${'x'.repeat(3995)}…`));
  assert.equal(document.includes('x'.repeat(4000)), false);
});

test('createHandoffSession summary mode persists file, prompt and lineage', async () => {
  await withIsolatedDatabase(async ({ projectPath }) => {
    sessionsDb.createAppSession('source-session-id', 'claude', projectPath);

    const history: NormalizedMessage[] = [
      textMessage('user', 'Refactor the settings page'),
      textMessage('assistant', 'Splitting it into smaller components.'),
    ];
    const historyResult: FetchHistoryResult = {
      messages: history,
      total: history.length,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const fetchMock = mock.method(sessionsService, 'fetchHistory', async () => historyResult);

    try {
      const result = await sessionHandoffService.createHandoffSession({
        sourceSessionId: 'source-session-id',
        targetProvider: 'codex',
        targetModel: 'gpt-5-codex',
        mode: 'summary',
        saveToFile: true,
      });

      assert.equal(fetchMock.mock.calls.length, 1);
      assert.deepEqual(fetchMock.mock.calls[0].arguments, [
        'source-session-id',
        { limit: null, offset: 0 },
      ]);

      assert.notEqual(result.sessionId, 'source-session-id');
      assert.equal(result.provider, 'codex');
      assert.equal(result.projectPath, projectPath);

      // Lineage is recorded on the new session row.
      const newRow = sessionsDb.getSessionById(result.sessionId);
      assert.equal(newRow?.provider, 'codex');
      assert.equal(newRow?.continued_from_session_id, 'source-session-id');

      // The summary is inlined into the prompt.
      assert.ok(result.handoffPrompt);
      assert.match(result.handoffPrompt as string, /continues from a previous claude session/);
      assert.match(result.handoffPrompt as string, /## Goal\n\nRefactor the settings page/);
      assert.match(
        result.handoffPrompt as string,
        /Continue the work from where it left off\. If anything is unclear, say so before acting\.$/,
      );

      // saveToFile persisted the same markdown under .cloudcli/handoffs.
      assert.ok(result.handoffFilePath);
      const handoffFilePath = result.handoffFilePath as string;
      assert.ok(handoffFilePath.startsWith(path.join(projectPath, '.cloudcli', 'handoffs')));
      const fileContent = await readFile(handoffFilePath, 'utf8');
      assert.match(fileContent, /# Session handoff/);
      assert.match(fileContent, /## Goal\n\nRefactor the settings page/);
      assert.ok((result.handoffPrompt as string).includes(fileContent.trim()));
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test('createHandoffSession full mode always writes the transcript file', async () => {
  await withIsolatedDatabase(async ({ projectPath }) => {
    sessionsDb.createAppSession('source-session-id', 'claude', projectPath);

    const historyResult: FetchHistoryResult = {
      messages: [textMessage('user', 'goal'), textMessage('assistant', 'turn one')],
      total: 2,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const fetchMock = mock.method(sessionsService, 'fetchHistory', async () => historyResult);

    try {
      const result = await sessionHandoffService.createHandoffSession({
        sourceSessionId: 'source-session-id',
        targetProvider: 'kimi',
        mode: 'full',
        saveToFile: false,
      });

      // Full transcripts are too large for a prompt: the file is written even
      // without saveToFile and the prompt only points at it.
      assert.ok(result.handoffFilePath);
      const handoffFilePath = result.handoffFilePath as string;
      const fileContent = await readFile(handoffFilePath, 'utf8');
      assert.match(fileContent, /## Full transcript/);
      assert.match(fileContent, /turn one/);

      assert.ok(result.handoffPrompt);
      assert.ok((result.handoffPrompt as string).includes(handoffFilePath));
      assert.equal((result.handoffPrompt as string).includes('## Full transcript'), false);

      assert.equal(sessionsDb.getSessionById(result.sessionId)?.continued_from_session_id, 'source-session-id');
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test('createHandoffSession fresh mode skips history and returns a null prompt', async () => {
  await withIsolatedDatabase(async ({ projectPath }) => {
    sessionsDb.createAppSession('source-session-id', 'claude', projectPath);

    const fetchMock = mock.method(sessionsService, 'fetchHistory', async () => {
      throw new Error('fetchHistory must not be called in fresh mode');
    });

    try {
      const result = await sessionHandoffService.createHandoffSession({
        sourceSessionId: 'source-session-id',
        targetProvider: 'codex',
        mode: 'fresh',
        saveToFile: true,
      });

      assert.equal(fetchMock.mock.calls.length, 0);
      assert.equal(result.handoffPrompt, null);
      assert.equal(result.handoffFilePath, undefined);
      assert.equal(result.provider, 'codex');
      assert.equal(sessionsDb.getSessionById(result.sessionId)?.continued_from_session_id, 'source-session-id');
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test('createHandoffSession prepends the memory instruction when saveToMemory is set', async () => {
  await withIsolatedDatabase(async ({ projectPath }) => {
    sessionsDb.createAppSession('source-session-id', 'claude', projectPath);

    const historyResult: FetchHistoryResult = {
      messages: [textMessage('user', 'remember this work')],
      total: 1,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const fetchMock = mock.method(sessionsService, 'fetchHistory', async () => historyResult);

    try {
      const result = await sessionHandoffService.createHandoffSession({
        sourceSessionId: 'source-session-id',
        targetProvider: 'codex',
        mode: 'summary',
        saveToMemory: true,
      });

      assert.ok(result.handoffPrompt);
      assert.match(
        result.handoffPrompt as string,
        /^First, persist the handoff summary below to this project's long-term memory/,
      );
      assert.match(result.handoffPrompt as string, /Obsidian MCP under a Handoffs note/);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test('createHandoffSession rejects unknown source sessions with a 404 error', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(
      sessionHandoffService.createHandoffSession({
        sourceSessionId: 'missing-session-id',
        targetProvider: 'codex',
      }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 404);
        assert.equal((error as { code?: string }).code, 'SESSION_NOT_FOUND');
        return true;
      },
    );
  });
});
