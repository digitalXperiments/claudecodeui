import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import JSZip from 'jszip';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import {
  getBackupConfig,
  runBackup,
  updateBackupConfig,
} from '../backup.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'backups-db-'));
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

async function loadManifest(zipPath: string): Promise<Record<string, unknown>> {
  const zip = await JSZip.loadAsync(await import('node:fs/promises').then((fs) => fs.readFile(zipPath)));
  const manifestEntry = zip.file('manifest.json');
  assert.ok(manifestEntry, 'manifest.json must be present in every backup archive');
  return JSON.parse(await manifestEntry!.async('string'));
}

test('backup config normalization', async (t) => {
  await withIsolatedDatabase(async () => {
    await t.test('defaults enable agent conversations and leave exclusions empty', () => {
      const config = getBackupConfig();
      assert.equal(config.includeAgentConversations, true);
      assert.deepEqual(config.excludedProjectPaths, []);
    });

    await t.test('rejects an invalid cron expression', () => {
      assert.throws(() => updateBackupConfig({ schedule: 'not-a-cron' }), /Invalid backup cron expression/);
    });

    await t.test('normalizes and dedupes excluded project paths', () => {
      const saved = updateBackupConfig({
        excludedProjectPaths: ['/workspace/demo//', '/workspace/demo', '   ', 42],
      });
      assert.deepEqual(saved.excludedProjectPaths, ['/workspace/demo']);
    });

    await t.test('honors an explicit false for the agent-conversations toggle', () => {
      const saved = updateBackupConfig({ includeAgentConversations: false });
      assert.equal(saved.includeAgentConversations, false);
    });
  });
});

test('agent conversation backup scoping', async (t) => {
  await withIsolatedDatabase(async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'backups-run-'));
    const destination = path.join(workDir, 'destination');
    // Deliberately not paths under the OS temp root: `isTemporaryProjectPath`
    // (used by `projectsDb.getProjectPaths()`) filters those out, which would
    // make every project invisible to the exclusion scoping under test.
    const includedProjectPath = '/workspace/backup-test-included-project';
    const excludedProjectPath = '/workspace/backup-test-excluded-project';

    // A splittable ("file") provider: one transcript file per session.
    const claudeIncludedTranscript = path.join(workDir, 'claude-included.jsonl');
    const claudeExcludedTranscript = path.join(workDir, 'claude-excluded.jsonl');
    await writeFile(claudeIncludedTranscript, '{"included":true}\n');
    await writeFile(claudeExcludedTranscript, '{"excluded":true}\n');

    // A directory-anchored ("dir") provider: the session IS a directory.
    const clineIncludedTaskDir = path.join(workDir, 'cline-task-included');
    await mkdir(clineIncludedTaskDir, { recursive: true });
    await writeFile(path.join(clineIncludedTaskDir, 'task_metadata.json'), '{}');
    await writeFile(path.join(clineIncludedTaskDir, 'api_conversation_history.json'), '[]');

    sessionsDb.createSession(
      'claude-included-session', 'claude', includedProjectPath, 'Included',
      undefined, undefined, claudeIncludedTranscript,
    );
    sessionsDb.createSession(
      'claude-excluded-session', 'claude', excludedProjectPath, 'Excluded',
      undefined, undefined, claudeExcludedTranscript,
    );
    sessionsDb.createSession(
      'cline-included-session', 'cline', includedProjectPath, 'Cline Included',
      undefined, undefined, clineIncludedTaskDir,
    );
    // opencode keeps every project's sessions in one shared sqlite store, so
    // its per-session jsonl_path is always null (see the synchronizer).
    sessionsDb.createSession(
      'opencode-excluded-session', 'opencode', excludedProjectPath, 'OpenCode Excluded',
      undefined, undefined, null,
    );

    updateBackupConfig({
      enabled: false,
      destination,
      includeDatabase: false,
      includeCodebase: false,
      includeAgentConversations: true,
      excludedProjectPaths: [excludedProjectPath],
    });

    const result = await runBackup('manual');
    assert.equal(result.status, 'success');

    const manifest = await loadManifest(result.path as string);
    const agentConversations = manifest.agentConversations as {
      projectsIncluded: string[];
      projectsExcluded: string[];
      providers: Array<Record<string, unknown>>;
      warnings: string[];
    };

    assert.deepEqual(agentConversations.projectsExcluded, [excludedProjectPath]);
    assert.ok(agentConversations.projectsIncluded.includes(includedProjectPath));
    assert.ok(!agentConversations.projectsIncluded.includes(excludedProjectPath));

    const claudeSummary = agentConversations.providers.find((entry) => entry.provider === 'claude');
    assert.equal(claudeSummary?.sessionsBackedUp, 1);
    assert.equal(claudeSummary?.sessionsExcluded, 1);

    const opencodeSummary = agentConversations.providers.find((entry) => entry.provider === 'opencode');
    assert.equal(opencodeSummary?.coverage, 'skipped');
    assert.ok(agentConversations.warnings.some((warning) => warning.startsWith('opencode:')));

    const zip = await JSZip.loadAsync(await (await import('node:fs/promises')).readFile(result.path as string));
    const entryNames = Object.keys(zip.files);
    assert.ok(entryNames.some((name) => name.startsWith('conversations/claude/claude-included-session/')));
    assert.ok(!entryNames.some((name) => name.startsWith('conversations/claude/claude-excluded-session/')));
    assert.ok(entryNames.some((name) => name === 'conversations/cline/cline-included-session/task_metadata.json'));
    assert.ok(!entryNames.some((name) => name.startsWith('conversations/opencode/')));

    await rm(workDir, { recursive: true, force: true });
  });
});
