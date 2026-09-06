import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import JSZip from 'jszip';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import {
  getBackupConfig,
  runBackup,
  setBackupConversationSourcesForTests,
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
    setBackupConversationSourcesForTests(null);
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
  const zip = await JSZip.loadAsync(await readFile(zipPath));
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

test('agent conversation backup scoping', async () => {
  await withIsolatedDatabase(async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'backups-run-'));
    const destination = path.join(workDir, 'destination');
    const claudeRoot = path.join(workDir, 'providers', 'claude');
    const clineRoot = path.join(workDir, 'providers', 'cline');
    const opencodeRoot = path.join(workDir, 'providers', 'opencode');
    const antigravityRoot = path.join(workDir, 'providers', 'antigravity');
    const missingCodexRoot = path.join(workDir, 'providers', 'missing-codex');
    await Promise.all([
      mkdir(claudeRoot, { recursive: true }),
      mkdir(clineRoot, { recursive: true }),
      mkdir(opencodeRoot, { recursive: true }),
      mkdir(antigravityRoot, { recursive: true }),
    ]);
    setBackupConversationSourcesForTests([
      { provider: 'claude', rootPath: claudeRoot },
      { provider: 'cline', rootPath: clineRoot },
      { provider: 'opencode', rootPath: opencodeRoot, databasePath: path.join(opencodeRoot, 'opencode.db') },
      { provider: 'antigravity', rootPath: antigravityRoot },
      { provider: 'codex', rootPath: missingCodexRoot },
    ]);
    // Deliberately not paths under the OS temp root: `isTemporaryProjectPath`
    // (used by `projectsDb.getProjectPaths()`) filters those out, which would
    // make every project invisible to the exclusion scoping under test.
    const includedProjectPath = '/workspace/backup-test-included-project';
    const excludedProjectPath = '/workspace/backup-test-excluded-project';

    // A splittable ("file") provider: one transcript file per session.
    const claudeIncludedTranscript = path.join(claudeRoot, 'claude-included.jsonl');
    const claudeExcludedTranscript = path.join(claudeRoot, 'claude-excluded.jsonl');
    const claudeEscapedTranscript = path.join(workDir, 'claude-escaped.jsonl');
    await writeFile(claudeIncludedTranscript, '{"included":true}\n');
    await writeFile(claudeExcludedTranscript, '{"excluded":true}\n');
    await writeFile(claudeEscapedTranscript, '{"escaped":true}\n');

    // A directory-anchored ("dir") provider: the session IS a directory.
    const clineIncludedTaskDir = path.join(clineRoot, 'cline-task-included');
    await mkdir(clineIncludedTaskDir, { recursive: true });
    await writeFile(path.join(clineIncludedTaskDir, 'task_metadata.json'), '{}');
    await writeFile(path.join(clineIncludedTaskDir, 'api_conversation_history.json'), '[]');

    await writeFile(path.join(opencodeRoot, 'opencode.db'), 'shared transcript data');
    await writeFile(path.join(opencodeRoot, 'auth.json'), '{"secret":"must-not-leak"}');

    await writeFile(path.join(antigravityRoot, 'agy-included.db'), 'included antigravity transcript');
    await writeFile(path.join(antigravityRoot, 'agy-included.meta'), JSON.stringify({ cwd: includedProjectPath }));
    await writeFile(path.join(antigravityRoot, 'agy-excluded.db'), 'excluded antigravity transcript');
    await writeFile(path.join(antigravityRoot, 'agy-excluded.meta'), JSON.stringify({ cwd: excludedProjectPath }));

    sessionsDb.createSession(
      'claude-included-session', 'claude', includedProjectPath, 'Included',
      undefined, undefined, claudeIncludedTranscript,
    );
    sessionsDb.createSession(
      'claude-excluded-session', 'claude', excludedProjectPath, 'Excluded',
      undefined, undefined, claudeExcludedTranscript,
    );
    sessionsDb.createSession(
      'claude-escaped-session', 'claude', includedProjectPath, 'Escaped',
      undefined, undefined, claudeEscapedTranscript,
    );
    sessionsDb.createSession(
      'cline-included-session', 'cline', includedProjectPath, 'Cline Included',
      undefined, undefined, clineIncludedTaskDir,
    );
    // Shared-store exclusions must inspect rows hidden from getAllSessions().
    sessionsDb.createSession(
      'opencode-archived-excluded', 'opencode', excludedProjectPath, 'OpenCode Archived',
      undefined, undefined, null,
    );
    sessionsDb.updateSessionIsArchived('opencode-archived-excluded', true);
    sessionsDb.createAppSession('opencode-internal-excluded', 'opencode', excludedProjectPath, { internal: true });
    sessionsDb.createSession(
      'agy-included', 'antigravity', includedProjectPath, 'Antigravity Included',
      undefined, undefined, null,
    );
    sessionsDb.createSession(
      'agy-excluded', 'antigravity', excludedProjectPath, 'Antigravity Excluded',
      undefined, undefined, null,
    );
    sessionsDb.createSession(
      'codex-missing', 'codex', includedProjectPath, 'Codex Missing',
      undefined, undefined, path.join(missingCodexRoot, 'codex-missing.jsonl'),
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
    assert.equal(claudeSummary?.sessionsSkippedUnsafe, 1);

    const opencodeSummary = agentConversations.providers.find((entry) => entry.provider === 'opencode');
    assert.equal(opencodeSummary?.coverage, 'skipped');
    assert.equal(opencodeSummary?.sessionsExcluded, 2);
    assert.ok(agentConversations.warnings.some((warning) => warning.startsWith('opencode:')));

    const antigravitySummary = agentConversations.providers.find((entry) => entry.provider === 'antigravity');
    assert.equal(antigravitySummary?.sessionsBackedUp, 1);
    assert.equal(antigravitySummary?.sessionsExcluded, 1);

    const codexSummary = agentConversations.providers.find((entry) => entry.provider === 'codex');
    assert.equal(codexSummary?.coverage, 'unavailable');
    assert.ok(agentConversations.warnings.some((warning) => warning.includes('requested conversation root')));

    const zip = await JSZip.loadAsync(await readFile(result.path as string));
    const entryNames = Object.keys(zip.files);
    assert.ok(entryNames.some((name) => name.startsWith('conversations/claude/claude-included-session/')));
    assert.ok(!entryNames.some((name) => name.startsWith('conversations/claude/claude-excluded-session/')));
    assert.ok(!entryNames.some((name) => name.startsWith('conversations/claude/claude-escaped-session/')));
    assert.ok(entryNames.some((name) => name === 'conversations/cline/cline-included-session/task_metadata.json'));
    assert.ok(!entryNames.some((name) => name.startsWith('conversations/opencode/')));
    assert.ok(entryNames.includes('conversations/antigravity/agy-included/agy-included.db'));
    assert.ok(entryNames.includes('conversations/antigravity/agy-included/agy-included.meta'));
    assert.ok(!entryNames.some((name) => name.includes('agy-excluded')));

    await rm(workDir, { recursive: true, force: true });
  });
});

test('shared conversation stores copy only exact SQLite artifacts and omit auth files', async () => {
  await withIsolatedDatabase(async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'backups-shared-store-'));
    const destination = path.join(workDir, 'destination');
    const opencodeRoot = path.join(workDir, 'opencode');
    const kiloRoot = path.join(workDir, 'kilo');
    await Promise.all([
      mkdir(opencodeRoot, { recursive: true }),
      mkdir(kiloRoot, { recursive: true }),
    ]);

    const opencodeDatabase = path.join(opencodeRoot, 'opencode.db');
    const kiloDatabase = path.join(kiloRoot, 'kilo.db');
    await Promise.all([
      writeFile(opencodeDatabase, 'opencode transcript store'),
      writeFile(`${opencodeDatabase}-wal`, 'opencode wal'),
      writeFile(path.join(opencodeRoot, 'auth.json'), '{"token":"opencode-secret"}'),
      writeFile(path.join(opencodeRoot, 'unrelated.json'), '{"not":"a transcript"}'),
      writeFile(kiloDatabase, 'kilo transcript store'),
      writeFile(path.join(kiloRoot, 'auth.json'), '{"token":"kilo-secret"}'),
    ]);
    setBackupConversationSourcesForTests([
      { provider: 'opencode', rootPath: opencodeRoot, databasePath: opencodeDatabase },
      { provider: 'kilo', rootPath: kiloRoot, databasePath: kiloDatabase },
    ]);

    sessionsDb.createSession('opencode-included', 'opencode', '/workspace/shared-opencode', 'OpenCode', undefined, undefined, null);
    sessionsDb.createSession('kilo-included', 'kilo', '/workspace/shared-kilo', 'Kilo', undefined, undefined, null);
    updateBackupConfig({
      destination,
      includeDatabase: false,
      includeCodebase: false,
      includeAgentConversations: true,
      excludedProjectPaths: [],
    });

    const result = await runBackup('manual');
    const zip = await JSZip.loadAsync(await readFile(result.path as string));
    const entryNames = Object.keys(zip.files);
    assert.ok(entryNames.includes('conversations/opencode/opencode.db'));
    assert.ok(entryNames.includes('conversations/opencode/opencode.db-wal'));
    assert.ok(entryNames.includes('conversations/kilo/kilo.db'));
    assert.ok(!entryNames.some((name) => name.endsWith('/auth.json')));
    assert.ok(!entryNames.some((name) => name.endsWith('/unrelated.json')));

    const manifest = await loadManifest(result.path as string);
    const agentConversations = manifest.agentConversations as { providers: Array<Record<string, unknown>> };
    assert.equal(agentConversations.providers.find((entry) => entry.provider === 'opencode')?.coverage, 'full-store');
    assert.equal(agentConversations.providers.find((entry) => entry.provider === 'kilo')?.coverage, 'full-store');

    await rm(workDir, { recursive: true, force: true });
  });
});

test('project source archive prefixes distinguish duplicate basenames', async () => {
  await withIsolatedDatabase(async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'backups-project-prefix-'));
    const destination = path.join(workDir, 'destination');
    const firstProject = path.join(workDir, 'one', 'demo');
    const secondProject = path.join(workDir, 'two', 'demo');
    await Promise.all([
      mkdir(firstProject, { recursive: true }),
      mkdir(secondProject, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(firstProject, 'first.txt'), 'first project'),
      writeFile(path.join(secondProject, 'second.txt'), 'second project'),
    ]);

    updateBackupConfig({
      destination,
      includeDatabase: false,
      includeCodebase: false,
      includeAgentConversations: false,
      includeProjects: true,
      projectPaths: [firstProject, secondProject],
    });

    const result = await runBackup('manual');
    const zip = await JSZip.loadAsync(await readFile(result.path as string));
    const fileEntries = Object.keys(zip.files).filter((name) => name.endsWith('.txt'));
    assert.equal(fileEntries.length, 2);
    const prefixes = new Set(fileEntries.map((name) => name.split('/').slice(0, 2).join('/')));
    assert.equal(prefixes.size, 2);
    assert.ok([...prefixes].every((prefix) => /^projects\/demo-[a-f0-9]{16}$/.test(prefix)));

    await rm(workDir, { recursive: true, force: true });
  });
});
