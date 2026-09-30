import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyReadOnlyPreset,
  applyWorkshopDraft,
  cronSummary,
  defaultToolDecision,
  isValidCron,
  setToolDecision,
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

test('read-only preset holds write-like tools for approval without loosening or inventing decisions', () => {
  const result = applyReadOnlyPreset({
    github: { list_issues: 'allow', create_issue: 'allow', merge_pull_request: 'deny' },
    browser: { click: 'allow', read_page: 'allow' },
  }, { github: ['list_issues', 'get_issue', 'send_review'] });
  assert.equal(result.github.list_issues, 'allow');
  assert.equal(result.github.create_issue, 'ask');
  assert.equal(result.github.merge_pull_request, 'deny');
  assert.equal(result.github.send_review, 'ask');
  assert.equal('get_issue' in result.github, false);
  assert.equal(result.browser.read_page, 'allow');
  assert.equal(defaultToolDecision('create_issue', true), 'ask');
  assert.equal(defaultToolDecision('list_issues', true), 'default');
  assert.equal(defaultToolDecision('list_issues'), 'default');
});

test('untouched tools are never persisted as allow; default clears an explicit decision', () => {
  const policy = setToolDecision({}, 'mail', 'send_message', 'default');
  assert.deepEqual(policy, {});
  const allowed = setToolDecision({ mail: { read: 'ask' } }, 'mail', 'send_message', 'allow');
  assert.deepEqual(allowed, { mail: { read: 'ask', send_message: 'allow' } });
  assert.deepEqual(setToolDecision(allowed, 'mail', 'send_message', 'default'), { mail: { read: 'ask' } });
  assert.deepEqual(setToolDecision({ mail: { send_message: 'deny' } }, 'mail', 'send_message', 'default'), {});
});
