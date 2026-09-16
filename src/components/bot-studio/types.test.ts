import test from 'node:test';
import assert from 'node:assert/strict';

import type { McSection } from '../mission-control/api/missionControlApi';

import { botPatch, sectionToBot } from './types';

const section = (overrides: Partial<McSection> = {}): McSection => ({
  section_id: 'bot-1', title: 'Inbox helper', icon: 'bot', sort_order: 0, enabled: true,
  scope: 'global', project_id: null, mode: 'review', schedule_cron: '0 9 * * 1-5',
  provider: 'claude', model: 'sonnet', permission_mode: 'default', dry_run: false,
  auto_approve: false, produce_prompt: 'Find useful things.\nThen summarize.', produce_tools: [],
  resolve_prompt: 'Resolve approved items.', resolve_tools: [], actions: [], create_kanban_task: false,
  create_swarm_on_approve: false, kanban_assignee_provider: null, kanban_review_provider: null,
  kanban_mcp_tools: [], last_run_at: null, last_run_error: null, created_at: '', updated_at: '', ...overrides,
});

test('maps section autonomy and purpose into a bot', () => {
  assert.equal(sectionToBot(section()).autonomy, 'propose');
  assert.equal(sectionToBot(section({ mode: 'fire_and_forget' })).autonomy, 'act');
  assert.equal(sectionToBot(section({ mode: 'fire_and_forget', dry_run: true })).autonomy, 'dry_run');
  assert.equal(sectionToBot(section()).purpose, 'Find useful things.');
});

test('unions MCP servers and merges health summary fields', () => {
  const bot = sectionToBot(section({
    enabled: false,
    produce_tools: ['github', 'slack'],
    resolve_tools: ['slack'],
    kanban_mcp_tools: ['github'],
  }), { pending: 2, failed: 1, resolvedToday: 4, lastRunAt: '2026-09-16T08:00:00Z', lastError: 'timeout' });
  assert.deepEqual(bot.tools.map((tool) => [tool.name, tool.produce, tool.resolve, tool.kanban]), [
    ['github', true, false, true],
    ['slack', true, true, false],
  ]);
  assert.equal(bot.pending, 2);
  assert.equal(bot.resolvedToday, 4);
  assert.equal(bot.health, 'needs');
  assert.equal(sectionToBot(section({ enabled: false })).health, 'paused');
  assert.equal(sectionToBot(section({ last_run_error: 'failed' })).health, 'failing');
});

test('maps all autonomy modes back to mode and dry_run', () => {
  assert.deepEqual(botPatch('dry_run'), { mode: 'review', dry_run: true });
  assert.deepEqual(botPatch('propose'), { mode: 'review', dry_run: false });
  assert.deepEqual(botPatch('act'), { mode: 'fire_and_forget', dry_run: false });
  assert.equal(botPatch('act', { title: 'Updated' }).title, 'Updated');
  assert.deepEqual(botPatch({ autonomy: 'act', title: 'Updated' }), { title: 'Updated', mode: 'fire_and_forget', dry_run: false });
});
