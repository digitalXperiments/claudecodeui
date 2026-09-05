import assert from 'node:assert/strict';
import test from 'node:test';

import { viewportPointFromClient } from './BrowserUsePanel';

test('browser takeover maps letterboxed screenshot coordinates to viewport coordinates', () => {
  const viewport = { width: 800, height: 600 };
  const rect = { left: 100, top: 50, width: 1_000, height: 800 } as DOMRect;

  // scale = min(1000/800, 800/600) = 1.25, so the 800x600 viewport renders as
  // 1000x750 with a 25px letterbox band above and below.
  assert.deepEqual(viewportPointFromClient(600, 425, rect, viewport), { x: 400, y: 280 });
  assert.deepEqual(viewportPointFromClient(600, 450, rect, viewport), { x: 400, y: 300 });
  assert.equal(viewportPointFromClient(600, 55, rect, viewport), null);
  assert.equal(viewportPointFromClient(600, 845, rect, viewport), null);
});
