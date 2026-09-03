import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  configureMissionControlRuntimes,
  extractRunOutcome,
  parseJsonFromAgentText,
  runMissionControlAgent,
} from '@/modules/mission-control/mission-control-agent.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { McSection } from '@/modules/mission-control/mission-control.types.js';

const DETACHED_CONNECTION = { readyState: -1, send: () => undefined };

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mission-control-agent-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    configureMissionControlRuntimes({});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('headless Mission Control runs use an internal app session', async () => {
  await withIsolatedDatabase(async () => {
    let runtimeAppSessionId: string | undefined;
    configureMissionControlRuntimes({
      claude: async (_prompt, options, writer) => {
        runtimeAppSessionId = String((options as { appSessionId?: string }).appSessionId);
        const runtimeWriter = writer as {
          send: (message: unknown) => void;
          sendComplete: (options: { exitCode: number }) => void;
        };
        runtimeWriter.send({ kind: 'text', provider: 'claude', content: '[]' });
        runtimeWriter.sendComplete({ exitCode: 0 });
      },
    });

    const section: McSection = {
      section_id: 'mc-internal-test',
      title: 'Internal test run',
      icon: 'bot',
      sort_order: 0,
      enabled: true,
      scope: 'global',
      project_id: null,
      mode: 'fire_and_forget',
      schedule_cron: null,
      provider: 'claude',
      model: null,
      permission_mode: 'bypassPermissions',
      dry_run: false,
      auto_approve: false,
      produce_prompt: '',
      produce_tools: [],
      resolve_prompt: '',
      resolve_tools: [],
      actions: [],
      create_kanban_task: false,
      create_swarm_on_approve: false,
      kanban_assignee_provider: null,
      kanban_review_provider: null,
      kanban_mcp_tools: [],
      last_run_at: null,
      last_run_error: null,
      created_at: '2026-09-02T00:00:00.000Z',
      updated_at: '2026-09-02T00:00:00.000Z',
    };

    const result = await runMissionControlAgent({
      section,
      prompt: 'Return an empty result.',
      tools: [],
    });

    assert.equal(result.success, true);
    assert.ok(runtimeAppSessionId);
    assert.equal(sessionsDb.getSessionById(runtimeAppSessionId)?.is_internal, 1);
  });
});

function startRun(appSessionId: string) {
  sessionsDb.createAppSession(appSessionId, 'claude', '/workspace/demo');
  const run = chatRunRegistry.startRun({
    appSessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: DETACHED_CONNECTION,
    userId: null,
  });
  assert.ok(run);
  return run;
}

test('successful run: assistant text only, not failed', async () => {
  await withIsolatedDatabase(() => {
    const run = startRun('mc-ok-1');
    run.writer.send({ kind: 'text', provider: 'claude', content: '[{"title":"a"}]' });
    run.writer.sendComplete({ exitCode: 0 });

    const outcome = extractRunOutcome('mc-ok-1');
    assert.equal(outcome.text, '[{"title":"a"}]');
    assert.equal(outcome.failed, false);
    assert.equal(outcome.errorMessage, null);
  });
});

test('provider API failure: non-zero exit marks the run failed, error text kept separate', async () => {
  await withIsolatedDatabase(() => {
    const run = startRun('mc-fail-1');
    run.writer.send({
      kind: 'text',
      provider: 'claude',
      content: 'API Error: Unable to connect to API (ENOTFOUND)',
    });
    run.writer.send({
      kind: 'error',
      provider: 'claude',
      content: 'Claude Code returned an error result: API Error: Unable to connect to API (ENOTFOUND)',
    });
    run.writer.sendComplete({ exitCode: 1 });

    const outcome = extractRunOutcome('mc-fail-1');
    assert.equal(outcome.failed, true);
    assert.equal(outcome.text, 'API Error: Unable to connect to API (ENOTFOUND)');
    assert.match(outcome.errorMessage ?? '', /returned an error result/);
  });
});

test('benign error event with zero exit is not a failure and stays out of the text', async () => {
  await withIsolatedDatabase(() => {
    const run = startRun('mc-ok-2');
    run.writer.send({ kind: 'error', provider: 'cursor', content: 'warning: noisy stderr' });
    run.writer.send({ kind: 'text', provider: 'cursor', content: '[{"title":"b","dedupeKey":"k"}]' });
    run.writer.sendComplete({ exitCode: 0 });

    const outcome = extractRunOutcome('mc-ok-2');
    assert.equal(outcome.failed, false);
    assert.equal(outcome.text, '[{"title":"b","dedupeKey":"k"}]');
    assert.equal(outcome.errorMessage, 'warning: noisy stderr');
  });
});

test('parseJsonFromAgentText: plain array', () => {
  const parsed = parseJsonFromAgentText(
    '[{"title":"a","summary":"s","body":{},"dedupeKey":"k","confidence":1}]',
  );
  assert.ok(Array.isArray(parsed));
  assert.equal((parsed as { title: string }[])[0]?.title, 'a');
});

test('parseJsonFromAgentText: fenced json with tool-narration preamble', () => {
  const text = `Now I'll fetch the channel histories and search for mentions/DMs in parallel.
Found all three channel IDs. Now reading full channel history for yesterday's window.
\`\`\`json
[
  {
    "title": "Slack Summary — 2026-07-22",
    "summary": "Outage day",
    "body": { "date": "2026-07-22", "markdown": "all clear" },
    "dedupeKey": "slack-summary-2026-07-22",
    "confidence": 0.9
  }
]
\`\`\``;
  const parsed = parseJsonFromAgentText(text);
  assert.ok(Array.isArray(parsed));
  assert.equal((parsed as { dedupeKey: string }[])[0]?.dedupeKey, 'slack-summary-2026-07-22');
});

test('parseJsonFromAgentText: repairs unescaped quotes inside string values', () => {
  // Real failure mode from Daily Slack Summaries: model quoted a phrase inside
  // markdown without escaping, which breaks strict JSON.parse.
  const text = `Now reading history.
\`\`\`json
[
  {
    "title": "Slack Summary",
    "summary": "brief",
    "body": {
      "markdown": "showed things "operating normal" again by ~18:05 IST."
    },
    "dedupeKey": "slack-summary-2026-07-22",
    "confidence": 0.8
  }
]
\`\`\``;
  const parsed = parseJsonFromAgentText(text);
  assert.ok(Array.isArray(parsed));
  const item = (parsed as { body: { markdown: string }; dedupeKey: string }[])[0];
  assert.equal(item?.dedupeKey, 'slack-summary-2026-07-22');
  assert.match(item?.body.markdown ?? '', /operating normal/);
});

test('parseJsonFromAgentText: repairs quoted Slack phrases followed by punctuation', () => {
  // Real Daily Slack Summaries output used quotes inside markdown prose and
  // followed them with punctuation. jsonrepair alone rejects this shape.
  const text = `
\`\`\`json
[
  {
    "title": "Slack Summary — 2026-08-05",
    "summary": "A summary",
    "body": {
      "markdown": "Ram was on leave ("you should be on leave"). Another message said ("We did it finalllyyyyyyyy") and thanked the team."
    },
    "dedupeKey": "slack-summary:2026-08-05",
    "confidence": 0.85
  }
]
\`\`\``;

  const parsed = parseJsonFromAgentText(text);
  assert.ok(Array.isArray(parsed));
  const item = parsed as { body: { markdown: string }; dedupeKey: string }[];
  assert.equal(item[0]?.dedupeKey, 'slack-summary:2026-08-05');
  assert.match(item[0]?.body.markdown ?? '', /you should be on leave/);
  assert.match(item[0]?.body.markdown ?? '', /We did it finalllyyyyyyyy/);
});
