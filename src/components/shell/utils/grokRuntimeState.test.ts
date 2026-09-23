import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGrokRuntimeState, parseGrokSlashCommand } from './grokRuntimeState';

test('prefers Grok 4.7 Fast over Grok 4.7 when both appear', () => {
  assert.deepEqual(
    parseGrokRuntimeState('Grok 4.7 high\nGrok 4.7 Fast medium'),
    { model: 'grok-4.7-build-fast', effort: 'medium' },
  );
});

test('reads a model id from the TUI status line', () => {
  assert.equal(
    parseGrokRuntimeState('session  grok-4.7-build-fast  xhigh').model,
    'grok-4.7-build-fast',
  );
});

test('status line Grok 4.7 (low) beats an older model id in the scrollback', () => {
  assert.deepEqual(
    parseGrokRuntimeState('spawn --model grok-4.5\nWeekly limit left: 5% · Grok 4.7 (low) · always-approve'),
    { model: 'grok-4.7', effort: 'low' },
  );
});

test('reads parenthetical effort next to Grok 4.7 Fast', () => {
  assert.deepEqual(
    parseGrokRuntimeState('Grok 4.7 Fast (extra high)'),
    { model: 'grok-4.7-build-fast', effort: 'xhigh' },
  );
});

test('maps Extra High to xhigh', () => {
  assert.equal(parseGrokRuntimeState('Reasoning effort: Extra High').effort, 'xhigh');
});

test('parses /model and /effort slash commands', () => {
  assert.deepEqual(
    parseGrokSlashCommand('/model grok-4.7-build-fast'),
    { model: 'grok-4.7-build-fast' },
  );
  assert.deepEqual(
    parseGrokSlashCommand('/model Grok 4.7 Fast xhigh'),
    { model: 'grok-4.7-build-fast', effort: 'xhigh' },
  );
  assert.deepEqual(parseGrokSlashCommand('/effort high'), { effort: 'high' });
});
