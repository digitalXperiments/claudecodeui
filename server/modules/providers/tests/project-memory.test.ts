import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scaffoldVault, resolveVaultTargetDir } from '@/modules/providers/shared/memory/memory.scaffold.js';
import {
  buildObsidianMcpServerInput,
  OBSIDIAN_MCP_SERVER_NAME,
} from '@/modules/providers/shared/memory/obsidian-mcp.config.js';
import {
  buildMemorySkillContent,
  MEMORY_SKILL_DIRECTORY_NAME,
} from '@/modules/providers/shared/memory/memory-skill.template.js';
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
  assert.equal(input.command, 'npx');
  assert.deepEqual(input.args, ['-y', '@fazer-ai/mcp-obsidian@latest']);
  assert.equal(input.env?.OBSIDIAN_API_KEY, 'secret-key');
  assert.equal(input.env?.OBSIDIAN_PROTOCOL, 'http');
  assert.equal(input.env?.OBSIDIAN_HOST, '127.0.0.1');
  assert.equal(input.env?.OBSIDIAN_PORT, '27123');
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
});
