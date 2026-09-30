import test from 'node:test';
import assert from 'node:assert/strict';

import type { McItem, McWorkProfile } from '../../../mission-control/api/missionControlApi';

import { BOARD_DONE_LIMIT, BOARD_FILTER_ALL, BOARD_FILTER_WORK, boardColumnFor, boardDropFor, buildBoard, defaultBoardBotFilter } from './boardSelectors';

const approve = { id: 'approve', label: 'Approve', kind: 'approve', style: 'primary' as const };
const item = (id: string, overrides: Partial<McItem> = {}): McItem => ({
  item_id: id, section_id: 'work', status: 'pending', title: id, summary: '', body: {}, source: {},
  actions: [approve], confidence: 0.8, provider: 'claude', model: 'sonnet', dedupe_key: id, result: null, error: null,
  created_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', resolved_at: null, work_ready_at: null, ...overrides,
});
const profile: McWorkProfile = { auto_start: false, provider: 'claude', model: 'sonnet', effort: null, mcp_servers: [], context: '', default_project_id: null, routes: [{ client: 'Acme', aliases: [], project_id: 'acme', context: '' }] };
const bots = [{ section_id: 'work', title: 'Work bot', work_profile: profile }, { section_id: 'plain', title: 'Plain bot', work_profile: null }];

test('assigns each status to its column', () => {
  assert.equal(boardColumnFor(item('a')), 'approval');
  assert.equal(boardColumnFor(item('a', { actions: [{ ...approve, kind: 'work' }] })), null);
  assert.equal(boardColumnFor(item('a', { status: 'awaiting_work' })), 'ready');
  assert.equal(boardColumnFor(item('a', { status: 'resolving' })), 'in_progress');
  assert.equal(boardColumnFor(item('a', { status: 'working' })), 'in_progress');
  assert.equal(boardColumnFor(item('a', { status: 'in_qa' })), 'in_qa');
  assert.equal(boardColumnFor(item('a', { status: 'resolved' })), 'done');
  assert.equal(boardColumnFor(item('a', { status: 'failed' })), 'blocked');
  assert.equal(boardColumnFor(item('a', { status: 'dismissed' })), null);
  assert.equal(boardColumnFor(item('a', { status: 'expired' })), null);
});

test('caps Done at the most recent items and counts the rest', () => {
  const done = Array.from({ length: BOARD_DONE_LIMIT + 3 }, (_, index) => item(`d${index}`, { status: 'resolved', updated_at: new Date(Date.UTC(2026, 8, 1, index)).toISOString() }));
  const board = buildBoard(done, bots, BOARD_FILTER_ALL);
  assert.equal(board.columns.done.length, BOARD_DONE_LIMIT);
  assert.equal(board.olderDone, 3);
  assert.equal(board.columns.done[0].item_id, `d${BOARD_DONE_LIMIT + 2}`);
});

test('defaults the bot filter to work bots and filters by it', () => {
  assert.equal(defaultBoardBotFilter(bots), BOARD_FILTER_WORK);
  assert.equal(defaultBoardBotFilter([bots[1]]), BOARD_FILTER_ALL);
  const items = [item('w'), item('p', { section_id: 'plain' })];
  assert.deepEqual(buildBoard(items, bots, BOARD_FILTER_WORK).columns.approval.map((entry) => entry.item_id), ['w']);
  assert.deepEqual(buildBoard(items, bots, 'plain').columns.approval.map((entry) => entry.item_id), ['p']);
  assert.equal(buildBoard(items, bots, BOARD_FILTER_ALL, 'plain bot').columns.approval.length, 1);
});

test('allows only the supported drops', () => {
  assert.equal(boardDropFor('approval', 'ready', item('a')), 'approve');
  assert.equal(boardDropFor('approval', 'in_progress', item('a')), 'approve');
  assert.equal(boardDropFor('approval', 'ready', item('a', { actions: [{ ...approve, kind: 'send_reply' }] })), null);
  assert.equal(boardDropFor('ready', 'in_progress', item('a', { body: { client: 'acme' } }), bots[0]), 'start_work');
  assert.equal(boardDropFor('ready', 'in_progress', item('a', { body: { client: 'other' } }), bots[0]), null);
  assert.equal(boardDropFor('in_qa', 'done', item('a')), 'accept');
  assert.equal(boardDropFor('in_qa', 'in_progress', item('a')), 'send_back');
  assert.equal(boardDropFor('done', 'in_qa', item('a')), null);
  assert.equal(boardDropFor('blocked', 'in_progress', item('a')), null);
});
