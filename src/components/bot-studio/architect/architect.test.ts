import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDraft } from '../view/tabs/runtime/triggers/triggerForm';

import {
  applyReadOnlyPreset,
  applyWorkshopDraft,
  cronSummary,
  defaultToolDecision,
  isValidCron,
  setToolDecision,
  type CreateMcSectionInput,
} from './types';
import { COALESCING_EXPLANATION, WAKE_PRESETS } from './wakePresets';

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

test('every wake-up preset starts from a draft that only needs the user to fill in the blanks', () => {
  assert.deepEqual(WAKE_PRESETS.map((preset) => preset.id), ['plain', 'webhook', 'rss', 'folder', 'github', 'json', 'run', 'kanban', 'interrupt']);
  for (const preset of WAKE_PRESETS) {
    const draft = preset.make();
    assert.ok(preset.kinds.includes(draft.kind), preset.id);
    assert.equal(draft.enabled, true);
    assert.equal(draft.kind === 'cron' || draft.kind === 'interval', false, 'schedules use the section schedule, not a trigger');
  }
  const byId = Object.fromEntries(WAKE_PRESETS.map((preset) => [preset.id, preset.make()]));
  assert.equal(byId.rss.kind === 'watch' && byId.rss.adapter, 'rss');
  assert.equal(byId.folder.kind === 'watch' && byId.folder.adapter, 'directory');
  assert.equal(byId.github.kind === 'watch' && byId.github.adapter, 'github');
  assert.equal(byId.json.kind === 'watch' && byId.json.adapter, 'http_json');
  assert.equal(byId.kanban.event, 'task.done', 'a board task finishing is the kanban task.done event');
  // Event presets with no required field are valid straight away; the others ask for their first field.
  assert.equal(validateDraft(byId.run), null);
  assert.equal(validateDraft(byId.interrupt), null);
  assert.equal(validateDraft(byId.kanban), null);
  assert.match(validateDraft(byId.plain) ?? '', /Describe the schedule/);
  assert.match(validateDraft(byId.webhook) ?? '', /secret/);
  assert.match(validateDraft(byId.rss) ?? '', /feed URL/);
  assert.match(COALESCING_EXPLANATION, /merged into one wake-up/);
});
