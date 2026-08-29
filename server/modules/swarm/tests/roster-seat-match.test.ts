import assert from 'node:assert/strict';
import test from 'node:test';

import { matchRosterSeat } from '@/modules/swarm/swarm.service.js';
import type { SwarmAgentSpec } from '@/modules/swarm/swarm.types.js';

const roster: SwarmAgentSpec[] = [
  { id: 'orchestrator', kind: 'orchestrator', label: 'Orchestrator' },
  { id: 'explorer-1', kind: 'explorer', label: 'explorer-1 (Claude Sonnet 4.6)' },
  { id: 'implementer-1', kind: 'implementer', label: 'Builder' },
];

test('matchRosterSeat binds kind name Explorer to the explorer seat', () => {
  const seat = matchRosterSeat('Explorer', roster);
  assert.ok(seat);
  assert.equal(seat!.id, 'explorer-1');
});

test('matchRosterSeat binds generated seat ids', () => {
  const seat = matchRosterSeat('explorer-1', roster);
  assert.equal(seat?.id, 'explorer-1');
});

test('matchRosterSeat binds label prefixes before the model suffix', () => {
  const seat = matchRosterSeat('explorer-1', roster);
  assert.equal(seat?.label, 'explorer-1 (Claude Sonnet 4.6)');
});

test('matchRosterSeat binds exact labels', () => {
  const seat = matchRosterSeat('Builder', roster);
  assert.equal(seat?.kind, 'implementer');
});

test('matchRosterSeat rejects unknown names', () => {
  assert.equal(matchRosterSeat('Reviewer', roster), null);
});
