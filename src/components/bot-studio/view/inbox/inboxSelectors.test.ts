import test from 'node:test';
import assert from 'node:assert/strict';

import type { McItem } from '../../../mission-control/api/missionControlApi';

import { filterInboxItems, getInboxCounts, inboxKeyboardReducer, sortInboxItems } from './inboxSelectors';

const item = (id: string, overrides: Partial<McItem> = {}): McItem => ({
  item_id: id,
  section_id: 'one',
  status: 'pending',
  title: id,
  summary: '',
  body: {},
  source: {},
  actions: [{ id: 'approve', label: 'Approve', kind: 'approve', style: 'primary' }],
  confidence: 0.8,
  provider: 'claude',
  model: 'sonnet',
  dedupe_key: id,
  result: null,
  error: null,
  created_at: '2026-09-16T10:00:00Z',
  updated_at: '2026-09-16T10:00:00Z',
  resolved_at: null,
  work_ready_at: null,
  ...overrides,
});

const bots = [{
  section_id: 'one', title: 'Gmail bot', purpose: 'Find mail',
}, {
  section_id: 'two', title: 'GitHub bot', purpose: 'Find issues',
}] as never[];

test('filters by status, bot, and bot-aware search and counts grouped statuses', () => {
  const items = [
    item('mail', { summary: 'Customer reply' }),
    item('issue', { section_id: 'two', status: 'resolved', actions: [] }),
    item('dismissed', { status: 'dismissed', actions: [] }),
    item('failed', { status: 'failed' }),
    item('ready', { status: 'awaiting_work', actions: [] }),
    item('working', { status: 'working', actions: [] }),
    item('resolving', { status: 'resolving' }),
    item('qa', { status: 'in_qa', actions: [] }),
  ];
  assert.deepEqual(filterInboxItems(items, bots, 'pending', 'all', 'github'), []);
  assert.deepEqual(filterInboxItems(items, bots, 'needs_attention', 'all', '').map((entry) => entry.item_id), ['mail', 'failed', 'ready', 'qa']);
  assert.deepEqual(filterInboxItems(items, bots, 'in_progress', 'all', '').map((entry) => entry.item_id), ['working', 'resolving']);
  assert.deepEqual(filterInboxItems(items, bots, 'in_qa', 'all', '').map((entry) => entry.item_id), ['qa']);
  assert.deepEqual(filterInboxItems(items, bots, 'resolved', 'two', 'issue').map((entry) => entry.item_id), ['issue']);
  assert.deepEqual(getInboxCounts(items), { needs_attention: 4, pending: 1, in_progress: 2, in_qa: 1, resolved: 2, failed: 1, all: 8 });
});

test('sorts needs-decision items first and then newest first', () => {
  const items = [
    item('old', { created_at: '2026-09-15T10:00:00Z' }),
    item('new', { created_at: '2026-09-16T11:00:00Z' }),
    item('resolved', { status: 'resolved', actions: [], created_at: '2026-09-16T12:00:00Z' }),
    item('qa', { status: 'in_qa', actions: [], created_at: '2026-09-14T12:00:00Z' }),
    item('working', { status: 'working', actions: [], created_at: '2026-09-16T13:00:00Z' }),
  ];
  assert.deepEqual(sortInboxItems(items).map((entry) => entry.item_id), ['new', 'old', 'qa', 'working', 'resolved']);
});

test('keyboard reducer moves selection, toggles multi-select, and clears it', () => {
  const initial = { selectedItemId: 'one', checkedIds: ['one'] };
  const moved = inboxKeyboardReducer(initial, { type: 'move', itemIds: ['one', 'two', 'three'], direction: 1 });
  assert.equal(moved.selectedItemId, 'two');
  const toggled = inboxKeyboardReducer(moved, { type: 'toggle', itemId: 'two' });
  assert.deepEqual(toggled.checkedIds, ['one', 'two']);
  assert.deepEqual(inboxKeyboardReducer(toggled, { type: 'clear' }).checkedIds, []);
});
