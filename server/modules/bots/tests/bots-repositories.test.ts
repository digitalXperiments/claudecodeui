import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  botBudgetsDb,
  botChannelsDb,
  botCommitmentsDb,
  botEpisodesDb,
  botEventsDb,
  botGateDecisionsDb,
  botGoalsDb,
  botLeasesDb,
  botOperatorProfileDb,
  botOutboundLogDb,
  botProposalsDb,
  botRulesDb,
  botSkillsDb,
  botSpacesDb,
  botTeamsDb,
  botThreadDb,
  botTriggersDb,
  deleteBotRuntimeData,
  patchBotRuntimeConfig,
  readBotRuntimeConfig,
  resolveBotHome,
} from '@/modules/bots/index.js';
import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withDatabase(run: (botId: string) => void | Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousHome = process.env.CLOUDCLI_BOTS_HOME;
  const scratch = await makeScratchDir('bots-repos-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_BOTS_HOME = path.join(scratch, 'bots');
  await initializeDatabase();
  try {
    const bot = missionControlDb.createSection({ title: 'Runtime bot', produce_prompt: 'Go' });
    await run(bot.section_id);
  } finally {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousHome === undefined) delete process.env.CLOUDCLI_BOTS_HOME;
    else process.env.CLOUDCLI_BOTS_HOME = previousHome;
    await rm(scratch, { recursive: true, force: true });
  }
}

const count = (table: string, botId: string): number =>
  (getConnection().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE bot_id = ?`).get(botId) as { n: number }).n;

test('migration adds runtime_json and FTS5 is usable', async () => {
  await withDatabase((botId) => {
    const db = getConnection();
    const cols = (db.prepare('PRAGMA table_info(mc_sections)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('runtime_json'));
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.prepare('INSERT INTO bot_episodes_fts (episode_id, bot_id, summary, plan_text) VALUES (?, ?, ?, ?)').run(
      'e1', botId, 'Reconciled the invoices', 'open ledger',
    );
    const hit = db.prepare('SELECT episode_id FROM bot_episodes_fts WHERE bot_episodes_fts MATCH ?').get('invoices') as
      | { episode_id: string }
      | undefined;
    assert.equal(hit?.episode_id, 'e1');
    db.prepare('DELETE FROM bot_episodes_fts WHERE episode_id = ?').run('e1');
    assert.equal(db.prepare('SELECT 1 FROM bot_episodes_fts WHERE bot_episodes_fts MATCH ?').get('invoices'), undefined);
  });
});

test('events: dedupe, claimBatch, consume/drop, counts', async () => {
  await withDatabase((botId) => {
    const first = botEventsDb.insert({ botId, source: 'webhook', kind: 'push', dedupeKey: 'k1', trust: 'external', payload: { a: 1 } });
    assert.equal(first.duplicate, false);
    assert.equal(first.event.status, 'queued');
    const dupe = botEventsDb.insert({ botId, source: 'webhook', kind: 'push', dedupeKey: 'k1', trust: 'external', payload: { a: 2 } });
    assert.equal(dupe.duplicate, true);
    assert.equal(dupe.event.event_id, first.event.event_id);
    assert.deepEqual(dupe.event.payload, { a: 1 });
    // Null dedupe keys never collide.
    botEventsDb.insert({ botId, source: 'x', kind: 'k', trust: 'internal', payload: {} });
    botEventsDb.insert({ botId, source: 'x', kind: 'k', trust: 'internal', payload: {} });
    assert.equal(botEventsDb.countQueued(botId), 3);

    const batch = botEventsDb.claimBatch(botId, { max: 2 });
    assert.equal(batch.length, 2);
    assert.ok(batch.every((event) => event.status === 'claimed' && event.claimed_at));
    assert.equal(botEventsDb.claimBatch(botId, { max: 10 }).length, 1);
    assert.equal(botEventsDb.claimBatch(botId, { max: 10 }).length, 0);

    assert.equal(botEventsDb.markConsumed([batch[0].event_id], 'bep_x'), 1);
    assert.equal(botEventsDb.get(batch[0].event_id)?.status, 'consumed');
    assert.equal(botEventsDb.get(batch[0].event_id)?.episode_id, 'bep_x');
    assert.equal(botEventsDb.markDropped([batch[1].event_id], 'noise'), 1);
    assert.equal(botEventsDb.get(batch[1].event_id)?.status, 'dropped');
    assert.equal(botEventsDb.get(batch[1].event_id)?.payload._drop_reason, 'noise');
    assert.equal(botEventsDb.listRecent(botId, 2).length, 2);
    assert.equal(botEventsDb.releaseClaimed(botId), 1);
    assert.equal(botEventsDb.countQueued(botId), 1);
  });
});

test('events: coalesce window limits the claimed batch', async () => {
  await withDatabase((botId) => {
    const db = getConnection();
    const a = botEventsDb.insert({ botId, source: 's', kind: 'k', trust: 'internal', payload: {} }).event;
    const b = botEventsDb.insert({ botId, source: 's', kind: 'k', trust: 'internal', payload: {} }).event;
    db.prepare('UPDATE bot_events SET received_at = ? WHERE event_id = ?').run('2026-01-01T00:00:00.000Z', a.event_id);
    db.prepare('UPDATE bot_events SET received_at = ? WHERE event_id = ?').run('2026-01-01T00:10:00.000Z', b.event_id);
    const batch = botEventsDb.claimBatch(botId, { max: 10, coalesceMs: 1000 });
    assert.deepEqual(batch.map((e) => e.event_id), [a.event_id]);
  });
});

test('triggers CRUD', async () => {
  await withDatabase((botId) => {
    const trigger = botTriggersDb.create({ botId, kind: 'cron', config: { cron: '0 9 * * *' } });
    assert.equal(trigger.enabled, true);
    const updated = botTriggersDb.update(trigger.trigger_id, { enabled: false, cursor: { n: 1 }, lastFiredAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(updated?.enabled, false);
    assert.deepEqual(updated?.cursor, { n: 1 });
    assert.deepEqual(updated?.config, { cron: '0 9 * * *' });
    assert.equal(botTriggersDb.list(botId).length, 1);
    assert.equal(botTriggersDb.listEnabled().length, 0);
    assert.equal(botTriggersDb.delete(trigger.trigger_id), true);
    assert.equal(botTriggersDb.get(trigger.trigger_id), null);
  });
});

test('leases: contention, renew, release by holder, expiry takeover', async () => {
  await withDatabase((botId) => {
    const a = botLeasesDb.acquire(botId, 'holder-a', 60_000, 'bep_1');
    assert.equal(a?.holder, 'holder-a');
    assert.equal(botLeasesDb.acquire(botId, 'holder-b', 60_000), null, 'live lease blocks other holders');
    assert.equal(botLeasesDb.renew(botId, 'holder-b', 60_000), false);
    assert.equal(botLeasesDb.renew(botId, 'holder-a', 120_000, 'bep_2'), true);
    assert.equal(botLeasesDb.get(botId)?.episode_id, 'bep_2');
    assert.equal(botLeasesDb.release(botId, 'holder-b'), false);
    assert.equal(botLeasesDb.get(botId)?.holder, 'holder-a');

    getConnection().prepare('UPDATE bot_leases SET expires_at = ? WHERE bot_id = ?').run('2000-01-01T00:00:00.000Z', botId);
    const takeover = botLeasesDb.acquire(botId, 'holder-b', 60_000);
    assert.equal(takeover?.holder, 'holder-b');

    getConnection().prepare('UPDATE bot_leases SET expires_at = ? WHERE bot_id = ?').run('2000-01-01T00:00:00.000Z', botId);
    const expired = botLeasesDb.expireStale();
    assert.equal(expired.length, 1);
    assert.equal(botLeasesDb.get(botId), null);
    assert.equal(botLeasesDb.acquire(botId, 'holder-c', 60_000)?.holder, 'holder-c');
    assert.equal(botLeasesDb.release(botId, 'holder-c'), true);
  });
});

test('goals and commitments CRUD + due query', async () => {
  await withDatabase((botId) => {
    const goal = botGoalsDb.create({ botId, statement: 'Inbox zero', successCriteria: '<5 unread', sortOrder: 2 });
    botGoalsDb.create({ botId, statement: 'Earlier', sortOrder: 1 });
    assert.equal(botGoalsDb.list(botId)[0].statement, 'Earlier');
    const updated = botGoalsDb.update(goal.goal_id, { status: 'paused', progress: { pct: 40 } });
    assert.equal(updated?.status, 'paused');
    assert.deepEqual(updated?.progress, { pct: 40 });
    assert.equal(botGoalsDb.list(botId, 'active').length, 1);
    assert.equal(botGoalsDb.delete(goal.goal_id), true);

    const due = botCommitmentsDb.create({ botId, description: 'Follow up', dueAt: '2026-01-01T00:00:00.000Z', waitingOn: 'Sam' });
    botCommitmentsDb.create({ botId, description: 'Later', dueAt: '2999-01-01T00:00:00.000Z' });
    assert.deepEqual(botCommitmentsDb.listDue(new Date('2026-06-01')).map((c) => c.commitment_id), [due.commitment_id]);
    assert.equal(botCommitmentsDb.complete(due.commitment_id)?.status, 'done');
    assert.equal(botCommitmentsDb.listDue(new Date('2026-06-01')).length, 0);
    const other = botCommitmentsDb.list(botId, 'open')[0];
    assert.equal(botCommitmentsDb.cancel(other.commitment_id)?.status, 'cancelled');
  });
});

test('episodes: lifecycle and FTS search/index/reindex', async () => {
  await withDatabase((botId) => {
    const ep = botEpisodesDb.create({ botId, triggerKinds: 'cron', eventIds: ['bev_1'], botVersion: 3 });
    assert.equal(ep.status, 'running');
    const done = botEpisodesDb.update(ep.episode_id, {
      status: 'succeeded',
      summary: 'Reconciled the quarterly invoices with the ledger',
      planText: 'fetch statements then diff',
      runIds: ['run_1'],
      tainted: true,
      costUsd: 0.42,
      finishedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(done?.tainted, true);
    assert.deepEqual(done?.run_ids, ['run_1']);
    assert.deepEqual(done?.event_ids, ['bev_1']);

    assert.equal(botEpisodesDb.indexEpisode(ep.episode_id), true);
    const hits = botEpisodesDb.search(botId, 'invoices ledger', 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].episode_id, ep.episode_id);
    assert.equal(typeof hits[0].score, 'number');
    assert.equal(botEpisodesDb.search(botId, 'unrelated zebra', 5).length, 0);
    assert.equal(botEpisodesDb.search(botId, '"*( OR', 5).length, 0, 'operator characters cannot break the query');
    assert.equal(botEpisodesDb.search(botId, '   ', 5).length, 0);

    // Re-index after an update replaces the old entry (no stale hits).
    botEpisodesDb.update(ep.episode_id, { summary: 'Sent the newsletter' });
    botEpisodesDb.indexEpisode(ep.episode_id);
    assert.equal(botEpisodesDb.search(botId, 'invoices', 5).length, 0);
    assert.equal(botEpisodesDb.search(botId, 'newsletter', 5).length, 1);

    const other = missionControlDb.createSection({ title: 'Other bot' });
    assert.equal(botEpisodesDb.search(other.section_id, 'newsletter', 5).length, 0, 'search is scoped to the bot');

    assert.equal(botEpisodesDb.listByStatus('running').length, 0);
    botEpisodesDb.removeFromIndex(ep.episode_id);
    assert.equal(botEpisodesDb.search(botId, 'newsletter', 5).length, 0);
    assert.equal(botEpisodesDb.list(botId).length, 1);
  });
});

test('rules, gate decisions and budgets', async () => {
  await withDatabase((botId) => {
    const global = botRulesDb.create({ scope: 'global', match: { risk: ['send'] }, decision: 'ask', priority: 1 });
    const scoped = botRulesDb.create({ scope: 'bot', botId, match: { tool: 'slack_post' }, decision: 'allow', priority: 5, createdFrom: 'manual' });
    botRulesDb.create({ scope: 'bot', botId: 'someone-else', decision: 'deny' });
    botRulesDb.create({ scope: 'global', decision: 'deny', expiresAt: '2000-01-01T00:00:00.000Z' });
    assert.deepEqual(botRulesDb.listApplicable(botId).map((r) => r.rule_id), [scoped.rule_id, global.rule_id]);
    assert.deepEqual(botRulesDb.get(scoped.rule_id)?.match, { tool: 'slack_post' });
    assert.equal(botRulesDb.update(global.rule_id, { decision: 'deny', note: 'tight' })?.decision, 'deny');
    assert.equal(botRulesDb.list({ scope: 'global' }).length, 2);
    assert.equal(botRulesDb.delete(global.rule_id), true);

    const decision = botGateDecisionsDb.create({
      botId, server: 'slack', tool: 'post', risk: 'send', args: { channel: 'c' }, decision: 'ask', decidedBy: 'floor', reason: 'send floor',
    });
    assert.equal(decision.outcome, null);
    assert.equal(botGateDecisionsDb.setInterrupt(decision.decision_id, 'int_1')?.interrupt_id, 'int_1');
    const resolved = botGateDecisionsDb.recordOutcome(decision.decision_id, 'approved');
    assert.equal(resolved?.outcome, 'approved');
    assert.ok(resolved?.resolved_at);
    assert.equal(botGateDecisionsDb.listForBot(botId).length, 1);
    assert.equal(botGateDecisionsDb.countSince(botId, '2000-01-01T00:00:00.000Z'), 1);
    assert.equal(botGateDecisionsDb.countSince(botId, '2000-01-01T00:00:00.000Z', 'deny'), 0);

    assert.equal(botBudgetsDb.get(botId), null);
    const budget = botBudgetsDb.put(botId, { dailyUsd: 5, maxWakesPerHour: 4 });
    assert.equal(budget.soft_ratio, 0.8);
    const patched = botBudgetsDb.put(botId, { monthlyUsd: 50, dailyUsd: null });
    assert.equal(patched.daily_usd, null);
    assert.equal(patched.monthly_usd, 50);
    assert.equal(patched.max_wakes_per_hour, 4);
    assert.equal(botBudgetsDb.delete(botId), true);
  });
});

test('learning: proposals, skills, operator profile', async () => {
  await withDatabase((botId) => {
    const proposal = botProposalsDb.create({ botId, kind: 'memory', title: 'Prefers terse', evidence: [{ episode: 'bep_1' }], confidence: 0.9 });
    assert.equal(proposal.status, 'proposed');
    assert.equal(proposal.decided_at, null);
    assert.equal(botProposalsDb.setStatus(proposal.proposal_id, 'approved')?.status, 'approved');
    assert.ok(botProposalsDb.get(proposal.proposal_id)?.decided_at);
    assert.equal(botProposalsDb.list(botId, 'proposed').length, 0);
    assert.equal(botProposalsDb.list(botId).length, 1);

    const skill = botSkillsDb.upsert({ botId, name: 'triage', path: '/skills/triage/SKILL.md', origin: 'reflector' });
    assert.equal(skill.version, 1);
    const bumped = botSkillsDb.upsert({ botId, name: 'triage', path: '/skills/triage/SKILL.md' });
    assert.equal(bumped.link_id, skill.link_id);
    assert.equal(bumped.version, 2);
    assert.equal(bumped.origin, 'reflector');
    assert.equal(botSkillsDb.setEnabled(skill.link_id, false)?.enabled, false);
    assert.equal(botSkillsDb.list(botId).length, 1);
    assert.equal(botSkillsDb.delete(skill.link_id), true);

    botOperatorProfileDb.set('tone', 'terse');
    assert.equal(botOperatorProfileDb.set('tone', 'friendly', 'reflector').source, 'reflector');
    assert.equal(botOperatorProfileDb.get('tone')?.value, 'friendly');
    assert.equal(botOperatorProfileDb.list().length, 1);
    assert.equal(botOperatorProfileDb.delete('tone'), true);
  });
});

test('channels, thread, outbound log', async () => {
  await withDatabase((botId) => {
    const global = botChannelsDb.upsert({ kind: 'slack', config: { channel: '#ops' }, policy: { min_urgency: 0.5 } });
    botChannelsDb.upsert({ kind: 'inapp' });
    const own = botChannelsDb.upsert({ botId, kind: 'slack', config: { channel: '#mine' } });
    assert.equal(global.bot_id, null);
    assert.deepEqual(global.policy, { min_urgency: 0.5 });
    const effective = botChannelsDb.listEffective(botId);
    assert.equal(effective.length, 2);
    assert.equal(effective.find((c) => c.kind === 'slack')?.channel_id, own.channel_id);
    const edited = botChannelsDb.upsert({ channelId: own.channel_id, kind: 'slack', enabled: false });
    assert.equal(edited.enabled, false);
    assert.deepEqual(edited.config, { channel: '#mine' });
    assert.equal(botChannelsDb.delete(own.channel_id), true);

    botThreadDb.post(botId, { role: 'operator', body: 'hi' });
    botThreadDb.post(botId, { role: 'bot', body: 'hello', meta: { episode: 'bep_1' } });
    const thread = botThreadDb.list(botId);
    assert.deepEqual(thread.map((m) => m.body), ['hi', 'hello']);
    assert.equal(thread[1].channel, 'inapp');
    assert.deepEqual(thread[1].meta, { episode: 'bep_1' });
    assert.equal(botThreadDb.list(botId, { limit: 1 })[0].body, 'hello');

    botOutboundLogDb.record({ botId, channelKind: 'slack', urgency: 0.7, delivered: true });
    botOutboundLogDb.record({ botId, channelKind: 'slack', urgency: 0.1, delivered: false, reason: 'below_min_urgency' });
    botOutboundLogDb.record({ botId: null, channelKind: 'email', urgency: 0.9, delivered: true });
    assert.equal(botOutboundLogDb.countDeliveredSince(botId, 'slack', '2000-01-01T00:00:00.000Z'), 1);
    assert.equal(botOutboundLogDb.countDeliveredSince(null, 'email', '2000-01-01T00:00:00.000Z'), 1);
    assert.equal(botOutboundLogDb.listRecent(botId).length, 2);
    assert.equal(botOutboundLogDb.listRecent(null).length, 3);
  });
});

test('collab: teams and spaces', async () => {
  await withDatabase((botId) => {
    const team = botTeamsDb.create({ name: 'Growth', goal: 'Grow', coordinatorBotId: botId, members: [{ botId, role: 'lead' }] });
    assert.equal(team.members.length, 1);
    assert.equal(botTeamsDb.addMember(team.team_id, 'bot-2', 'analyst')?.members.length, 2);
    assert.equal(botTeamsDb.listForBot('bot-2').length, 1);
    assert.equal(botTeamsDb.update(team.team_id, { goal: 'Grow faster' })?.goal, 'Grow faster');
    assert.equal(botTeamsDb.removeMember(team.team_id, 'bot-2'), true);
    assert.equal(botTeamsDb.list().length, 1);

    const space = botSpacesDb.create({ botId, title: 'Notes', path: 'spaces/notes.md' });
    assert.equal(space.kind, 'markdown');
    assert.equal(botSpacesDb.update(space.space_id, { title: 'Notes v2' })?.title, 'Notes v2');
    assert.equal(botSpacesDb.list(botId).length, 1);
    botSpacesDb.touch(space.space_id);
    assert.equal(botSpacesDb.delete(space.space_id), true);

    assert.equal(botTeamsDb.delete(team.team_id), true);
    assert.equal(botTeamsDb.get(team.team_id), null);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM bot_team_members').get() as { n: number }).n, 0);
  });
});

test('runtime config read/patch and bot home', async () => {
  await withDatabase((botId) => {
    assert.deepEqual(readBotRuntimeConfig(botId), {});
    assert.equal(readBotRuntimeConfig('missing'), null);
    const next = patchBotRuntimeConfig(botId, {
      identity: { persona: 'Careful analyst' },
      routing: { act: { provider: 'claude', model: 'opus', effort: 'high' } },
      backend: 'docker',
      enforcement: 'advisory',
    });
    assert.equal(next?.backend, 'docker');
    assert.equal(next?.routing?.act?.model, 'opus');
    const again = patchBotRuntimeConfig(botId, { gateway: false, backend: null });
    assert.equal(again?.gateway, false);
    assert.equal(again?.backend, undefined);
    assert.equal(again?.identity?.persona, 'Careful analyst');
    assert.equal(readBotRuntimeConfig(botId)?.enforcement, 'advisory');
    // Invalid values are dropped, not stored.
    const cleaned = patchBotRuntimeConfig(botId, { backend: 'mars' as never });
    assert.equal(cleaned?.backend, undefined);
    assert.equal(patchBotRuntimeConfig('missing', { gateway: true }), null);

    const home = resolveBotHome(botId);
    assert.ok(home.startsWith(process.env.CLOUDCLI_BOTS_HOME!));
    assert.ok(home.endsWith(path.join(botId, 'home')));
    assert.ok(existsSync(home));
    assert.throws(() => resolveBotHome('../escape'));
  });
});

test('deleting the mc_sections row cascades; deleteBotRuntimeData clears the rest', async () => {
  await withDatabase((botId) => {
    const ep = botEpisodesDb.create({ botId });
    botEpisodesDb.update(ep.episode_id, { summary: 'cascade test summary' });
    botEpisodesDb.indexEpisode(ep.episode_id);
    botEventsDb.insert({ botId, source: 's', kind: 'k', trust: 'internal', payload: {} });
    botTriggersDb.create({ botId, kind: 'manual' });
    botGoalsDb.create({ botId, statement: 'g' });
    botCommitmentsDb.create({ botId, description: 'c', dueAt: '2030-01-01T00:00:00.000Z' });
    botBudgetsDb.put(botId, { dailyUsd: 1 });
    botProposalsDb.create({ botId, kind: 'memory', title: 't' });
    botSkillsDb.upsert({ botId, name: 's', path: 'p' });
    botThreadDb.post(botId, { role: 'bot', body: 'b' });
    botSpacesDb.create({ botId, title: 't', path: 'p' });
    botLeasesDb.acquire(botId, 'h', 60_000);
    botRulesDb.create({ scope: 'bot', botId, decision: 'allow' });
    botRulesDb.create({ scope: 'global', decision: 'ask' });
    botGateDecisionsDb.create({ botId, server: 's', tool: 't', risk: 'read', decision: 'allow', decidedBy: 'default' });
    botChannelsDb.upsert({ botId, kind: 'inapp' });
    botOutboundLogDb.record({ botId, channelKind: 'inapp', urgency: 0.5, delivered: true });
    const team = botTeamsDb.create({ name: 'T', coordinatorBotId: botId, members: [{ botId }] });

    const db = getConnection();
    db.prepare('DELETE FROM mc_sections WHERE section_id = ?').run(botId);
    const cascaded = [
      'bot_triggers', 'bot_events', 'bot_goals', 'bot_commitments', 'bot_episodes', 'bot_budgets',
      'bot_learning_proposals', 'bot_skills', 'bot_thread_messages', 'bot_spaces',
    ];
    for (const table of cascaded) assert.equal(count(table, botId), 0, `${table} should cascade`);
    // Non-FK tables and FTS survive the cascade -> explicit helper is required.
    assert.equal(count('bot_episodes_fts', botId), 1);
    assert.equal(count('bot_leases', botId), 1);
    assert.equal(count('bot_gate_decisions', botId), 1);

    deleteBotRuntimeData(botId);
    for (const table of [...cascaded, 'bot_episodes_fts', 'bot_leases', 'bot_gate_decisions', 'bot_channels', 'bot_outbound_log', 'bot_team_members']) {
      assert.equal(count(table, botId), 0, `${table} should be empty`);
    }
    assert.equal(botRulesDb.list({ scope: 'bot' }).length, 0);
    assert.equal(botRulesDb.list({ scope: 'global' }).length, 1);
    assert.equal(botTeamsDb.get(team.team_id)?.coordinator_bot_id, null);
  });
});
