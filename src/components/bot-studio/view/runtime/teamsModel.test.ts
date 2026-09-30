import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotPeerTraffic, BotSpace, BotTeam } from '../../types/botRuntime';

import {
  MAX_TEAM_MEMBERS,
  addableBots,
  canAddMember,
  memberRows,
  peerRows,
  rootOptions,
  sortSpaces,
  spaceFileName,
  validateSpaceTitle,
  validateTeamDraft,
  wakeBlockedReason,
} from './teamsModel';

function team(members: Array<[string, string]>, coordinator: string | null = null): BotTeam {
  return {
    team_id: 't1', name: 'Growth', goal: '', coordinator_bot_id: coordinator,
    members: members.map(([bot_id, role]) => ({ team_id: 't1', bot_id, role })),
    created_at: '', updated_at: '',
  };
}

test('canAddMember stops at the server limit of six', () => {
  assert.equal(MAX_TEAM_MEMBERS, 6);
  assert.equal(canAddMember(team([])), true);
  assert.equal(canAddMember(team(['a', 'b', 'c', 'd', 'e'].map((id) => [id, ''] as [string, string]))), true);
  assert.equal(canAddMember(team(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, ''] as [string, string]))), false);
});

test('addableBots excludes current members and sorts by title', () => {
  const bots = [{ section_id: 'b', title: 'Beta' }, { section_id: 'a', title: 'Alpha' }, { section_id: 'c', title: 'Gamma' }];
  assert.deepEqual(addableBots(bots, team([['b', '']])).map((bot) => bot.section_id), ['a', 'c']);
  assert.deepEqual(addableBots([], team([])), []);
});

test('validateTeamDraft checks name, length and case-insensitive clashes', () => {
  assert.equal(validateTeamDraft({ name: 'Growth', goal: 'x' }), null);
  assert.match(validateTeamDraft({ name: '  ', goal: '' }) ?? '', /needs a name/);
  assert.match(validateTeamDraft({ name: 'x'.repeat(81), goal: '' }) ?? '', /80/);
  assert.match(validateTeamDraft({ name: 'ok', goal: 'g'.repeat(1001) }) ?? '', /1000/);
  assert.match(validateTeamDraft({ name: 'growth', goal: '' }, ['Growth']) ?? '', /already exists/);
  assert.equal(validateTeamDraft({ name: 'Sales', goal: '' }, ['Growth']), null);
});

test('memberRows puts the coordinator first', () => {
  const rows = memberRows(team([['a', 'writer'], ['b', 'lead'], ['c', '']], 'b'), (id) => id.toUpperCase());
  assert.deepEqual(rows.map((row) => [row.botId, row.isCoordinator, row.title]), [['b', true, 'B'], ['a', false, 'A'], ['c', false, 'C']]);
});

test('wakeBlockedReason needs a coordinator who is still a member', () => {
  assert.match(wakeBlockedReason(team([['a', '']])) ?? '', /coordinator/);
  assert.match(wakeBlockedReason(team([['a', '']], 'gone')) ?? '', /no longer/);
  assert.equal(wakeBlockedReason(team([['a', '']], 'a')), null);
});

test('space helpers', () => {
  assert.equal(validateSpaceTitle('Notes'), null);
  assert.match(validateSpaceTitle('   ') ?? '', /needs a title/);
  assert.match(validateSpaceTitle('x'.repeat(121)) ?? '', /120/);
  assert.equal(spaceFileName({ path: '/bots/a/spaces/notes.md' }), 'notes.md');
  assert.equal(spaceFileName({ path: 'C:\\x\\y.md' }), 'y.md');
  assert.equal(spaceFileName({ path: '' }), '');
  const older = { space_id: '1', updated_at: '2026-09-01T00:00:00Z' } as BotSpace;
  const newer = { space_id: '2', updated_at: '2026-10-01T00:00:00Z' } as BotSpace;
  assert.deepEqual(sortSpaces([older, newer]).map((space) => space.space_id), ['2', '1']);
  assert.deepEqual(rootOptions(['/a', '', 42, null, { path: '/b' }, '/c']), ['/a', '/c']);
});

test('peerRows sort newest first with direction labels', () => {
  const base = { event_id: '', kind: 'peer_message', type: 'note', status: 'consumed', correlation_id: null, preview: '' };
  const traffic: BotPeerTraffic[] = [
    { ...base, event_id: 'old', direction: 'in', other_bot_id: 'a', received_at: '2026-09-30T00:00:00Z' },
    { ...base, event_id: 'new', direction: 'out', other_bot_id: 'b', received_at: '2026-10-01T00:00:00Z' },
  ];
  const rows = peerRows(traffic, (id) => `bot ${id}`);
  assert.deepEqual(rows.map((row) => [row.event_id, row.directionLabel, row.otherTitle]), [['new', 'Sent to', 'bot b'], ['old', 'Received from', 'bot a']]);
});
