import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getItemContentPreview } from './itemContent';

describe('getItemContentPreview', () => {
  it('prefers the implementation brief stored in the item body', () => {
    const result = getItemContentPreview({
      body: {
        summary: 'Short summary',
        whatNeedsToBeDone: 'Add the missing purchase metrics.',
        actionItems: ['Confirm the target tables', 'Backfill historical data'],
      },
    });

    assert.deepEqual(result, {
      label: 'What needs to be done',
      text: 'Add the missing purchase metrics.',
      actionItems: ['Confirm the target tables', 'Backfill historical data'],
    });
  });

  it('falls back to action items when there is no body prose', () => {
    assert.deepEqual(getItemContentPreview({ body: { actionItems: ['Review the draft'] } }), {
      label: 'Action items',
      actionItems: ['Review the draft'],
    });
    assert.equal(getItemContentPreview({ body: {} }), null);
  });
});
