import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDetailTab } from './detailTabs';

test('keeps current tab ids and maps legacy deep links', () => {
  assert.deepEqual(resolveDetailTab('pipeline'), { tab: 'pipeline', focus: null, legacy: false });
  assert.deepEqual(resolveDetailTab('tools'), { tab: 'pipeline', focus: 'propose', legacy: true });
  assert.deepEqual(resolveDetailTab('outputs'), { tab: 'pipeline', focus: 'resolve', legacy: true });
  assert.deepEqual(resolveDetailTab('iterate'), { tab: 'pipeline', focus: 'architect', legacy: true });
  assert.equal(resolveDetailTab('inbox').tab, 'overview');
  assert.equal(resolveDetailTab('simulator').tab, 'test');
  assert.deepEqual(resolveDetailTab('versions'), { tab: 'history', focus: 'versions', legacy: true });
  assert.equal(resolveDetailTab('ticks').tab, 'history');
  for (const legacy of ['trust', 'memory', 'danger']) assert.equal(resolveDetailTab(legacy).tab, 'settings');
  assert.deepEqual(resolveDetailTab('nonsense'), { tab: 'overview', focus: null, legacy: false });
  assert.deepEqual(resolveDetailTab(undefined), { tab: 'overview', focus: null, legacy: false });
});
