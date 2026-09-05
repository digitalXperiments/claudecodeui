import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidPreviewPort } from '@/modules/studio/studio-universes.routes.js';

test('Studio Universes preview port validation: accepts undefined and in-range ports, rejects everything else', () => {
  assert.equal(isValidPreviewPort(undefined), true);
  assert.equal(isValidPreviewPort(1), true);
  assert.equal(isValidPreviewPort(3000), true);
  assert.equal(isValidPreviewPort(65535), true);

  assert.equal(isValidPreviewPort(0), false);
  assert.equal(isValidPreviewPort(-1), false);
  assert.equal(isValidPreviewPort(65536), false);
  assert.equal(isValidPreviewPort(1.5), false);
  assert.equal(isValidPreviewPort(Number.NaN), false);
});
