import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AGENT_RELAY_MCP_SERVER_NAME, AGENT_RELAY_MCP_TOOLS } from '@/shared/agent-relay-mcp-tools.js';
import { mcpCatalogService } from '@/modules/providers/services/mcp-catalog.service.js';
import { mcpToolsProbeService } from '@/modules/providers/services/mcp-tools-probe.service.js';

/**
 * A tiny stdio MCP server: answers `initialize` and `tools/list` with a
 * fixed fake tool, ignores everything else. Used to exercise the probe
 * without depending on any real MCP server binary.
 */
const FAKE_STDIO_SERVER_SCRIPT = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const raw = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!raw) continue;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'fake_tool', description: 'A fake tool for tests.', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
    }
  }
});
`;

test('mcpToolsProbeService returns the built-in catalog for cloudcli-agent-relay without spawning', {
  concurrency: false,
}, async () => {
  const result = await mcpToolsProbeService.listTools(AGENT_RELAY_MCP_SERVER_NAME);
  assert.deepEqual(result.tools, AGENT_RELAY_MCP_TOOLS);
  assert.equal(result.error, undefined);
});

test('mcpToolsProbeService probes a stdio catalog server and caches the result', {
  concurrency: false,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-tools-probe-'));
  const originalHome = os.homedir;
  (os as { homedir: () => string }).homedir = () => tempRoot;

  try {
    await mcpCatalogService.upsert({
      name: 'fake-tools-server',
      transport: 'stdio',
      scope: 'user',
      command: process.execPath,
      args: ['-e', FAKE_STDIO_SERVER_SCRIPT],
      providers: [],
    });

    mcpToolsProbeService.clearCache('fake-tools-server');
    const first = await mcpToolsProbeService.listTools('fake-tools-server');
    assert.equal(first.error, undefined);
    assert.equal(first.tools.length, 1);
    assert.equal(first.tools[0].name, 'fake_tool');
    assert.equal(first.cached, undefined);

    const second = await mcpToolsProbeService.listTools('fake-tools-server');
    assert.equal(second.cached, true);
    assert.equal(second.tools[0].name, 'fake_tool');
  } finally {
    mcpToolsProbeService.clearCache('fake-tools-server');
    (os as { homedir: () => string }).homedir = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('mcpToolsProbeService reports an error for an unknown catalog server', {
  concurrency: false,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-tools-probe-missing-'));
  const originalHome = os.homedir;
  (os as { homedir: () => string }).homedir = () => tempRoot;

  try {
    mcpToolsProbeService.clearCache('does-not-exist');
    const result = await mcpToolsProbeService.listTools('does-not-exist');
    assert.deepEqual(result.tools, []);
    assert.match(result.error ?? '', /not found/i);
  } finally {
    (os as { homedir: () => string }).homedir = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
