// Regression: tests once leaked bot homes into the operator's real ~/.cloudcli/bots.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { resolveBotsRoot } from '@/modules/bots/bots-home.js';
test('test runs never resolve to the real bots folder', () => {
  delete process.env.CLOUDCLI_BOTS_HOME;
  assert.ok(!resolveBotsRoot().startsWith(os.homedir() + '/.cloudcli'), resolveBotsRoot());
});
