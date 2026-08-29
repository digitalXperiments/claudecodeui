import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionActivity } from '../../../hooks/useSessionProtection';
import type { Project } from '../../../types/app';

import { buildRunningProjects } from './utils';

const activity = (overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  source: 'chat',
  statusText: null,
  canInterrupt: true,
  startedAt: 1_700_000_000_000,
  title: 'Live session',
  projectId: 'proj-1',
  projectDisplayName: 'CloudCLI Fork',
  provider: 'grok',
  ...overrides,
});

test('includes a running session that is not on the loaded project page', () => {
  const project: Project = {
    projectId: 'proj-1',
    displayName: 'CloudCLI Fork',
    fullPath: '/workspace/cloudcli',
    sessions: [{
      id: 'page-session',
      summary: 'On the first page',
    }],
    sessionMeta: { total: 501, hasMore: true },
  };

  const active = new Map<string, SessionActivity>([
    ['hidden-live', activity({ title: 'Generate Swarm Goals' })],
    ['page-session', activity({ title: 'On the first page' })],
  ]);

  const running = buildRunningProjects([project], active);
  assert.equal(running.length, 1);
  assert.deepEqual(
    running[0]?.sessions?.map((session) => session.id).sort(),
    ['hidden-live', 'page-session'],
  );
  assert.equal(running[0]?.sessionMeta?.total, 2);
  assert.equal(running[0]?.sessionMeta?.hasMore, false);
});

test('synthesizes a project row when the live session belongs to an unloaded project', () => {
  const active = new Map<string, SessionActivity>([
    ['other-live', activity({
      projectId: 'proj-missing',
      projectDisplayName: 'EYEWA',
      title: 'Other work',
    })],
  ]);

  const running = buildRunningProjects([], active);
  assert.equal(running.length, 1);
  assert.equal(running[0]?.displayName, 'EYEWA');
  assert.equal(running[0]?.sessions?.[0]?.id, 'other-live');
  assert.equal(running[0]?.sessions?.[0]?.summary, 'Other work');
});
