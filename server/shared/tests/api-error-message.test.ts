import assert from 'node:assert/strict';
import test from 'node:test';

import { apiErrorMessage } from '@/shared/api-error-message.js';

test('apiErrorMessage reads structured and legacy API envelopes', () => {
  assert.equal(apiErrorMessage({ error: { message: 'Task 2 is invalid.', code: 'BAD_TASK' } }, 'fallback'), 'Task 2 is invalid.');
  assert.equal(apiErrorMessage({ error: 'Legacy failure.' }, 'fallback'), 'Legacy failure.');
  assert.equal(apiErrorMessage({ message: 'Top-level failure.' }, 'fallback'), 'Top-level failure.');
  assert.equal(apiErrorMessage({ error: { code: 'NO_MESSAGE' } }, 'fallback'), 'fallback');
});
