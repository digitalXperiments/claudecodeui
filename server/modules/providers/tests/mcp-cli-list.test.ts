import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeCliMcpEntries,
  parseCliMcpListOutput,
} from '@/modules/providers/services/mcp-cli-list.service.js';

test('parseCliMcpListOutput parses claude mcp list lines', () => {
  const raw = `
Checking MCP server health…

claude.ai Superhuman Docs: https://docs.superhuman.com/apis/mcp - ! Needs authentication
claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
obsidian: npx -y @fazer-ai/mcp-obsidian@latest - ✔ Connected
cloudcli-browser: /usr/bin/node /path/to/browser-use-mcp.js - ✔ Connected
leong-associates-mcp: https://example.com/mcp (HTTP) - ✔ Connected
`;
  const entries = parseCliMcpListOutput(raw);
  assert.equal(entries.length, 5);

  const slack = entries.find((e) => e.name === 'claude.ai Slack');
  assert.ok(slack);
  assert.equal(slack!.target, 'https://mcp.slack.com/mcp');
  assert.equal(slack!.connected, true);
  assert.equal(slack!.needsAuth, false);

  const superhuman = entries.find((e) => e.name === 'claude.ai Superhuman Docs');
  assert.ok(superhuman);
  assert.equal(superhuman!.needsAuth, true);
  assert.equal(superhuman!.connected, false);

  const obsidian = entries.find((e) => e.name === 'obsidian');
  assert.ok(obsidian);
  assert.match(obsidian!.target, /npx/);
});

test('parseCliMcpListOutput parses grok project marker', () => {
  const raw = `
  Composio: https://connect.composio.dev/mcp
  x-mcp: npx -y @xdevplatform/xurl mcp https://api.x.com/mcp
  obsidian: npx -y @fazer-ai/mcp-obsidian@latest (project)
`;
  const entries = parseCliMcpListOutput(raw);
  assert.equal(entries.length, 3);
  const obs = entries.find((e) => e.name === 'obsidian');
  assert.ok(obs);
  assert.equal(obs!.projectScoped, true);
  assert.match(obs!.target, /npx/);
});

test('mergeCliMcpEntries prefers existing file config', () => {
  const existing = [
    {
      provider: 'claude' as const,
      name: 'obsidian',
      scope: 'user' as const,
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@fazer-ai/mcp-obsidian@latest'],
      env: { OBSIDIAN_API_KEY: 'secret' },
    },
  ];
  const cli = parseCliMcpListOutput(`
obsidian: npx -y @fazer-ai/mcp-obsidian@latest - ✔ Connected
claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
`);
  const merged = mergeCliMcpEntries('claude', 'user', existing, cli);
  assert.equal(merged.length, 2);
  const obs = merged.find((s) => s.name === 'obsidian');
  assert.equal(obs?.env?.OBSIDIAN_API_KEY, 'secret');
  assert.ok(merged.find((s) => s.name === 'claude.ai Slack'));
});
