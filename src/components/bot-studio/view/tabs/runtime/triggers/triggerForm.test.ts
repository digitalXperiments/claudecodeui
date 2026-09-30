import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotTrigger } from '../../../../types/botRuntime';

import {
  configFromDraft,
  describeEvent,
  draftFromTrigger,
  emptyDraft,
  formatEvery,
  fromSeconds,
  mergeConfig,
  readCompiledSchedule,
  splitHeaders,
  summarizeTrigger,
  tccFolder,
  toSeconds,
  triggerHealth,
  validateDraft,
  webhookUrl,
} from './triggerForm';

const trigger = (kind: string, config: Record<string, unknown>, cursor: Record<string, unknown> = {}): BotTrigger => ({
  trigger_id: 't1', bot_id: 'b1', kind, config, enabled: true, cursor, last_fired_at: null, created_at: '', updated_at: '',
});

test('interval units convert to seconds and back using the largest even unit', () => {
  assert.equal(toSeconds('15', 'minutes'), 900);
  assert.equal(toSeconds('2', 'hours'), 7200);
  assert.deepEqual(fromSeconds(86_400), { value: '1', unit: 'days' });
  assert.deepEqual(fromSeconds(5400), { value: '90', unit: 'minutes' });
  assert.deepEqual(fromSeconds(0), { value: '', unit: 'minutes' });
  assert.equal(formatEvery(3600), '1 hour');
  assert.equal(formatEvery(900), '15 minutes');
  assert.ok(Number.isNaN(toSeconds('abc', 'minutes')));
});

test('validateDraft mirrors the server rules per kind', () => {
  const d = emptyDraft('cron');
  assert.equal(validateDraft(d), null);
  assert.match(validateDraft({ ...d, cron: '' }) ?? '', /cron expression/);
  assert.match(validateDraft({ ...d, cron: '0 9 * *' }) ?? '', /five cron fields/);
  assert.match(validateDraft({ ...emptyDraft('nl_schedule'), text: ' ' }) ?? '', /Describe the schedule/);
  assert.equal(validateDraft({ ...emptyDraft('nl_schedule'), text: 'weekdays at 9am' }), null);
  assert.match(validateDraft({ ...emptyDraft('interval'), everyValue: '0.5' }) ?? '', /at least 1 minute/);
  assert.equal(validateDraft({ ...emptyDraft('interval'), everyValue: '1' }), null);
  assert.match(validateDraft(emptyDraft('webhook')) ?? '', /secret/);
  assert.equal(validateDraft({ ...emptyDraft('webhook'), secretRef: 'HOOK' }), null);
  assert.match(validateDraft({ ...emptyDraft('run_completed'), coalesceMs: '-1' }) ?? '', /Coalesce/);
  assert.match(validateDraft({ ...emptyDraft('run_completed'), coalesceMs: '700000' }) ?? '', /Coalesce/);
  assert.equal(validateDraft({ ...emptyDraft('run_completed'), coalesceMs: '2000' }), null);
});

test('watch adapters validate their own fields', () => {
  const watch = emptyDraft('watch');
  assert.match(validateDraft({ ...watch, adapter: 'rss', url: 'ftp://x' }) ?? '', /feed URL/);
  assert.equal(validateDraft({ ...watch, adapter: 'rss', url: 'https://example.com/feed.xml' }), null);
  assert.match(validateDraft({ ...watch, adapter: 'directory', path: '~/Documents/inbox' }) ?? '', /Documents/);
  assert.match(validateDraft({ ...watch, adapter: 'directory', path: '/Users/ram/Downloads' }) ?? '', /Downloads/);
  assert.equal(validateDraft({ ...watch, adapter: 'directory', path: '~/watched' }), null);
  assert.match(validateDraft({ ...watch, adapter: 'directory', path: '~/w', pattern: '(' }) ?? '', /regular expression/);
  assert.match(validateDraft({ ...watch, adapter: 'github', repo: 'nope' }) ?? '', /owner\/name/);
  assert.equal(validateDraft({ ...watch, adapter: 'github', repo: 'acme/app' }), null);
  assert.match(validateDraft({ ...watch, adapter: 'github', repo: 'acme/app', what: [] }) ?? '', /at least one/);
  assert.match(validateDraft({ ...watch, adapter: 'http_json', url: 'https://x.io/api' }) ?? '', /id field/);
  assert.match(validateDraft({ ...watch, adapter: 'http_json', url: 'https://x.io/api', idField: 'id', headerName: 'Authorization' }) ?? '', /header name and its secret/);
  assert.equal(validateDraft({ ...watch, adapter: 'http_json', url: 'https://x.io/api', idField: 'id' }), null);
  assert.match(validateDraft({ ...watch, adapter: 'rss', url: 'https://a.b', watchIntervalValue: '0.5' }) ?? '', /Poll interval/);
});

test('tccFolder detects protected folders under ~ and /Users', () => {
  assert.equal(tccFolder('~/Desktop/x'), 'Desktop');
  assert.equal(tccFolder('/Users/ram/documents'), 'Documents');
  assert.equal(tccFolder('/Users/ram/Development/docs'), null);
  assert.equal(tccFolder('~/DocumentsArchive'), null);
});

test('configFromDraft emits only what the kind needs and omits blanks', () => {
  assert.deepEqual(configFromDraft({ ...emptyDraft('cron'), cron: ' 0 9 * * * ', timezone: 'Asia/Dubai' }), { cron: '0 9 * * *', timezone: 'Asia/Dubai' });
  assert.deepEqual(configFromDraft({ ...emptyDraft('interval'), everyValue: '2', everyUnit: 'hours' }), { every_s: 7200 });
  assert.deepEqual(configFromDraft({ ...emptyDraft('webhook'), secretRef: 'HOOK' }), { secret_ref: 'HOOK' });
  assert.deepEqual(
    configFromDraft({ ...emptyDraft('run_completed'), status: 'failed', allowBotOrigin: true, coalesceMs: '1000' }),
    { status: 'failed', allow_bot_origin: true, coalesce_ms: 1000 },
  );
  assert.deepEqual(configFromDraft(emptyDraft('kanban_event')), {});
  assert.deepEqual(
    configFromDraft({ ...emptyDraft('watch'), adapter: 'github', repo: 'acme/app', what: ['issues'], watchIntervalValue: '10' }),
    { adapter: 'github', interval_s: 600, what: ['issues'], repo: 'acme/app' },
  );
});

test('http_json builds a secret header and keeps unrelated headers', () => {
  const draft = {
    ...emptyDraft('watch'), adapter: 'http_json' as const, url: 'https://x.io/api', idField: 'id', itemsPath: 'data.items',
    headerName: 'Authorization', headerSecret: 'API_TOKEN', headerPrefix: 'Bearer ' as const, extraHeaders: { 'X-Team': 'eng' },
  };
  const config = configFromDraft(draft);
  assert.deepEqual(config.headers, { 'X-Team': 'eng', Authorization: 'Bearer ${secret:API_TOKEN}' });
  assert.deepEqual(splitHeaders(config.headers), { name: 'Authorization', secret: 'API_TOKEN', prefix: 'Bearer ', extra: { 'X-Team': 'eng' } });
  const round = draftFromTrigger(trigger('watch', config));
  assert.equal(round.headerSecret, 'API_TOKEN');
  assert.equal(round.headerPrefix, 'Bearer ');
  assert.deepEqual(round.extraHeaders, { 'X-Team': 'eng' });
});

test('draftFromTrigger round-trips and mergeConfig preserves unmanaged keys', () => {
  const original = { cron: '0 9 * * *', timezone: 'UTC', mirrored_from: 'schedule_cron', coalesce_ms: 1000 };
  const draft = draftFromTrigger(trigger('cron', original));
  assert.equal(draft.cron, '0 9 * * *');
  assert.equal(draft.coalesceMs, '1000');
  assert.deepEqual(mergeConfig(original, { ...draft, timezone: '', coalesceMs: '' }), { cron: '0 9 * * *', mirrored_from: 'schedule_cron' });
  const interval = draftFromTrigger(trigger('interval', { every_s: 5400 }));
  assert.equal(interval.everyValue, '90');
  assert.deepEqual(configFromDraft(interval), { every_s: 5400 });
});

test('summarizeTrigger gives a one-line description per kind', () => {
  assert.equal(summarizeTrigger(trigger('cron', { cron: '0 9 * * 1-5', timezone: 'UTC' })), '0 9 * * 1-5 (UTC)');
  assert.match(summarizeTrigger(trigger('cron', { cron: '0 9 * * *', mirrored_from: 'schedule_cron' })), /mirrors the bot schedule/);
  assert.equal(
    summarizeTrigger(trigger('nl_schedule', { text: 'weekdays at 9', compiled: { description: 'Weekdays at 09:00' } })),
    'weekdays at 9 → Weekdays at 09:00',
  );
  assert.equal(summarizeTrigger(trigger('interval', { every_s: 900 })), 'Every 15 minutes');
  assert.equal(summarizeTrigger(trigger('webhook', { secret_ref: 'HOOK' })), 'Signed POST · secret HOOK');
  assert.equal(summarizeTrigger(trigger('run_completed', { status: 'failed', allow_bot_origin: true })), 'Any run completes · status failed · includes bot runs');
  assert.equal(summarizeTrigger(trigger('kanban_event', {})), 'Board event');
  assert.equal(summarizeTrigger(trigger('interrupt_created', { severity: 'high' })), 'Interrupt raised · severity high');
  assert.equal(summarizeTrigger(trigger('watch', { adapter: 'rss', url: 'https://a.b/feed', interval_s: 300 })), 'RSS https://a.b/feed · every 5 minutes');
  assert.equal(summarizeTrigger(trigger('watch', { adapter: 'github', repo: 'a/b', what: ['issues'], interval_s: 600 })), 'GitHub a/b (issues) · every 10 minutes');
  assert.equal(summarizeTrigger(trigger('manual', {})), 'Run now / wake');
});

test('triggerHealth reads the watch cursor', () => {
  assert.deepEqual(triggerHealth(trigger('watch', {}, {})), { error: null, errorAt: null, polledAt: null });
  assert.deepEqual(
    triggerHealth(trigger('watch', {}, { last_error: 'HTTP 404', last_error_at: 'a', last_polled_at: 'b' })),
    { error: 'HTTP 404', errorAt: 'a', polledAt: 'b' },
  );
  assert.equal(triggerHealth(trigger('watch', {}, { last_error: null })).error, null);
});

test('webhookUrl builds the public endpoint', () => {
  assert.equal(webhookUrl('abc'), '/api/hooks/bots/abc');
  assert.equal(webhookUrl('a b', 'https://host.example/'), 'https://host.example/api/hooks/bots/a%20b');
});

test('readCompiledSchedule narrows the compile response and lists exclusions', () => {
  assert.equal(readCompiledSchedule({ success: true }), null);
  assert.deepEqual(
    readCompiledSchedule({ success: true, cron: '0 9 * * 1-5', description: 'Weekdays at 09:00', timezone: 'UTC', exclusions: { weekdays: [5], dates: ['2026-12-25'] } }),
    { cron: '0 9 * * 1-5', description: 'Weekdays at 09:00', timezone: 'UTC', exclusions: ['Skips Friday', 'Skips 2026-12-25'] },
  );
  assert.deepEqual(readCompiledSchedule({ cron: '* * * * *', exclusions: {} })?.exclusions, []);
});

test('describeEvent prefers a payload title and labels schedule events', () => {
  assert.equal(describeEvent({ kind: 'schedule', source: 'trigger:cron', payload: {} }), 'Scheduled (cron)');
  assert.equal(describeEvent({ kind: 'run_completed', source: 'automation:run_completed', payload: { status: 'failed' } }), 'run completed · failed');
  assert.equal(describeEvent({ kind: 'manual', source: 'operator', payload: { note: 'hello' } }), 'manual · hello');
});
