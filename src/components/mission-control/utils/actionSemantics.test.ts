import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { McAction } from '../api/missionControlApi';

import { getActionSemantics } from './actionSemantics';

const action = (overrides: Partial<McAction>): McAction => ({
  id: 'approve',
  label: 'Approve',
  kind: 'approve',
  style: 'primary',
  ...overrides,
});

describe('getActionSemantics', () => {
  it('keeps Draft reply non-terminal and confirmation-free', () => {
    const result = getActionSemantics(action({ id: 'draft_reply', label: 'Draft reply' }), 'Item');

    assert.equal(result.scope, 'draft');
    assert.equal(result.confirmation, null);
    assert.match(result.detail, /nothing is sent/i);
  });

  it('confirms sending, archiving, and marking read as remote mutations', () => {
    for (const label of ['Send reply', 'Archive at source', 'Mark as read']) {
      const result = getActionSemantics(action({ label }), 'Customer message');
      assert.equal(result.scope, 'remote');
      assert.match(result.confirmation ?? '', /connected source|changes the connected source/i);
    }
  });

  it('identifies dismiss and delete as local actions', () => {
    assert.equal(getActionSemantics(action({ kind: 'dismiss', label: 'Dismiss' }), 'Item').scope, 'local');
    const deletion = getActionSemantics(action({ kind: 'delete', label: 'Delete' }), 'Item');
    assert.equal(deletion.scope, 'local');
    assert.match(deletion.confirmation ?? '', /local Action Centre item/i);
  });
});
