import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { emptyDraft } from '../view/tabs/runtime/triggers/triggerForm';

import type { ArchitectStepId } from './steps';

// Components only fetch inside effects, which static rendering never runs; stub the browser globals
// the api module reads at import time anyway.
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0,
};
(globalThis as unknown as { window: unknown }).window = { localStorage: (globalThis as unknown as { localStorage: Storage }).localStorage, addEventListener: () => undefined, removeEventListener: () => undefined, location: { origin: 'http://localhost' } };

const { default: BotArchitect } = await import('./BotArchitect');
const { default: WakeUps } = await import('./WakeUps');
const { default: GoalsStep } = await import('./GoalsStep');
const { default: GuardrailsPanel } = await import('./GuardrailsPanel');
const { default: AutonomyPicker } = await import('../view/tabs/runtime/abilities/AutonomyPicker');
const { default: ReachStep } = await import('./ReachStep');
const { default: AgentExtras } = await import('./AgentExtras');
const { default: EnforcementNotice } = await import('./EnforcementNotice');
const { default: SetupProgress } = await import('./SetupProgress');
const { emptyRuntimeDraft } = await import('./runtimeDraft');
const { buildSetupPlan } = await import('./setupPlan');

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);
const noop = () => undefined;
const idle = { data: null, loading: false, error: null };

const architect = (props: { runtimeV2: boolean; mode?: 'create' | 'edit' }) => html(createElement(BotArchitect, {
  mode: props.mode ?? 'create', projects: [], onSaved: noop, onCancel: noop, runtimeV2: props.runtimeV2,
}));

test('flag off: the wizard is the original eight steps with the original wording', () => {
  const page = architect({ runtimeV2: false });
  assert.match(page, /Shape a bot in eight small decisions/);
  for (const title of ['Purpose', 'Agent', 'Brief', 'Tools', 'Triggers', 'Outputs &amp; actions', 'Guardrails', 'Review']) assert.match(page, new RegExp(`>${title}<`));
  assert.doesNotMatch(page, />Goals</);
  assert.doesNotMatch(page, />Reach me</);
  assert.match(page, /01 · Purpose/);
});

test('flag on, new bot: ten steps including Goals and Reach me', () => {
  const page = architect({ runtimeV2: true });
  assert.match(page, /Shape a bot in ten small decisions/);
  for (const title of ['Goals', 'Wake-ups', 'Reach me']) assert.match(page, new RegExp(`>${title}<`));
  assert.equal((page.match(/class="step-number"/g) ?? []).length, 10);
});

test('flag on, editing: the steps stay as they were', () => {
  const page = architect({ runtimeV2: true, mode: 'edit' });
  assert.match(page, /Edit and save a new version/);
  assert.equal((page.match(/class="step-number"/g) ?? []).length, 8);
});

test('wake-ups: schedule-like and event presets are offered, with coalescing explained', () => {
  const page = html(createElement(WakeUps, { triggers: [], onChange: noop }));
  for (const label of ['In plain English', 'When something calls a webhook', 'A news or blog feed', 'A folder on this computer', 'A GitHub repository', 'A JSON web address', 'When a run completes', 'When a board task finishes', 'When an interrupt appears']) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /merged into one wake-up/);
  assert.match(page, /No extra wake-ups yet/);
  const list = html(createElement(WakeUps, { triggers: [{ ...emptyDraft('watch'), adapter: 'rss', url: 'https://a.b/feed' }, { ...emptyDraft('kanban_event'), event: 'task.done' }], onChange: noop }));
  assert.match(list, /RSS https:\/\/a\.b\/feed/);
  assert.match(list, /Board event · event task\.done/);
  assert.match(list, /Remove wake-up 2/);
});

test('wake-ups: a plain-English schedule warns that it adds to the section schedule', () => {
  const nl = [{ ...emptyDraft('nl_schedule'), text: 'weekdays at 9am' }];
  assert.match(html(createElement(WakeUps, { triggers: nl, onChange: noop, scheduleActive: true })), /runs in addition to the schedule above/);
  assert.doesNotMatch(html(createElement(WakeUps, { triggers: nl, onChange: noop, scheduleActive: false })), /runs in addition/);
  assert.doesNotMatch(html(createElement(WakeUps, { triggers: [{ ...emptyDraft('webhook'), secretRef: 'S' }], onChange: noop, scheduleActive: true })), /runs in addition/);
});

test('goals: a suggestion from the purpose is offered once, and empty state explains itself', () => {
  const runtime = emptyRuntimeDraft();
  const withPurpose = html(createElement(GoalsStep, { title: 'Triage', purpose: 'Watch new support tickets and classify urgency.', runtime, onChange: noop }));
  assert.match(withPurpose, /A starting point from your purpose/);
  assert.match(withPurpose, /Use this goal/);
  assert.match(withPurpose, /No goals yet/);
  const dismissed = html(createElement(GoalsStep, { title: 'Triage', purpose: 'Watch new support tickets and classify urgency.', runtime: { ...runtime, goalSuggestionDismissed: true }, onChange: noop }));
  assert.doesNotMatch(dismissed, /A starting point/);
  assert.doesNotMatch(html(createElement(GoalsStep, { title: '', purpose: '', runtime, onChange: noop })), /A starting point/);
  const withGoal = html(createElement(GoalsStep, { title: '', purpose: '', runtime: { ...runtime, goals: [{ id: 'goal-1', statement: 'Ship it', successCriteria: 'Shipped', horizon: '' }] }, onChange: noop }));
  assert.match(withGoal, /Goal 1 statement/);
  assert.match(withGoal, /value="Ship it"/);
});

test('guardrails: autonomy replaces the provider card, and the floor, budget and dry run stay', () => {
  const props = { provider: 'claude', enforcement: idle, servers: [], runtime: emptyRuntimeDraft(), onChange: noop, dryRun: false, onDryRun: noop, permissionMode: 'bypassPermissions', onPermissionMode: noop };
  const page = html(createElement(GuardrailsPanel, { ...props, configurable: true }));
  assert.match(page, /How much can this bot do on its own\?/);
  for (const label of ['Ask', 'Auto', 'Bypass']) assert.match(page, new RegExp(`>${label}<`));
  assert.match(page, /aria-checked="true"[^>]*>(?:(?!<button).)*Ask/, 'Ask is the default');
  assert.match(page, /This bot can read anything and work in its own folder; it asks before sending, publishing, deleting, buying, logging in/);
  assert.match(page, /The safety floor/);
  for (const risk of ['send', 'publish', 'delete', 'purchase', 'credential', 'prod change']) assert.match(page, new RegExp(risk));
  assert.match(page, /always ask you first/);
  assert.match(page, /Never allow deleting/);
  assert.match(page, /Daily spend limit in dollars/);
  assert.match(page, /value="5"/);
  assert.match(page, /value="12"/);
  assert.match(page, /Start with a dry run \(recommended\)/);
  assert.doesNotMatch(page, /phantom controls/);
  assert.doesNotMatch(page, /Provider permission mode/, 'an unknown or enforced provider hides the raw mode');
  assert.doesNotMatch(page, /action gate, not this setting/, 'the old card is gone');
  assert.doesNotMatch(page, />bypassPermissions</, 'the raw mode is never the headline');
  const editing = html(createElement(GuardrailsPanel, { ...props, configurable: false }));
  assert.match(editing, /managed on its Rules tab/);
  assert.match(editing, /Abilities tab/);
  assert.doesNotMatch(editing, /Daily spend limit/);
  assert.doesNotMatch(editing, /How much can this bot do on its own\?/);
});

test('guardrails: Auto and Bypass change the copy, and the raw permission mode appears only when it matters', () => {
  const base = { provider: 'claude', enforcement: idle, servers: [], onChange: noop, dryRun: false, onDryRun: noop, permissionMode: 'bypassPermissions', onPermissionMode: noop, configurable: true };
  const auto = emptyRuntimeDraft();
  auto.autonomy = 'auto';
  const autoPage = html(createElement(GuardrailsPanel, { ...base, runtime: auto }));
  assert.match(autoPage, /Auto does everything on its own except it always asks before purchases, credentials/);
  assert.match(autoPage, /automatic reviewer checks the action against your brief and goals/);
  assert.match(autoPage, /passwords and login files stay off limits/);
  assert.doesNotMatch(autoPage, /The safety floor/, 'the floor only describes Ask bots');
  assert.match(autoPage, /What should this bot never do\?/);
  assert.match(autoPage, /Never allow deleting/);
  assert.doesNotMatch(autoPage, /Provider permission mode/);

  const loose = emptyRuntimeDraft();
  loose.autonomy = 'bypass';
  const loosePage = html(createElement(GuardrailsPanel, { ...base, runtime: loose }));
  assert.match(loosePage, /This bot is Bypass/);
  assert.match(loosePage, /Rules do not apply/);
  assert.doesNotMatch(loosePage, /Never allow deleting/);
  assert.match(loosePage, /Provider permission mode/, 'with no gate the raw mode is the only control');
  assert.match(loosePage, /no gate/);
  assert.match(loosePage, /skips its own questions/);
  assert.match(loosePage, /Daily spend limit/, 'a budget still applies');

  const advisory = html(createElement(GuardrailsPanel, { ...base, runtime: emptyRuntimeDraft(), provider: 'codex', enforcement: { data: { provider: 'codex', level: 'advisory', detail: 'x', builtin_tool_gate: false }, loading: false, error: null } }));
  assert.match(advisory, /Provider permission mode/);
  assert.match(advisory, /Codex can use tools the gate cannot see/);
  const failedCheck = html(createElement(GuardrailsPanel, { ...base, runtime: emptyRuntimeDraft(), enforcement: { data: null, loading: false, error: 'boom' } }));
  assert.match(failedCheck, /Provider permission mode/, 'if the check fails the setting stays reachable');
  const enforced = html(createElement(GuardrailsPanel, { ...base, runtime: emptyRuntimeDraft(), enforcement: { data: { provider: 'claude', level: 'enforced', detail: 'x', builtin_tool_gate: true }, loading: false, error: null } }));
  assert.doesNotMatch(enforced, /Provider permission mode/);
});

test('the autonomy picker shows three radio cards with the exact meanings and a warning once Bypass', () => {
  const page = html(createElement(AutonomyPicker, { value: 'auto', onChange: noop }));
  assert.equal((page.match(/role="radio"/g) ?? []).length, 3);
  assert.match(page, /role="radiogroup"/);
  assert.match(page, /Reads anything except password and login files, and writes inside its own folder/);
  assert.match(page, /Does everything on its own, except it always asks before purchases, credentials/);
  assert.match(page, /No gate and no questions/);
  assert.doesNotMatch(page, /Type <strong>bypass/);
  assert.doesNotMatch(page, /This bot is Bypass/);
  const loose = html(createElement(AutonomyPicker, { value: 'bypass', onChange: noop }));
  assert.match(loose, /This bot is Bypass\. Nothing checks what it does\./);
  assert.match(html(createElement(AutonomyPicker, { value: 'ask', onChange: noop, disabled: true })), /disabled=""/);
});

test('the autonomy picker offers Ask, Auto and Bypass as radio cards with Ask selected by default', () => {
  const page = html(createElement(AutonomyPicker, { value: emptyRuntimeDraft().autonomy, onChange: noop }));
  const cards = page.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
  assert.equal(cards.length, 3);
  for (const label of ['Ask', 'Auto', 'Bypass']) assert.match(page, new RegExp(`>${label}</span>`));
  assert.deepEqual(cards.map((card) => /aria-checked="true"/.test(card)), [true, false, false], 'Ask is the default');
  assert.doesNotMatch(page, /Careful|Trusted|Unrestricted/);
  assert.doesNotMatch(page, /Nothing checks what it does/, 'no Bypass warning unless Bypass is selected');
  const bypass = html(createElement(AutonomyPicker, { value: 'bypass', onChange: noop }));
  assert.deepEqual((bypass.match(/<button[^>]*role="radio"[^>]*>/g) ?? []).map((card) => /aria-checked="true"/.test(card)), [false, false, true]);
  assert.match(bypass, /role="alert"[^>]*>(?:(?!<\/p>).)*This bot is Bypass\. Nothing checks what it does\./);
});

test('enforcement is explained in plain words for both levels, and a failed check does not block', () => {
  const enforced = html(createElement(EnforcementNotice, { provider: 'claude', state: { data: { provider: 'claude', level: 'enforced', detail: 'detail', builtin_tool_gate: true }, loading: false, error: null } }));
  assert.match(enforced, /Action gate: Enforced/);
  assert.match(enforced, /every tool call and built-in action/);
  const advisory = html(createElement(EnforcementNotice, { provider: 'codex', state: { data: { provider: 'codex', level: 'advisory', detail: 'x', builtin_tool_gate: false }, loading: false, error: null } }));
  assert.match(advisory, /Action gate: Advisory/);
  assert.match(advisory, /cannot see/);
  const off = html(createElement(EnforcementNotice, { provider: 'claude', state: { data: { provider: 'claude', level: 'off', detail: 'x', builtin_tool_gate: true }, loading: false, error: null } }));
  assert.match(off, /Action gate: Off/);
  assert.match(off, /nothing it does on claude is checked/);
  assert.match(html(createElement(EnforcementNotice, { provider: 'codex', state: { data: null, loading: false, error: 'boom' } })), /Could not check enforcement for codex \(boom\)/);
  assert.match(html(createElement(EnforcementNotice, { provider: 'codex', state: { data: null, loading: true, error: null } })), /Checking/);
});

test('agent extras: backups and the cheaper screening model are optional and explained', () => {
  const runtime = emptyRuntimeDraft();
  const page = html(createElement(AgentExtras, { provider: 'claude', runtime, onChange: noop, enforcement: idle }));
  assert.match(page, /If claude is down or rate-limited/);
  assert.match(page, /No backups/);
  assert.match(page, /Use a cheaper model to screen signals first/);
  assert.doesNotMatch(page, /Screening model/);
  const on = html(createElement(AgentExtras, { provider: 'claude', runtime: { ...runtime, fallback: [{ provider: 'codex' }], watcher: { enabled: true, route: { provider: 'claude', model: null, effort: null } } }, onChange: noop, enforcement: idle }));
  assert.match(on, /Backup 1/);
  assert.match(on, /Order: claude → codex/);
  assert.match(on, /Screening model/);
});

test('reach me: shared channels can be opted out of, quiet hours and learning are explained', () => {
  const slack = { channel_id: 'c1', bot_id: null, kind: 'slack', config: {}, policy: { max_pings_per_day: 3 }, enabled: true, created_at: '', updated_at: '' };
  const page = html(createElement(ReachStep, { runtime: emptyRuntimeDraft(), onChange: noop, globals: { data: [slack], loading: false, error: null, reload: noop } }));
  assert.match(page, /Use Slack for this bot/);
  assert.match(page, /Max 3 pings\/day/);
  assert.match(page, /Quiet hours/);
  assert.match(page, /Learning/);
  assert.match(page, /nothing takes effect until you approve it/);
  assert.match(page, /Auto-apply memories/);
  assert.doesNotMatch(page, /Minimum confidence/, 'auto-apply is off by default');
  const empty = html(createElement(ReachStep, { runtime: emptyRuntimeDraft(), onChange: noop, globals: { data: [], loading: false, error: null, reload: noop } }));
  assert.match(empty, /No shared channels yet/);
  assert.match(empty, /href="\/bots\/channels"/);
  const on = emptyRuntimeDraft();
  on.learning.autoApply = true;
  on.channels.own.telegram = { enabled: true, config: { slackMode: 'bot', tokenRef: '', channelId: '', webhookUrlRef: '', chatId: '', inbound: true, actionBaseUrl: '' } };
  const detailed = html(createElement(ReachStep, { runtime: on, onChange: noop, globals: { data: [], loading: false, error: null, reload: noop } }));
  assert.match(detailed, /Minimum confidence/);
  assert.match(detailed, /Telegram chat id/);
  assert.match(detailed, /Keep that chat private/);
});

test('setup progress shows each step, a partial failure in plain words and a retry', () => {
  const { tasks } = buildSetupPlan({ runtime: emptyRuntimeDraft(), globalChannels: [], enableAfter: true });
  assert.deepEqual(tasks.map((task) => task.id), ['budget', 'enable']);
  const page = html(createElement(SetupProgress, {
    tasks, botEnabled: false, busy: false, onRetry: noop,
    state: { budget: { status: 'failed', error: 'network down' }, enable: { status: 'blocked', error: 'setup is not finished, so the bot stays off.' } },
  }));
  assert.match(page, /Set spending and wake-up limits/);
  assert.match(page, /Did not finish: network down/);
  assert.match(page, /Left paused/);
  assert.match(page, /created, but 2 of 2 setup steps did not finish, so it is paused/);
  assert.match(page, /Retry remaining \(2\)/);
  const done = html(createElement(SetupProgress, { tasks, botEnabled: true, busy: false, onRetry: noop, state: { budget: { status: 'done' }, enable: { status: 'done' } } }));
  assert.match(done, /Everything is set up and the bot is on/);
  assert.doesNotMatch(done, /Retry remaining/);
  assert.equal(html(createElement(SetupProgress, { tasks: [], state: {}, botEnabled: false, busy: false, onRetry: noop })), '');
});

const stepPage = (id: ArchitectStepId, runtimeV2: boolean, mode: 'create' | 'edit' = 'create') => html(createElement(BotArchitect, {
  mode, projects: [], onSaved: noop, onCancel: noop, runtimeV2, initialStep: id,
}));

test('flag off: Triggers and Guardrails keep today\'s wording and controls', () => {
  const triggers = stepPage('triggers', false);
  assert.match(triggers, /When should this bot tick\?/);
  assert.match(triggers, /Manual only/);
  assert.doesNotMatch(triggers, /More ways to wake it up/);
  const guardrails = stepPage('guardrails', false);
  assert.match(guardrails, /no hidden budgets or phantom controls/);
  assert.match(guardrails, /Permission mode/);
  assert.doesNotMatch(guardrails, /The safety floor/);
  const agent = stepPage('agent', false);
  assert.match(agent, /Permission mode/);
  assert.doesNotMatch(agent, /Action gate/);
  assert.doesNotMatch(agent, /If claude is down/);
  assert.match(stepPage('review', false), /Trigger/);
});

test('flag on, new bot: every step renders with its v2 content', () => {
  const triggers = stepPage('triggers', true);
  assert.match(triggers, /When should this bot wake up\?/);
  assert.match(triggers, /Only when I message it/);
  assert.match(triggers, /More ways to wake it up/);
  assert.match(triggers, /Raw cron/, 'schedule presets and raw cron stay');
  assert.match(triggers, /Every 15 minutes/);
  const guardrails = stepPage('guardrails', true);
  assert.doesNotMatch(guardrails, /phantom controls/);
  assert.match(guardrails, /The safety floor/);
  assert.match(guardrails, /How much can this bot do on its own\?/);
  assert.match(guardrails, /it asks before sending, publishing, deleting, buying, logging in/);
  assert.doesNotMatch(guardrails, /Current policy summary/);
  assert.doesNotMatch(guardrails, /tool decisions loaded/);
  assert.doesNotMatch(guardrails, /Provider permission mode/);
  const agent = stepPage('agent', true);
  assert.doesNotMatch(agent, /Advanced: provider permission mode/);
  assert.doesNotMatch(agent, /Provider permission mode/, 'an enforced (or not yet checked) provider hides the raw mode');
  assert.doesNotMatch(agent, />Permission mode</);
  assert.match(agent, /Use a cheaper model to screen signals first/);
  assert.match(stepPage('goals', true), /What does good look like\?/);
  assert.match(stepPage('reach', true), /Where should it reach you\?/);
  const review = stepPage('review', true);
  for (const label of ['Schedule', 'Autonomy', 'More wake-ups', 'Goals', 'Rules', 'Budget', 'Enforcement', 'Backup providers', 'Triage model', 'Reaches you on', 'Learning']) assert.match(review, new RegExp(`>${label}<`));
  assert.match(review, /\$5\.00\/day/);
  assert.match(review, /12 wake-ups\/hour/);
  assert.match(review, /setup step/);
});

test('flag on, editing: new guardrails copy but no create-only inputs', () => {
  const guardrails = stepPage('guardrails', true, 'edit');
  assert.match(guardrails, /managed on its Rules tab/);
  assert.match(guardrails, /changed on its Abilities tab/);
  assert.doesNotMatch(guardrails, /Daily spend limit/);
  assert.match(stepPage('triggers', true, 'edit'), /managed on the bot(?:'|&#x27;)s Triggers tab/);
  assert.doesNotMatch(stepPage('triggers', true, 'edit'), /More ways to wake it up/);
});
