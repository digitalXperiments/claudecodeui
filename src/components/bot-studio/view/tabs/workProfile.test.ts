import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorkProfile, prepareWorkProfile } from './workProfile';

test('loads an empty profile and validates before saving', () => {
  const empty = loadWorkProfile({ provider: 'grok', work_profile: null });
  assert.equal(empty.provider, 'grok');
  assert.equal(prepareWorkProfile(empty).error, 'Select a work-session model.');
  assert.equal(prepareWorkProfile({ ...empty, model: 'm' }).error, 'Select a default project or add a client mapping.');
  const routed = prepareWorkProfile({ ...empty, model: 'm', routes: [{ client: 'Acme', aliases: [' A ', ''], project_id: 'p', context: '' }] });
  assert.equal(routed.error, null);
  assert.deepEqual(routed.profile.routes[0].aliases, ['A']);
});
