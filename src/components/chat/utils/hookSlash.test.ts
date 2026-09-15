import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandHookInstruction,
  mapEnabledHooksToSlashCommands,
  type HookCatalogItem,
} from './hookSlash';

const hook = (overrides: Partial<HookCatalogItem> = {}): HookCatalogItem => ({
  id: 'hook_1',
  name: 'House style',
  slug: 'house-style',
  enabled: true,
  instruction: 'Always reply in British English.',
  provider: 'all',
  ...overrides,
});

test('expandHookInstruction replaces $ARGUMENTS', () => {
  const expanded = expandHookInstruction('Review $ARGUMENTS carefully.', 'src/app.ts');
  assert.equal(expanded, 'Review src/app.ts carefully.');
});

test('expandHookInstruction appends remainder when there is no placeholder', () => {
  const expanded = expandHookInstruction('Always be concise.', 'fix the tests');
  assert.equal(expanded, 'Always be concise.\n\nfix the tests');
});

test('expandHookInstruction leaves body unchanged when remainder is empty', () => {
  assert.equal(expandHookInstruction('Always be concise.', '  '), 'Always be concise.');
});

test('mapEnabledHooksToSlashCommands filters by enabled + provider', () => {
  const commands = mapEnabledHooksToSlashCommands(
    [
      hook(),
      hook({ id: 'off', slug: 'off', enabled: false, name: 'Off' }),
      hook({ id: 'g', slug: 'grok-only', provider: 'grok', name: 'Grok only' }),
      hook({ id: 'c', slug: 'claude-only', provider: 'claude', name: 'Claude only' }),
    ],
    'claude',
  );
  assert.deepEqual(
    commands.map((item) => item.name),
    ['/house-style', '/claude-only'],
  );
  assert.equal(commands[0]?.type, 'hook');
  assert.equal(commands[0]?.metadata.instruction, 'Always reply in British English.');
});
