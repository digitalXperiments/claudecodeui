import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionHandoffService } from '@/modules/providers/services/session-handoff.service.js';
import { sessionSummarizerService } from '@/modules/providers/services/session-summarizer.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';

// The real summarizer shells out to the Claude Agent SDK; every summary-mode
// test below mocks it explicitly so tests stay hermetic (no network calls)
// regardless of whether Claude Code happens to be installed on the runner.

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

test('createHandoffSession summary mode falls back to the mechanical summary when the LLM summarizer is unavailable', async () => {
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
    const summarizerMock = mock.method(sessionSummarizerService, 'summarizeConversation', async () => null);

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
      assert.equal(summarizerMock.mock.calls.length, 1);

      assert.notEqual(result.sessionId, 'source-session-id');
      assert.equal(result.provider, 'codex');
      assert.equal(result.projectPath, projectPath);

      // Lineage is recorded on the new session row.
      const newRow = sessionsDb.getSessionById(result.sessionId);
      assert.equal(newRow?.provider, 'codex');
      assert.equal(newRow?.continued_from_session_id, 'source-session-id');

      // No LLM summary available: the mechanical goal + recent-turns summary is used.
      assert.ok(result.handoffPrompt);
      assert.match(result.handoffPrompt as string, /continues from a previous claude session/);
      assert.match(result.handoffPrompt as string, /## Goal\n\nRefactor the settings page/);
      assert.match(
        result.handoffPrompt as string,
        /Continue the work from where it left off\. If anything is unclear, say so before acting\.$/,
      );
      assert.equal(result.backupFilePath, undefined);

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
      summarizerMock.mock.restore();
    }
  });
});

test('createHandoffSession summary mode uses the LLM summary when available and keeps the full transcript as a backup', async () => {
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
    const summarizerMock = mock.method(
      sessionSummarizerService,
      'summarizeConversation',
      async () => 'The user asked to refactor the settings page; work is split into smaller components.',
    );

    try {
      const result = await sessionHandoffService.createHandoffSession({
        sourceSessionId: 'source-session-id',
        targetProvider: 'codex',
        targetModel: 'gpt-5-codex',
        mode: 'summary',
        saveToFile: false,
      });

      assert.equal(summarizerMock.mock.calls.length, 1);
      const summarizerInput = summarizerMock.mock.calls[0].arguments[0] as { transcriptMarkdown: string };
      assert.match(summarizerInput.transcriptMarkdown, /## Full transcript/);
      assert.match(summarizerInput.transcriptMarkdown, /Splitting it into smaller components\./);

      // The LLM summary replaces the mechanical one in the prompt.
      assert.ok(result.handoffPrompt);
      assert.match(
        result.handoffPrompt as string,
        /## Summary\n\nThe user asked to refactor the settings page/,
      );
      assert.equal((result.handoffPrompt as string).includes('## Goal'), false);

      // The full transcript is always kept on disk as a safety net, even
      // though saveToFile was false — the LLM summary is lossy.
      assert.ok(result.backupFilePath);
      const backupFilePath = result.backupFilePath as string;
      assert.ok(backupFilePath.startsWith(path.join(projectPath, '.cloudcli', 'handoffs')));
      const backupContent = await readFile(backupFilePath, 'utf8');
      assert.match(backupContent, /## Full transcript/);
      assert.match(backupContent, /Splitting it into smaller components\./);
      assert.match(result.handoffPrompt as string, new RegExp(backupFilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      // saveToFile was false and no LLM-less fallback ran, so no separate
      // handoffFilePath is written on top of the backup.
      assert.equal(result.handoffFilePath, undefined);
    } finally {
      fetchMock.mock.restore();
      summarizerMock.mock.restore();
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
    const summarizerMock = mock.method(sessionSummarizerService, 'summarizeConversation', async () => null);

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
      summarizerMock.mock.restore();
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

test('buildHandoffContextSections renders git/kanban sections only when present', () => {
  const gitState = 'Changes since HEAD:\n```\n M server/index.js\n```';
  const kanbanState = 'Active kanban cards for this project:\n- Fix login [in_progress]';

  const both = sessionHandoffService.buildHandoffDocument(buildDocumentInput(
    [textMessage('user', 'goal'), textMessage('assistant', 'turn')],
    'summary',
  ));
  assert.equal(both.includes('## Working tree state'), false);
  assert.equal(both.includes('## Kanban context'), false);

  const withContext = buildDocumentInput([textMessage('user', 'goal')], 'summary');
  const document = sessionHandoffService.buildHandoffDocument({
    ...withContext,
    gitState,
    kanbanState,
  });
  assert.match(document, /## Working tree state\n\nChanges since HEAD:/);
  assert.match(document, /## Kanban context\n\nActive kanban cards for this project:\n- Fix login \[in_progress\]/);

  const gitOnly = sessionHandoffService.buildHandoffDocument({
    ...withContext,
    gitState,
    kanbanState: null,
  });
  assert.match(gitOnly, /## Working tree state/);
  assert.equal(gitOnly.includes('## Kanban context'), false);

  const kanbanOnly = sessionHandoffService.buildHandoffDocument({
    ...withContext,
    gitState: null,
    kanbanState,
  });
  assert.equal(kanbanOnly.includes('## Working tree state'), false);
  assert.match(kanbanOnly, /## Kanban context/);
});

test('createHandoffSession with includeGitState/includeKanbanState degrades gracefully when unavailable', async () => {
  // The isolated temp project is not a git repo and has no kanban board, so
  // both capture helpers resolve null and the document omits the sections.
  await withIsolatedDatabase(async ({ projectPath }) => {
    sessionsDb.createAppSession('source-session-id', 'claude', projectPath);

    const historyResult: FetchHistoryResult = {
      messages: [textMessage('user', 'goal'), textMessage('assistant', 'turn')],
      total: 2,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const fetchMock = mock.method(sessionsService, 'fetchHistory', async () => historyResult);
    const summarizerMock = mock.method(sessionSummarizerService, 'summarizeConversation', async () => null);

    try {
      const result = await sessionHandoffService.createHandoffSession({
        sourceSessionId: 'source-session-id',
        targetProvider: 'codex',
        mode: 'summary',
        includeGitState: true,
        includeKanbanState: true,
      });

      assert.ok(result.handoffPrompt);
      const prompt = result.handoffPrompt as string;
      assert.match(prompt, /## Goal\n\ngoal/);
      assert.equal(prompt.includes('## Working tree state'), false);
      assert.equal(prompt.includes('## Kanban context'), false);
    } finally {
      fetchMock.mock.restore();
      summarizerMock.mock.restore();
    }
  });
});

test('reverseHandoffSession returns work to the origin provider from the lineage', async () => {
  await withIsolatedDatabase(async ({ projectPath }) => {
    // Lineage: origin (claude) -> intermediary (codex) -> current session.
    sessionsDb.createAppSession('origin-session-id', 'claude', projectPath);
    sessionsDb.createAppSession('intermediary-session-id', 'codex', projectPath);
    sessionsDb.createAppSession('current-session-id', 'grok', projectPath);
    sessionsDb.setContinuedFrom('intermediary-session-id', 'origin-session-id');
    sessionsDb.setContinuedFrom('current-session-id', 'intermediary-session-id');

    const historyResult: FetchHistoryResult = {
      messages: [textMessage('user', 'goal'), textMessage('assistant', 'turn')],
      total: 2,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const fetchMock = mock.method(sessionsService, 'fetchHistory', async () => historyResult);
    const summarizerMock = mock.method(sessionSummarizerService, 'summarizeConversation', async () => null);

    try {
      const result = await sessionHandoffService.reverseHandoffSession({
        sessionId: 'current-session-id',
        mode: 'summary',
      });

      assert.equal(result.provider, 'claude');
      assert.equal(sessionsDb.getSessionById(result.sessionId)?.continued_from_session_id, 'current-session-id');
      assert.ok(result.handoffPrompt);
      assert.match(result.handoffPrompt as string, /hands the work back to the provider that originally started it/);
    } finally {
      fetchMock.mock.restore();
      summarizerMock.mock.restore();
    }
  });
});

test('reverseHandoffSession honors an explicit targetProvider over lineage discovery', async () => {
  await withIsolatedDatabase(async ({ projectPath }) => {
    sessionsDb.createAppSession('origin-session-id', 'claude', projectPath);
    sessionsDb.createAppSession('current-session-id', 'grok', projectPath);
    sessionsDb.setContinuedFrom('current-session-id', 'origin-session-id');

    const historyResult: FetchHistoryResult = {
      messages: [textMessage('user', 'goal')],
      total: 1,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const fetchMock = mock.method(sessionsService, 'fetchHistory', async () => historyResult);
    const summarizerMock = mock.method(sessionSummarizerService, 'summarizeConversation', async () => null);

    try {
      const result = await sessionHandoffService.reverseHandoffSession({
        sessionId: 'current-session-id',
        targetProvider: 'kimi',
        mode: 'summary',
      });
      assert.equal(result.provider, 'kimi');
    } finally {
      fetchMock.mock.restore();
      summarizerMock.mock.restore();
    }
  });
});

test('reverseHandoffSession rejects unknown sessions with a 404 error', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(
      sessionHandoffService.reverseHandoffSession({ sessionId: 'missing-session-id' }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 404);
        assert.equal((error as { code?: string }).code, 'SESSION_NOT_FOUND');
        return true;
      },
    );
  });
});

test('mergeSessions merges transcripts of multiple sessions into one continuation', async () => {
  await withIsolatedDatabase(async ({ projectPath }) => {
    sessionsDb.createAppSession('session-a', 'claude', projectPath);
    sessionsDb.createAppSession('session-b', 'codex', projectPath);

    const historyA: FetchHistoryResult = {
      messages: [textMessage('user', 'goal from a'), textMessage('assistant', 'work from a')],
      total: 2,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const historyB: FetchHistoryResult = {
      messages: [textMessage('user', 'goal from b'), textMessage('assistant', 'work from b')],
      total: 2,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const fetchMock = mock.method(
      sessionsService,
      'fetchHistory',
      async (sessionId: string) => (sessionId === 'session-a' ? historyA : historyB),
    );

    try {
      const result = await sessionHandoffService.mergeSessions({
        sessionIds: ['session-a', 'session-b'],
        targetProvider: 'claude',
        mode: 'summary',
      });

      assert.ok(result.handoffPrompt);
      const prompt = result.handoffPrompt as string;
      assert.match(prompt, /## Merged sessions/);
      assert.match(prompt, /1\. claude session `session-a`/);
      assert.match(prompt, /2\. codex session `session-b`/);
      assert.match(prompt, /## Session 1 \(claude\)/);
      assert.match(prompt, /## Session 2 \(codex\)/);
      assert.match(prompt, /goal from a/);
      assert.match(prompt, /work from b/);
      assert.match(prompt, /merged into one\./);
      assert.equal(sessionsDb.getSessionById(result.sessionId)?.continued_from_session_id, 'session-a');

      // The mechanical summary writes the full merged transcript to disk as a
      // safety net for the continuation.
      assert.ok(result.backupFilePath);
      const backupContent = await readFile(result.backupFilePath as string, 'utf8');
      assert.match(backupContent, /## Session 2 \(codex\)/);
      assert.match(backupContent, /work from b/);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test('mergeSessions rejects sessions from different projects', async () => {
  await withIsolatedDatabase(async ({ projectPath }) => {
    const otherProject = path.join(path.dirname(projectPath), 'other-project');
    await mkdir(otherProject, { recursive: true });
    sessionsDb.createAppSession('session-a', 'claude', projectPath);
    sessionsDb.createAppSession('session-b', 'codex', otherProject);

    const historyResult: FetchHistoryResult = {
      messages: [textMessage('user', 'goal')],
      total: 1,
      hasMore: false,
      offset: 0,
      limit: null,
    };
    const fetchMock = mock.method(sessionsService, 'fetchHistory', async () => historyResult);

    try {
      await assert.rejects(
        sessionHandoffService.mergeSessions({
          sessionIds: ['session-a', 'session-b'],
          mode: 'summary',
        }),
        (error: unknown) => {
          assert.equal((error as { statusCode?: number }).statusCode, 400);
          assert.equal((error as { code?: string }).code, 'HANDOFF_MERGE_PROJECT_MISMATCH');
          return true;
        },
      );
    } finally {
      fetchMock.mock.restore();
    }
  });
});

test('mergeSessions rejects empty session id lists', async () => {
  await withIsolatedDatabase(async () => {
    await assert.rejects(
      sessionHandoffService.mergeSessions({ sessionIds: [], mode: 'summary' }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
        assert.equal((error as { code?: string }).code, 'HANDOFF_MERGE_EMPTY');
        return true;
      },
    );
  });
});
