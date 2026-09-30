import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { rm } from 'node:fs/promises';

import express from 'express';

import { automationService } from '@/modules/automation/index.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { interruptsDb } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { runService } from '@/modules/runs/index.js';
import { configureSecretsKeyDir, secretsService } from '@/modules/secrets/index.js';
import { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
import {
  botHooksPublicRouter,
  botSignals,
  botTriggers,
  botTriggersRouter,
  fireScheduledTrigger,
  handleAutomationEvent,
  pollWatchTrigger,
  registerWatchAdapter,
  scanCommitments,
  startAutomationBridge,
  startSignals,
  stopAutomationBridge,
  stopSignals,
  clampCoalesceMs,
  getScheduledTriggerCount,
} from '@/modules/bots/signals/index.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
import { botTriggersDb } from '@/modules/bots/signals/bot-triggers.repository.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withBots(run: (ctx: { botId: string; otherBotId: string }) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousKey = process.env.CLOUDCLI_SECRETS_KEY;
  const scratch = await makeScratchDir('bots-signals-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_SECRETS_KEY = randomBytes(32).toString('base64');
  configureSecretsKeyDir(path.join(scratch, 'key'));
  await initializeDatabase();
  try {
    const bot = missionControlDb.createSection({ title: 'Signal bot', produce_prompt: 'Go' });
    const other = missionControlDb.createSection({ title: 'Other bot', produce_prompt: 'Go' });
    await run({ botId: bot.section_id, otherBotId: other.section_id });
  } finally {
    stopSignals();
    stopAutomationBridge();
    botSignals.setWakeHandler(null);
    botSignals.cancelWakes();
    closeConnection();
    configureSecretsKeyDir(null);
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousKey === undefined) delete process.env.CLOUDCLI_SECRETS_KEY;
    else process.env.CLOUDCLI_SECRETS_KEY = previousKey;
    await rm(scratch, { recursive: true, force: true });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const base = (botId: string, extra: Partial<Parameters<typeof botSignals.ingest>[0]> = {}) => ({
  botId,
  source: 'test',
  kind: 'note',
  trust: 'internal' as const,
  payload: {},
  ...extra,
});

test('ingest dedupes on (bot, dedupe_key) and only the first insert is broadcast/woken', async () => {
  await withBots(({ botId, otherBotId }) => {
    const wakes: string[] = [];
    botSignals.setWakeHandler((id) => wakes.push(id));
    const a = botSignals.ingest(base(botId, { dedupeKey: 'k1', payload: { n: 1 } }));
    const b = botSignals.ingest(base(botId, { dedupeKey: 'k1', payload: { n: 2 } }));
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.event.event_id, a.event.event_id);
    assert.deepEqual(b.event.payload, { n: 1 });
    // Same key for a different bot is a distinct event; null keys never dedupe.
    assert.equal(botSignals.ingest(base(otherBotId, { dedupeKey: 'k1' })).duplicate, false);
    assert.equal(botSignals.ingest(base(botId)).duplicate, false);
    assert.equal(botSignals.ingest(base(botId)).duplicate, false);
    assert.equal(botEventsDb.countQueued(botId), 3);
    botSignals.flushWakes();
    assert.deepEqual([...wakes].sort(), [botId, otherBotId].sort());
  });
});

test('ingest throws for an unknown bot and records events for disabled bots as dropped without waking', async () => {
  await withBots(({ botId }) => {
    const wakes: string[] = [];
    botSignals.setWakeHandler((id) => wakes.push(id));
    assert.throws(() => botSignals.ingest(base('nope')), /Unknown bot/);
    missionControlDb.updateSection(botId, { enabled: false });
    const { event } = botSignals.ingest(base(botId, { dedupeKey: 'd1' }));
    assert.equal(event.status, 'dropped');
    assert.equal(event.payload._drop_reason, 'bot_disabled');
    assert.equal(botEventsDb.countQueued(botId), 0);
    assert.equal(botSignals.hasPendingWake(botId), false);
    botSignals.flushWakes();
    assert.deepEqual(wakes, []);
    assert.deepEqual(botSignals.claimBatch(botId, { max: 10 }), []);
  });
});

test('wake is debounced per bot: a burst collapses into one wake using the trigger coalesce_ms', async () => {
  await withBots(async ({ botId, otherBotId }) => {
    const wakes: string[] = [];
    botSignals.setWakeHandler((id) => wakes.push(id));
    const trigger = botTriggers.create({ botId, kind: 'manual', config: { coalesce_ms: 60 } });
    const fast = botTriggers.create({ botId: otherBotId, kind: 'manual', config: { coalesce_ms: 0 } });
    for (let i = 0; i < 5; i += 1) {
      botSignals.ingest(base(botId, { triggerId: trigger.trigger_id, dedupeKey: `e${i}` }));
      await sleep(10);
    }
    botSignals.ingest(base(otherBotId, { triggerId: fast.trigger_id }));
    await sleep(25);
    assert.deepEqual(wakes, [otherBotId]); // zero-delay bot woke, the burst is still coalescing
    assert.equal(botSignals.hasPendingWake(botId), true);
    await sleep(120);
    assert.deepEqual(wakes.filter((id) => id === botId), [botId]);
    const batch = botSignals.claimBatch(botId, { max: 50, coalesceMs: 10_000 });
    assert.equal(batch.length, 5);
    assert.ok(batch.every((e) => e.status === 'claimed'));
  });
});

test('operator events do not wait for a long default debounce and the coalesce clamp holds', async () => {
  assert.equal(clampCoalesceMs(-5), 0);
  assert.equal(clampCoalesceMs(9_999_999), 600_000);
  assert.equal(clampCoalesceMs('250'), 250);
  assert.equal(clampCoalesceMs('abc'), 5_000);
  assert.equal(clampCoalesceMs(undefined, 123), 123);
  await withBots(async ({ botId }) => {
    const wakes: string[] = [];
    botSignals.setWakeHandler((id) => wakes.push(id));
    const trigger = botTriggers.create({ botId, kind: 'operator_message', config: { coalesce_ms: 600000 } });
    botSignals.ingest(base(botId, { triggerId: trigger.trigger_id, trust: 'operator', kind: 'operator_message' }));
    await sleep(1_150);
    assert.deepEqual(wakes, [botId]);
  });
});

test('claimBatch / markConsumed / markDropped delegate to the event store', async () => {
  await withBots(({ botId }) => {
    const ids = [1, 2, 3].map((n) => botSignals.ingest(base(botId, { dedupeKey: `c${n}` })).event.event_id);
    const claimed = botSignals.claimBatch(botId, { max: 2 });
    assert.equal(claimed.length, 2);
    assert.equal(botSignals.markConsumed([claimed[0].event_id], 'bep_test'), 1);
    assert.equal(botSignals.markDropped([ids[2]], 'noise'), 1);
    assert.equal(botEventsDb.get(claimed[0].event_id)?.status, 'consumed');
    assert.equal(botEventsDb.get(claimed[0].event_id)?.episode_id, 'bep_test');
    assert.equal(botEventsDb.get(ids[2])?.payload._drop_reason, 'noise');
    botSignals.cancelWakes();
  });
});

test('commitment scanner fires due open commitments once, skips future ones and disabled bots', async () => {
  await withBots(({ botId, otherBotId }) => {
    botSignals.setWakeHandler(() => {});
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const due = botCommitmentsDb.create({ botId, description: 'Chase the vendor', dueAt: past, waitingOn: 'vendor' });
    const later = botCommitmentsDb.create({ botId, description: 'Later', dueAt: future });
    const done = botCommitmentsDb.create({ botId, description: 'Already done', dueAt: past });
    botCommitmentsDb.complete(done.commitment_id);
    missionControlDb.updateSection(otherBotId, { enabled: false });
    const parked = botCommitmentsDb.create({ botId: otherBotId, description: 'Parked', dueAt: past });

    assert.equal(scanCommitments(), 1);
    assert.equal(botCommitmentsDb.get(due.commitment_id)?.status, 'fired');
    assert.equal(botCommitmentsDb.get(later.commitment_id)?.status, 'open');
    assert.equal(botCommitmentsDb.get(parked.commitment_id)?.status, 'open');

    const events = botEventsDb.listRecent(botId);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'commitment_due');
    assert.equal(events[0].trust, 'internal');
    assert.equal(events[0].dedupe_key, `commitment:${due.commitment_id}:${due.due_at}`);
    assert.equal(events[0].payload.commitment_id, due.commitment_id);
    assert.equal(scanCommitments(), 0);
    assert.equal(scanCommitments(new Date(Date.now() + 7_200_000)), 1); // `later` comes due
    botSignals.cancelWakes();
  });
});

test('trigger validation covers every kind and normalizes config', async () => {
  await withBots(({ botId }) => {
    const bad = (kind: string, config: Record<string, unknown> | undefined, pattern: RegExp) =>
      assert.throws(() => botTriggers.create({ botId, kind, config }), pattern);

    bad('nonsense', {}, /Unknown trigger kind/);
    bad('cron', {}, /needs config\.cron/);
    bad('cron', { cron: 'not a cron' }, /Invalid cron/);
    bad('cron', { cron: '0 9 * * *', timezone: 'Mars/Base' }, /Unknown timezone/);
    bad('interval', { every_s: 30 }, /at least 60/);
    bad('interval', {}, /every_s is required/);
    bad('nl_schedule', {}, /needs config\.text/);
    bad('nl_schedule', { text: 'whenever' }, /Could not understand/);
    bad('webhook', {}, /secret_ref/);
    bad('watch', {}, /config\.adapter/);
    bad('watch', { adapter: 'nope' }, /Unknown watch adapter/);
    bad('watch', { adapter: 'rss', url: 'https://x.test/f', interval_s: 10 }, /at least 60/);
    bad('watch', { adapter: 'rss' }, /rss: url is required/);
    bad('watch', { adapter: 'directory', path: `${process.env.HOME}/Downloads` }, /Downloads/);
    bad('watch', { adapter: 'github', repo: 'nope' }, /owner\/name/);
    bad('run_completed', { status: 5 }, /status must be a string/);
    bad('manual', [] as unknown as Record<string, unknown>, /config must be an object/);
    assert.throws(() => botTriggers.create({ botId: 'missing', kind: 'manual' }), /Bot not found/);

    const cron = botTriggers.create({ botId, kind: 'cron', config: { cron: ' 0 9 * * 1-5 ', timezone: 'Asia/Dubai' } });
    assert.equal(cron.config.cron, '0 9 * * 1-5');
    const nl = botTriggers.create({ botId, kind: 'nl_schedule', config: { text: 'weekdays at 9 except fridays' } });
    assert.deepEqual((nl.config.compiled as { exclusions: unknown }).exclusions, { weekdays: [5] });
    const watch = botTriggers.create({ botId, kind: 'watch', config: { adapter: 'rss', url: 'https://x.test/f' } });
    assert.equal(watch.config.interval_s, 300);
    const interval = botTriggers.create({ botId, kind: 'interval', config: { every_s: 90.7, coalesce_ms: 99999999 } });
    assert.equal(interval.config.every_s, 90);
    assert.equal(interval.config.coalesce_ms, 600000);
    for (const kind of ['kanban_event', 'run_completed', 'interrupt_created', 'peer_message', 'ask_bot', 'commitment_due', 'operator_message', 'manual']) {
      assert.equal(botTriggers.create({ botId, kind }).kind, kind);
    }
    assert.equal(botTriggers.create({ botId, kind: 'webhook', config: { secret_ref: 'HOOK' } }).config.secret_ref, 'HOOK');

    const updated = botTriggers.update(cron.trigger_id, { enabled: false });
    assert.equal(updated?.enabled, false);
    assert.throws(() => botTriggers.update(cron.trigger_id, { config: { cron: 'bad' } }), /Invalid cron/);
    assert.equal(botTriggers.update('btr_missing', { enabled: true }), null);
    assert.equal(botTriggers.delete(cron.trigger_id), true);
    assert.equal(botTriggers.delete(cron.trigger_id), false);
  });
});

test('startSignals schedules cron/interval/nl/watch timers, reschedules on change, stops cleanly', async () => {
  await withBots(({ botId }) => {
    const cron = botTriggers.create({ botId, kind: 'cron', config: { cron: '0 9 * * *' } });
    botTriggers.create({ botId, kind: 'interval', config: { every_s: 3600 } });
    botTriggers.create({ botId, kind: 'nl_schedule', config: { text: 'daily at 8' } });
    botTriggers.create({ botId, kind: 'watch', config: { adapter: 'rss', url: 'https://x.test/f' } });
    botTriggers.create({ botId, kind: 'manual' });
    botTriggers.create({ botId, kind: 'cron', config: { cron: '0 10 * * *' }, enabled: false });
    assert.equal(getScheduledTriggerCount(), 0); // nothing before startSignals
    startSignals();
    assert.equal(getScheduledTriggerCount(), 4);
    botTriggers.update(cron.trigger_id, { config: { cron: '0 11 * * *' } });
    assert.equal(getScheduledTriggerCount(), 4);
    botTriggers.delete(cron.trigger_id);
    assert.equal(getScheduledTriggerCount(), 3);
    stopSignals();
    assert.equal(getScheduledTriggerCount(), 0);
  });
});

test('scheduled fires ingest internal events, dedupe per slot, and honour nl_schedule exclusions', async () => {
  await withBots(({ botId }) => {
    botSignals.setWakeHandler(() => {});
    const nl = botTriggers.create({
      botId,
      kind: 'nl_schedule',
      config: { text: 'every weekday at 9 except fridays', timezone: 'UTC' },
    });
    const friday = new Date('2026-09-25T09:00:00Z');
    const thursday = new Date('2026-09-24T09:00:00Z');
    assert.equal(fireScheduledTrigger(nl, friday), false);
    assert.equal(botEventsDb.listRecent(botId).length, 0);
    assert.equal(fireScheduledTrigger(nl, thursday), true);
    assert.equal(fireScheduledTrigger(nl, thursday), true); // same slot: deduped, not a second event
    const events = botEventsDb.listRecent(botId);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'schedule');
    assert.equal(events[0].trust, 'internal');
    assert.equal(events[0].trigger_id, nl.trigger_id);
    assert.ok(botTriggersDb.get(nl.trigger_id)?.last_fired_at);

    const interval = botTriggers.create({ botId, kind: 'interval', config: { every_s: 60 } });
    assert.equal(fireScheduledTrigger(interval, new Date('2026-09-24T09:00:10Z')), true);
    fireScheduledTrigger(interval, new Date('2026-09-24T09:00:40Z'));
    assert.equal(botEventsDb.listRecent(botId).length, 2);
    botSignals.cancelWakes();
  });
});

test('ensureCronTriggerFromSection mirrors schedule_cron idempotently and tracks changes', async () => {
  await withBots(({ botId }) => {
    assert.equal(botTriggers.ensureCronTriggerFromSection({ section_id: botId, schedule_cron: null }), null);
    const first = botTriggers.ensureCronTriggerFromSection({ section_id: botId, schedule_cron: '*/30 * * * *' });
    assert.ok(first);
    assert.equal(first.config.cron, '*/30 * * * *');
    assert.equal(first.config.mirrored_from, 'schedule_cron');
    const again = botTriggers.ensureCronTriggerFromSection({ section_id: botId, schedule_cron: '*/30 * * * *' });
    assert.equal(again?.trigger_id, first.trigger_id);
    assert.equal(botTriggers.list(botId).length, 1);
    const changed = botTriggers.ensureCronTriggerFromSection({ section_id: botId, schedule_cron: '0 7 * * *' });
    assert.equal(changed?.trigger_id, first.trigger_id);
    assert.equal(changed?.config.cron, '0 7 * * *');
    // An invalid schedule never replaces the mirror.
    assert.equal(botTriggers.ensureCronTriggerFromSection({ section_id: botId, schedule_cron: 'garbage' })?.config.cron, '0 7 * * *');
    assert.equal(botTriggers.hasTriggers(botId), true);
  });
});

test('watch trigger poll ingests external events, persists cursor, and records adapter errors without throwing', async () => {
  await withBots(async ({ botId }) => {
    botSignals.setWakeHandler(() => {});
    let mode: 'ok' | 'boom' = 'ok';
    const seenCursors: Array<Record<string, unknown>> = [];
    registerWatchAdapter('fake', {
      validate: (cfg) => (cfg.thing ? null : 'thing is required'),
      async poll(_cfg, cursor) {
        seenCursors.push(cursor);
        if (mode === 'boom') throw new Error('upstream exploded');
        const n = Number(cursor.n ?? 0) + 1;
        return {
          events: [{ source: 'watch:fake', kind: 'watch', dedupeKey: `fake:${n}`, trust: 'external', payload: { n } }],
          cursor: { n },
        };
      },
    });
    assert.throws(() => botTriggers.create({ botId, kind: 'watch', config: { adapter: 'fake' } }), /thing is required/);
    const trigger = botTriggers.create({ botId, kind: 'watch', config: { adapter: 'fake', thing: 1 } });

    assert.deepEqual(await pollWatchTrigger(trigger.trigger_id), { ingested: 1 });
    assert.deepEqual(await pollWatchTrigger(trigger.trigger_id), { ingested: 1 });
    let stored = botTriggersDb.get(trigger.trigger_id)!;
    assert.equal(stored.cursor.n, 2);
    assert.equal(stored.cursor.last_error, null);
    assert.equal(seenCursors[1].n, 1);
    const events = botEventsDb.listRecent(botId);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.trust === 'external' && e.trigger_id === trigger.trigger_id));

    mode = 'boom';
    const failed = await pollWatchTrigger(trigger.trigger_id);
    assert.equal(failed.ingested, 0);
    assert.match(failed.error ?? '', /upstream exploded/);
    stored = botTriggersDb.get(trigger.trigger_id)!;
    assert.match(String(stored.cursor.last_error), /upstream exploded/);
    assert.equal(stored.cursor.n, 2); // cursor preserved across a failure
    mode = 'ok';
    assert.equal((await pollWatchTrigger(trigger.trigger_id)).ingested, 1);
    assert.equal(botTriggersDb.get(trigger.trigger_id)?.cursor.last_error, null);

    assert.match((await pollWatchTrigger('btr_missing')).error ?? '', /not a watch trigger/);
    botSignals.cancelWakes();
  });
});

test('automation sink maps run_completed / kanban_event / interrupt_created / webhook_inbound with filters', async () => {
  await withBots(async ({ botId, otherBotId }) => {
    botSignals.setWakeHandler(() => {});
    const run = botTriggers.create({ botId, kind: 'run_completed', config: { status: 'failed', source: 'chat' } });
    botTriggers.create({ botId: otherBotId, kind: 'run_completed', config: {} });
    botTriggers.create({ botId, kind: 'kanban_event', config: { event: 'task.done' } });
    botTriggers.create({ botId, kind: 'interrupt_created', config: { kind: 'approval_pending' } });
    botTriggers.create({ botId, kind: 'webhook', config: { secret_ref: 'X', source: 'jira' } });
    botTriggers.create({ botId, kind: 'webhook', config: { secret_ref: 'X' } }); // per-bot hook only

    startAutomationBridge();
    // Goes through the real automationService.fire seam.
    await automationService.fire({ type: 'run_completed', payload: { runId: 'run_a', status: 'failed', source: 'chat' } });
    await automationService.fire({ type: 'run_completed', payload: { runId: 'run_b', status: 'succeeded', source: 'chat' } });
    await automationService.fire({ type: 'run_completed', payload: { runId: 'run_c', status: 'failed', source: 'kanban' } });
    await automationService.fire({ type: 'kanban_event', event: 'task.done', payload: { taskId: 't1', title: 'T' } });
    await automationService.fire({ type: 'kanban_event', event: 'task.failed', payload: { taskId: 't2' } });
    await automationService.fire({ type: 'interrupt_created', payload: { interruptId: 'int_1', kind: 'approval_pending' } });
    await automationService.fire({ type: 'interrupt_created', payload: { interruptId: 'int_2', kind: 'permission' } });
    await automationService.fire({ type: 'webhook_inbound', payload: { deliveryId: 'd1', source: 'jira', text: 'hi' } });
    await automationService.fire({ type: 'webhook_inbound', payload: { deliveryId: 'd2', source: 'other' } });
    await automationService.fire({ type: 'cron', payload: {} });

    const mine = botEventsDb.listRecent(botId).map((e) => [e.kind, e.trust, e.dedupe_key]).sort();
    assert.deepEqual(mine, [
      ['interrupt_created', 'internal', 'interrupt:int_1'],
      ['kanban_event', 'internal', 'kanban:t1:task.done'],
      ['run_completed', 'internal', 'run_completed:run_a'],
      ['webhook', 'external', 'webhook_delivery:d1'],
    ]);
    assert.equal(botEventsDb.listRecent(otherBotId).length, 3); // unfiltered bot sees every run_completed
    assert.ok(botTriggersDb.get(run.trigger_id)?.last_fired_at);

    // Replaying the same event is deduped.
    assert.equal(handleAutomationEvent({ type: 'run_completed', payload: { runId: 'run_a', status: 'failed', source: 'chat' } }), 0);
    stopAutomationBridge();
    await automationService.fire({ type: 'kanban_event', event: 'task.done', payload: { taskId: 't9' } });
    assert.equal(botEventsDb.listRecent(botId).length, 4);
    botSignals.cancelWakes();
  });
});

test('automation sink loop guard ignores runs and interrupts of ANY bot unless allow_bot_origin, and a throwing sink never breaks fire', async () => {
  await withBots(async ({ botId, otherBotId }) => {
    botSignals.setWakeHandler(() => {});
    botTriggers.create({ botId, kind: 'run_completed', config: {} });
    botTriggers.create({ botId, kind: 'interrupt_created', config: {} });
    // The other bot opts in to bot-origin events.
    botTriggers.create({ botId: otherBotId, kind: 'run_completed', config: { allow_bot_origin: true } });
    botTriggers.create({ botId: otherBotId, kind: 'interrupt_created', config: { allow_bot_origin: true } });
    const ownRun = runService.create({ source: 'mission_control', meta: { sectionId: botId } });
    const snakeRun = runService.create({ source: 'mission_control', meta: { section_id: botId } });
    const foreignRun = runService.create({ source: 'mission_control', meta: { sectionId: otherBotId } });
    const plainRun = runService.create({ source: 'chat' });
    for (const r of [ownRun, snakeRun, foreignRun, plainRun]) {
      handleAutomationEvent({ type: 'run_completed', payload: { runId: r.run_id, status: 'succeeded', source: r.source } });
    }
    assert.deepEqual(
      botEventsDb.listRecent(botId).map((e) => e.payload.run_id).sort(),
      [plainRun.run_id],
      'a foreign bot\'s run is ignored too (bot-to-bot loops)',
    );
    assert.deepEqual(
      botEventsDb.listRecent(otherBotId).filter((e) => e.kind === 'run_completed').map((e) => e.payload.run_id).sort(),
      [ownRun.run_id, snakeRun.run_id, foreignRun.run_id, plainRun.run_id].sort(),
      'allow_bot_origin opts back in',
    );

    const ownInterrupt = interruptsDb.create({ kind: 'bot_gate', title: 'mine', meta: { botId } });
    const foreignInterrupt = interruptsDb.create({ kind: 'approval_pending', title: 'theirs', meta: { botId: otherBotId } });
    const plainInterrupt = interruptsDb.create({ kind: 'approval_pending', title: 'plain' });
    for (const i of [ownInterrupt, foreignInterrupt, plainInterrupt]) {
      handleAutomationEvent({ type: 'interrupt_created', payload: { interruptId: i.interrupt_id, kind: i.kind } });
    }
    assert.deepEqual(
      botEventsDb.listRecent(botId).filter((e) => e.kind === 'interrupt_created').map((e) => e.payload.interrupt_id).sort(),
      [plainInterrupt.interrupt_id],
    );
    assert.equal(botEventsDb.listRecent(otherBotId).filter((e) => e.kind === 'interrupt_created').length, 3);

    const { configureAutomationEventSink } = await import('@/modules/automation/index.js');
    configureAutomationEventSink(() => {
      throw new Error('sink blew up');
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await automationService.fire({ type: 'manual', payload: {} }), []);
    } finally {
      console.error = originalError;
      configureAutomationEventSink(null);
    }
    botSignals.cancelWakes();
  });
});

// ---- HTTP routes ------------------------------------------------------------------

async function withServer(
  mount: (app: express.Express) => void,
  run: (call: (method: string, urlPath: string, body?: string | Buffer, headers?: Record<string, string>) => Promise<{ status: number; json: any }>) => Promise<void>,
): Promise<void> {
  const app = express();
  mount(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const call = async (method: string, urlPath: string, body?: string | Buffer, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      body: body as string | undefined,
      headers,
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  };
  try {
    await run(call);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const sign = (secret: string, body: string | Buffer) => createHmac('sha256', secret).update(body).digest('hex');

// Same parser config as server/index.js (global JSON parser that stashes rawBody).
const mountLikeServer = (app: express.Express) => {
  app.use(express.json({ limit: '50mb', verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; } }));
  app.use('/api/hooks/bots', botHooksPublicRouter);
  app.use('/api/bots', botTriggersRouter);
  app.use((err: Error & { statusCode?: number; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message });
  });
};

test('per-bot webhook verifies HMAC, enforces the 1MB limit and ingests external events (parser mounted globally)', async () => {
  await withBots(async ({ botId }) => {
    botSignals.setWakeHandler(() => {});
    secretsService.put({ name: 'BOT_HOOK', value: 'whsec_test_value' });
    const trigger = botTriggers.create({ botId, kind: 'webhook', config: { secret_ref: 'BOT_HOOK' } });
    const disabled = botTriggers.create({ botId, kind: 'webhook', config: { secret_ref: 'BOT_HOOK' }, enabled: false });
    const missingSecret = botTriggers.create({ botId, kind: 'webhook', config: { secret_ref: 'NOT_STORED' } });
    const manual = botTriggers.create({ botId, kind: 'manual' });
    await withServer(mountLikeServer, async (call) => {
      const body = JSON.stringify({ hello: 'world' });
      const json = { 'content-type': 'application/json' };

      const ok = await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, body, { ...json, 'x-webhook-signature': sign('whsec_test_value', body), 'x-webhook-id': 'dlv-1' });
      assert.equal(ok.status, 202);
      assert.equal(ok.json.duplicate, false);
      const event = botEventsDb.get(ok.json.event_id)!;
      assert.equal(event.trust, 'external');
      assert.equal(event.kind, 'webhook');
      assert.deepEqual(event.payload.body, { hello: 'world' });
      assert.equal(event.trigger_id, trigger.trigger_id);

      const replay = await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, body, { ...json, 'x-webhook-signature': `sha256=${sign('whsec_test_value', body)}`, 'x-webhook-id': 'dlv-1' });
      assert.equal(replay.status, 202);
      assert.equal(replay.json.duplicate, true);
      assert.equal(replay.json.event_id, ok.json.event_id);

      assert.equal((await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, body, json)).status, 401);
      assert.equal((await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, body, { ...json, 'x-webhook-signature': sign('wrong', body) })).status, 401);
      assert.equal((await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, body, { ...json, 'x-webhook-signature': 'zzzz' })).status, 401);
      // Signature over different bytes (tampered body) fails.
      assert.equal((await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, `${body} `, { ...json, 'x-webhook-signature': sign('whsec_test_value', body) })).status, 401);

      assert.equal((await call('POST', `/api/hooks/bots/${disabled.trigger_id}`, body, json)).status, 404);
      assert.equal((await call('POST', `/api/hooks/bots/${manual.trigger_id}`, body, json)).status, 404);
      assert.equal((await call('POST', '/api/hooks/bots/btr_unknown', body, json)).status, 404);
      assert.equal((await call('POST', `/api/hooks/bots/${missingSecret.trigger_id}`, body, { ...json, 'x-webhook-signature': 'aa' })).status, 503);

      const big = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) });
      const tooLarge = await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, big, { ...json, 'x-webhook-signature': sign('whsec_test_value', big) });
      assert.equal(tooLarge.status, 413);
      assert.equal(botEventsDb.listRecent(botId).length, 1);
    });
    botSignals.cancelWakes();
  });
});

test('per-bot webhook also works when mounted before the global parser and accepts non-JSON bodies', async () => {
  await withBots(async ({ botId }) => {
    botSignals.setWakeHandler(() => {});
    secretsService.put({ name: 'BOT_HOOK2', value: 'another-secret' });
    const trigger = botTriggers.create({ botId, kind: 'webhook', config: { secret_ref: 'BOT_HOOK2' } });
    await withServer(
      (app) => {
        app.use('/api/hooks/bots', botHooksPublicRouter);
        app.use(express.json());
        app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          res.status(err.status ?? 500).json({ error: err.message });
        });
      },
      async (call) => {
        const text = 'plain text payload, not json';
        const ok = await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, text, { 'content-type': 'text/plain', 'x-webhook-signature': sign('another-secret', text) });
        assert.equal(ok.status, 202);
        assert.equal(botEventsDb.get(ok.json.event_id)?.payload.body, text);
        const big = 'y'.repeat(1024 * 1024 + 1);
        const tooLarge = await call('POST', `/api/hooks/bots/${trigger.trigger_id}`, big, { 'content-type': 'text/plain', 'x-webhook-signature': sign('another-secret', big) });
        assert.equal(tooLarge.status, 413);
      },
    );
    botSignals.cancelWakes();
  });
});

test('authenticated router: trigger CRUD, test fire, compile-schedule preview, events and manual wake', async () => {
  await withBots(async ({ botId, otherBotId }) => {
    botSignals.setWakeHandler(() => {});
    await withServer(mountLikeServer, async (call) => {
      const json = { 'content-type': 'application/json' };
      const post = (p: string, b: unknown) => call('POST', p, JSON.stringify(b), json);

      const preview = await post('/api/bots/triggers/compile-schedule', { text: 'weekdays at 9 except fridays', timezone: 'UTC' });
      assert.equal(preview.status, 200);
      assert.equal(preview.json.cron, '0 9 * * 1-5');
      assert.deepEqual(preview.json.exclusions, { weekdays: [5] });
      const badPreview = await post('/api/bots/triggers/compile-schedule', { text: 'soonish' });
      assert.equal(badPreview.status, 400);
      assert.match(badPreview.json.error, /Could not understand/);

      assert.equal((await call('GET', '/api/bots/ghost/triggers')).status, 404);
      const invalid = await post(`/api/bots/${botId}/triggers`, { kind: 'cron', config: { cron: 'x' } });
      assert.equal(invalid.status, 400);
      assert.equal((await post(`/api/bots/${botId}/triggers`, { config: {} })).status, 400);

      const created = await post(`/api/bots/${botId}/triggers`, { kind: 'nl_schedule', config: { text: 'daily at 7' } });
      assert.equal(created.status, 201);
      const id = created.json.trigger.trigger_id as string;
      assert.equal(created.json.trigger.config.compiled.cron, '0 7 * * *');
      assert.equal((await call('GET', `/api/bots/${botId}/triggers`)).json.triggers.length, 1);
      assert.equal((await call('GET', `/api/bots/${otherBotId}/triggers`)).json.triggers.length, 0);

      const patched = await call('PATCH', `/api/bots/${botId}/triggers/${id}`, JSON.stringify({ enabled: false }), json);
      assert.equal(patched.json.trigger.enabled, false);
      assert.equal((await call('PATCH', `/api/bots/${otherBotId}/triggers/${id}`, JSON.stringify({ enabled: true }), json)).status, 404);

      const tested = await post(`/api/bots/${botId}/triggers/${id}/test`, {});
      assert.equal(tested.status, 202);
      assert.equal(tested.json.event.payload.sample, true);
      assert.equal(tested.json.event.kind, 'schedule');

      const wake = await post(`/api/bots/${botId}/wake`, { note: 'please look at the inbox' });
      assert.equal(wake.status, 202);
      assert.equal(wake.json.event.trust, 'operator');
      assert.equal(wake.json.event.kind, 'manual');
      assert.equal(wake.json.event.payload.note, 'please look at the inbox');

      const events = await call('GET', `/api/bots/${botId}/events?limit=1`);
      assert.equal(events.json.events.length, 1);
      assert.equal((await call('GET', `/api/bots/${botId}/events`)).json.events.length, 2);

      assert.equal((await call('DELETE', `/api/bots/${botId}/triggers/${id}`)).json.ok, true);
      assert.equal((await call('DELETE', `/api/bots/${botId}/triggers/${id}`)).status, 404);
    });
    botSignals.cancelWakes();
  });
});

test('M7: kanban_event from a bot-created task is ignored unless the trigger sets allow_bot_origin', async () => {
  await withBots(async ({ botId, otherBotId }) => {
    const { kanbanDb } = await import('@/modules/kanban/index.js');
    botSignals.setWakeHandler(() => {});
    botTriggers.create({ botId, kind: 'kanban_event', config: {} });
    botTriggers.create({ botId: otherBotId, kind: 'kanban_event', config: { allow_bot_origin: true } });
    const board = kanbanDb.getOrCreateGlobalBoard();
    const botTask = kanbanDb.createTask({ boardId: board.board_id, projectId: 'p', title: 'Follow up', description: `[bot:${otherBotId}] created by a bot` });
    const humanTask = kanbanDb.createTask({ boardId: board.board_id, projectId: 'p', title: 'Human task' });

    const fire = (taskId: string, extra: Record<string, unknown> = {}) =>
      handleAutomationEvent({ type: 'kanban_event', event: 'task.done', payload: { taskId, ...extra } });
    fire(botTask.task_id);
    fire(humanTask.task_id);
    fire('t-meta', { meta: { botId: otherBotId } });
    fire('t-source', { source: `bot:${otherBotId}` });

    assert.deepEqual(botEventsDb.listRecent(botId).map((e) => e.payload.task_id), [humanTask.task_id]);
    assert.equal(botEventsDb.listRecent(otherBotId).length, 4, 'opted-in trigger sees all four');
    botSignals.cancelWakes();
  });
});
