import assert from 'node:assert/strict';
import test from 'node:test';

import { activeRelayJobCount, disableRelayImpactMessage, shouldConfirmDisableAtSave } from './AgentRelaySettingsForm';

test('disable impact includes both running and queued relay jobs', () => {
  assert.equal(activeRelayJobCount({ activeCount: 2, queuedCount: 3, enabled: true, mcpServerName: '', skillName: '', providers: [] }), 5);
  assert.match(disableRelayImpactMessage({ activeCount: 0, queuedCount: 1, enabled: true, mcpServerName: '', skillName: '', providers: [] }) ?? '', /cancel 1 active or queued worker job/);
  assert.match(disableRelayImpactMessage({ activeCount: 2, queuedCount: 3, enabled: true, mcpServerName: '', skillName: '', providers: [] }) ?? '', /cancel 5 active or queued worker jobs/);
});

test('disable impact is omitted when no relay jobs are active or queued', () => {
  assert.equal(activeRelayJobCount(null), 0);
  assert.equal(disableRelayImpactMessage({ activeCount: 0, queuedCount: 0, enabled: true, mcpServerName: '', skillName: '', providers: [] }), null);
});

test('disable confirmation is deferred until save and requires a fresh active count', () => {
  const status = { activeCount: 2, queuedCount: 1, enabled: true, mcpServerName: '', skillName: '', providers: [] };
  assert.equal(shouldConfirmDisableAtSave(true, false, status), true);
  assert.equal(shouldConfirmDisableAtSave(true, false, { ...status, activeCount: 0, queuedCount: 0 }), false);
  assert.equal(shouldConfirmDisableAtSave(false, false, status), false);
  assert.equal(shouldConfirmDisableAtSave(true, true, status), false);
});
