import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createGitignoreEntryFilter } from './gitignore.js';

const projectRoot = path.resolve('/tmp/gitignore-filter-project');

test('gitignore entry filter handles file, directory, and negated rules', () => {
  const includeEntry = createGitignoreEntryFilter(
    projectRoot,
    ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n'),
  );

  assert.equal(includeEntry(path.join(projectRoot, 'debug.log'), false), false);
  assert.equal(includeEntry(path.join(projectRoot, 'keep.log'), false), true);
  assert.equal(includeEntry(path.join(projectRoot, 'cache'), true), false);
  assert.equal(includeEntry(path.join(projectRoot, 'src', 'generated.ts'), false), false);
  assert.equal(includeEntry(path.join(projectRoot, 'src', 'index.ts'), false), true);
});

test('gitignore entry filter normalizes nested paths before matching', () => {
  const includeEntry = createGitignoreEntryFilter(projectRoot, 'fixtures/*.json');

  assert.equal(includeEntry(path.join(projectRoot, 'fixtures', 'sample.json'), false), false);
  assert.equal(includeEntry(path.join(projectRoot, 'fixtures', 'sample.txt'), false), true);
});
