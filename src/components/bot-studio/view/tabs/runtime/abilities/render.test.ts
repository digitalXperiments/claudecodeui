import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { McSection } from '../../../../../mission-control/api/missionControlApi';
import type { BotAbilities } from '../../../../types/botRuntime';

// Components only fetch inside effects, which static rendering never runs; stub the browser globals
// the api module reads at import time anyway.
const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 } as unknown as Storage;
(globalThis as unknown as { localStorage: Storage }).localStorage = storage;
(globalThis as unknown as { window: unknown }).window = { localStorage: storage, sessionStorage: storage, addEventListener: () => undefined, removeEventListener: () => undefined, location: { origin: 'http://localhost' } };

const { default: AutonomySection, PlainLists } = await import('./AutonomySection');
const { default: AppsSection } = await import('./AppsSection');
const { default: BrowserCard } = await import('./BrowserCard');
const { default: AbilityCard } = await import('./AbilityCard');

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);
const noop = () => undefined;

const abilities = (overrides: Partial<BotAbilities> = {}): BotAbilities => ({
  autonomy: 'careful',
  provider: 'claude',
  enforcement: { level: 'enforced', detail: 'Built-in tools are gated.' },
  apps: [
    { server: 'claude.ai Gmail', connected: true, tools_policy_counts: { allow: 4, ask: 2, deny: 1 } },
    { server: 'jira-cloud', connected: false, tools_policy_counts: { allow: 0, ask: 0, deny: 0 } },
  ],
  plain: { canDoAlone: ['Read your inbox', 'Write drafts'], asksFirst: ['Send an email'], neverDoes: ['Open password files'] },
  skills_count: 2,
  spaces_count: 1,
  credentials: [{ server: 'jira-cloud', key: 'JIRA_API_TOKEN' }],
  browser: { profile_exists: true, size_bytes: 2048, last_used_at: null },
  ...overrides,
});

test('an ability card is a labelled section with a number, a title and one plain sentence', () => {
  // eslint-disable-next-line react/no-children-prop
  const page = html(createElement(AbilityCard, { id: 'apps', number: 2, title: 'Apps it can use', description: 'Only these.', children: createElement('p', null, 'inside') }));
  assert.match(page, /id="abilities-apps"/);
  assert.match(page, /aria-labelledby="abilities-apps-title"/);
  assert.match(page, />Apps it can use</);
  assert.match(page, />inside</);
});

test('the autonomy section shows the picker, the three plain lists and the enforcement line', () => {
  const page = html(createElement(AutonomySection, { botId: 'b1', abilities: abilities(), permissionMode: 'bypassPermissions', onChanged: noop, onOpenPipeline: noop }));
  assert.match(page, /How much it can do alone/);
  assert.equal((page.match(/role="radio"/g) ?? []).length, 3);
  for (const text of ['Can do alone', 'Asks you first', 'Never does', 'Read your inbox', 'Send an email', 'Open password files']) assert.match(page, new RegExp(text));
  assert.match(page, /Claude is fully controlled by the gate\./);
  assert.match(page, /Built-in tools are gated\./);
  assert.doesNotMatch(page, /Change it on the Pipeline tab/, 'the raw provider mode stays hidden for a Careful bot on an enforced provider');
  assert.doesNotMatch(page, />bypassPermissions</);
});

test('the autonomy section explains the raw provider mode only when it matters', () => {
  const loose = html(createElement(AutonomySection, { botId: 'b1', abilities: abilities({ autonomy: 'unrestricted', enforcement: { level: 'off' } }), permissionMode: 'bypassPermissions', onChanged: noop, onOpenPipeline: noop }));
  assert.match(loose, /This bot is Unrestricted/);
  assert.match(loose, /There is no gate on this bot/);
  assert.match(loose, /<strong>bypassPermissions<\/strong>: The provider skips its own questions/);
  assert.match(loose, /Change it on the Pipeline tab/);
  const advisory = html(createElement(AutonomySection, { botId: 'b1', abilities: abilities({ provider: 'codex', enforcement: { level: 'advisory' } }), permissionMode: 'default', onChanged: noop, onOpenPipeline: noop }));
  assert.match(advisory, /Codex is only partly controlled/);
  assert.match(advisory, /Codex can use tools the gate cannot see/);
  const loading = html(createElement(AutonomySection, { botId: 'b1', abilities: null, permissionMode: 'default', onChanged: noop, onOpenPipeline: noop }));
  assert.doesNotMatch(loading, /role="radio"/);
});

test('plain lists tolerate a missing payload', () => {
  assert.match(html(createElement(PlainLists, { plain: undefined })), /Nothing is blocked outright/);
});

const section = { section_id: 'b1', title: 'Mailer', produce_tools: ['claude.ai Gmail'], resolve_tools: [], tool_policy: {}, permission_mode: 'default' } as unknown as McSection;

test('apps list each attached server with its status and tool counts, and say a bot can only use these', () => {
  const page = html(createElement(AppsSection, { section, abilities: abilities(), onSave: async () => undefined, onChanged: noop, onOpenPipeline: noop }));
  assert.match(page, /Apps it can use/);
  assert.match(page, /can only use the apps listed here/);
  assert.match(page, /2 apps attached\. The bot can use only these\./);
  assert.match(page, />Gmail</);
  assert.match(page, />Connected</);
  assert.match(page, /4 allowed · 2 ask first · 1 blocked/);
  assert.match(page, />Not connected</);
  assert.match(page, /default rules/);
  assert.match(page, /Change apps/);
  assert.match(page, /Connect it in Settings/);
  assert.match(html(createElement(AppsSection, { section, abilities: abilities({ apps: [] }), onSave: async () => undefined, onChanged: noop, onOpenPipeline: noop })), /cannot use any outside app/);
  assert.doesNotMatch(html(createElement(AppsSection, { section, abilities: null, onSave: async () => undefined, onChanged: noop, onOpenPipeline: noop })), /apps? attached/);
});

test('the browser card offers sign-in and sign-out in plain words', () => {
  const page = html(createElement(BrowserCard, { botId: 'b1', botTitle: 'Mailer', initial: { profile_exists: true, size_bytes: 2048 }, onChanged: noop }));
  assert.match(page, /Websites it is signed in to/);
  assert.match(page, /This bot has its own browser with saved logins · 2 KB\./);
  assert.match(page, /Sign in as this bot/);
  assert.match(page, /Site to sign in to/);
  assert.match(page, /Sign the bot out everywhere/);
  assert.doesNotMatch(page, /I&#x27;m done signing in/, 'the finish button only appears during a sign-in');
  const none = html(createElement(BrowserCard, { botId: 'b1', botTitle: 'Mailer', initial: { profile_exists: false }, onChanged: noop }));
  assert.match(none, /no browser logins yet/);
  assert.doesNotMatch(none, /Sign the bot out everywhere/);
});

test('a sign-in in progress shows the session where the server said, plus the finish button', () => {
  const win = (globalThis as unknown as { window: { sessionStorage: Storage } }).window;
  const withPending = (target: unknown) => {
    win.sessionStorage = { ...storage, getItem: () => JSON.stringify({ sessionId: 's1', url: 'https://mail.example.com/', target }) } as Storage;
    try { return html(createElement(BrowserCard, { botId: 'b1', botTitle: 'Mailer', initial: { profile_exists: false }, onChanged: noop })); } finally { win.sessionStorage = storage; }
  };
  const route = withPending({ kind: 'route', path: '/browser' });
  assert.match(route, /Signing in to https:\/\/mail\.example\.com\//);
  assert.match(route, /href="\/browser"/);
  assert.match(route, /target="_blank"/);
  assert.match(route, /rel="noopener noreferrer"/);
  assert.match(route, /I&#x27;m done signing in/);
  assert.doesNotMatch(route, /Site to sign in to/, 'the URL form is replaced while a session is open');
  assert.match(withPending({ kind: 'event', name: 'cloudcli:show-browser', detail: {} }), /Show the browser session/);
  assert.match(withPending({ kind: 'instructions', text: 'Open the Browser panel; the session named Mailer is yours to drive.' }), /the session named Mailer is yours to drive/);
});
