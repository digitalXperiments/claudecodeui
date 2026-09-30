import test from 'node:test';
import assert from 'node:assert/strict';

import { DETAIL_TABS, detailTabsFor, isRuntimeTabId, resolveDetailTab } from './detailTabs';

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

const RUNTIME_IDS = ['activity', 'thread', 'goals', 'triggers', 'rules', 'learning'];

test('flag off: tab list is exactly the classic five and runtime ids fall back', () => {
  assert.deepEqual(detailTabsFor(false).map((entry) => entry.value), ['overview', 'pipeline', 'test', 'history', 'settings']);
  assert.equal(detailTabsFor(false), DETAIL_TABS);
  assert.deepEqual(resolveDetailTab('triggers'), { tab: 'pipeline', focus: 'propose', legacy: true });
  assert.deepEqual(resolveDetailTab('triggers', { runtimeV2: false }), { tab: 'pipeline', focus: 'propose', legacy: true });
  for (const id of RUNTIME_IDS.filter((entry) => entry !== 'triggers')) {
    assert.deepEqual(resolveDetailTab(id), { tab: 'overview', focus: null, legacy: false });
  }
  assert.deepEqual(resolveDetailTab('brief'), { tab: 'pipeline', focus: null, legacy: true });
});

test('flag on: runtime tabs follow Overview and triggers is a real tab', () => {
  assert.deepEqual(
    detailTabsFor(true).map((entry) => entry.value),
    ['overview', 'activity', 'thread', 'goals', 'triggers', 'rules', 'learning', 'pipeline', 'test', 'history', 'settings'],
  );
  for (const id of RUNTIME_IDS) assert.deepEqual(resolveDetailTab(id, { runtimeV2: true }), { tab: id, focus: null, legacy: false });
  assert.deepEqual(resolveDetailTab(' Triggers ', { runtimeV2: true }), { tab: 'triggers', focus: null, legacy: false });
  // Other legacy ids and classic tabs are unaffected by the flag.
  assert.deepEqual(resolveDetailTab('brief', { runtimeV2: true }), { tab: 'pipeline', focus: null, legacy: true });
  assert.deepEqual(resolveDetailTab('tools', { runtimeV2: true }), { tab: 'pipeline', focus: 'propose', legacy: true });
  assert.deepEqual(resolveDetailTab('history', { runtimeV2: true }), { tab: 'history', focus: null, legacy: false });
});

test('isRuntimeTabId flags ids whose resolution depends on the feature flag', () => {
  for (const id of RUNTIME_IDS) assert.equal(isRuntimeTabId(id), true);
  assert.equal(isRuntimeTabId('pipeline'), false);
  assert.equal(isRuntimeTabId(undefined), false);
});
