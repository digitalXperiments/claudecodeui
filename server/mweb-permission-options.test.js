import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { parse } from 'acorn';

const htmlPath = path.resolve('public/mweb/index.html');

async function inlineScriptFunctions() {
  const html = await readFile(htmlPath, 'utf8');
  const match = html.match(/<script>\s*([\s\S]*?)<\/script>/i);
  assert.ok(match, 'mweb must contain its inline application script');
  const source = match[1];
  const tree = parse(source, { ecmaVersion: 5 });
  const functions = new Map();
  for (const node of tree.body) {
    if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
      const callee = node.expression.callee;
      if (callee.type !== 'FunctionExpression') continue;
      for (const statement of callee.body.body) {
        if (statement.type === 'FunctionDeclaration' && statement.id) {
          functions.set(statement.id.name, source.slice(statement.start, statement.end));
        }
      }
    }
  }
  return functions;
}

test('mweb does not repeat a session-owned permission mode on every message', async () => {
  const functions = await inlineScriptFunctions();
  const helper = functions.get('buildSessionSendOptions');
  const sendChat = functions.get('sendChat');
  assert.ok(helper, 'buildSessionSendOptions must exist');
  assert.match(sendChat, /frame\.options\s*=\s*buildSessionSendOptions\(state\.currentSessionId\)/);

  const context = {
    state: {
      currentSessionProvider: 'codex',
      capabilities: {
        codex: {
          permissionModes: ['default', 'auto', 'bypassPermissions'],
          defaultPermissionMode: 'default',
        },
      },
      sessionOptions: { resumed: { model: 'gpt-test' } },
    },
    $: () => ({ value: 'codex' }),
  };
  vm.runInNewContext(`${helper}; result = buildSessionSendOptions('resumed');`, context);

  assert.equal(context.result.permissionMode, undefined);
  assert.equal(context.result.model, 'gpt-test');
});

test('mweb session creation persists the selected permission mode on the server', async () => {
  const functions = await inlineScriptFunctions();
  const newSession = functions.get('newSession');
  assert.ok(newSession);
  assert.match(newSession, /permissionMode:\s*permissionMode/);
  assert.doesNotMatch(newSession, /options\.permissionMode/);
});

test('mweb persists a mid-session permission change without attaching it to chat.send', async () => {
  const functions = await inlineScriptFunctions();
  const persist = functions.get('persistSessionPermissionMode');
  const hydrate = functions.get('hydrateSessionPermissionMode');
  const sendChat = functions.get('sendChat');
  assert.ok(persist);
  assert.ok(hydrate);
  assert.match(persist, /chat\.session-preferences/);
  assert.match(persist, /runtime-preferences/);
  assert.match(hydrate, /\/meta/);
  assert.doesNotMatch(sendChat, /permissionMode/);
});
