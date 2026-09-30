import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { updateAppFeatures } from '@/modules/app-features/index.js';
import { gatewaySessions } from '@/shared/bot-gateway-sessions.js';
import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { mcpCatalogService, providerModelsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { configureMissionControlRuntimes, buildProducePrompt } from '../mission-control-agent.service.js';
import { acceptWorkItem, dispatchWorkItem, drainWorkQueue, followUpWorkItem, markWorkReady, recoverWorkDispatches } from '../mission-control-dispatch.service.js';
import { parseWorkProfile, routeWorkItem } from '../mission-control-work-profile.js';
import { missionControlDb } from '../mission-control.repository.js';
import { applyItemAction, runSectionProduce } from '../mission-control-runner.service.js';
import type { McDraftItem, McItemStatus, McSection, McWorkProfile } from '../mission-control.types.js';

type Sink = { send: (event: unknown) => void };
type Fixture = { profile: McWorkProfile; defaultProjectId: string };

async function fixture(run: (context: Fixture) => Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('mc-dispatch-');
  const originalModels = providerModelsService.getProviderModels;
  const originalMcp = mcpCatalogService.resolveForProvider;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  const project = projectsDb.createProjectPath(path.join(directory, 'vast'), 'VAST Data').project!;
  const fallback = projectsDb.createProjectPath(path.join(directory, 'eyewa'), 'Eyewa Data').project!;
  providerModelsService.getProviderModels = async () => ({ models: { OPTIONS: [{ value: 'flash-high', label: 'Flash High' }], DEFAULT: 'flash-high' }, cache: { source: 'fresh', updatedAt: '', expiresAt: '' } });
  mcpCatalogService.resolveForProvider = async () => [{ name: 'fluxito', transport: 'http', url: 'https://example.invalid/mcp', headers: {} }];
  try {
    await run({
      profile: { auto_start: true, provider: 'antigravity', model: 'flash-high', effort: null, mcp_servers: ['fluxito'], context: 'Shared instructions', default_project_id: null, routes: [{ client: 'VAST Data', aliases: ['VAST'], project_id: project.project_id, context: 'Fluxito project: vast-client' }] },
      defaultProjectId: fallback.project_id,
    });
  } finally {
    providerModelsService.getProviderModels = originalModels;
    mcpCatalogService.resolveForProvider = originalMcp;
    configureMissionControlRuntimes({});
    chatRunRegistry.clearAll();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const complete = (provider: string) => async (_prompt: string, _options: unknown, sink: unknown) => {
  (sink as Sink).send({ kind: 'complete', provider, exitCode: 0 });
};

/** A produce/resolve runtime that answers with fixed text. */
const answer = (provider: string, text: string) => async (_prompt: string, _options: unknown, sink: unknown) => {
  (sink as Sink).send({ kind: 'text', provider, content: text });
  (sink as Sink).send({ kind: 'complete', provider, exitCode: 0 });
};

function readyItem(section: McSection, draft: Partial<McDraftItem> & { dedupeKey: string }) {
  const item = missionControlDb.insertItemIfNew(section, { title: draft.dedupeKey, summary: '', body: {}, ...draft })!;
  return markWorkReady(missionControlDb.getSection(section.section_id)!, item.item_id);
}

async function waitForStatus(itemId: string, statuses: McItemStatus[]) {
  for (let n = 0; n < 200 && !statuses.includes(missionControlDb.getItem(itemId)!.status); n++) await new Promise((resolve) => setTimeout(resolve, 5));
  return missionControlDb.getItem(itemId)!;
}

test('work profile validates routes/default project and routes by override, client, then default', async () => fixture(async ({ profile, defaultProjectId }) => {
  const section = missionControlDb.createSection({ title: 'TL Tasks', work_profile: parseWorkProfile(profile) });
  assert.deepEqual(section.work_profile, profile);
  const item = missionControlDb.insertItemIfNew(section, { title: 'Task', summary: '', body: { client: 'vast' }, dedupeKey: 'one' })!;
  assert.equal(routeWorkItem(item, profile).project_id, profile.routes[0].project_id);
  assert.throws(() => routeWorkItem({ ...item, body: { client: 'Other' } }, profile), /No unique client mapping/);
  assert.equal(routeWorkItem({ ...item, body: { client: 'Other' } }, { ...profile, default_project_id: defaultProjectId }).project_id, defaultProjectId);
  assert.equal(routeWorkItem(item, profile, defaultProjectId).project_id, defaultProjectId);
  assert.throws(() => parseWorkProfile({ ...profile, routes: [...profile.routes, profile.routes[0]] }), /Duplicate client/);
  assert.throws(() => parseWorkProfile({ ...profile, routes: [{ ...profile.routes[0], project_id: 'missing' }] }), /missing or archived/);
  assert.throws(() => parseWorkProfile({ ...profile, routes: [] }), /default project or add a client mapping/);
  assert.throws(() => parseWorkProfile({ ...profile, default_project_id: 'missing' }), /Default project is missing/);
  assert.equal(parseWorkProfile({ ...profile, routes: [], default_project_id: defaultProjectId })?.default_project_id, defaultProjectId);
  assert.equal(missionControlDb.updateSection(section.section_id, { work_profile: null })?.work_profile, null);
}));

test('work agent, model and effort are configurable per bot and validated against the model catalog', async () => fixture(async ({ profile, defaultProjectId }) => {
  assert.throws(() => parseWorkProfile({ ...profile, provider: 'nope' }), /Select a work-session agent/);
  assert.equal(parseWorkProfile({ ...profile, mcp_servers: [] })?.mcp_servers.length, 0);
  const claudeProfile = parseWorkProfile({ ...profile, provider: 'claude', model: 'opus', effort: 'high', mcp_servers: ['claude.ai Eyewa MCP'], routes: [], default_project_id: defaultProjectId, auto_start: false })!;
  providerModelsService.getProviderModels = async () => ({ models: { OPTIONS: [{ value: 'opus', label: 'Opus', effort: { values: [{ value: 'low' }, { value: 'high' }] } }], DEFAULT: 'opus' }, cache: { source: 'fresh', updatedAt: '', expiresAt: '' } });
  let seen: Record<string, unknown> | null = null;
  configureMissionControlRuntimes({ claude: async (prompt, options, sink) => {
    seen = options as Record<string, unknown>;
    assert.doesNotMatch(prompt, /Before using/);
    (sink as Sink).send({ kind: 'complete', provider: 'claude', exitCode: 0 });
  } });
  const section = missionControlDb.createSection({ title: 'Other bot', work_profile: { ...claudeProfile, effort: 'max' } });
  const item = readyItem(section, { dedupeKey: 'one' });
  await assert.rejects(dispatchWorkItem(item.item_id), /Effort "max" is not supported/);
  missionControlDb.updateSection(section.section_id, { work_profile: claudeProfile });
  const result = await dispatchWorkItem(item.item_id);
  await result.completion;
  assert.equal(result.provider, 'claude');
  assert.equal(result.projectId, defaultProjectId);
  assert.equal(seen!.model, 'opus');
  assert.equal(seen!.effort, 'high');
  // claude.ai account connectors are loaded by the Claude runtime, not the catalog.
  assert.deepEqual(seen!.mcpServers, ['claude.ai Eyewa MCP']);
}));

test('concurrent Start work launches one session; finishing moves to QA, accept resolves, re-ingestion reuses the session', async () => fixture(async ({ profile }) => {
  let calls = 0;
  configureMissionControlRuntimes({ antigravity: async (prompt, options, sink) => {
    calls++;
    assert.match(prompt, /Fluxito project: vast-client/);
    assert.match(prompt, /Shared instructions/);
    assert.equal(options.model, 'flash-high');
    assert.deepEqual(options.mcpServers, ['fluxito']);
    assert.equal(options.strictMcpSelection, true);
    (sink as Sink).send({ kind: 'complete', provider: 'antigravity', exitCode: 0 });
  } });
  const section = missionControlDb.createSection({ title: 'TL Tasks', work_profile: { ...profile, auto_start: false } });
  const draft = { title: 'Task', summary: '', body: { client: 'VAST', trelloCardId: '0123456789abcdef01234567' }, dedupeKey: 'trello:card:0123456789abcdef01234567' };
  const item = readyItem(section, draft);
  assert.equal(item.status, 'awaiting_work');
  assert.ok(item.work_ready_at);
  const [first, second] = await Promise.all([dispatchWorkItem(item.item_id), dispatchWorkItem(item.item_id)]);
  await first.completion;
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(calls, 1);
  assert.equal(missionControlDb.getItem(item.item_id)?.status, 'in_qa');
  assert.equal(acceptWorkItem(item.item_id).status, 'resolved');
  assert.throws(() => acceptWorkItem(item.item_id), /Only items in QA/);
  missionControlDb.deleteItem(item.item_id);
  const replacement = readyItem(section, draft);
  assert.equal((await dispatchWorkItem(replacement.item_id)).sessionId, first.sessionId);
  assert.equal(missionControlDb.getItem(replacement.item_id)?.status, 'in_qa');
  assert.equal(calls, 1);
}));

test('an operator project choice overrides routing for a manual Start work', async () => fixture(async ({ profile, defaultProjectId }) => {
  configureMissionControlRuntimes({ antigravity: complete('antigravity') });
  const section = missionControlDb.createSection({ title: 'TL Tasks', work_profile: { ...profile, auto_start: false } });
  const item = readyItem(section, { dedupeKey: 'one', body: { client: 'VAST' } });
  const result = await dispatchWorkItem(item.item_id, defaultProjectId);
  await result.completion;
  assert.equal(result.projectId, defaultProjectId);
  assert.equal(result.matchReason, 'manual selection');
}));

test('dry-run, unavailable model, missing MCP and held policies fail before claiming a session', async () => fixture(async ({ profile }) => {
  let calls = 0;
  configureMissionControlRuntimes({ antigravity: async () => { calls++; } });
  const section = missionControlDb.createSection({ title: 'TL Tasks', work_profile: { ...profile, auto_start: false }, dry_run: true });
  const item = readyItem(section, { dedupeKey: 'one', body: { client: 'VAST' } });
  await assert.rejects(dispatchWorkItem(item.item_id), /Dry run/);
  missionControlDb.updateSection(section.section_id, { dry_run: false, work_profile: { ...profile, auto_start: false, model: 'not-installed' } });
  await assert.rejects(dispatchWorkItem(item.item_id), /model is unavailable/);
  missionControlDb.updateSection(section.section_id, { work_profile: { ...profile, auto_start: false } });
  mcpCatalogService.resolveForProvider = async () => [];
  await assert.rejects(dispatchWorkItem(item.item_id), /Enable these MCP/);
  missionControlDb.updateSection(section.section_id, { tool_policy: { fluxito: { write: 'ask' } } });
  await assert.rejects(dispatchWorkItem(item.item_id), /held or denied/);
  assert.equal(calls, 0);
  assert.equal((getConnection().prepare('SELECT count(*) AS n FROM mc_work_dispatches').get() as { n: number }).n, 0);
  const pending = missionControlDb.insertItemIfNew(section, { title: 'Pending', summary: '', body: { client: 'VAST' }, dedupeKey: 'pending' })!;
  await assert.rejects(dispatchWorkItem(pending.item_id), /not ready for work/);
}));

test('pipeline without a resolve prompt: produce sends items straight to the work gate (manual or automatic)', async () => fixture(async ({ profile }) => {
  let calls = 0;
  configureMissionControlRuntimes({
    grok: answer('grok', JSON.stringify([{ title: 'Task', summary: '', body: { client: 'VAST' }, dedupeKey: 'one' }])),
    antigravity: async (_prompt, _options, sink) => { calls++; (sink as Sink).send({ kind: 'complete', provider: 'antigravity', exitCode: 0 }); },
  });
  const manual = missionControlDb.createSection({ title: 'Manual', work_profile: { ...profile, auto_start: false }, provider: 'grok', produce_prompt: 'Fetch Trello tasks', auto_approve: true });
  assert.match(buildProducePrompt(manual), /Return ONLY a JSON array/);
  await runSectionProduce(manual.section_id);
  const [manualId] = missionControlDb.listItemIdsBySection(manual.section_id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(missionControlDb.getItem(manualId)?.status, 'awaiting_work');
  assert.equal(calls, 0);

  const auto = missionControlDb.createSection({ title: 'Auto', work_profile: profile, provider: 'grok', produce_prompt: 'Fetch Trello tasks' });
  await runSectionProduce(auto.section_id);
  const [autoId] = missionControlDb.listItemIdsBySection(auto.section_id);
  assert.equal((await waitForStatus(autoId, ['in_qa'])).status, 'in_qa');
  assert.equal(calls, 1);
}));

test('pipeline with a manual resolve: Approve resolves, then the resolve result feeds the automatic work session', async () => fixture(async ({ profile, defaultProjectId }) => {
  let workPrompt = '';
  configureMissionControlRuntimes({
    claude: async (prompt, _options, sink) => {
      const text = prompt.includes('Create a Jira issue')
        ? JSON.stringify({ jiraKey: 'DE-42', url: 'https://jira.example/DE-42' })
        : JSON.stringify([{ title: 'Fix report', summary: '', body: { whatNeedsToBeDone: 'Fix the report' }, dedupeKey: 'slack:1' }]);
      (sink as Sink).send({ kind: 'text', provider: 'claude', content: text });
      (sink as Sink).send({ kind: 'complete', provider: 'claude', exitCode: 0 });
    },
    antigravity: async (prompt, _options, sink) => { workPrompt = prompt; (sink as Sink).send({ kind: 'complete', provider: 'antigravity', exitCode: 0 }); },
  });
  const section = missionControlDb.createSection({
    title: 'Jira Drafts', produce_prompt: 'Find Slack work', resolve_prompt: 'Create a Jira issue in DE.',
    work_profile: { ...profile, routes: [], default_project_id: defaultProjectId },
  });
  await runSectionProduce(section.section_id);
  const [itemId] = missionControlDb.listItemIdsBySection(section.section_id);
  assert.equal(missionControlDb.getItem(itemId)?.status, 'pending');
  await assert.rejects(dispatchWorkItem(itemId), /not ready for work/);
  const approved = await applyItemAction(itemId, 'approve');
  assert.equal(approved?.status, 'awaiting_work');
  assert.deepEqual(approved?.result, { jiraKey: 'DE-42', url: 'https://jira.example/DE-42' });
  assert.equal((await waitForStatus(itemId, ['in_qa'])).status, 'in_qa');
  assert.match(workPrompt, /Resolve step result/);
  assert.match(workPrompt, /DE-42/);
  assert.equal((missionControlDb.getItem(itemId)?.body.workSession as { projectId: string }).projectId, defaultProjectId);
}));

test('automatic resolve without a work stage resolves; record-only bots finish on creation; a failed resolve never starts work', async () => fixture(async ({ profile, defaultProjectId }) => {
  let workCalls = 0;
  configureMissionControlRuntimes({
    claude: async (prompt, _options, sink) => {
      const text = prompt.includes('Resolve it') ? JSON.stringify({ done: true })
        : prompt.includes('Break it') ? JSON.stringify({ error: 'Jira rejected the issue' })
          : JSON.stringify([{ title: 'Item', summary: '', body: {}, dedupeKey: 'k' }]);
      (sink as Sink).send({ kind: 'text', provider: 'claude', content: text });
      (sink as Sink).send({ kind: 'complete', provider: 'claude', exitCode: 0 });
    },
    antigravity: async () => { workCalls++; },
  });
  const auto = missionControlDb.createSection({ title: 'Auto resolve', produce_prompt: 'Find', resolve_prompt: 'Resolve it', auto_approve: true });
  await runSectionProduce(auto.section_id);
  assert.equal(missionControlDb.getItem(missionControlDb.listItemIdsBySection(auto.section_id)[0])?.status, 'resolved');

  const record = missionControlDb.createSection({ title: 'Record only', produce_prompt: 'Find', auto_approve: true });
  await runSectionProduce(record.section_id);
  assert.equal(missionControlDb.getItem(missionControlDb.listItemIdsBySection(record.section_id)[0])?.status, 'resolved');

  const failing = missionControlDb.createSection({ title: 'Failing', produce_prompt: 'Find', resolve_prompt: 'Break it', auto_approve: true, work_profile: { ...profile, routes: [], default_project_id: defaultProjectId } });
  await runSectionProduce(failing.section_id);
  const failed = missionControlDb.getItem(missionControlDb.listItemIdsBySection(failing.section_id)[0])!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.work_ready_at, null);
  await assert.rejects(dispatchWorkItem(failed.item_id), /not ready for work/);
  assert.equal(workCalls, 0);
}));

test('Send back posts feedback into the same session and returns the item to QA', async () => fixture(async ({ profile }) => {
  const prompts: string[] = [];
  const statuses: string[] = [];
  let itemId = '';
  configureMissionControlRuntimes({ antigravity: async (prompt, _options, sink) => {
    prompts.push(prompt);
    statuses.push(missionControlDb.getItem(itemId)!.status);
    (sink as Sink).send({ kind: 'complete', provider: 'antigravity', exitCode: 0 });
  } });
  const section = missionControlDb.createSection({ title: 'TL Tasks', work_profile: { ...profile, auto_start: false } });
  const item = readyItem(section, { dedupeKey: 'one', body: { client: 'VAST' } });
  itemId = item.item_id;
  const started = await dispatchWorkItem(item.item_id);
  await started.completion;
  await assert.rejects(followUpWorkItem(item.item_id, '  '), /Describe what should change/);
  const { completion } = await followUpWorkItem(item.item_id, 'The chart axis is still wrong.');
  await completion;
  assert.deepEqual(statuses, ['working', 'working']);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /The chart axis is still wrong/);
  const after = missionControlDb.getItem(item.item_id)!;
  assert.equal(after.status, 'in_qa');
  assert.equal((after.body.workSession as { sessionId: string }).sessionId, started.sessionId);
}));

test('a failed work session stays in the work stage; restart recovery never replays it; retry continues the session', async () => fixture(async ({ profile }) => {
  let fail = true;
  configureMissionControlRuntimes({ antigravity: async (_prompt, _options, sink) => {
    if (fail) throw new Error('Runtime offline');
    (sink as Sink).send({ kind: 'complete', provider: 'antigravity', exitCode: 0 });
  } });
  const section = missionControlDb.createSection({ title: 'TL Tasks', work_profile: { ...profile, auto_start: false } });
  const item = readyItem(section, { dedupeKey: 'one', body: { client: 'VAST' } });
  const result = await dispatchWorkItem(item.item_id);
  await result.completion;
  const failed = missionControlDb.getItem(item.item_id)!;
  assert.equal(failed.status, 'failed');
  assert.ok(failed.work_ready_at);
  assert.match(failed.error ?? '', /Runtime offline/);
  await assert.rejects(applyItemAction(item.item_id, 'approve'), /not actionable/);
  getConnection().prepare("UPDATE mc_work_dispatches SET status = 'running'").run();
  recoverWorkDispatches();
  assert.match(missionControlDb.getItem(item.item_id)?.error ?? '', /Server restarted/);
  assert.equal((await dispatchWorkItem(item.item_id)).sessionId, result.sessionId);
  fail = false;
  const retry = await followUpWorkItem(item.item_id, 'The previous attempt failed. Continue.');
  await retry.completion;
  assert.equal(missionControlDb.getItem(item.item_id)?.status, 'in_qa');
}));

test('automatic queue is serialized, ignores unqueued items, and exposes unknown clients', async () => fixture(async ({ profile }) => {
  let calls = 0;
  let running = 0;
  let maximum = 0;
  configureMissionControlRuntimes({ antigravity: async (_prompt, _options, sink) => {
    calls++; running++; maximum = Math.max(maximum, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running--;
    (sink as Sink).send({ kind: 'complete', provider: 'antigravity', exitCode: 0 });
  } });
  const section = missionControlDb.createSection({ title: 'TL Tasks', work_profile: profile });
  const first = readyItem(section, { dedupeKey: 'first', body: { client: 'VAST' } });
  const second = readyItem(section, { dedupeKey: 'second', body: { client: 'VAST' } });
  const unknown = readyItem(section, { dedupeKey: 'unknown', body: { client: 'Not mapped' } });
  const old = missionControlDb.insertItemIfNew(section, { title: 'old', summary: '', dedupeKey: 'old', body: { client: 'VAST' } })!;
  missionControlDb.setItemStatus(old.item_id, 'awaiting_work', { workReadyAt: new Date().toISOString() });
  drainWorkQueue(section.section_id);
  drainWorkQueue(section.section_id);
  for (const item of [first, second, unknown]) await waitForStatus(item.item_id, ['in_qa', 'failed']);
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  assert.equal(missionControlDb.getItem(old.item_id)?.status, 'awaiting_work');
  assert.equal(missionControlDb.getItem(unknown.item_id)?.status, 'failed');
  assert.match(missionControlDb.getItem(unknown.item_id)?.error ?? '', /No unique client mapping/);
}));

test('changing to Dry run during model preflight prevents launch', async () => fixture(async ({ profile }) => {
  let calls = 0;
  configureMissionControlRuntimes({ antigravity: async () => { calls++; } });
  const section = missionControlDb.createSection({ title: 'TL Tasks', work_profile: { ...profile, auto_start: false } });
  const item = readyItem(section, { dedupeKey: 'one', body: { client: 'VAST' } });
  const models = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async (...args) => {
    missionControlDb.updateSection(section.section_id, { dry_run: true });
    return models(...args);
  };
  await assert.rejects(dispatchWorkItem(item.item_id), /settings changed/);
  assert.equal(calls, 0);
  missionControlDb.updateSection(section.section_id, { dry_run: false });
  providerModelsService.getProviderModels = async (...args) => {
    missionControlDb.setItemStatus(item.item_id, 'dismissed');
    return models(...args);
  };
  await assert.rejects(dispatchWorkItem(item.item_id), /Task changed/);
  assert.equal(calls, 0);
}));

test('migration converts Act sections to the single pipeline once', async () => fixture(async ({ profile }) => {
  const db = getConnection();
  const act = missionControlDb.createSection({ title: 'Digest', produce_prompt: 'Summarize' });
  const work = missionControlDb.createSection({ title: 'TL Tasks', work_profile: profile });
  const waiting = missionControlDb.insertItemIfNew(work, { title: 'Card', summary: '', body: {}, dedupeKey: 'card' })!;
  db.exec('ALTER TABLE mc_items DROP COLUMN work_ready_at');
  db.prepare("UPDATE mc_sections SET mode = 'fire_and_forget'").run();
  // Reopening runs migrations exactly as a server boot does.
  closeConnection();
  await initializeDatabase();
  assert.equal(missionControlDb.getSection(act.section_id)?.auto_approve, true);
  assert.equal(missionControlDb.getSection(work.section_id)?.auto_approve, false);
  assert.deepEqual((getConnection().prepare('SELECT DISTINCT mode FROM mc_sections').all() as Array<{ mode: string }>).map((row) => row.mode), ['review']);
  const migrated = missionControlDb.getItem(waiting.item_id)!;
  assert.equal(migrated.status, 'awaiting_work');
  assert.ok(migrated.work_ready_at);
}));

test('Propose and Resolve run on their own agent, model and effort; Work never inherits the Propose effort', async () => fixture(async ({ profile, defaultProjectId }) => {
  const seen: Array<{ provider: string; model: unknown; effort: unknown }> = [];
  const record = (provider: string, text: string) => async (_prompt: string, options: Record<string, unknown>, sink: unknown) => {
    seen.push({ provider, model: options.model, effort: options.effort });
    if (text) (sink as Sink).send({ kind: 'text', provider, content: text });
    (sink as Sink).send({ kind: 'complete', provider, exitCode: 0 });
  };
  configureMissionControlRuntimes({
    grok: record('grok', JSON.stringify([{ title: 'Item', summary: '', body: {}, dedupeKey: 'k' }])),
    codex: record('codex', JSON.stringify({ done: true })),
    claude: record('claude', JSON.stringify({ done: true })),
    antigravity: record('antigravity', ''),
  });
  const section = missionControlDb.createSection({
    title: 'Split agents', produce_prompt: 'Find', resolve_prompt: 'Resolve it', auto_approve: true,
    provider: 'grok', model: 'grok-4', effort: 'high',
    resolve_provider: 'codex', resolve_model: 'gpt-6', resolve_effort: 'low',
    work_profile: { ...profile, routes: [], default_project_id: defaultProjectId },
  });
  await runSectionProduce(section.section_id);
  const [itemId] = missionControlDb.listItemIdsBySection(section.section_id);
  await waitForStatus(itemId, ['in_qa']);
  assert.deepEqual(seen, [
    { provider: 'grok', model: 'grok-4', effort: 'high' },
    { provider: 'codex', model: 'gpt-6', effort: 'low' },
    { provider: 'antigravity', model: 'flash-high', effort: undefined },
  ]);

  // Clearing the Resolve agent falls back to the Propose agent, ignoring stale resolve fields.
  const same = missionControlDb.updateSection(section.section_id, { resolve_provider: null })!;
  assert.equal(same.resolve_model, null);
  seen.length = 0;
  const item = missionControlDb.insertItemIfNew(same, { title: 'Manual', summary: '', body: {}, dedupeKey: 'manual' })!;
  await applyItemAction(item.item_id, 'approve');
  assert.deepEqual(seen[0], { provider: 'grok', model: 'grok-4', effort: 'high' });
}));

test('M3(c): gateway-bound work sessions bind tainted and carry the built-in gate and binding secret', async () => fixture(async ({ profile }) => {
  updateAppFeatures({ botsRuntimeV2: true });
  try {
    const captured: { seen: { appSessionId: string; options: Record<string, unknown> } | null; binding: ReturnType<typeof gatewaySessions.get> } = { seen: null, binding: null };
    configureMissionControlRuntimes({ antigravity: async (_prompt, options, sink) => {
      const appSessionId = String((options as { appSessionId?: string }).appSessionId ?? '');
      captured.seen = { appSessionId, options: options as Record<string, unknown> };
      captured.binding = gatewaySessions.get(appSessionId);
      (sink as Sink).send({ kind: 'complete', provider: 'antigravity', exitCode: 0 });
    } });
    const section = missionControlDb.createSection({ title: 'Gateway work', work_profile: { ...profile, auto_start: false } });
    const item = readyItem(section, { title: 'Task', summary: '', body: { client: 'VAST' }, dedupeKey: 'gw:task:1' });
    const result = await dispatchWorkItem(item.item_id);
    await result.completion;
    const { seen, binding } = captured;
    assert.ok(seen, 'the work runtime ran');
    assert.ok(binding, 'the session was bound to the bot while the turn ran');
    assert.equal(binding.tainted, true, 'work acts on possibly-untrusted items');
    assert.equal(typeof seen.options.builtinToolGate, 'function');
    assert.equal(seen.options.botGatewaySecret, binding.secret);
    assert.equal(gatewaySessions.get(seen.appSessionId!), null, 'unbound once the turn settled');
  } finally {
    updateAppFeatures({ botsRuntimeV2: false });
  }
}));
