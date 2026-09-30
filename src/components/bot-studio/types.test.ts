import test from 'node:test';
import assert from 'node:assert/strict';

import type { McItem, McSection, McWorkProfile } from '../mission-control/api/missionControlApi';

import { autoApproveLabel, isInboxActionLocked, itemAcceptsActions, pipelineLabel, pipelineStages, pipelineSummary, routeWorkProject, sectionToBot } from './types';

const section = (overrides: Partial<McSection> = {}): McSection => ({
  section_id: 'bot-1', title: 'Inbox helper', icon: 'bot', sort_order: 0, enabled: true,
  scope: 'global', project_id: null, schedule_cron: '0 9 * * 1-5',
  provider: 'claude', model: 'sonnet', permission_mode: 'default', dry_run: false,
  auto_approve: false, produce_prompt: 'Find useful things.\nThen summarize.', produce_tools: [],
  resolve_prompt: 'Resolve approved items.', resolve_tools: [], actions: [],
  last_run_at: null, last_run_error: null, created_at: '', updated_at: '', ...overrides,
});

const profile = (overrides: Partial<McWorkProfile> = {}): McWorkProfile => ({
  auto_start: false, provider: 'claude', model: 'sonnet', effort: null, mcp_servers: [], context: 'Do the work.',
  default_project_id: null, routes: [], ...overrides,
});

test('maps section purpose and dry run into a bot', () => {
  assert.equal(sectionToBot(section()).purpose, 'Find useful things.');
  assert.equal(sectionToBot(section({ dry_run: true })).dry_run, true);
});

test('unions MCP servers and merges health summary fields', () => {
  const bot = sectionToBot(section({
    enabled: false,
    produce_tools: ['github', 'slack'],
    resolve_tools: ['slack'],
  }), { pending: 2, failed: 1, resolvedToday: 4, lastRunAt: '2026-09-16T08:00:00Z', lastError: 'timeout' });
  assert.deepEqual(bot.tools.map((tool) => [tool.name, tool.produce, tool.resolve]), [
    ['github', true, false],
    ['slack', true, true],
  ]);
  assert.equal(bot.pending, 2);
  assert.equal(bot.resolvedToday, 4);
  assert.equal(bot.health, 'needs');
  assert.equal(sectionToBot(section({ enabled: false })).health, 'paused');
  assert.equal(sectionToBot(section({ last_run_error: 'failed' })).health, 'failing');
  assert.equal(sectionToBot(section(), { failed: 1, pending: 0 }).health, 'failing');
});

test('derives pipeline stages, labels, and the auto-approve toggle label', () => {
  assert.deepEqual(pipelineStages(section()), { resolve: 'manual', work: 'none' });
  assert.deepEqual(pipelineStages(section({ auto_approve: true, work_profile: profile({ auto_start: true }) })), { resolve: 'auto', work: 'auto' });
  assert.deepEqual(pipelineStages(section({ resolve_prompt: '  ', work_profile: profile() })), { resolve: 'none', work: 'manual' });
  assert.equal(pipelineLabel(section({ auto_approve: true, work_profile: profile() })), 'Resolve auto · Work manual');
  assert.equal(pipelineLabel(section({ resolve_prompt: '', auto_approve: true })), 'Record only · auto');
  assert.equal(pipelineSummary(section({ work_profile: profile({ auto_start: true }) })), 'Propose → Resolve (manual) → Work (auto)');
  assert.equal(autoApproveLabel(section())?.label, 'Resolve automatically');
  assert.equal(autoApproveLabel(section({ resolve_prompt: '' }))?.label, 'Approve automatically');
  assert.equal(autoApproveLabel(section({ resolve_prompt: '', work_profile: profile() })), null);
});

test('routes work projects like the server', () => {
  const routes = [
    { client: 'VAST Data', aliases: ['VastData'], project_id: 'vast', context: '' },
    { client: 'Acme', aliases: [], project_id: 'acme', context: '' },
  ];
  assert.equal(routeWorkProject({ body: { client: 'vast-data' } }, profile({ routes })), 'vast');
  assert.equal(routeWorkProject({ body: { client: 'VASTDATA' } }, profile({ routes })), 'vast');
  assert.equal(routeWorkProject({ body: { client: 'Other' } }, profile({ routes, default_project_id: 'home' })), 'home');
  assert.equal(routeWorkProject({ body: {} }, profile({ routes })), null);
  assert.equal(routeWorkProject({ body: { client: 'Acme' } }, null), null);
});

test('locks actions only while an agent runs and routes failures by stage', () => {
  assert.equal(isInboxActionLocked({ status: 'pending' }), false);
  assert.equal(isInboxActionLocked({ status: 'resolving' }), true);
  assert.equal(isInboxActionLocked({ status: 'working' }), true);
  const failed = { status: 'failed' } as Pick<McItem, 'status' | 'work_ready_at'>;
  assert.equal(itemAcceptsActions(failed), true);
  assert.equal(itemAcceptsActions({ ...failed, work_ready_at: '2026-09-25T10:00:00Z' }), false);
});
