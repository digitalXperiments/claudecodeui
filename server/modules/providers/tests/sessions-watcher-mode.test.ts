import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  createWatcherIgnoreMatcher,
  shouldUsePollingForRoot,
} from '@/modules/providers/services/sessions-watcher.service.js';

test('watcher uses native events on macOS/Windows and keeps polling elsewhere by default', () => {
  assert.equal(shouldUsePollingForRoot('claude', 'darwin', {}), false);
  assert.equal(shouldUsePollingForRoot('claude', 'win32', {}), false);
  assert.equal(shouldUsePollingForRoot('claude', 'linux', {}), true);
});

test('watcher polling can be forced globally or per provider root', () => {
  assert.equal(shouldUsePollingForRoot('claude', 'darwin', { CLOUDCLI_WATCHER_POLLING: '1' }), true);
  assert.equal(shouldUsePollingForRoot('claude', 'linux', { CLOUDCLI_WATCHER_POLLING: '0' }), false);

  const env = { CLOUDCLI_WATCHER_POLL_PROVIDERS: 'antigravity, cline' };
  assert.equal(shouldUsePollingForRoot('antigravity', 'darwin', env), true);
  assert.equal(shouldUsePollingForRoot('cline', 'darwin', env), true);
  assert.equal(shouldUsePollingForRoot('claude', 'darwin', env), false);
});

test('watcher ignore matcher skips dependency/VCS trees and scratch files relative to the root', () => {
  const root = path.join('/Users', 'me', 'build', '.claude', 'projects');
  const ignored = createWatcherIgnoreMatcher(root);

  // A root that itself lives under `build/` must still be watched.
  assert.equal(ignored(root), false);
  assert.equal(ignored(path.join(root, '-Users-me-app', 'abc.jsonl')), false);

  assert.equal(ignored(path.join(root, 'x', 'node_modules', 'pkg', 'a.jsonl')), true);
  assert.equal(ignored(path.join(root, 'x', '.git', 'HEAD')), true);
  assert.equal(ignored(path.join(root, 'dist')), true);
  assert.equal(ignored(path.join(root, 'x', 'abc.jsonl.tmp')), true);
  assert.equal(ignored(path.join(root, 'x', '.abc.swp')), true);
  assert.equal(ignored(path.join(root, '.DS_Store')), true);
  // Paths outside the root are never claimed by this matcher.
  assert.equal(ignored(path.join('/elsewhere', 'node_modules')), false);
});
