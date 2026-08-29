import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  buildSectionWorkshopPrompt,
  configureSectionWorkshopRunner,
  parseSectionWorkshopDraft,
  runSectionWorkshop,
} from '@/modules/mission-control/mission-control-section-workshop.service.js';

afterEach(() => configureSectionWorkshopRunner(null));

test('section workshop prompt includes context, transcript, and exact MCP inventory', () => {
  const prompt = buildSectionWorkshopPrompt({
    projectName: 'CloudCLI',
    currentDraft: { title: 'Inbox', mode: 'review' },
    availableMcpServers: ['Slack', 'Linear'],
    messages: [
      { role: 'user', content: 'Triage customer feedback each morning' },
      { role: 'assistant', content: 'Should it create engineering work?' },
    ],
  });
  assert.match(prompt, /Selected project: CloudCLI/);
  assert.match(prompt, /"title":"Inbox"/);
  assert.match(prompt, /Slack, Linear/);
  assert.match(prompt, /Triage customer feedback/);
  assert.match(prompt, /```mission-section/);
});

test('section workshop parser sanitizes fields and deduplicates MCP names', () => {
  const draft = parseSectionWorkshopDraft([
    'Ready.',
    '```mission-section',
    JSON.stringify({
      title: 'Feedback triage',
      scope: 'project',
      mode: 'review',
      schedule_cron: '0 9 * * 1-5',
      produce_prompt: 'Collect feedback and return bounded drafts.',
      resolve_prompt: 'Create the approved ticket.',
      create_kanban_task: true,
      recommended_mcp_servers: ['Slack', 'Linear', 'Slack', ''],
    }),
    '```',
  ].join('\n'));
  assert.deepEqual(draft, {
    title: 'Feedback triage',
    scope: 'project',
    mode: 'review',
    scheduleCron: '0 9 * * 1-5',
    producePrompt: 'Collect feedback and return bounded drafts.',
    resolvePrompt: 'Create the approved ticket.',
    createKanbanTask: true,
    recommendedMcpServers: ['Slack', 'Linear'],
  });
});

test('section workshop parser defaults unsafe enums and rejects incomplete output', () => {
  const safe = parseSectionWorkshopDraft([
    '```mission-section',
    '{"title":"Digest","scope":"other","mode":"destructive","producePrompt":"Summarize changes"}',
    '```',
  ].join('\n'));
  assert.equal(safe?.scope, 'global');
  assert.equal(safe?.mode, 'review');
  assert.equal(parseSectionWorkshopDraft('no fenced payload'), null);
  assert.equal(parseSectionWorkshopDraft('```mission-section\n{"title":"Missing prompt"}\n```'), null);
});

test('section workshop uses a safe provider default and filters hallucinated MCP servers', async () => {
  let provider = '';
  configureSectionWorkshopRunner(async ({ section }) => {
    provider = section.provider;
    return {
      success: true,
      errorMessage: null,
      text: [
        'Plan ready.',
        '```mission-section',
        JSON.stringify({
          title: 'Daily digest',
          scope: 'global',
          mode: 'review',
          producePrompt: 'Create a factual digest.',
          resolvePrompt: '',
          createKanbanTask: false,
          recommendedMcpServers: ['Slack', 'Invented CRM'],
        }),
        '```',
      ].join('\n'),
    };
  });
  const result = await runSectionWorkshop({
    provider: 'unknown-provider',
    messages: [{ role: 'user', content: 'Create a daily digest' }],
    availableMcpServers: ['Slack'],
  });
  assert.equal(provider, 'claude');
  assert.equal(result.ready, true);
  assert.deepEqual(result.draft?.recommendedMcpServers, ['Slack']);
});

test('section workshop rejects empty conversations and provider failures', async () => {
  await assert.rejects(
    () => runSectionWorkshop({ messages: [] }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      return true;
    },
  );

  configureSectionWorkshopRunner(async () => ({
    success: false,
    text: '',
    errorMessage: 'Provider unavailable',
  }));
  await assert.rejects(
    () => runSectionWorkshop({ messages: [{ role: 'user', content: 'Build a digest' }] }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 502);
      assert.match((error as Error).message, /Provider unavailable/);
      return true;
    },
  );
});
