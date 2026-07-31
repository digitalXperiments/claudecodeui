import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { configureMissionControlRuntimes } from '@/modules/mission-control/mission-control-agent.service.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { runSectionProduce } from '@/modules/mission-control/mission-control-runner.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

/**
 * The Claude CLI's own wording when its OAuth session is dead. This text used to
 * be fed to the JSON parser, which reported "candidate is not JSON-shaped" and
 * parked one bogus draft per scheduled run.
 */
const AUTH_ERROR = 'Failed to authenticate: OAuth session expired and could not be refreshed';

type Writer = {
  send: (event: AnyRecord) => void;
  sendComplete: (event: AnyRecord) => void;
};

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'mc-auth-failure-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    configureMissionControlRuntimes({});
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Installs a fake claude runtime that emits `output` then exits with `exitCode`. */
function stubClaudeRuntime(output: string, exitCode: number, errorText?: string): void {
  configureMissionControlRuntimes({
    claude: async (_command: string, _options: AnyRecord, writer: unknown) => {
      const w = writer as Writer;
      if (errorText) {
        w.send({ kind: 'error', provider: 'claude', content: errorText });
      }
      w.send({ kind: 'text', provider: 'claude', content: output });
      w.sendComplete({ exitCode });
    },
  });
}

function seedReviewSection() {
  return missionControlDb.createSection({
    title: 'Jira Drafts',
    mode: 'review',
    provider: 'claude',
    produce_prompt: 'Produce Jira drafts.',
    resolve_prompt: '',
  });
}

test('auth failure on a zero-exit run is reported as auth, not a parse failure', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedReviewSection();
    // Exit code 0: exactly the case that slipped past the !success guard and
    // reached the JSON parser.
    stubClaudeRuntime(AUTH_ERROR, 0);

    const result = await runSectionProduce(section.section_id);

    assert.match(result.error ?? '', /not authenticated/i);
    assert.match(result.error ?? '', /OAuth session expired/);
    assert.match(result.error ?? '', /claude auth login/);
    assert.doesNotMatch(result.error ?? '', /JSON-shaped/);

    // No draft item may be created for an auth failure.
    assert.equal(result.created, 0);
    assert.equal(result.items.length, 0);
    assert.equal(missionControlDb.listItems({ sectionId: section.section_id }).length, 0);

    // The section records the auth error so the UI can show the real cause.
    const stored = missionControlDb.getSection(section.section_id);
    assert.match(stored?.last_run_error ?? '', /not authenticated/i);
  });
});

test('auth failure on a non-zero exit also reports the auth cause', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedReviewSection();
    stubClaudeRuntime('', 1, AUTH_ERROR);

    const result = await runSectionProduce(section.section_id);

    assert.match(result.error ?? '', /not authenticated/i);
    assert.match(result.error ?? '', /claude auth login/);
    assert.equal(result.items.length, 0);
  });
});

test('a genuine malformed-output run still parks a parse-failed item', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedReviewSection();
    // Prose with no JSON and no auth signal: the existing behaviour must remain.
    stubClaudeRuntime('I looked at the board and everything is already up to date.', 0);

    const result = await runSectionProduce(section.section_id);

    assert.match(result.error ?? '', /JSON/i);
    assert.doesNotMatch(result.error ?? '', /not authenticated/i);
    assert.equal(result.items.length, 1);
    assert.match(result.items[0]?.title ?? '', /produce parse failed/);
  });
});

test('a well-formed produce run is unaffected', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedReviewSection();
    stubClaudeRuntime(
      JSON.stringify([{ title: 'Ship it', summary: 's', body: {}, dedupeKey: 'k1', confidence: 1 }]),
      0,
    );

    const result = await runSectionProduce(section.section_id);

    assert.equal(result.error, undefined);
    assert.equal(result.created, 1);
    assert.equal(result.items[0]?.title, 'Ship it');
  });
});

// Guards the false-positive risk of scanning output for auth wording: a draft
// that legitimately talks about expired sessions must still be created.
test('drafts whose content mentions expired sessions are still created', async () => {
  await withIsolatedDatabase(async () => {
    const section = seedReviewSection();
    stubClaudeRuntime(
      JSON.stringify([{
        title: 'AUTH-42: OAuth session expired for some users',
        summary: 'Users report "Failed to authenticate" after 24h',
        body: { note: 'invalid API key reported in logs' },
        dedupeKey: 'jira-AUTH-42',
        confidence: 0.9,
      }]),
      0,
    );

    const result = await runSectionProduce(section.section_id);

    assert.equal(result.error, undefined);
    assert.equal(result.created, 1);
    assert.match(result.items[0]?.title ?? '', /AUTH-42/);
  });
});
