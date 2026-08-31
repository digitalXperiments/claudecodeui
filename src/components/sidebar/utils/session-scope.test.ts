import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionActivity } from '../../../hooks/useSessionProtection';
import type { Project } from '../../../types/app';

import { getProjectSessionsWithActivity } from './utils';

const activity = (projectId: string | null, title: string): SessionActivity => ({
  source: 'chat',
  statusText: null,
  canInterrupt: true,
  startedAt: 1_700_000_000_000,
  title,
  projectId,
  projectDisplayName: projectId === 'project-a' ? 'Project A' : 'Project B',
  provider: 'grok',
});

const project: Project = {
  projectId: 'project-a',
  displayName: 'Project A',
  fullPath: '/workspace/project-a',
  sessions: [{ id: 'old-session', summary: 'Old session' }],
};

test('does not inject a live session from another project into the picker', () => {
  const sessions = getProjectSessionsWithActivity(
    project,
    new Map([
      ['other-live', activity('project-b', 'Other project work')],
    ]),
  );

  assert.deepEqual(sessions.map((session) => session.id), ['old-session']);
});

test('does not pin internal relay or swarm workers into the picker', () => {
  const sessions = getProjectSessionsWithActivity(
    project,
    new Map([
      ['relay-worker', activity('project-a', 'Relay · claude · investigate')],
    ]),
  );
  const withInternal = getProjectSessionsWithActivity(
    project,
    new Map([
      ['relay-worker', { ...activity('project-a', 'Relay · claude · investigate'), isInternal: true }],
    ]),
  );

  assert.deepEqual(sessions.map((session) => session.id), ['relay-worker', 'old-session']);
  assert.deepEqual(withInternal.map((session) => session.id), ['old-session']);
});

test('hides untitled grok watcher shadows but keeps empty user drafts', () => {
  const mixed: Project = {
    ...project,
    sessions: [
      { id: 'user-draft', summary: '', messageCount: 0, __provider: 'grok' },
      {
        id: 'watcher-shadow',
        summary: 'Untitled Grok Session',
        messageCount: 0,
        __provider: 'grok',
      },
      {
        id: 'real-grok',
        summary: 'Untitled Grok Session',
        messageCount: 3,
        __provider: 'grok',
      },
      { id: 'internal-row', summary: 'Relay worker', isInternal: true, __provider: 'grok' },
    ],
  };

  const sessions = getProjectSessionsWithActivity(mixed, new Map());
  assert.deepEqual(
    sessions.map((session) => session.id),
    ['user-draft', 'real-grok'],
  );
});

test('pins a live session from the selected project even when it is not loaded', () => {
  const sessions = getProjectSessionsWithActivity(
    project,
    new Map([
      ['project-live', activity('project-a', 'Current project work')],
    ]),
  );

  assert.deepEqual(sessions.map((session) => session.id), ['project-live', 'old-session']);
  assert.equal(sessions[0]?.summary, 'Current project work');
});
