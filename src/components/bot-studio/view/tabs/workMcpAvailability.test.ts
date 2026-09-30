import assert from 'node:assert/strict';
import test from 'node:test';

import type { McpInventoryItem } from '../../../mcp/types';

import { workMcpUnavailableReason } from './workMcpAvailability';

test('work MCP selection requires an explicit catalog binding, even for native servers', () => {
  const browser: McpInventoryItem = { name: 'cloudcli-browser', source: 'provider_native', providers: ['antigravity'] };
  assert.match(workMcpUnavailableReason(browser, 'antigravity')!, /shared catalog/);
  const catalog: McpInventoryItem = { ...browser, source: 'cloudcli', bindings: { claude: { enabled: true } } };
  assert.match(workMcpUnavailableReason(catalog, 'antigravity')!, /Enable for antigravity/);
  assert.equal(workMcpUnavailableReason({ ...catalog, bindings: { antigravity: { enabled: true } } }, 'antigravity'), null);
  assert.match(workMcpUnavailableReason(undefined, 'antigravity')!, /Not found/);
});

test('Claude account connectors remain confined to Claude', () => {
  const connector: McpInventoryItem = { name: 'claude.ai Slack', source: 'provider_cloud', providers: ['claude'], originProvider: 'claude' };
  assert.equal(workMcpUnavailableReason(connector, 'claude'), null);
  assert.match(workMcpUnavailableReason(connector, 'antigravity')!, /belongs to claude/);
});
