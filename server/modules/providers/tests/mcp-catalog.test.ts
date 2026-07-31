import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mcpCatalogService } from '@/modules/providers/services/mcp-catalog.service.js';

/**
 * Catalog is the single source of truth; fan-out writes provider-specific
 * projections. Bindings are sparse — only checked providers get a copy.
 */
test('mcpCatalogService upserts once and fans out only to selected providers', {
  concurrency: false,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-catalog-'));
  const originalHome = os.homedir;
  (os as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await fs.mkdir(path.join(tempRoot, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, '.claude.json'), JSON.stringify({}), 'utf8');
    await fs.mkdir(path.join(tempRoot, '.grok'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, '.cursor'), { recursive: true });

    const entry = await mcpCatalogService.upsert({
      name: 'shared-obsidian',
      transport: 'stdio',
      scope: 'user',
      command: 'npx',
      args: ['-y', '@fazer-ai/mcp-obsidian@1.2.0'],
      env: { OBSIDIAN_API_KEY: 'test-key' },
      providers: ['claude', 'grok'],
    });

    assert.equal(entry.name, 'shared-obsidian');
    assert.equal(entry.source, 'cloudcli');
    assert.equal(entry.bindings.claude?.enabled, true);
    assert.equal(entry.bindings.grok?.enabled, true);
    assert.equal(entry.bindings.cursor?.enabled, false);

    const catalogPath = path.join(tempRoot, '.cloudcli', 'mcp', 'catalog.json');
    const catalogRaw = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as {
      servers: Record<string, { name: string }>;
    };
    assert.ok(catalogRaw.servers['shared-obsidian']);

    // Claude projection
    const claudeConfig = JSON.parse(await fs.readFile(path.join(tempRoot, '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.ok(claudeConfig.mcpServers?.['shared-obsidian']);

    // Grok projection (TOML)
    const grokToml = await fs.readFile(path.join(tempRoot, '.grok', 'config.toml'), 'utf8');
    assert.match(grokToml, /shared-obsidian/);

    // Cursor must not receive it
    const cursorPath = path.join(tempRoot, '.cursor', 'mcp.json');
    let cursorExists = true;
    try {
      await fs.stat(cursorPath);
    } catch {
      cursorExists = false;
    }
    if (cursorExists) {
      const cursorConfig = JSON.parse(await fs.readFile(cursorPath, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
      };
      assert.equal(cursorConfig.mcpServers?.['shared-obsidian'], undefined);
    }

    // Inventory must list a single catalog row (no duplicate definition)
    const inventory = await mcpCatalogService.listInventory();
    const matches = inventory.filter((i) => i.name === 'shared-obsidian');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].source, 'cloudcli');
    assert.deepEqual([...matches[0].providers].sort(), ['claude', 'grok']);

    // Disable Grok only
    const updated = await mcpCatalogService.setBindings({
      name: 'shared-obsidian',
      providers: ['claude'],
    });
    assert.equal(updated.bindings.grok?.enabled, false);
    const grokTomlAfter = await fs.readFile(path.join(tempRoot, '.grok', 'config.toml'), 'utf8');
    assert.doesNotMatch(grokTomlAfter, /shared-obsidian/);

    // Remove tears down all projections
    await mcpCatalogService.remove('shared-obsidian');
    const claudeAfter = JSON.parse(await fs.readFile(path.join(tempRoot, '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.equal(claudeAfter.mcpServers?.['shared-obsidian'], undefined);
    const catalogAfter = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as {
      servers: Record<string, unknown>;
    };
    assert.equal(catalogAfter.servers['shared-obsidian'], undefined);
  } finally {
    os.homedir = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveForProvider only resolves servers bound to that provider', {
  concurrency: false,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-catalog-resolve-'));
  const originalHome = os.homedir;
  (os as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await fs.mkdir(path.join(tempRoot, '.claude'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, '.claude.json'), JSON.stringify({}), 'utf8');
    await fs.mkdir(path.join(tempRoot, '.grok'), { recursive: true });

    await mcpCatalogService.upsert({
      name: 'bound-to-grok',
      transport: 'stdio',
      scope: 'user',
      command: 'npx',
      args: ['-y', 'some-mcp'],
      env: { TOKEN: 'abc' },
      providers: ['grok'],
    });
    await mcpCatalogService.upsert({
      name: 'claude-only',
      transport: 'http',
      scope: 'user',
      url: 'https://example.com/mcp',
      providers: ['claude'],
    });

    const resolved = await mcpCatalogService.resolveForProvider('grok', ['bound-to-grok', 'claude-only', 'unknown-name']);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].name, 'bound-to-grok');
    assert.equal(resolved[0].transport, 'stdio');
    assert.equal(resolved[0].command, 'npx');
    assert.deepEqual(resolved[0].args, ['-y', 'some-mcp']);
    assert.deepEqual(resolved[0].env, { TOKEN: 'abc' });

    const none = await mcpCatalogService.resolveForProvider('grok', []);
    assert.deepEqual(none, []);
  } finally {
    os.homedir = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('mcpCatalogService create with no providers stays catalog-only', {
  concurrency: false,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-catalog-empty-'));
  const originalHome = os.homedir;
  (os as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await fs.writeFile(path.join(tempRoot, '.claude.json'), JSON.stringify({}), 'utf8');

    await mcpCatalogService.upsert({
      name: 'draft-server',
      transport: 'http',
      scope: 'user',
      url: 'https://example.com/mcp',
      providers: [],
    });

    const claudeConfig = JSON.parse(await fs.readFile(path.join(tempRoot, '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    assert.equal(claudeConfig.mcpServers?.['draft-server'], undefined);

    const catalog = await mcpCatalogService.listCatalog();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, 'draft-server');
    assert.deepEqual(
      Object.values(catalog[0].bindings).every((b) => b?.enabled === false),
      true,
    );
  } finally {
    os.homedir = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
