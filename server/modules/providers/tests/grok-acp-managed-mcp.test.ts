import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildGrokPriorSessionContextHint,
  seedGrokSessionTranscript,
  shouldPreferGrokAcpSessionLoad,
  toGrokAcpMcpServers,
} from '@/modules/providers/list/grok/grok-acp-managed-mcp.js';
import { resolveGrokSessionDir } from '@/modules/providers/list/grok/grok-sessions.provider.js';

test('shouldPreferGrokAcpSessionLoad defaults to false (session/new for managed MCPs)', () => {
  assert.equal(shouldPreferGrokAcpSessionLoad(null, {}), false);
  assert.equal(shouldPreferGrokAcpSessionLoad('sess-1', {}), false);
  assert.equal(shouldPreferGrokAcpSessionLoad('sess-1', { CLOUDCLI_GROK_ACP_SESSION_LOAD: '0' }), false);
});

test('shouldPreferGrokAcpSessionLoad is true only with explicit env', () => {
  assert.equal(
    shouldPreferGrokAcpSessionLoad('sess-1', { CLOUDCLI_GROK_ACP_SESSION_LOAD: '1' }),
    true,
  );
  assert.equal(
    shouldPreferGrokAcpSessionLoad('sess-1', { CLOUDCLI_GROK_ACP_SESSION_LOAD: 'true' }),
    true,
  );
  assert.equal(
    shouldPreferGrokAcpSessionLoad('', { CLOUDCLI_GROK_ACP_SESSION_LOAD: '1' }),
    false,
  );
});

test('seedGrokSessionTranscript copies empty dest from prior session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-acp-seed-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const projectPath = path.join(root, 'proj');
    const fromId = 'from-id';
    const toId = 'to-id';
    const fromDir = resolveGrokSessionDir(projectPath, fromId);
    const toDir = resolveGrokSessionDir(projectPath, toId);
    await mkdir(fromDir, { recursive: true });
    await mkdir(toDir, { recursive: true });
    await writeFile(path.join(fromDir, 'chat_history.jsonl'), '{"type":"user","content":"hi"}\n');
    await writeFile(path.join(fromDir, 'summary.json'), '{"title":"t"}');
    await writeFile(path.join(toDir, 'chat_history.jsonl'), '');

    assert.equal(seedGrokSessionTranscript(projectPath, fromId, toId), true);
    const seeded = await readFile(path.join(toDir, 'chat_history.jsonl'), 'utf8');
    assert.match(seeded, /"type":"user"/);
    const summary = await readFile(path.join(toDir, 'summary.json'), 'utf8');
    assert.match(summary, /title/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('seedGrokSessionTranscript does not overwrite non-empty dest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-acp-seed-keep-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const projectPath = path.join(root, 'proj');
    const fromId = 'from-id';
    const toId = 'to-id';
    const fromDir = resolveGrokSessionDir(projectPath, fromId);
    const toDir = resolveGrokSessionDir(projectPath, toId);
    await mkdir(fromDir, { recursive: true });
    await mkdir(toDir, { recursive: true });
    await writeFile(path.join(fromDir, 'chat_history.jsonl'), '{"type":"user","content":"old"}\n');
    await writeFile(path.join(toDir, 'chat_history.jsonl'), '{"type":"user","content":"already here"}\n');

    // Returns false when nothing was copied (dest already had content).
    assert.equal(seedGrokSessionTranscript(projectPath, fromId, toId), false);
    const kept = await readFile(path.join(toDir, 'chat_history.jsonl'), 'utf8');
    assert.match(kept, /already here/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test('toGrokAcpMcpServers uses ACP env array + type (not config.toml map)', () => {
  const out = toGrokAcpMcpServers([
    {
      name: 'obsidian',
      transport: 'stdio',
      command: 'node',
      args: ['/tmp/obs.js'],
      env: { OBSIDIAN_API_KEY: 'secret', OBSIDIAN_PORT: '27123' },
    },
    {
      name: 'Composio',
      transport: 'http',
      url: 'https://connect.composio.dev/mcp',
      headers: { Authorization: 'Bearer x' },
    },
  ]);

  assert.deepEqual(out[0], {
    name: 'obsidian',
    type: 'stdio',
    command: 'node',
    args: ['/tmp/obs.js'],
    env: [
      { name: 'OBSIDIAN_API_KEY', value: 'secret' },
      { name: 'OBSIDIAN_PORT', value: '27123' },
    ],
  });
  assert.equal(out[1].type, 'http');
  assert.equal(out[1].url, 'https://connect.composio.dev/mcp');
  assert.deepEqual(out[1].headers, [{ name: 'Authorization', value: 'Bearer x' }]);
  // No undefined cwd key — ACP rejects unknown/null fields on the enum.
  assert.equal('cwd' in (out[0] as object), false);
});

test('buildGrokPriorSessionContextHint extracts recent user turns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-acp-hint-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const projectPath = path.join(root, 'proj');
    const sessionId = 'sess-hint';
    const dir = resolveGrokSessionDir(projectPath, sessionId);
    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'user', content: '<user_query>first question</user_query>' }),
      JSON.stringify({ type: 'assistant', content: 'first answer about widgets' }),
      JSON.stringify({ type: 'user', content: '<user_query>second question</user_query>' }),
    ];
    await writeFile(path.join(dir, 'chat_history.jsonl'), `${lines.join('\n')}\n`);

    const hint = buildGrokPriorSessionContextHint(projectPath, sessionId);
    assert.match(hint, /system-reminder/);
    assert.match(hint, /first question/);
    assert.match(hint, /second question/);
    assert.match(hint, /first answer about widgets/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
