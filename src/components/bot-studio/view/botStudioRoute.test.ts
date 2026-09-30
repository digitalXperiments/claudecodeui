import assert from 'node:assert/strict';
import test from 'node:test';

import { botTabPath, isRuntimePage, parseRoute, viewPath } from './botStudioRoute';

test('parseRoute keeps the pre-runtime routes', () => {
  assert.deepEqual(parseRoute('/bots'), { page: 'dashboard' });
  assert.deepEqual(parseRoute('/bots/'), { page: 'dashboard' });
  assert.deepEqual(parseRoute('/bots/inbox'), { page: 'inbox' });
  assert.deepEqual(parseRoute('/bots/board'), { page: 'board' });
  assert.deepEqual(parseRoute('/bots/activity'), { page: 'activity' });
  assert.deepEqual(parseRoute('/bots/exceptions'), { page: 'exceptions' });
  assert.deepEqual(parseRoute('/bots/templates'), { page: 'templates' });
  assert.deepEqual(parseRoute('/bots/import'), { page: 'import' });
  assert.deepEqual(parseRoute('/bots/new'), { page: 'new' });
  assert.deepEqual(parseRoute('/bots/nonsense'), { page: 'dashboard' });
  assert.deepEqual(parseRoute('/elsewhere/brief'), { page: 'dashboard' });
});

test('parseRoute parses bot detail routes with default and explicit tabs', () => {
  assert.deepEqual(parseRoute('/bots/b/abc'), { page: 'bots', botId: 'abc', tab: 'overview' });
  assert.deepEqual(parseRoute('/bots/b/abc/learning'), { page: 'bots', botId: 'abc', tab: 'learning' });
  assert.deepEqual(parseRoute('/bots/b/a%20b/history'), { page: 'bots', botId: 'a b', tab: 'history' });
  assert.deepEqual(parseRoute('/bots/b/%E0%A4%A/x'), { page: 'bots', botId: '%E0%A4%A', tab: 'x' });
});

test('parseRoute recognises the runtime pages', () => {
  assert.deepEqual(parseRoute('/bots/brief'), { page: 'brief' });
  assert.deepEqual(parseRoute('/bots/channels'), { page: 'channels' });
  assert.deepEqual(parseRoute('/bots/teams'), { page: 'teams' });
  assert.equal(isRuntimePage('brief'), true);
  assert.equal(isRuntimePage('teams'), true);
  assert.equal(isRuntimePage('board'), false);
  assert.equal(isRuntimePage(undefined), false);
});

test('viewPath and botTabPath build the matching URLs', () => {
  assert.equal(viewPath('dashboard'), '/bots');
  assert.equal(viewPath('brief'), '/bots/brief');
  assert.equal(viewPath('channels'), '/bots/channels');
  assert.equal(botTabPath('x y', 'learning'), '/bots/b/x%20y/learning');
  assert.equal(botTabPath('x'), '/bots/b/x/overview');
  for (const view of ['inbox', 'board', 'activity', 'brief', 'channels', 'teams'] as const) {
    assert.equal(parseRoute(viewPath(view)).page, view);
  }
});
