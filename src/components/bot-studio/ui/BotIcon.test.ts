import assert from 'node:assert/strict';
import test from 'node:test';

import { AlarmClock } from 'lucide-react';

import { resolveBotIcon } from './BotIconResolver';

test('BotIcon resolves emoji as text', () => {
  const result = resolveBotIcon('📧');
  assert.equal(result.kind, 'text');
  if (result.kind === 'text') assert.equal(result.value, '📧');
});

test('BotIcon maps legacy SF Symbol names', () => {
  assert.equal(resolveBotIcon('ticket').kind, 'icon');
  assert.equal(resolveBotIcon('DOC.TEXT').kind, 'icon');
});

test('BotIcon resolves PascalCase lucide exports as a fallback', () => {
  const result = resolveBotIcon('alarm-clock');
  assert.equal(result.kind, 'icon');
  if (result.kind === 'icon') assert.equal(result.value, AlarmClock);
});

test('BotIcon uses Bot for empty and unknown values', () => {
  const empty = resolveBotIcon('');
  const unknown = resolveBotIcon('not-a-real-icon');
  assert.equal(empty.kind, 'icon');
  assert.equal(unknown.kind, 'icon');
  if (empty.kind === 'icon' && unknown.kind === 'icon') assert.equal(empty.value, unknown.value);
});
