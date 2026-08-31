import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOmpSpawnArgs } from './omp-cli.js';

test('OMP RPC spawn vectors use valid tools for new plan and full sessions', () => {
  assert.deepEqual(buildOmpSpawnArgs({ permissionMode: 'plan' }), [
    '--mode', 'rpc',
    '--tools', 'read,grep,glob',
    '--auto-approve',
  ]);
  assert.deepEqual(buildOmpSpawnArgs({ permissionMode: 'bypassPermissions' }), [
    '--mode', 'rpc',
    '--tools', 'read,bash,edit,write,grep,glob',
    '--auto-approve',
  ]);
});

test('OMP RPC resume vector uses documented --resume with model and thinking', () => {
  assert.deepEqual(buildOmpSpawnArgs({
    resumeSessionId: 'session-1',
    model: 'openai-codex/gpt-5.4',
    thinkingLevel: 'high',
    permissionMode: 'plan',
  }), [
    '--mode', 'rpc',
    '--resume', 'session-1',
    '--model', 'openai-codex/gpt-5.4',
    '--thinking', 'high',
    '--tools', 'read,grep,glob',
    '--auto-approve',
  ]);
});
