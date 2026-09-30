import test from 'node:test';
import assert from 'node:assert/strict';

import { trustWarnings } from './trustWarnings';

const base = { permission_mode: 'default', resolve_prompt: 'Resolve.', auto_approve: false, work_profile: null, produce_tools: [], resolve_tools: [], tool_policy: {}, provider: 'claude', scope: 'project' as const };

test('flags automatic stages, bypass mode, and missing tool decisions', () => {
  assert.deepEqual(trustWarnings(base), []);
  assert.deepEqual(trustWarnings({ ...base, auto_approve: true }), ['New items are resolved automatically without review.']);
  const endToEnd = { ...base, auto_approve: true, work_profile: { auto_start: true, provider: 'claude' as const, model: 'm', effort: null, mcp_servers: [], context: '', default_project_id: 'p', routes: [] } };
  assert.ok(trustWarnings(endToEnd).includes('Items run end-to-end without review.'));
  assert.ok(trustWarnings({ ...base, permission_mode: 'bypassPermissions' })[0].includes('bypasses'));
  assert.ok(trustWarnings({ ...base, produce_tools: ['github'] }).includes('Some attached servers have no explicit per-tool decisions.'));
});
