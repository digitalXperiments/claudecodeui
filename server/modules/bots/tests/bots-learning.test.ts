import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import express from 'express';

import { updateAppFeatures } from '@/modules/app-features/index.js';
import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { evalsService } from '@/modules/evals/index.js';
import {
  acceptWorkItem,
  applyItemAction,
  configureMissionControlRuntimes,
  emitItemFeedback,
  listBotMemories,
  missionControlDb,
  proposeBotMemory,
  recordSectionVersion,
  reviewBotMemory,
  type McItem,
} from '@/modules/mission-control/index.js';
import { makeScratchDir } from '@/shared/scratch.js';
import type { AnyRecord } from '@/shared/types.js';
import { patchBotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
import { botRulesDb } from '@/modules/bots/gate/bot-rules.repository.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { buildKernelPrompt } from '@/modules/bots/kernel/index.js';
import { botProposalsDb } from '@/modules/bots/learning/bot-proposals.repository.js';
import { botSkillsDb } from '@/modules/bots/learning/bot-skills.repository.js';
import {
  botLearningRouter,
  evalsBridge,
  installLearning,
  learning,
  operatorProfile,
  privacy,
  reflector,
  setSkillDrafter,
  shadow,
  skills,
  uninstallLearning,
  type ShadowRunner,
} from '@/modules/bots/learning/index.js';
import { readBotFeedbackLog } from '@/modules/bots/learning/feedback.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
import { botThreadDb } from '@/modules/bots/channels/bot-thread.repository.js';
import { resolveBotHome } from '@/modules/bots/bots-home.js';

type Writer = { send: (event: AnyRecord) => void; sendComplete: (event: AnyRecord) => void };
type Fake = (prompt: string, options: AnyRecord, writer: Writer) => void | Promise<void>;

function fakeRuntime(reply: string | ((prompt: string) => string)): { fn: Fake; prompts: string[] } {
  const prompts: string[] = [];
  const fn: Fake = (prompt, _options, writer) => {
    prompts.push(prompt);
    writer.send({ kind: 'text', provider: 'claude', content: typeof reply === 'function' ? reply(prompt) : reply });
    writer.sendComplete({ exitCode: 0 });
  };
  return { fn, prompts };
}

const ENV_KEYS = ['DATABASE_PATH', 'CLOUDCLI_BOTS_HOME', 'CLOUDCLI_OPERATOR_PROFILE_PATH', 'CLOUDCLI_SKILLS_CATALOG_DIRS'] as const;

async function withLearning(run: (ctx: { botId: string; scratch: string }) => void | Promise<void>): Promise<void> {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const scratch = await makeScratchDir('bots-learning-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  process.env.CLOUDCLI_BOTS_HOME = path.join(scratch, 'bots');
  delete process.env.CLOUDCLI_OPERATOR_PROFILE_PATH;
  delete process.env.CLOUDCLI_SKILLS_CATALOG_DIRS;
  await initializeDatabase();
  updateAppFeatures({ botsRuntimeV2: true });
  installLearning();
  try {
    const bot = missionControlDb.createSection({ title: 'Learner', produce_prompt: 'Triage my inbox.' });
    await run({ botId: bot.section_id, scratch });
  } finally {
    uninstallLearning();
    setSkillDrafter(null);
    configureMissionControlRuntimes({});
    closeConnection();
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

function seedItem(botId: string, title: string, opts: { episodeId?: string; source?: Record<string, unknown>; body?: Record<string, unknown> } = {}): McItem {
  const section = missionControlDb.getSection(botId)!;
  const item = missionControlDb.insertItemIfNew(section, {
    title,
    summary: '',
    body: opts.body ?? {},
    dedupeKey: randomUUID(),
    source: { ...(opts.source ?? {}), ...(opts.episodeId ? { episodeId: opts.episodeId } : {}) },
  });
  assert.ok(item);
  return item;
}

function seedEpisode(botId: string, opts: { plan?: string; summary?: string; itemIds?: string[]; status?: 'succeeded' | 'failed' } = {}) {
  const episode = botEpisodesDb.create({ botId, triggerKinds: 'webhook' });
  botEpisodesDb.update(episode.episode_id, {
    status: opts.status ?? 'succeeded',
    planText: opts.plan ?? '',
    summary: opts.summary ?? '',
    outcome: { item_ids: opts.itemIds ?? [] },
    finishedAt: new Date().toISOString(),
  });
  botEpisodesDb.indexEpisode(episode.episode_id);
  return botEpisodesDb.get(episode.episode_id)!;
}

let decisionClock = 0;
function seedDecision(botId: string, opts: { episodeId?: string; server?: string; tool?: string; risk?: string; decision?: 'allow' | 'ask' | 'deny'; outcome?: string; decidedBy?: string }) {
  const row = botGateDecisionsDb.create({
    botId,
    episodeId: opts.episodeId ?? null,
    server: opts.server ?? 'jira',
    tool: opts.tool ?? 'add_comment',
    risk: opts.risk ?? 'draft',
    decision: opts.decision ?? 'ask',
    decidedBy: opts.decidedBy ?? 'default',
  });
  // Strictly increasing timestamps so "ordered tool calls" is deterministic within one millisecond.
  decisionClock += 1;
  getConnection()
    .prepare('UPDATE bot_gate_decisions SET created_at = ? WHERE decision_id = ?')
    .run(new Date(Date.now() - 3_600_000 + decisionClock * 1_000).toISOString(), row.decision_id);
  if (opts.outcome) botGateDecisionsDb.recordOutcome(row.decision_id, opts.outcome);
  return botGateDecisionsDb.get(row.decision_id)!;
}

/** A human dismissal of a mail item from `sender`. */
async function dismissFrom(botId: string, sender: string, title: string, episodeId?: string): Promise<McItem> {
  const item = seedItem(botId, title, { episodeId, body: { from: `Promo <${sender}>` } });
  await applyItemAction(item.item_id, 'deny');
  return item;
}

const versionCount = (botId: string): number =>
  (getConnection().prepare('SELECT COUNT(*) AS n FROM mc_section_versions WHERE section_id = ?').get(botId) as { n: number }).n;

// ---- feedback capture -------------------------------------------------------------------------

test('feedback: human actions land on the episode, auto approvals are tagged auto, itemless episodes use the bot log', async () => {
  await withLearning(async ({ botId }) => {
    const episode = seedEpisode(botId);
    const approved = seedItem(botId, 'Reply to Acme', { episodeId: episode.episode_id });
    await applyItemAction(approved.item_id, 'approve', { note: 'edited by the operator' });
    const auto = seedItem(botId, 'Auto item', { episodeId: episode.episode_id });
    await applyItemAction(auto.item_id, 'approve', undefined, { actor: 'auto' });
    const dismissed = seedItem(botId, 'Newsletter', { episodeId: episode.episode_id });
    await applyItemAction(dismissed.item_id, 'deny');

    const feedback = botEpisodesDb.get(episode.episode_id)!.feedback as Array<Record<string, unknown>>;
    const kinds = feedback.map((f) => `${f.kind}:${f.actor}`);
    assert.deepEqual(kinds, ['edit:human', 'approve:human', 'approve:auto', 'dismiss:human']);
    assert.match(String(feedback[0]!.text), /note/);
    assert.equal(feedback[1]!.action, 'approve');
    assert.equal(feedback[3]!.item_id, dismissed.item_id);

    // Items with no episode are recorded against the bot (hidden from proposal lists).
    const loose = seedItem(botId, 'Loose item');
    await applyItemAction(loose.item_id, 'deny');
    const log = readBotFeedbackLog(botId);
    assert.equal(log.length, 1);
    assert.equal(log[0]!.kind, 'dismiss');
    assert.equal(learning.list(botId).length, 0);

    // Accept and send-back (emitted directly: sending back needs a live work session).
    const inQa = seedItem(botId, 'Built thing', { episodeId: episode.episode_id });
    missionControlDb.setItemStatus(inQa.item_id, 'in_qa', {});
    acceptWorkItem(inQa.item_id);
    emitItemFeedback({ itemId: inQa.item_id, sectionId: botId, kind: 'send_back', text: 'Use bullets', item: inQa });
    const after = botEpisodesDb.get(episode.episode_id)!.feedback as Array<Record<string, unknown>>;
    assert.deepEqual(after.slice(4).map((f) => f.kind), ['accept', 'send_back']);
    assert.equal(after[5]!.text, 'Use bullets');
  });
});

test('feedback capture is inert while the runtime flag is off', async () => {
  await withLearning(async ({ botId }) => {
    updateAppFeatures({ botsRuntimeV2: false });
    const item = seedItem(botId, 'Quiet');
    await applyItemAction(item.item_id, 'deny');
    assert.equal(readBotFeedbackLog(botId).length, 0);
  });
});

// ---- heuristics -------------------------------------------------------------------------------

test('dismissals: 3 from one sender propose an ignore memory; dedupe, supersede and rejection suppression', async () => {
  await withLearning(async ({ botId }) => {
    const ids = [
      (await dismissFrom(botId, 'deals@shop.example', 'Big sale today')).item_id,
      (await dismissFrom(botId, 'deals@shop.example', 'Weekend offers')).item_id,
    ];
    assert.equal((await reflector.reflectBot(botId)).length, 0);
    ids.push((await dismissFrom(botId, 'deals@shop.example', 'Last chance coupon')).item_id);
    // An auto-generated "dismissal" must not count.
    const created = await reflector.reflectBot(botId);
    assert.equal(created.length, 1);
    const proposal = created[0]!;
    assert.equal(proposal.kind, 'memory');
    assert.match(proposal.title, /Ignore\/deprioritize mail from deals@shop\.example/);
    assert.deepEqual([...(proposal.evidence as string[])].sort(), [...ids].sort());
    assert.ok(proposal.confidence > 0 && proposal.confidence <= 1);

    assert.equal((await reflector.reflectBot(botId)).length, 0, 'same evidence is not re-proposed');

    ids.push((await dismissFrom(botId, 'deals@shop.example', 'Flash deal')).item_id);
    const next = await reflector.reflectBot(botId);
    assert.equal(next.length, 1);
    assert.equal(botProposalsDb.get(proposal.proposal_id)!.status, 'superseded');
    assert.equal(learning.list(botId, { status: 'proposed' }).length, 1);

    learning.reject(next[0]!.proposal_id);
    await dismissFrom(botId, 'deals@shop.example', 'One more');
    assert.equal((await reflector.reflectBot(botId)).length, 0, 'rejected within 30 days stays suppressed');

    getConnection()
      .prepare('UPDATE bot_learning_proposals SET decided_at = ? WHERE proposal_id = ?')
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), next[0]!.proposal_id);
    assert.equal((await reflector.reflectBot(botId)).length, 1, 'after 30 days it may be proposed again');
  });
});

test('dismissals that the operator also approves are not turned into ignore rules', async () => {
  await withLearning(async ({ botId }) => {
    for (const title of ['Invoice one', 'Invoice two', 'Invoice three']) await dismissFrom(botId, 'billing@vendor.example', title);
    for (const title of ['Invoice four', 'Invoice five', 'Invoice six']) {
      const item = seedItem(botId, title, { body: { from: 'billing@vendor.example' } });
      await applyItemAction(item.item_id, 'approve');
    }
    assert.equal((await reflector.reflectBot(botId)).length, 0);
  });
});

test('send-backs become "When <context>, <instruction>" memory proposals at confidence 0.6', async () => {
  await withLearning(async ({ botId }) => {
    const episode = seedEpisode(botId);
    const item = seedItem(botId, 'Jira summary for PROJ-9', { episodeId: episode.episode_id });
    emitItemFeedback({ itemId: item.item_id, sectionId: botId, kind: 'send_back', text: 'Always lead with the customer impact', item });
    const created = await reflector.reflectBot(botId);
    const memory = created.find((p) => p.kind === 'memory')!;
    assert.match(memory.body, /^When handling "Jira summary for PROJ-9", Always lead with the customer impact/);
    assert.equal(memory.confidence, 0.6);
    assert.ok((memory.evidence as string[]).includes(item.item_id));
  });
});

test('rules: 5 human approvals with no rejection propose a bot allow rule; floor risks are flagged; builtin and rejected tools are not', async () => {
  await withLearning(async ({ botId }) => {
    for (let i = 0; i < 5; i += 1) seedDecision(botId, { server: 'jira', tool: 'add_comment', outcome: i % 2 ? 'executed' : 'approved' });
    for (let i = 0; i < 5; i += 1) seedDecision(botId, { server: 'mail', tool: 'send_email', risk: 'send', outcome: 'approved' });
    for (let i = 0; i < 4; i += 1) seedDecision(botId, { server: 'wiki', tool: 'edit', outcome: 'approved' });
    for (let i = 0; i < 5; i += 1) seedDecision(botId, { server: 'trello', tool: 'move', outcome: 'approved' });
    seedDecision(botId, { server: 'trello', tool: 'move', outcome: 'rejected' });
    for (let i = 0; i < 6; i += 1) seedDecision(botId, { server: 'builtin', tool: 'Bash', outcome: 'approved' });
    for (let i = 0; i < 6; i += 1) seedDecision(botId, { server: 'auto', tool: 'fetch', decision: 'allow', outcome: 'executed', decidedBy: 'default' });

    const created = (await reflector.reflectBot(botId)).filter((p) => p.kind === 'rule');
    assert.deepEqual(created.map((p) => `${p.payload.server}.${p.payload.tool}`).sort(), ['jira.add_comment', 'mail.send_email']);
    assert.equal(created.find((p) => p.payload.tool === 'send_email')!.payload.floor, true);
    assert.equal(created.find((p) => p.payload.tool === 'add_comment')!.payload.floor, false);
    assert.equal((await reflector.reflectBot(botId)).length, 0);
  });
});

test('new skill: an all-accepted succeeded episode with 3+ executed tool calls proposes a SKILL.md draft', async () => {
  await withLearning(async ({ botId }) => {
    const episode = seedEpisode(botId, { plan: 'Pull the weekly numbers, then draft the digest.', summary: 'Weekly digest' });
    const item = seedItem(botId, 'Weekly digest', { episodeId: episode.episode_id, body: { digest: 'x', period: 'w1' } });
    botEpisodesDb.update(episode.episode_id, { outcome: { item_ids: [item.item_id] } });
    const tools = ['query', 'fetch_chart', 'draft_mail'];
    tools.forEach((tool) => seedDecision(botId, { episodeId: episode.episode_id, server: 'bi', tool, outcome: 'executed', decision: 'allow' }));
    await applyItemAction(item.item_id, 'approve');

    const created = (await reflector.onEpisodeFinished(episode.episode_id)).filter((p) => p.kind === 'new_skill');
    assert.equal(created.length, 1);
    const draft = created[0]!.payload.content as string;
    assert.match(draft, /^---\nname: weekly-digest\ndescription: /);
    assert.match(draft, /Pull the weekly numbers/);
    assert.ok(draft.indexOf('bi.query') < draft.indexOf('bi.fetch_chart') && draft.indexOf('bi.fetch_chart') < draft.indexOf('bi.draft_mail'));
    assert.match(draft, /digest, period/);
    assert.ok((created[0]!.evidence as string[]).includes(episode.episode_id));
    assert.equal((created[0]!.evidence as string[]).filter((e) => e.startsWith('bgd_')).length, 3);

    // A send-back on the same episode, or too few tool calls, disqualifies.
    const other = seedEpisode(botId, { plan: 'short', summary: 'Short one' });
    const otherItem = seedItem(botId, 'Short', { episodeId: other.episode_id });
    botEpisodesDb.update(other.episode_id, { outcome: { item_ids: [otherItem.item_id] } });
    seedDecision(botId, { episodeId: other.episode_id, outcome: 'executed', decision: 'allow' });
    await applyItemAction(otherItem.item_id, 'approve');
    assert.equal((await reflector.reflectBot(botId)).length, 0);
  });
});

test('new skill: negative feedback blocks it; a custom drafter and the reflect-route polish are both honoured', async () => {
  await withLearning(async ({ botId }) => {
    const makeGood = async (summary: string, feedbackKind: 'approve' | 'deny') => {
      const episode = seedEpisode(botId, { plan: `Plan for ${summary}`, summary });
      const item = seedItem(botId, summary, { episodeId: episode.episode_id });
      botEpisodesDb.update(episode.episode_id, { outcome: { item_ids: [item.item_id] } });
      for (const tool of ['a', 'b', 'c']) seedDecision(botId, { episodeId: episode.episode_id, server: 's', tool, outcome: 'executed', decision: 'allow' });
      await applyItemAction(item.item_id, feedbackKind === 'approve' ? 'approve' : 'deny');
      return episode;
    };
    const bad = await makeGood('Bad run', 'deny');
    assert.equal((await reflector.onEpisodeFinished(bad.episode_id)).filter((p) => p.kind === 'new_skill').length, 0);

    setSkillDrafter(({ template }) => ({ ...template, content: `${template.content}\nCUSTOM-DRAFTER` }));
    const good = await makeGood('Good run', 'approve');
    const custom = (await reflector.onEpisodeFinished(good.episode_id)).find((p) => p.kind === 'new_skill')!;
    assert.match(String(custom.payload.content), /CUSTOM-DRAFTER/);

    setSkillDrafter(null);
    patchBotRuntimeConfig(botId, { routing: { reflect: { provider: 'claude', model: 'cheap' } } });
    const runtime = fakeRuntime('```markdown\n---\nname: ignored\ndescription: Polished\n---\n# Polished skill\n```');
    configureMissionControlRuntimes({ claude: runtime.fn } as never);
    const polished = await makeGood('Polished run', 'approve');
    const result = (await reflector.onEpisodeFinished(polished.episode_id)).find((p) => p.kind === 'new_skill')!;
    assert.match(String(result.payload.content), /# Polished skill/);
    assert.match(String(result.payload.content), /^---\nname: polished-run\n/, 'name is forced to the slug');
    assert.equal(runtime.prompts.length, 1);
  });
});

test('skill patch: negative feedback on an episode that used a skill proposes a Lessons note', async () => {
  await withLearning(async ({ botId }) => {
    skills.save(botId, { name: 'triage-mail', content: '# Triage mail\n\n## Steps\n1. Read\n\n## Output\nBullets.\n' });
    const episode = seedEpisode(botId, { plan: 'Used triage-mail to sort the inbox.' });
    const item = seedItem(botId, 'Inbox sort', { episodeId: episode.episode_id });
    emitItemFeedback({ itemId: item.item_id, sectionId: botId, kind: 'send_back', text: 'Keep vendor mail separate', item });
    const patch = (await reflector.reflectBot(botId)).find((p) => p.kind === 'skill_patch')!;
    assert.equal(patch.payload.skill, 'triage-mail');
    assert.match(String(patch.payload.note), /Keep vendor mail separate/);

    learning.approve(patch.proposal_id);
    const { content, skill } = skills.get(botId, 'triage-mail');
    assert.match(content, /## Lessons\n- .*Keep vendor mail separate/);
    assert.ok(content.indexOf('## Output') < content.indexOf('## Lessons'));
    assert.equal(skill.version, 2);
  });
});

// ---- approval ---------------------------------------------------------------------------------

test('approve applies each proposal kind and records a version; memory obeys the raised limit', async () => {
  await withLearning(async ({ botId }) => {
    recordSectionVersion(missionControlDb.getSection(botId)!, 'baseline');
    const before = versionCount(botId);
    const memoryProposal = botProposalsDb.create({ botId, kind: 'memory', title: 'm', body: 'Prefers terse replies', payload: { content: 'Prefers terse replies' } });
    const applied = learning.approve(memoryProposal.proposal_id, { editedBody: 'Prefers terse replies in bullets' });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(listBotMemories(botId).filter((m) => m.status === 'approved').map((m) => m.content), ['Prefers terse replies in bullets']);
    assert.equal(versionCount(botId), before + 1);
    assert.throws(() => learning.approve(memoryProposal.proposal_id), /already applied/);

    const ruleProposal = botProposalsDb.create({ botId, kind: 'rule', title: 'r', payload: { server: 'jira', tool: 'add_comment', expires_days: 30 } });
    learning.approve(ruleProposal.proposal_id);
    const rule = botRulesDb.list({ botId })[0]!;
    assert.deepEqual([rule.scope, rule.decision, rule.created_from, rule.note, rule.match.server, rule.match.tool], ['bot', 'allow', 'manual', 'learned', 'jira', 'add_comment']);
    const days = (Date.parse(rule.expires_at!) - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30);

    const skillProposal = botProposalsDb.create({ botId, kind: 'new_skill', title: 's', payload: { name: 'my-skill', description: 'Does a thing', content: '# My skill\n' } });
    learning.approve(skillProposal.proposal_id);
    const row = botSkillsDb.getByName(botId, 'my-skill')!;
    assert.equal(row.origin, 'reflector');
    const file = path.join(resolveBotHome(botId), 'skills', 'my-skill', 'SKILL.md');
    assert.match(readFileSync(file, 'utf8'), /^---\nname: my-skill\ndescription: Does a thing\n---\n/);

    for (let i = 0; i < 49; i += 1) reviewBotMemory(botId, proposeBotMemory(botId, `fact ${i}`, null).memoryId, 'approved');
    const overflow = botProposalsDb.create({ botId, kind: 'memory', title: 'x', payload: { content: 'one too many' } });
    assert.throws(() => learning.approve(overflow.proposal_id), /at most 50/);
    assert.equal(botProposalsDb.get(overflow.proposal_id)!.status, 'proposed');
  });
});

test('auto-promotion applies memory proposals at or above the threshold and never rules or skills', async () => {
  await withLearning(async ({ botId }) => {
    patchBotRuntimeConfig(botId, { learning: { auto_promote_memory_min_confidence: 0.5 } });
    // Memory: dismissals from one sender (confidence >= 0.5) apply by themselves.
    for (const title of ['Promo one', 'Promo two', 'Promo three']) await dismissFrom(botId, 'spam@ads.example', title);
    // Rule + skill candidates in the same pass.
    for (let i = 0; i < 5; i += 1) seedDecision(botId, { server: 'jira', tool: 'add_comment', outcome: 'approved' });
    const episode = seedEpisode(botId, { plan: 'p', summary: 'Auto skill' });
    const item = seedItem(botId, 'Auto skill', { episodeId: episode.episode_id });
    botEpisodesDb.update(episode.episode_id, { outcome: { item_ids: [item.item_id] } });
    for (const tool of ['a', 'b', 'c']) seedDecision(botId, { episodeId: episode.episode_id, server: 's', tool, outcome: 'executed', decision: 'allow' });
    await applyItemAction(item.item_id, 'approve');

    const created = await reflector.reflectBot(botId);
    const byKind = Object.fromEntries(created.map((p) => [p.kind, p.status]));
    assert.equal(byKind.memory, 'applied');
    assert.equal(byKind.rule, 'proposed');
    assert.equal(byKind.new_skill, 'proposed');
    assert.equal(listBotMemories(botId).filter((m) => m.status === 'approved').length, 1);
    assert.equal(botRulesDb.list({ botId }).length, 0);
    assert.equal(botSkillsDb.list(botId).length, 0);

    // Below the threshold nothing auto-applies.
    patchBotRuntimeConfig(botId, { learning: { auto_promote_memory_min_confidence: 0.99 } });
    const low = botProposalsDb.create({ botId, kind: 'memory', title: 'low', confidence: 0.9, payload: { content: 'nope' } });
    assert.equal(learning.maybeAutoPromote(low).status, 'proposed');
  });
});

// ---- skills -----------------------------------------------------------------------------------

test('skills: names are validated, writes stay inside the bot home, symlinks cannot escape', async () => {
  await withLearning(async ({ botId, scratch }) => {
    for (const bad of ['../evil', 'a/b', '..', '.', 'UPPER', '/etc/passwd', 'a\\b', '', 'x'.repeat(65), '-lead']) {
      assert.throws(() => skills.save(botId, { name: bad, content: 'x' }), /Skill name/, `rejects ${JSON.stringify(bad)}`);
      assert.throws(() => skills.get(botId, bad), /Skill name/);
      assert.throws(() => skills.remove(botId, bad), /Skill name/);
    }
    assert.equal(existsSync(path.join(scratch, 'evil')), false);

    const saved = skills.save(botId, { name: 'good-skill', content: '# Hi\n', description: 'A good one' });
    assert.equal(saved.description, 'A good one');
    assert.equal(saved.version, 1);
    assert.equal(skills.save(botId, { name: 'good-skill', content: '# Hi again\n' }).version, 2);
    assert.match(skills.get(botId, 'good-skill').content, /Hi again/);

    // A symlinked skill directory pointing outside the home is refused.
    const outside = path.join(scratch, 'outside');
    mkdirSync(outside);
    const skillsRoot = path.join(resolveBotHome(botId), 'skills');
    symlinkSync(outside, path.join(skillsRoot, 'linked'));
    assert.ok(lstatSync(path.join(skillsRoot, 'linked')).isSymbolicLink());
    assert.throws(() => skills.save(botId, { name: 'linked', content: 'pwn' }), /escapes/);
    assert.equal(existsSync(path.join(outside, 'SKILL.md')), false);

    skills.disable(botId, 'good-skill');
    assert.equal(botSkillsDb.getByName(botId, 'good-skill')!.enabled, false);
    skills.enable(botId, 'good-skill');
    assert.equal(skills.remove(botId, 'good-skill'), true);
    assert.equal(existsSync(path.join(skillsRoot, 'good-skill')), false);
    assert.equal(skills.remove(botId, 'good-skill'), false);
  });
});

test('skills: fromRun makes a disabled draft from an episode or one of its runs', async () => {
  await withLearning(async ({ botId }) => {
    const episode = seedEpisode(botId, { plan: 'Sync the roadmap.', summary: 'Roadmap sync' });
    botEpisodesDb.update(episode.episode_id, { runIds: ['run_abc'] });
    seedDecision(botId, { episodeId: episode.episode_id, server: 'notion', tool: 'read_page', outcome: 'executed', decision: 'allow' });
    const fromEpisode = await skills.fromRun(botId, { episodeId: episode.episode_id });
    assert.equal(fromEpisode.name, 'roadmap-sync');
    assert.equal(fromEpisode.enabled, false);
    assert.equal(fromEpisode.origin, 'reflector');
    assert.match(skills.get(botId, 'roadmap-sync').content, /notion\.read_page/);
    const fromRunId = await skills.fromRun(botId, { runId: 'run_abc' });
    assert.equal(fromRunId.name, 'roadmap-sync-2', 'names stay unique');
    await assert.rejects(skills.fromRun(botId, { runId: 'nope' }), /No episode/);
  });
});

test('skills: catalog links are read-only, root-checked and never delete the source', async () => {
  await withLearning(async ({ botId, scratch }) => {
    const catalog = path.join(scratch, 'catalog');
    mkdirSync(path.join(catalog, 'shared-skill'), { recursive: true });
    const source = path.join(catalog, 'shared-skill', 'SKILL.md');
    writeFileSync(source, '---\nname: shared-skill\ndescription: Global one\n---\n# Shared\n');
    process.env.CLOUDCLI_SKILLS_CATALOG_DIRS = catalog;

    const linked = skills.linkCatalogSkill(botId, path.join(catalog, 'shared-skill'));
    assert.equal(linked.origin, 'catalog');
    assert.equal(linked.readonly, true);
    assert.equal(linked.description, 'Global one');
    assert.match(skills.get(botId, 'shared-skill').content, /# Shared/);
    assert.throws(() => skills.save(botId, { name: 'shared-skill', content: 'overwrite' }), /read-only/);
    assert.throws(() => skills.appendLesson(botId, 'shared-skill', 'note'), /read-only/);

    const secret = path.join(scratch, 'secret', 'SKILL.md');
    mkdirSync(path.dirname(secret));
    writeFileSync(secret, 'secret');
    assert.throws(() => skills.linkCatalogSkill(botId, secret), /not inside a known skills catalog/);
    assert.throws(() => skills.linkCatalogSkill(botId, path.join(catalog, 'missing')), /not found/i);

    assert.equal(skills.remove(botId, 'shared-skill'), true);
    assert.equal(existsSync(source), true, 'the global skill file is untouched');
  });
});

// ---- operator profile -------------------------------------------------------------------------

test('operator profile: CRUD, file mirror (atomic write + startup read) and the perceive section', async () => {
  await withLearning(async ({ botId, scratch }) => {
    const file = path.join(scratch, 'vault', 'operator-profile.md');
    process.env.CLOUDCLI_OPERATOR_PROFILE_PATH = file;
    operatorProfile.set('tone', 'Terse, no emojis');
    operatorProfile.set('timezone', 'Asia/Dubai');
    const written = readFileSync(file, 'utf8');
    assert.match(written, /- timezone: Asia\/Dubai/);
    assert.match(written, /- tone: Terse, no emojis/);
    assert.equal(existsSync(`${file}.tmp`), false);

    // Edit the file by hand (as in Obsidian), then "restart".
    writeFileSync(file, `${written}- jira: use bullet comments\n`.replace('Terse, no emojis', 'Very terse'));
    assert.equal(operatorProfile.syncFromFile(), 2);
    assert.equal(operatorProfile.get('jira')!.value, 'use bullet comments');
    assert.equal(operatorProfile.get('tone')!.value, 'Very terse');
    assert.equal(operatorProfile.get('tone')!.source, 'file');

    const section = missionControlDb.getSection(botId)!;
    const { prompt } = buildKernelPrompt({ section, events: [], reason: 'manual' });
    assert.match(prompt, /OPERATOR PREFERENCES[^\n]*\n- jira: use bullet comments/);
    assert.match(prompt, /- tone: Very terse/);

    for (let i = 0; i < 80; i += 1) operatorProfile.set(`pref ${String(i).padStart(2, '0')}`, 'x'.repeat(120));
    const capped = buildKernelPrompt({ section, events: [], reason: 'manual' }).prompt;
    const block = /OPERATOR PREFERENCES[^\n]*\n((?:- .*\n?)+)/.exec(capped)![0];
    assert.ok(block.length <= 1_600, `profile block is capped (${block.length})`);

    assert.equal(operatorProfile.delete('tone'), true);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /- tone:/);
    assert.throws(() => operatorProfile.set('bad:key/\n', 'v'), /Invalid profile key/);
  });
});

// ---- evals + shadow ---------------------------------------------------------------------------

function seedLabeledEpisode(botId: string, accepted: string[], dismissed: string[]) {
  const episode = seedEpisode(botId, { summary: 'labeled' });
  const items: string[] = [];
  botEventsDb.markConsumed([botEventsDb.insert({ botId, source: 't', kind: 'webhook', trust: 'external', payload: { n: randomUUID() } }).event.event_id], episode.episode_id);
  return { episode, items, run: async () => {
    for (const title of accepted) {
      const item = seedItem(botId, title, { episodeId: episode.episode_id });
      items.push(item.item_id);
      await applyItemAction(item.item_id, 'approve');
    }
    for (const title of dismissed) {
      const item = seedItem(botId, title, { episodeId: episode.episode_id });
      items.push(item.item_id);
      await applyItemAction(item.item_id, 'deny');
    }
    botEpisodesDb.update(episode.episode_id, { outcome: { item_ids: items } });
  } };
}

test('evals bridge: builds a mission_control suite tagged by bot with human_review cases, and rebuilds in place', async () => {
  await withLearning(async ({ botId }) => {
    const seeded = seedLabeledEpisode(botId, ['Quarterly report ready', 'Invoice from Acme'], ['Weekly newsletter']);
    await seeded.run();
    const suite = evalsBridge.buildSuite(botId);
    assert.equal(suite.scope, 'mission_control');
    assert.deepEqual(suite.tags, [`bot:${botId}`]);
    assert.equal(suite.cases.length, 3);
    const present = suite.cases.filter((c) => c.expected_outcome.present === true).map((c) => c.expected_outcome.title).sort();
    assert.deepEqual(present, ['Invoice from Acme', 'Quarterly report ready']);
    assert.equal(suite.cases.filter((c) => c.expected_outcome.present === false).length, 1);
    assert.ok(suite.cases.every((c) => c.graders.every((g) => g.type === 'human_review')));

    const other = missionControlDb.createSection({ title: 'Other', produce_prompt: 'x' });
    evalsBridge.buildSuite(other.section_id);
    const again = evalsBridge.buildSuite(botId);
    assert.equal(evalsService.list({ scope: 'mission_control' }).filter((s) => s.tags.includes(`bot:${botId}`)).length, 1);
    assert.equal(again.cases.length, 3);
  });
});

test('shadow: scores a candidate against accepted and dismissed items with token-Jaccard matching', async () => {
  await withLearning(async ({ botId }) => {
    const first = seedLabeledEpisode(botId, ['Quarterly report ready for review', 'Invoice from Acme Corp'], ['Weekly newsletter digest']);
    await first.run();
    const second = seedLabeledEpisode(botId, ['Contract renewal due Friday'], ['Flash sale newsletter']);
    await second.run();
    // An episode without verdicts is listed but not scored.
    seedLabeledEpisode(botId, [], []);

    const runner: ShadowRunner = async ({ episodeId, events, candidate }) => {
      assert.ok(events.length > 0);
      assert.equal(candidate.produce_prompt, 'Only report what needs action.');
      if (episodeId === first.episode.episode_id) return ['Quarterly report ready for review', 'Weekly newsletter digest', 'Totally unrelated thing'];
      if (episodeId === second.episode.episode_id) return ['Contract renewal due Friday'];
      return ['Something'];
    };
    const result = await shadow.evaluate(botId, { produce_prompt: 'Only report what needs action.' }, { episodes: 5, runner });
    assert.equal(result.episodes, 3);
    const one = result.perEpisode.find((e) => e.episodeId === first.episode.episode_id)!;
    assert.equal(one.truePositives, 1);
    assert.equal(one.falsePositives, 1);
    assert.equal(one.precision, 0.5);
    assert.equal(one.recall, 0.5);
    const two = result.perEpisode.find((e) => e.episodeId === second.episode.episode_id)!;
    assert.deepEqual([two.precision, two.recall, two.f1], [1, 1, 1]);
    assert.equal(result.perEpisode.filter((e) => e.labeled).length, 2);
    // Micro average: tp 2, fp 1, positives 3, matched 2.
    assert.deepEqual(result.candidate, { precision: 0.667, recall: 0.667, f1: 0.667 });
    // Baseline: what the current version actually produced (all accepted + dismissed titles).
    assert.deepEqual(result.baseline, { precision: 0.6, recall: 1, f1: 0.75 });
    assert.equal(result.verdict, 'worse');
    assert.equal(result.deltaF1, -0.083);

    const limited = await shadow.evaluate(botId, {}, { episodes: 1, runner: async () => [] });
    assert.equal(limited.perEpisode.length, 1);
    const none = await shadow.evaluate(botId, {}, { episodes: 5, runner: async () => [] });
    assert.equal(none.candidate.f1, 0);
  });
});

// ---- privacy ----------------------------------------------------------------------------------

test('privacy: export is complete and masks secrets; purge removes selected data including FTS rows and skill files', async () => {
  await withLearning(async ({ botId }) => {
    patchBotRuntimeConfig(botId, { backend: 'ssh', backend_config: { host: 'box', api_token: 'hunter2' } });
    const episode = seedEpisode(botId, { plan: 'remember the zebra plan', summary: 'zebra summary' });
    const item = seedItem(botId, 'Zebra item', { episodeId: episode.episode_id });
    await applyItemAction(item.item_id, 'deny');
    botEventsDb.insert({ botId, source: 't', kind: 'webhook', trust: 'external', payload: { hello: 'world' } });
    reviewBotMemory(botId, proposeBotMemory(botId, 'Likes zebras', null).memoryId, 'approved');
    botThreadDb.post(botId, { role: 'operator', body: 'hi bot' });
    botProposalsDb.create({ botId, kind: 'memory', title: 'pending', payload: { content: 'x' } });
    seedDecision(botId, { episodeId: episode.episode_id, outcome: 'executed', decision: 'allow' });
    botRulesDb.create({ scope: 'bot', botId, decision: 'allow', match: { server: 's', tool: 't' } });
    skills.save(botId, { name: 'zebra-care', content: '# Zebra care\n' });
    const skillDir = path.join(resolveBotHome(botId), 'skills');
    mkdirSync(path.join(skillDir, 'stray'), { recursive: true });
    writeFileSync(path.join(skillDir, 'stray', 'notes.txt'), 'stray');

    const dump = privacy.exportBot(botId) as Record<string, any>;
    for (const key of ['section', 'runtime', 'goals', 'commitments', 'episodes', 'events', 'memories', 'rules', 'gate_decisions', 'skills', 'thread', 'proposals']) {
      assert.ok(key in dump, `export has ${key}`);
    }
    assert.equal(dump.episodes.length, 1);
    assert.equal(dump.events.length, 1);
    assert.equal(dump.memories.length, 1);
    assert.equal(dump.rules.length, 1);
    assert.equal(dump.gate_decisions.length, 1);
    assert.equal(dump.thread.length, 1);
    assert.equal(dump.proposals.length, 1, 'the hidden feedback log is not a proposal');
    assert.equal(dump.feedback_log.length + dump.episodes[0].feedback.length, 1);
    assert.match(dump.skills[0].content, /Zebra care/);
    assert.equal(dump.runtime.backend_config.api_token, '[redacted]');
    assert.equal(dump.runtime.backend_config.host, 'box');
    assert.doesNotMatch(JSON.stringify(dump), /hunter2/);

    const counts = privacy.purgeBot(botId, { memories: true, episodes: true });
    assert.equal(counts.memories, 1);
    assert.equal(counts.episodes, 1);
    assert.equal(listBotMemories(botId).length, 0);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM bot_episodes_fts WHERE bot_id = ?').get(botId) as { n: number }).n, 0);
    assert.equal(botEpisodesDb.search(botId, 'zebra').length, 0);
    assert.equal(botEventsDb.listRecent(botId).length, 1, 'unselected data stays');
    assert.equal(botSkillsDb.list(botId).length, 1);

    privacy.purgeBot(botId, { events: true, threads: true, proposals: true, skills: true });
    assert.equal(botEventsDb.listRecent(botId).length, 0);
    assert.equal(botThreadDb.list(botId).length, 0);
    assert.equal(botProposalsDb.list(botId).length, 0);
    assert.equal(botSkillsDb.list(botId).length, 0);
    assert.equal(existsSync(skillDir), false);
    const empty = privacy.exportBot(botId) as Record<string, any>;
    assert.deepEqual([empty.episodes.length, empty.events.length, empty.memories.length, empty.thread.length, empty.proposals.length], [0, 0, 0, 0, 0]);
  });
});

// ---- routes -----------------------------------------------------------------------------------

test('routes: proposals, skills, profile, shadow (202 + poll), export and purge', async () => {
  await withLearning(async ({ botId }) => {
    const app = express();
    app.use(express.json());
    app.use('/api/bots', botLearningRouter);
    app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ error: error.message });
    });
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots`;
    const call = async (method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> => {
      const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    try {
      assert.equal((await call('GET', '/nope/proposals')).status, 404);
      const proposal = botProposalsDb.create({ botId, kind: 'memory', title: 'm', payload: { content: 'Route memory' } });
      assert.equal((await call('GET', `/${botId}/proposals?status=proposed`)).json.proposals.length, 1);
      assert.equal((await call('GET', `/${botId}/proposals?status=bogus`)).status, 400);
      assert.equal((await call('POST', `/${botId}/proposals/${proposal.proposal_id}/approve`, { editedBody: 'Edited route memory' })).json.proposal.status, 'applied');
      assert.equal(listBotMemories(botId)[0]!.content, 'Edited route memory');
      const second = botProposalsDb.create({ botId, kind: 'memory', title: 'm2', payload: { content: 'x' } });
      assert.equal((await call('POST', `/${botId}/proposals/${second.proposal_id}/reject`)).json.proposal.status, 'rejected');
      assert.equal((await call('POST', `/${botId}/proposals/${second.proposal_id}/approve`)).status, 409);

      assert.equal((await call('PUT', `/${botId}/skills/bad..name`, { content: 'x' })).status, 400);
      assert.equal((await call('PUT', `/${botId}/skills/route-skill`, { content: '# R\n', description: 'Routed' })).status, 200);
      assert.equal((await call('GET', `/${botId}/skills`)).json.skills[0].description, 'Routed');
      assert.match((await call('GET', `/${botId}/skills/route-skill`)).json.content, /# R/);
      assert.equal((await call('POST', `/${botId}/skills/route-skill/disable`)).json.skill.enabled, false);
      assert.equal((await call('DELETE', `/${botId}/skills/route-skill`)).json.deleted, true);
      assert.equal((await call('DELETE', `/${botId}/skills/route-skill`)).status, 404);

      assert.equal((await call('PUT', '/operator-profile/tone', { value: 'Brief' })).json.entry.value, 'Brief');
      assert.equal((await call('GET', '/operator-profile')).json.entries.length, 1);
      assert.equal((await call('DELETE', '/operator-profile/tone')).json.deleted, true);

      // Shadow: default runner against a fake provider.
      const seeded = seedLabeledEpisode(botId, ['Quarterly report ready'], []);
      await seeded.run();
      const runtime = fakeRuntime('{"summary":"s","items":[{"title":"Quarterly report ready","summary":"","body":{},"dedupeKey":"k","confidence":0.9}]}');
      configureMissionControlRuntimes({ claude: runtime.fn } as never);
      const started = await call('POST', `/${botId}/shadow`, { produce_prompt: 'Candidate brief', memories: ['Be brief'], episodes: 3 });
      assert.equal(started.status, 202);
      let job: any;
      for (let i = 0; i < 200; i += 1) {
        job = (await call('GET', `/${botId}/shadow/${started.json.jobId}`)).json.job;
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(job.status, 'done', job.error ?? '');
      assert.equal(job.result.candidate.recall, 1);
      assert.match(runtime.prompts[0]!, /Candidate brief/);
      assert.match(runtime.prompts[0]!, /CANDIDATE MEMORIES[\s\S]*Be brief/);
      assert.equal(runtime.prompts.length, 1);
      assert.equal((await call('GET', `/${botId}/shadow/unknown`)).status, 404);

      assert.equal((await call('GET', `/${botId}/export`)).json.bot_id, botId);
      assert.equal((await call('POST', `/${botId}/purge`, {})).status, 400);
      assert.equal((await call('POST', `/${botId}/purge`, { memories: true })).json.purged.memories, 1);
      assert.equal((await call('POST', `/${botId}/evals/suite`)).json.suite.scope, 'mission_control');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
