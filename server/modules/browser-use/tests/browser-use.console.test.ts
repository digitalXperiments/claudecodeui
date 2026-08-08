import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserConsoleBuffer,
  normalizeConsoleLevel,
} from '@/modules/browser-use/browser-use.console.js';

test('console buffer filters by level, bounds entries, and clears after read', () => {
  const buffer = new BrowserConsoleBuffer(2);
  buffer.add({ level: 'log', text: 'old', url: null, lineNumber: null, columnNumber: null, stack: null });
  buffer.add({ level: 'error', text: 'failed', url: 'https://example.test', lineNumber: 4, columnNumber: 2, stack: 'Error: failed' });
  buffer.add({ level: 'pageerror', text: 'uncaught', url: 'https://example.test', lineNumber: null, columnNumber: null, stack: 'stack' });

  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.read({ level: 'error' }).map((message) => message.text), ['failed']);
  assert.deepEqual(buffer.read({ clear: true }).map((message) => message.level), ['error', 'pageerror']);
  assert.equal(buffer.size, 0);
});

test('console levels normalize browser warning and unknown messages', () => {
  assert.equal(normalizeConsoleLevel('warning'), 'warn');
  assert.equal(normalizeConsoleLevel('pageerror'), 'pageerror');
  assert.equal(normalizeConsoleLevel('unknown'), 'log');
});

