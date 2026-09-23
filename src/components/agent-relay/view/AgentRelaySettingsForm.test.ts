import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { activeRelayJobCount, disableRelayImpactMessage } from './AgentRelaySettingsForm';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'AgentRelaySettingsForm.tsx'), 'utf8');

test('disable impact includes both running and queued relay jobs', () => {
  assert.equal(activeRelayJobCount({ activeCount: 2, queuedCount: 3, enabled: true, mcpServerName: '', skillName: '', providers: [] }), 5);
  assert.match(disableRelayImpactMessage({ activeCount: 0, queuedCount: 1, enabled: true, mcpServerName: '', skillName: '', providers: [] }) ?? '', /cancel 1 active or queued worker job/);
  assert.match(disableRelayImpactMessage({ activeCount: 2, queuedCount: 3, enabled: true, mcpServerName: '', skillName: '', providers: [] }) ?? '', /cancel 5 active or queued worker jobs/);
});

test('disable impact is omitted when no relay jobs are active or queued', () => {
  assert.equal(activeRelayJobCount(null), 0);
  assert.equal(disableRelayImpactMessage({ activeCount: 0, queuedCount: 0, enabled: true, mcpServerName: '', skillName: '', providers: [] }), null);
});

test('save publishes the saved settings event before attempting integration sync', () => {
  const savedEvent = source.indexOf("window.dispatchEvent(new Event('agentRelaySettingsChanged'))");
  const syncCall = source.indexOf('const synced = await agentRelayApi.sync();', savedEvent);
  assert.ok(savedEvent > source.indexOf('setSavedSettings(persisted)'));
  assert.ok(syncCall > savedEvent);
  assert.match(source, /Settings saved, but provider bindings could not be refreshed/);
  assert.match(source, /Retry integration sync/);
});
