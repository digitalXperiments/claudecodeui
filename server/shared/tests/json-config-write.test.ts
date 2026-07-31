import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJsonConfig, updateJsonConfig, writeJsonConfig } from '@/shared/utils.js';

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-json-config-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('writeJsonConfig leaves no temp files behind', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, '.claude.json');
    await writeJsonConfig(target, { mcpServers: { a: { command: 'x' } } });

    assert.deepEqual(await readdir(dir), ['.claude.json']);
    assert.deepEqual(await readJsonConfig(target), { mcpServers: { a: { command: 'x' } } });
  });
});

test('writeJsonConfig preserves the existing file mode', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'config.json');
    await writeFile(target, '{}\n', { encoding: 'utf8', mode: 0o644 });
    const before = (await stat(target)).mode & 0o777;

    await writeJsonConfig(target, { changed: true });

    assert.equal((await stat(target)).mode & 0o777, before);
  });
});

// The `~/.claude.json` hazard: a plain read-modify-write drops whichever
// concurrent update read first, which for that file can revert `oauthAccount`
// and log the user out of Claude Code.
test('updateJsonConfig serializes concurrent updates without losing any', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, '.claude.json');
    await writeJsonConfig(target, { oauthAccount: { emailAddress: 'user@example.com' } });

    await Promise.all(
      Array.from({ length: 25 }, (_, index) => updateJsonConfig(target, (config) => {
        const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
        servers[`server-${index}`] = { command: 'node' };
        config.mcpServers = servers;
        return config;
      })),
    );

    const final = await readJsonConfig(target);
    const servers = final.mcpServers as Record<string, unknown>;

    assert.equal(Object.keys(servers).length, 25, 'every concurrent update must survive');
    // Unrelated keys owned by the Claude CLI must be untouched.
    assert.deepEqual(final.oauthAccount, { emailAddress: 'user@example.com' });
  });
});

test('updateJsonConfig keeps keys it does not own when the file changes underneath', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, '.claude.json');
    await writeJsonConfig(target, { oauthAccount: { emailAddress: 'old@example.com' } });

    // Simulate the Claude CLI rewriting the file, then CloudCLI merging: because
    // the read happens inside the lock, the newer account survives.
    await writeJsonConfig(target, {
      oauthAccount: { emailAddress: 'new@example.com' },
      projects: { '/tmp/x': { hasTrustDialogAccepted: true } },
    });

    await updateJsonConfig(target, (config) => {
      config.mcpServers = { obsidian: { command: 'node' } };
      return config;
    });

    const final = await readJsonConfig(target);
    assert.deepEqual(final.oauthAccount, { emailAddress: 'new@example.com' });
    assert.deepEqual(final.projects, { '/tmp/x': { hasTrustDialogAccepted: true } });
    assert.deepEqual(final.mcpServers, { obsidian: { command: 'node' } });
  });
});

test('updateJsonConfig skips the write when the mutator returns null', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'config.json');
    await writeJsonConfig(target, { keep: true });

    await updateJsonConfig(target, () => null);

    assert.deepEqual(await readJsonConfig(target), { keep: true });
  });
});

test('a failed update does not block later writes to the same path', async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, 'config.json');
    await writeJsonConfig(target, { n: 0 });

    await assert.rejects(updateJsonConfig(target, () => {
      throw new Error('mutator blew up');
    }), /mutator blew up/);

    await updateJsonConfig(target, (config) => ({ ...config, n: 1 }));
    assert.deepEqual(await readJsonConfig(target), { n: 1 });
  });
});
