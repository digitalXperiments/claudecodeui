import assert from 'node:assert/strict';
import test from 'node:test';

import { ListChecks } from 'lucide-react';

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

test('BotIcon normalises kebab and camel lucide names', () => {
  const kebab = resolveBotIcon('list-checks');
  const camel = resolveBotIcon('ListChecks');
  assert.equal(kebab.kind, 'icon');
  if (kebab.kind === 'icon') assert.equal(kebab.value, ListChecks);
  if (camel.kind === 'icon') assert.equal(camel.value, ListChecks);
});

test('BotIcon uses Bot for empty and unknown values', () => {
  const empty = resolveBotIcon('');
  const unknown = resolveBotIcon('not-a-real-icon');
  assert.equal(empty.kind, 'icon');
  assert.equal(unknown.kind, 'icon');
  if (empty.kind === 'icon' && unknown.kind === 'icon') assert.equal(empty.value, unknown.value);
});
