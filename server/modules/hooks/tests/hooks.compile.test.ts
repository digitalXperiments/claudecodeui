import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  expandHookInstruction,
  slugifyHookName,
  uniqueHookSlug,
} from '@/modules/hooks/hooks.compile.js';
import { configureHooksStorePath, hooksStore } from '@/modules/hooks/hooks.store.js';

test('slugifyHookName lowercases and hyphenates', () => {
  assert.equal(slugifyHookName('House Style'), 'house-style');
  assert.equal(slugifyHookName('  Review $FILES  '), 'review-files');
  assert.equal(slugifyHookName('@@@'), 'hook');
});

test('uniqueHookSlug avoids collisions', () => {
  const taken = new Set(['house-style']);
  assert.equal(uniqueHookSlug('House Style', taken), 'house-style-2');
  taken.add('house-style-2');
  assert.equal(uniqueHookSlug('House Style', taken), 'house-style-3');
});

test('expandHookInstruction replaces $ARGUMENTS', () => {
  assert.equal(
    expandHookInstruction('Review $ARGUMENTS then ship.', 'src/a.ts extra'),
    'Review src/a.ts extra then ship.',
  );
});

test('expandHookInstruction appends remainder when no placeholder', () => {
  assert.equal(
    expandHookInstruction('Always reply in British English.', 'Fix the test.'),
    'Always reply in British English.\n\nFix the test.',
  );
  assert.equal(expandHookInstruction('Always reply in British English.', ''), 'Always reply in British English.');
});

test('hooksStore backfills unique slugs on load and persists them', () => {
  const dir = path.join('tmp', 'cloudcli', 'hooks-tests');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `hooks-slug-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  configureHooksStorePath(filePath);
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        hooks: [
          {
            id: 'hook_legacy_1',
            name: 'House style',
            enabled: true,
            event: 'session_start',
            instruction: 'Always reply in British English.',
            provider: 'all',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'hook_legacy_2',
            name: 'House style',
            enabled: true,
            event: 'session_start',
            instruction: 'Duplicate name.',
            provider: 'claude',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );

    const listed = hooksStore.list();
    assert.equal(listed[0]?.id, 'hook_legacy_1');
    assert.equal(listed[0]?.slug, 'house-style');
    assert.equal(listed[1]?.slug, 'house-style-2');

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { hooks: Array<{ slug: string }> };
    assert.equal(persisted.hooks[0]?.slug, 'house-style');
    assert.equal(persisted.hooks[1]?.slug, 'house-style-2');

    const created = hooksStore.create({
      name: 'House style',
      instruction: 'Third copy.',
    });
    assert.equal(created.slug, 'house-style-3');
  } finally {
    configureHooksStorePath(null);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
});
