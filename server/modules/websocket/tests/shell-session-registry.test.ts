import assert from 'node:assert/strict';
import test from 'node:test';

import { shellSessionRegistry } from '@/modules/websocket/services/shell-session-registry.service.js';

test.afterEach(() => {
  shellSessionRegistry.clear();
});

test('lists provider-backed shell sessions and ignores duplicate chat ownership', () => {
  shellSessionRegistry.register('pty-1', {
    sessionId: 'app-1',
    provider: 'claude',
    startedAt: 123,
  });

  assert.equal(shellSessionRegistry.isActive('app-1'), true);
  assert.deepEqual(shellSessionRegistry.listRunning(), [{
    sessionId: 'app-1',
    provider: 'claude',
    startedAt: 123,
  }]);
  assert.equal(shellSessionRegistry.isActive('missing'), false);
});

test('subscribe fires only when the busy set actually changes', () => {
  let fires = 0;
  const unsubscribe = shellSessionRegistry.subscribe(() => {
    fires += 1;
  });

  shellSessionRegistry.register('pty-1', {
    sessionId: 'app-1',
    provider: 'grok',
    startedAt: 1,
  });
  shellSessionRegistry.register('pty-1', {
    sessionId: 'app-1',
    provider: 'grok',
    startedAt: 1,
  });
  shellSessionRegistry.unregister('pty-1');
  shellSessionRegistry.unregister('pty-1');
  unsubscribe();

  assert.equal(fires, 2);
});

test('listRunning collapses multiple PTY keys for the same app session', () => {
  shellSessionRegistry.register('pty-a', {
    sessionId: 'app-1',
    provider: 'grok',
    startedAt: 200,
  });
  shellSessionRegistry.register('pty-b', {
    sessionId: 'app-1',
    provider: 'grok',
    startedAt: 100,
  });

  assert.deepEqual(shellSessionRegistry.listRunning(), [{
    sessionId: 'app-1',
    provider: 'grok',
    startedAt: 100,
  }]);
});

test('unregister removes a shell session without affecting another PTY', () => {
  shellSessionRegistry.register('pty-1', {
    sessionId: 'app-1',
    provider: 'codex',
    startedAt: 123,
  });
  shellSessionRegistry.register('pty-2', {
    sessionId: 'app-2',
    provider: 'grok',
    startedAt: 456,
  });

  shellSessionRegistry.unregister('pty-1');

  assert.equal(shellSessionRegistry.isActive('app-1'), false);
  assert.equal(shellSessionRegistry.isActive('app-2'), true);
  assert.deepEqual(shellSessionRegistry.listRunning().map((session) => session.sessionId), ['app-2']);
});
