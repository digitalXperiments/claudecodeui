import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTONOMY_CHOICES, UNKNOWN_VIEW_INSTRUCTIONS, abilitiesChips, appsHeadline, autonomyLabel, autonomySummary, browserErrorMessage,
  browserStatusLine, countLabel, enforcementLine, formatBytes, isUnrestrictedConfirmation, mergeToolPolicy, needsTypedConfirmation,
  normalizeAutonomy, normalizePlain, normalizeSignInUrl, parseAbilitiesFocus, pendingSignIn, permissionModeReason, permissionModeWords,
  plainSections, prettyServerName, resolveViewHint, showProviderPermissionMode, toolCountsLabel,
  SIGN_IN_EXPIRED_MESSAGE, SIGN_IN_WARN_MS, signInCountdown,
} from './abilitiesModel';

test('the three autonomy levels carry the exact plain-language meaning', () => {
  assert.deepEqual(AUTONOMY_CHOICES.map((choice) => choice.value), ['careful', 'trusted', 'unrestricted']);
  const [careful, trusted, unrestricted] = AUTONOMY_CHOICES;
  assert.match(careful.meaning, /Reads, drafts and works in its own folder/);
  assert.match(careful.meaning, /Asks you before sending, publishing, deleting, buying or working outside its folder/);
  assert.match(trusted.meaning, /Also sends, publishes, deletes and works outside its folder on its own/);
  assert.match(trusted.meaning, /still asks right after it has read outside content \(emails, web pages\)/);
  assert.match(trusted.meaning, /never touches your passwords or login files/);
  assert.match(unrestricted.meaning, /No gate at all/);
  assert.match(unrestricted.meaning, /"bypass"/);
  assert.match(unrestricted.meaning, /read nothing from outside/);
  assert.equal(unrestricted.tone, 'danger');
});

test('only Unrestricted needs the word typed, and the check is forgiving about case and spaces', () => {
  assert.equal(needsTypedConfirmation('careful'), false);
  assert.equal(needsTypedConfirmation('trusted'), false);
  assert.equal(needsTypedConfirmation('unrestricted'), true);
  assert.equal(isUnrestrictedConfirmation('unrestricted'), true);
  assert.equal(isUnrestrictedConfirmation('  Unrestricted '), true);
  assert.equal(isUnrestrictedConfirmation('unrestrict'), false);
  assert.equal(isUnrestrictedConfirmation(''), false);
});

test('normalizeAutonomy falls back to Careful and the summary matches the level', () => {
  assert.equal(normalizeAutonomy(undefined), 'careful');
  assert.equal(normalizeAutonomy('nonsense'), 'careful');
  assert.equal(normalizeAutonomy('trusted'), 'trusted');
  assert.equal(autonomySummary('careful'), 'This bot can read and draft on its own; it will ask before sending, deleting or buying.');
  assert.match(autonomySummary('trusted'), /still ask right after it has read outside content/);
  assert.match(autonomySummary('unrestricted'), /Nothing will check this bot/);
  assert.match(autonomyLabel('careful'), /^Careful/);
  assert.match(autonomyLabel('unrestricted'), /no gate/);
});

test('enforcement is one friendly line per level', () => {
  assert.equal(enforcementLine('claude', 'enforced'), 'Claude is fully controlled by the gate.');
  assert.match(enforcementLine('codex', 'advisory'), /Codex is only partly controlled/);
  assert.match(enforcementLine('claude', 'off'), /no gate/);
  assert.match(enforcementLine('claude', null), /Checking/);
});

test('the raw provider permission mode shows only when it matters', () => {
  assert.equal(showProviderPermissionMode('careful', 'enforced'), false);
  assert.equal(showProviderPermissionMode('trusted', 'enforced'), false);
  assert.equal(showProviderPermissionMode('careful', null), false);
  assert.equal(showProviderPermissionMode('careful', 'advisory'), true);
  assert.equal(showProviderPermissionMode('unrestricted', 'enforced'), true);
  assert.equal(showProviderPermissionMode('unrestricted', null), true);
  assert.equal(showProviderPermissionMode('careful', 'off'), true);
  assert.equal(permissionModeReason('careful', 'enforced', 'claude'), null);
  assert.match(permissionModeReason('unrestricted', 'off', 'claude') ?? '', /no gate/);
  assert.match(permissionModeReason('careful', 'advisory', 'codex') ?? '', /Codex can use tools the gate cannot see/);
  assert.match(permissionModeWords('bypassPermissions'), /skips its own questions/);
  assert.match(permissionModeWords('plan'), /Read-only/);
  assert.equal(permissionModeWords('weird'), 'Set to weird.');
});

test('plain lists are always three sections in order, tolerate garbage, and have friendly empty states', () => {
  const sections = plainSections({ canDoAlone: ['Read files', ' ', 7], asksFirst: ['Send email'], neverDoes: [] });
  assert.deepEqual(sections.map((section) => section.key), ['canDoAlone', 'asksFirst', 'neverDoes']);
  assert.deepEqual(sections.map((section) => section.title), ['Can do alone', 'Asks you first', 'Never does']);
  assert.deepEqual(sections[0].items, ['Read files']);
  assert.equal(sections[2].items.length, 0);
  assert.match(sections[2].empty, /Nothing is blocked/);
  assert.deepEqual(normalizePlain(null), { canDoAlone: [], asksFirst: [], neverDoes: [] });
  assert.equal(plainSections(undefined).length, 3);
});

test('apps: counts read in plain words and the headline says the bot can use only these', () => {
  assert.equal(toolCountsLabel({ allow: 5, ask: 2, deny: 1 }), '5 allowed · 2 ask first · 1 blocked');
  assert.equal(toolCountsLabel({ allow: 0, ask: 3, deny: 0 }), '3 ask first');
  assert.match(toolCountsLabel({ allow: 0, ask: 0, deny: 0 }), /default rules/);
  assert.match(toolCountsLabel(null), /default rules/);
  assert.match(appsHeadline(0), /cannot use any outside app/);
  assert.match(appsHeadline(1), /^1 app attached\. The bot can use only these/);
  assert.match(appsHeadline(3), /^3 apps attached/);
  assert.equal(prettyServerName('claude.ai Gmail'), 'Gmail');
  assert.equal(prettyServerName('jira-cloud'), 'Jira Cloud');
});

test('merging a tool policy keeps unrelated servers, drops removed ones and takes the edited ones', () => {
  const saved = { gmail: { send: 'ask' as const }, slack: { post: 'allow' as const }, old: { x: 'deny' as const } };
  const draft = { gmail: { send: 'deny' as const }, jira: { create: 'ask' as const } };
  assert.deepEqual(mergeToolPolicy(saved, draft, ['gmail', 'slack', 'jira']), { gmail: { send: 'deny' }, slack: { post: 'allow' }, jira: { create: 'ask' } });
  assert.deepEqual(mergeToolPolicy(undefined, {}, ['gmail']), {});
});

test('summary chips use live counts and say plainly when there are no logins', () => {
  assert.deepEqual(abilitiesChips({ autonomy: 'trusted', apps: 1, skills: 2, spaces: 0, logins: 0, browserProfile: false }), ['Autonomy: Trusted', '1 app', '2 skills', '0 spaces', 'No logins yet']);
  assert.equal(abilitiesChips({ autonomy: 'careful', apps: 0, skills: 0, spaces: 1, logins: 2, browserProfile: true })[4], '2 saved keys · browser logins');
  assert.equal(countLabel(1, 'space'), '1 space');
});

test('browser status reads in plain words', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  assert.equal(browserStatusLine(null), 'This bot has no browser logins yet.');
  assert.equal(browserStatusLine({ profile_exists: false }), 'This bot has no browser logins yet.');
  assert.equal(
    browserStatusLine({ profile_exists: true, size_bytes: 5 * 1024 * 1024, last_used_at: '2026-10-01T10:00:00Z', signed_in_sites: ['mail.example.com'] }, now),
    'This bot has its own browser with saved logins · signed in to mail.example.com · 5 MB · used 2 h ago.',
  );
  assert.match(browserStatusLine({ profile_exists: true, signed_in_sites: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'] }, now), /and 2 more/);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(undefined), '');
  assert.equal(formatBytes(-1), '');
});

test('sign-in URLs are cleaned and only web addresses pass', () => {
  assert.deepEqual(normalizeSignInUrl('mail.example.com'), { url: 'https://mail.example.com/' });
  assert.deepEqual(normalizeSignInUrl(' https://a.example.com/login?x=1 '), { url: 'https://a.example.com/login?x=1' });
  assert.deepEqual(normalizeSignInUrl('http://localhost:3000/'), { url: 'http://localhost:3000/' });
  for (const bad of ['', '   ', 'javascript:alert(1)', 'file:///etc/passwd', 'nodots', 'ftp://a.b/']) assert.ok('error' in normalizeSignInUrl(bad), bad);
});

test('a 409 gets a friendly sentence, other errors keep their own message', () => {
  const busy = Object.assign(new Error('Conflict'), { status: 409 });
  assert.match(browserErrorMessage(busy, 'sign-in'), /running right now, or its browser is in use/);
  assert.match(browserErrorMessage(busy, 'sign-out'), /Wait for it to finish/);
  assert.match(browserErrorMessage(busy, 'finish'), /no longer open/);
  assert.equal(browserErrorMessage(new Error('Boom'), 'sign-in'), 'Boom');
  assert.equal(browserErrorMessage('x', 'sign-out'), 'Could not sign the bot out.');
  assert.equal(browserErrorMessage(null, 'finish'), 'Could not finish signing in.');
});

test('a viewHint is followed when it is a client route or a named event, otherwise it becomes instructions', () => {
  assert.deepEqual(resolveViewHint('/bots/browser?s=1', 'Mailer'), { kind: 'route', path: '/bots/browser?s=1' });
  assert.deepEqual(resolveViewHint({ route: '/browser' }, 'Mailer'), { kind: 'route', path: '/browser' });
  assert.deepEqual(resolveViewHint({ path: ' /browser ' }, 'Mailer'), { kind: 'route', path: '/browser' });
  assert.deepEqual(resolveViewHint({ event: 'cloudcli:show-browser', detail: { sessionId: 's1' } }, 'Mailer'), { kind: 'event', name: 'cloudcli:show-browser', detail: { sessionId: 's1' } });
  assert.deepEqual(resolveViewHint({ instructions: 'Use the Browser tab.' }, 'Mailer'), { kind: 'instructions', text: 'Use the Browser tab.' });
  assert.deepEqual(resolveViewHint('Open the Browser tab and pick the session', 'Mailer'), { kind: 'instructions', text: 'Open the Browser tab and pick the session' });
});

test('an unknown, malformed or unsafe viewHint falls back to the standard instructions with the bot named', () => {
  const expected = { kind: 'instructions', text: UNKNOWN_VIEW_INSTRUCTIONS('Mailer') };
  assert.match(expected.text, /Open the Browser panel; the session named Mailer is yours to drive/);
  for (const hint of [null, undefined, {}, { panel: 'browser' }, '', 'browser', '//evil.example.com/x', 'https://evil.example.com', { route: '//evil.example.com' }, { route: 'javascript:alert(1)' }, { event: 'bad event name' }, { event: '' }]) {
    assert.deepEqual(resolveViewHint(hint as never, 'Mailer'), expected, JSON.stringify(hint));
  }
  assert.match(UNKNOWN_VIEW_INSTRUCTIONS(''), /session named this bot/);
});

test('pendingSignIn keeps the session id, the site and where to show it', () => {
  assert.deepEqual(pendingSignIn({ sessionId: 's1', viewHint: '/b' }, 'https://a.b/', 'Mailer'), { sessionId: 's1', url: 'https://a.b/', target: { kind: 'route', path: '/b' }, expiresAt: null });
  assert.equal(pendingSignIn({ sessionId: 's1' }, 'https://a.b/', 'Mailer').target.kind, 'instructions');
});

test('deep links pick a section, or a skill to open', () => {
  assert.deepEqual(parseAbilitiesFocus('skills'), { section: 'skills', skill: null });
  assert.deepEqual(parseAbilitiesFocus('skill:daily-brief'), { section: 'skills', skill: 'daily-brief' });
  assert.deepEqual(parseAbilitiesFocus('accounts'), { section: 'accounts', skill: null });
  assert.deepEqual(parseAbilitiesFocus('skill:'), { section: 'skills', skill: null });
  assert.deepEqual(parseAbilitiesFocus('propose'), { section: null, skill: null });
  assert.deepEqual(parseAbilitiesFocus(null), { section: null, skill: null });
});

test('resolveViewHint embeds the server browser_panel hint inline, rejects odd ids', () => {
  assert.deepEqual(resolveViewHint({ kind: 'browser_panel', tab: 'browser', session_id: 'sess_01ABC' } as never, 'Bot'), { kind: 'embed', sessionId: 'sess_01ABC' });
  assert.equal(resolveViewHint({ kind: 'browser_panel', session_id: '../../x' } as never, 'Bot').kind, 'instructions');
});

test('signInCountdown: minutes left, a warning under five minutes, expired at zero, nothing without an expiry', () => {
  const now = Date.parse('2026-10-01T10:00:00.000Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(signInCountdown(null, now), null);
  assert.equal(signInCountdown('not a date', now), null);
  const plenty = signInCountdown(at(27 * 60_000 + 5_000), now)!;
  assert.deepEqual([plenty.label, plenty.low, plenty.expired], ['27:05 left', false, false]);
  const low = signInCountdown(at(SIGN_IN_WARN_MS - 1_000), now)!;
  assert.deepEqual([low.label, low.low, low.expired], ['4:59 left', true, false]);
  assert.equal(signInCountdown(at(SIGN_IN_WARN_MS), now)!.low, false, 'exactly five minutes is not yet low');
  const over = signInCountdown(at(-5_000), now)!;
  assert.deepEqual([over.label, over.low, over.expired, over.remainingMs], ['Time is up', false, true, 0]);
  assert.match(SIGN_IN_EXPIRED_MESSAGE, /closed after 30 minutes/);
  assert.match(SIGN_IN_EXPIRED_MESSAGE, /sign in again/);
});

test('extend errors read plainly, and a started sign-in keeps the server expiry', () => {
  assert.match(browserErrorMessage({ status: 409 }, 'extend'), /2 hour limit/);
  assert.equal(browserErrorMessage({ status: 404 }, 'extend'), SIGN_IN_EXPIRED_MESSAGE);
  assert.equal(browserErrorMessage(new Error(''), 'extend'), 'Could not add more time.');
  const pending = pendingSignIn({ sessionId: 's1', viewHint: null, expiresAt: '2026-10-01T10:30:00.000Z' }, 'https://x.com', 'Bot');
  assert.equal(pending.expiresAt, '2026-10-01T10:30:00.000Z');
  assert.equal(pendingSignIn({ sessionId: 's2' }, 'https://x.com', 'Bot').expiresAt, null);
});
