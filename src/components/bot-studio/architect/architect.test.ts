import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyReadOnlyPreset,
  applyWorkshopDraft,
  cronSummary,
  defaultToolDecision,
  isValidCron,
  type CreateMcSectionInput,
} from './types';

const base: CreateMcSectionInput = {
  title: 'Inbox bot',
  scope: 'global',
  dry_run: false,
  produce_prompt: 'old produce',
  resolve_prompt: 'old resolve',
  produce_tools: ['old-server'],
  resolve_tools: ['old-server'],
};

test('workshop draft maps server fields and recommended servers', () => {
  const result = applyWorkshopDraft(base, {
    title: 'Jira triage',
    scope: 'project',
    scheduleCron: '*/15 8-20 * * 1-5',
    producePrompt: 'Find new tickets.',
    resolvePrompt: 'Comment with the missing fields.',
    recommendedMcpServers: ['atl', 'obsidian', 'not-connected'],
  }, ['atl', 'obsidian']);
  assert.equal(result.title, 'Jira triage');
  assert.equal(result.schedule_cron, '*/15 8-20 * * 1-5');
  assert.deepEqual(result.produce_tools, ['atl', 'obsidian']);
  assert.deepEqual(result.resolve_tools, ['atl', 'obsidian']);
  assert.equal('kanban_mcp_tools' in result, false);
  assert.equal('mode' in result, false);
});

test('workshop draft without a resolve prompt attaches no resolve tools', () => {
  const result = applyWorkshopDraft(base, {
    title: 'Digest', scope: 'global', scheduleCron: null, producePrompt: 'Summarize.', resolvePrompt: '  ', recommendedMcpServers: ['atl'],
  });
  assert.deepEqual(result.produce_tools, ['atl']);
  assert.deepEqual(result.resolve_tools, []);
});

test('cron presets validate and summarize raw cron', () => {
  assert.equal(isValidCron('*/30 * * * *'), true);
  assert.equal(isValidCron('0 9 * *'), false);
  assert.equal(cronSummary('0 9-19 * * 1-5'), 'Workdays, 09:00–19:00');
  assert.equal(isValidCron(null), false);
  assert.equal(isValidCron(null, true), true);
  assert.equal(cronSummary(null), 'Manual only');
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
  assert.equal(defaultToolDecision('create_issue', true), 'ask');
  assert.equal(defaultToolDecision('list_issues', true), 'allow');
});
