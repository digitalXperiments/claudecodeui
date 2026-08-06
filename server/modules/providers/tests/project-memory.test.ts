import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  configureMemoryCurationRuntimes,
  listStaleNotes,
  projectMemoryService,
} from '@/modules/providers/services/project-memory.service.js';
import { scaffoldVault, resolveVaultTargetDir } from '@/modules/providers/shared/memory/memory.scaffold.js';
import {
  buildObsidianCodexRuntimeConfig,
  buildObsidianMcpServerInput,
  OBSIDIAN_MCP_SERVER_NAME,
} from '@/modules/providers/shared/memory/obsidian-mcp.config.js';
import {
  buildMemorySkillContent,
  MEMORY_SKILL_DIRECTORY_NAME,
} from '@/modules/providers/shared/memory/memory-skill.template.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/utils.js';

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Scaffolding writes the full second-brain skeleton on disk and is idempotent:
 * a second run must not clobber notes an agent may have edited.
 */
test('scaffoldVault writes the full skeleton and is idempotent', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-scaffold-'));
  try {
    const vaultPath = path.join(tempRoot, 'vault');
    const vaultFolder = 'Projects/demo';

    const first = await scaffoldVault({ vaultPath, vaultFolder, projectName: 'Demo' });
    assert.ok(first.created.includes('00-Overview.md'));
    assert.ok(first.created.includes('Index.md'));
    assert.equal(first.skipped.length, 0);

    const targetDir = path.join(vaultPath, 'Projects', 'demo');
    assert.equal(await pathExists(path.join(targetDir, '00-Overview.md')), true);
    assert.equal(await pathExists(path.join(targetDir, 'Index.md')), true);
    assert.equal(await pathExists(path.join(targetDir, 'Decisions')), true);
    assert.equal(await pathExists(path.join(targetDir, 'Entities')), true);
    assert.equal(await pathExists(path.join(targetDir, 'Sessions')), true);

    // Simulate an agent edit, then re-scaffold: the edit must survive.
    const overviewPath = path.join(targetDir, '00-Overview.md');
    await fs.writeFile(overviewPath, '# edited by an agent\n', 'utf8');

    const second = await scaffoldVault({ vaultPath, vaultFolder, projectName: 'Demo' });
    assert.equal(second.created.length, 0);
    assert.ok(second.skipped.includes('00-Overview.md'));
    assert.equal(await fs.readFile(overviewPath, 'utf8'), '# edited by an agent\n');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * A vault folder must never escape the vault root.
 */
test('resolveVaultTargetDir rejects path traversal', () => {
  assert.throws(
    () => resolveVaultTargetDir('/tmp/vault', '../../etc'),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );

  const ok = resolveVaultTargetDir('/tmp/vault', 'Projects/demo');
  assert.equal(ok, path.resolve('/tmp/vault', 'Projects/demo'));
});

/**
 * The MCP server definition installed into agents uses stdio + the shared name,
 * and threads the REST credentials through as env.
 */
test('buildObsidianMcpServerInput produces a stdio server carrying REST creds', () => {
  const input = buildObsidianMcpServerInput({
    vaultPath: '/tmp/vault',
    restProtocol: 'http',
    restHost: '127.0.0.1',
    restPort: 27123,
    restApiKey: 'secret-key',
  });

  assert.equal(input.name, OBSIDIAN_MCP_SERVER_NAME);
  assert.equal(input.transport, 'stdio');
  assert.equal(input.command, 'node');
  assert.equal(input.args?.length, 1);
  assert.ok(input.args?.[0].endsWith(path.join('mcp-obsidian', 'dist', 'index.js')));
  assert.equal(input.env?.OBSIDIAN_API_KEY, 'secret-key');
  assert.equal(input.env?.OBSIDIAN_PROTOCOL, 'http');
  assert.equal(input.env?.OBSIDIAN_HOST, '127.0.0.1');
  assert.equal(input.env?.OBSIDIAN_PORT, '27123');
});

test('buildObsidianCodexRuntimeConfig keeps REST creds in the child environment', () => {
  const runtime = buildObsidianCodexRuntimeConfig({
    vaultPath: '/vault',
    restProtocol: 'http',
    restHost: '127.0.0.1',
    restPort: 27123,
    restApiKey: 'secret-key',
  }, {
    PATH: '/bin',
    HOME: '/home/test',
  });

  const server = runtime.config.mcp_servers[OBSIDIAN_MCP_SERVER_NAME];
  assert.equal(server.command, 'node');
  assert.ok(server.args[0].endsWith('mcp-obsidian/dist/index.js'));
  assert.deepEqual(server.env_vars, [
    'OBSIDIAN_API_KEY',
    'OBSIDIAN_PROTOCOL',
    'OBSIDIAN_HOST',
    'OBSIDIAN_PORT',
  ]);
  assert.equal(server.default_tools_approval_mode, 'auto');
  assert.equal(runtime.env.OBSIDIAN_API_KEY, 'secret-key');
  assert.equal(runtime.env.OBSIDIAN_PROTOCOL, 'http');
  assert.equal(runtime.env.OBSIDIAN_HOST, '127.0.0.1');
  assert.equal(runtime.env.OBSIDIAN_PORT, '27123');
});

/**
 * The Memory skill must carry valid front matter and reference the project's
 * vault folder so agents scope their reads/writes correctly.
 */
test('buildMemorySkillContent embeds front matter and the vault folder', () => {
  const content = buildMemorySkillContent('Projects/demo');
  assert.match(content, /^---\nname: project-memory\n/);
  assert.match(content, /Projects\/demo\/00-Overview\.md/);
  assert.match(content, /Projects\/demo\/Sessions/);
  assert.equal(MEMORY_SKILL_DIRECTORY_NAME, 'project-memory');

  // Must document the real Obsidian MCP tool names (agents were previously
  // confused by non-existent names like get_note/search_notes).
  assert.match(content, /obsidian_get_file/);
  assert.match(content, /obsidian_simple_search/);
  assert.match(content, /obsidian_put_file/);
  assert.match(content, /obsidian_post_file/);
  assert.doesNotMatch(content, /`get_note`|`search_notes`|`create_note`|`update_note`|`get_backlinks`|`list_notes`/);

  // Write tools return a spurious "Unexpected end of JSON input" on success
  // (204 empty body). The skill must tell agents to treat it as success and not
  // retry, or they abandon memory / duplicate session entries.
  assert.match(content, /Unexpected end of JSON input/);
  assert.match(content, /treat it as success/i);
  assert.match(content, /do NOT retry/i);

  // The skill documents the curation contract so agents keep durable facts in
  // the session log for later curation passes.
  assert.match(content, /## Curation/);
});

/**
 * listStaleNotes walks the vault folder (ignoring hidden dirs) and returns only
 * markdown notes whose mtime is at least `staleDays` old, sorted by age.
 */
test('listStaleNotes flags old notes with correct daysOld and skips fresh/hidden ones', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-stale-'));
  try {
    const vaultPath = path.join(tempRoot, 'vault');
    await fs.mkdir(path.join(vaultPath, 'Decisions'), { recursive: true });
    await fs.mkdir(path.join(vaultPath, 'Sessions'), { recursive: true });
    await fs.mkdir(path.join(vaultPath, '.obsidian'), { recursive: true });

    const oldPath = path.join(vaultPath, 'Decisions', 'old-note.md');
    const freshPath = path.join(vaultPath, 'Sessions', 'fresh-note.md');
    const hiddenOldPath = path.join(vaultPath, '.obsidian', 'workspace.md');
    await fs.writeFile(oldPath, '# old\n', 'utf8');
    await fs.writeFile(freshPath, '# fresh\n', 'utf8');
    await fs.writeFile(hiddenOldPath, '# hidden\n', 'utf8');

    const oldMtime = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldPath, oldMtime, oldMtime);

    const stale = await listStaleNotes(vaultPath, 90);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.relativePath, 'Decisions/old-note.md');
    assert.equal(stale[0]?.path, oldPath);
    assert.ok(stale[0] && stale[0].daysOld >= 119 && stale[0].daysOld <= 121, 'daysOld near 120');
    assert.ok(stale[0]?.lastModified, 'lastModified timestamp present');

    // Fresh note and hidden-dir note are excluded.
    assert.ok(!stale.some((note) => note.relativePath.includes('fresh-note')));
    assert.ok(!stale.some((note) => note.relativePath.includes('.obsidian')));

    // A huge threshold keeps every note out.
    assert.deepEqual(await listStaleNotes(vaultPath, 10000), []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('listStaleNotes returns [] for a missing or empty vault', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-stale-empty-'));
  try {
    assert.deepEqual(await listStaleNotes(path.join(tempRoot, 'missing')), []);

    const emptyVault = path.join(tempRoot, 'empty-vault');
    await fs.mkdir(emptyVault, { recursive: true });
    assert.deepEqual(await listStaleNotes(emptyVault), []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-curation-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

test('curateProjectMemory runs a headless agent and parses its suggestions', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-curation-'));
    try {
      const suggestions = [
        {
          action: 'create',
          path: 'Entities/api-gateway.md',
          content: '# API Gateway\n\nREST edge for all clients.\n',
          reason: 'Durable entity discovered in recent sessions',
          confidence: 0.9,
        },
        {
          action: 'link',
          path: 'Index.md',
          content: '- [[api-gateway]]',
          reason: 'Connect the new entity to the map of content',
          confidence: 0.7,
        },
      ];

      const fakeSpawn = async (_content: string, _options: unknown, writer: unknown) => {
        const w = writer as {
          send: (message: Record<string, unknown>) => void;
          sendComplete: (opts: { exitCode: number }) => void;
        };
        w.send({ kind: 'text', provider: 'claude', content: JSON.stringify(suggestions) });
        w.sendComplete({ exitCode: 0 });
      };
      configureMemoryCurationRuntimes({ claude: fakeSpawn });

      const result = await projectMemoryService.curateProjectMemory({
        workspacePath: tempRoot,
        vaultFolder: 'Projects/demo',
      });

      assert.equal(result.success, true);
      assert.equal(result.error, undefined);
      assert.equal(result.suggestions.length, 2);
      assert.equal(result.suggestions[0]?.action, 'create');
      assert.equal(result.suggestions[0]?.path, 'Entities/api-gateway.md');
      assert.equal(result.suggestions[0]?.confidence, 0.9);
      assert.equal(result.suggestions[1]?.action, 'link');
      assert.equal(result.suggestions[1]?.path, 'Index.md');

      // The headless run created a persisted session row for the project.
      assert.ok(sessionsDb.getSessionsByProjectPath(tempRoot).length >= 1);
    } finally {
      configureMemoryCurationRuntimes({});
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test('applyMemoryCurationSuggestion writes notes into the vault and rejects path escapes', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-curation-apply-'));
  try {
    const vaultPath = path.join(tempRoot, 'vault');

    const result = await projectMemoryService.applyMemoryCurationSuggestion({
      vaultPath,
      vaultFolder: 'Projects/demo',
      path: 'Entities/api-gateway.md',
      content: '# API Gateway\n\nREST edge for all clients.\n',
    });
    assert.equal(result.success, true);
    assert.equal(result.created, true);
    assert.equal(result.path, path.resolve(vaultPath, 'Projects/demo/Entities/api-gateway.md'));
    assert.match(await fs.readFile(result.path, 'utf8'), /API Gateway/);

    // Overwriting an existing note reports created: false.
    const again = await projectMemoryService.applyMemoryCurationSuggestion({
      vaultPath,
      vaultFolder: 'Projects/demo',
      path: 'Entities/api-gateway.md',
      content: '# API Gateway v2\n',
    });
    assert.equal(again.success, true);
    assert.equal(again.created, false);
    assert.match(await fs.readFile(result.path, 'utf8'), /v2/);

    // A note path escaping the vault folder is rejected and nothing is written.
    const escape = await projectMemoryService.applyMemoryCurationSuggestion({
      vaultPath,
      vaultFolder: 'Projects/demo',
      path: '../../evil.md',
      content: 'x',
    });
    assert.equal(escape.success, false);
    assert.ok(escape.error);
    assert.equal(await pathExists(path.resolve(tempRoot, 'evil.md')), false);

    // A non-markdown note path is rejected.
    const nonMd = await projectMemoryService.applyMemoryCurationSuggestion({
      vaultPath,
      vaultFolder: 'Projects/demo',
      path: 'Entities/api-gateway.txt',
      content: 'x',
    });
    assert.equal(nonMd.success, false);
    assert.match(nonMd.error ?? '', /\.md/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
