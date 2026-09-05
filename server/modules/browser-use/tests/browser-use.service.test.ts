import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUseService, browserUseTestHooks } from '@/modules/browser-use/browser-use.service.js';

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

function installFakeSession(controller: 'agent' | 'human' = 'human') {
  const calls: string[] = [];
  let screenshotCount = 0;
  const page = {
    screenshot: async () => { screenshotCount += 1; return Buffer.from('frame'); },
    title: async () => 'Fake page',
    url: () => 'https://example.test/',
    viewportSize: () => ({ width: 800, height: 600 }),
    goto: async (url: string) => { calls.push(`goto:${url}`); },
    mouse: {
      click: async (x: number, y: number) => { calls.push(`click:${x},${y}`); },
      wheel: async (x: number, y: number) => { calls.push(`wheel:${x},${y}`); },
    },
    keyboard: {
      insertText: async (text: string) => {
        await new Promise((resolve) => setTimeout(resolve, text === 'first' ? 15 : 0));
        calls.push(`text:${text}`);
      },
      press: async (key: string) => { calls.push(`key:${key}`); },
    },
    evaluate: async () => ({ ok: true }),
  };
  browserUseTestHooks.installSession({
    id: 'test-browser-session', ownerId: 'agent', createdBy: 'agent', runtime: 'local',
    status: 'ready', url: null, title: null, screenshotDataUrl: 'data:image/jpeg;base64,old',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastAction: null,
    message: null, profileName: null, viewport: { width: 800, height: 600 }, cursor: null,
    workspacePath: '/tmp/cloudcli-browser-test', networkRecording: true, controller,
  }, { page });
  return { calls, page, get screenshotCount() { return screenshotCount; } };
}

test('human takeover rejects agent mutations and suppresses typed secret screenshots', async () => {
  const fake = installFakeSession('human');
  try {
    await assert.rejects(
      browserUseService.agentEvaluate('test-browser-session', { expression: '1 + 1' }),
      /human control/,
    );
    const result = await browserUseService.humanInput('test-browser-session', {
      action: 'type', text: 'password', secret: true,
    });
    assert.equal(result.screenshotSuppressed, true);
    assert.equal(result.session.screenshotDataUrl, null);
    assert.equal(fake.screenshotCount, 0);
  } finally {
    browserUseTestHooks.clear();
  }
});

test('human input is serialized per session and validates coordinates/navigation', async () => {
  const fake = installFakeSession('human');
  try {
    const first = browserUseService.humanInput('test-browser-session', { action: 'type', text: 'first' });
    const second = browserUseService.humanInput('test-browser-session', { action: 'type', text: 'second' });
    await Promise.all([first, second]);
    assert.deepEqual(fake.calls.slice(0, 2), ['text:first', 'text:second']);
    await assert.rejects(
      browserUseService.humanInput('test-browser-session', { action: 'click', x: 801, y: 0 }),
      /outside the browser viewport/,
    );
    await assert.rejects(
      browserUseService.humanInput('test-browser-session', { action: 'navigate', url: 'file:///secret' }),
      /Only http and https/,
    );
  } finally {
    browserUseTestHooks.clear();
  }
});
