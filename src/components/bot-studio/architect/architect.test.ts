import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyReadOnlyPreset,
  applyWorkshopDraft,
  autonomyFromSection,
  cronSummary,
  isValidCron,
  sectionFieldsForAutonomy,
  type CreateMcSectionInput,
} from './types';

const base: CreateMcSectionInput = {
  title: 'Inbox bot',
  scope: 'global',
  mode: 'review',
  dry_run: false,
  produce_prompt: 'old produce',
  resolve_prompt: 'old resolve',
  produce_tools: ['old-server'],
  resolve_tools: ['old-server'],
  kanban_mcp_tools: [],
};

test('workshop draft maps server fields and recommended servers', () => {
  const result = applyWorkshopDraft(base, {
    title: 'Jira triage',
    scope: 'project',
    mode: 'review',
    scheduleCron: '*/15 8-20 * * 1-5',
    producePrompt: 'Find new tickets.',
    resolvePrompt: 'Comment with the missing fields.',
    createKanbanTask: true,
    recommendedMcpServers: ['atl', 'obsidian', 'not-connected'],
  }, ['atl', 'obsidian']);
  assert.equal(result.title, 'Jira triage');
  assert.equal(result.schedule_cron, '*/15 8-20 * * 1-5');
  assert.deepEqual(result.produce_tools, ['atl', 'obsidian']);
  assert.deepEqual(result.resolve_tools, ['atl', 'obsidian']);
  assert.deepEqual(result.kanban_mcp_tools, ['atl', 'obsidian']);
});

test('cron presets validate and summarize raw cron', () => {
  assert.equal(isValidCron('*/30 * * * *'), true);
  assert.equal(isValidCron('0 9 * *'), false);
  assert.equal(cronSummary('0 9 * * 1-5'), 'Workdays, 09:00–19:00');
  assert.equal(cronSummary(null), 'Manual only');
});

test('autonomy maps dry run, propose, and act', () => {
  assert.equal(autonomyFromSection({ mode: 'review', dry_run: true }), 'dry_run');
  assert.equal(autonomyFromSection({ mode: 'review', dry_run: false }), 'propose');
  assert.equal(autonomyFromSection({ mode: 'fire_and_forget', dry_run: false }), 'act');
  assert.deepEqual(sectionFieldsForAutonomy('dry_run'), { mode: 'review', dry_run: true });
  assert.deepEqual(sectionFieldsForAutonomy('act'), { mode: 'fire_and_forget', dry_run: false });
});

test('read-only preset holds write-like tools for approval', () => {
  const result = applyReadOnlyPreset({
    github: { list_issues: 'allow', create_issue: 'allow', merge_pull_request: 'deny' },
    browser: { click: 'allow', read_page: 'allow' },
  });
  assert.equal(result.github.list_issues, 'allow');
  assert.equal(result.github.create_issue, 'ask');
  assert.equal(result.github.merge_pull_request, 'ask');
  assert.equal(result.browser.click, 'ask');
  assert.equal(result.browser.read_page, 'allow');
});
