import assert from 'node:assert/strict';
import test from 'node:test';

import type { McSection } from '../../../mission-control/api/missionControlApi';
import { sectionToBot } from '../../types';

import { selectCommandCenterSnapshot } from './commandCenterSelectors';

const section = (id: string, overrides: Partial<McSection> = {}): McSection => ({
  section_id: id,
  title: id,
  icon: 'bot',
  sort_order: 0,
  enabled: true,
  scope: 'global',
  project_id: null,
  mode: 'review',
  schedule_cron: null,
  provider: 'claude',
  model: 'sonnet',
  permission_mode: 'default',
  dry_run: false,
  auto_approve: false,
  produce_prompt: 'Do the work.',
  produce_tools: [],
  resolve_prompt: '',
  resolve_tools: [],
  actions: [],
  create_kanban_task: false,
  kanban_assignee_provider: null,
  kanban_review_provider: null,
  kanban_mcp_tools: [],
  last_run_at: null,
  last_run_error: null,
  created_at: '',
  updated_at: '',
  ...overrides,
});

test('builds fleet health, attention, activity, and spend metrics', () => {
  const healthy = sectionToBot(section('healthy'), { resolvedToday: 3 });
  const needs = sectionToBot(section('needs'), { pending: 2, resolvedToday: 1 });
  const failing = sectionToBot(section('failing'), { failed: 1, lastError: 'timeout' });
  const paused = sectionToBot(section('paused', { enabled: false }));

  const snapshot = selectCommandCenterSnapshot([healthy, needs, failing, paused], {
    healthy: [
      { run_id: 'active', status: 'running', started_at: '2026-09-22T09:00:00Z', cost_usd: 0.05 },
      { run_id: 'old', status: 'completed', started_at: '2026-09-21T09:00:00Z', cost_usd: 9 },
    ],
    failing: [{ run_id: 'failed', status: 'failed', started_at: '2026-09-22T08:00:00Z', cost_usd: 0.2 }],
  }, new Date('2026-09-22T12:00:00Z'));

  assert.deepEqual(snapshot.attentionBots.map((bot) => bot.section_id), ['failing', 'needs']);
  assert.deepEqual(snapshot.runningRuns.map(({ run }) => run.run_id), ['active']);
  assert.deepEqual(snapshot.recentRuns.map(({ run }) => run.run_id), ['active', 'failed', 'old']);
  assert.equal(snapshot.healthyBots, 1);
  assert.equal(snapshot.pausedBots, 1);
  assert.equal(snapshot.resolvedToday, 4);
  assert.equal(snapshot.ticksToday, 2);
  assert.equal(snapshot.failedToday, 1);
  assert.equal(snapshot.costToday, 0.25);
});
