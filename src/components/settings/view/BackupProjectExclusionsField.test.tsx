import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import BackupProjectExclusionsField from './BackupProjectExclusionsField';

const OPTIONS = [
  { fullPath: '/workspace/alpha', displayName: 'alpha' },
  { fullPath: '/workspace/beta', displayName: 'beta' },
];

test('shows a loading state while project options are loading', () => {
  const markup = renderToStaticMarkup(
    <BackupProjectExclusionsField
      excludedPaths={[]}
      options={[]}
      optionsLoading
      optionsError={null}
      onChange={() => {}}
    />,
  );
  assert.match(markup, /Loading projects…/);
});

test('shows an empty state when there are no projects at all', () => {
  const markup = renderToStaticMarkup(
    <BackupProjectExclusionsField
      excludedPaths={[]}
      options={[]}
      optionsLoading={false}
      optionsError={null}
      onChange={() => {}}
    />,
  );
  assert.match(markup, /No projects found\./);
});

test('reports zero matches without offering free-text entry', () => {
  const markup = renderToStaticMarkup(
    <BackupProjectExclusionsField
      excludedPaths={[]}
      options={OPTIONS}
      optionsLoading={false}
      optionsError={null}
      onChange={() => {}}
    />,
  );
  assert.match(markup, /alpha/);
  assert.match(markup, /beta/);
  assert.doesNotMatch(markup, /<input[^>]*type="text"/);
});

test('preserves a previously excluded path that no longer resolves to a live project', () => {
  const markup = renderToStaticMarkup(
    <BackupProjectExclusionsField
      excludedPaths={['/workspace/alpha', '/workspace/deleted-project']}
      options={OPTIONS}
      optionsLoading={false}
      optionsError={null}
      onChange={() => {}}
    />,
  );
  assert.match(markup, /\/workspace\/deleted-project/);
  assert.match(markup, /\(unavailable\)/);
  assert.match(markup, /2 excluded/);
});

test('empty exclusions read as "all projects included"', () => {
  const markup = renderToStaticMarkup(
    <BackupProjectExclusionsField
      excludedPaths={[]}
      options={OPTIONS}
      optionsLoading={false}
      optionsError={null}
      onChange={() => {}}
    />,
  );
  assert.match(markup, /All projects included/);
});
