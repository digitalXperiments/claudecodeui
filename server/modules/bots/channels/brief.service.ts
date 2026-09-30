/**
 * Morning brief: a deterministic aggregation across all bots (no model call), rendered to
 * markdown plus a structured document. Scheduled daily from the global channel policy
 * `brief_at` ("HH:MM") and delivered through `notifyOperator`.
 */

import { Cron } from 'croner';

import { appConfigDb, getConnection } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { botChannelsDb } from '@/modules/bots/channels/bot-channels.repository.js';
import { type ChannelPolicy, isValidTimeZone, onChannelsChanged } from '@/modules/bots/channels/channels.service.js';
import { notifyOperator } from '@/modules/bots/channels/notify.service.js';

export const BRIEF_LAST_SENT_CONFIG = 'bots.brief_last_sent_at';
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_SUMMARIES = 3;
const LIST_CAP = 25;

export interface BriefBot {
  bot_id: string;
  title: string;
  episodes: { count: number; succeeded: number; failed: number; top_summaries: string[] };
  cost_usd: number;
}

export interface BriefDoc {
  generated_at: string;
  since: string;
  totals: { episodes: number; failed: number; cost_usd: number };
  bots: BriefBot[];
  awaiting_you: {
    approvals: Array<{ interrupt_id: string; bot_id: string; title: string; kind: string; created_at: string }>;
    in_qa: Array<{ item_id: string; bot_id: string; title: string }>;
  };
  gate_decisions_awaiting: Array<{ decision_id: string; bot_id: string; server: string; tool: string; risk: string; interrupt_id: string | null }>;
  commitments_due: Array<{ commitment_id: string; bot_id: string; description: string; due_at: string; waiting_on: string | null }>;
  learning_proposals: Array<{ proposal_id: string; bot_id: string; kind: string; title: string; confidence: number }>;
  suppressed: Array<{ bot_id: string | null; channel: string; reason: string; created_at: string }>;
  markdown: string;
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

function botIdOfInterrupt(meta: Record<string, unknown>): string {
  for (const key of ['botId', 'bot_id', 'sectionId', 'section_id']) {
    if (typeof meta[key] === 'string' && meta[key]) return meta[key] as string;
  }
  return '';
}

export function lastBriefSince(now: Date = new Date()): string {
  const stored = appConfigDb.get(BRIEF_LAST_SENT_CONFIG);
  if (stored && !Number.isNaN(Date.parse(stored))) return stored;
  return new Date(now.getTime() - DAY_MS).toISOString();
}

export function generateBrief(options: { since?: string; now?: Date } = {}): BriefDoc {
  const now = options.now ?? new Date();
  const since = options.since && !Number.isNaN(Date.parse(options.since)) ? new Date(options.since).toISOString() : lastBriefSince(now);
  const db = getConnection();
  const titles = new Map(missionControlDb.listSections().map((section) => [section.section_id, section.title]));
  const titleOf = (botId: string | null): string => (botId ? (titles.get(botId) ?? botId) : 'all bots');

  const episodeRows = db
    .prepare(
      `SELECT bot_id, status, summary, cost_usd FROM bot_episodes
       WHERE started_at >= ? AND status != 'running' ORDER BY started_at DESC`,
    )
    .all(since) as Array<{ bot_id: string; status: string; summary: string; cost_usd: number }>;
  const botMap = new Map<string, BriefBot>();
  for (const row of episodeRows) {
    const bot =
      botMap.get(row.bot_id)
      ?? { bot_id: row.bot_id, title: titleOf(row.bot_id), episodes: { count: 0, succeeded: 0, failed: 0, top_summaries: [] }, cost_usd: 0 };
    bot.episodes.count += 1;
    if (row.status === 'succeeded') bot.episodes.succeeded += 1;
    if (row.status === 'failed') bot.episodes.failed += 1;
    if (row.summary && bot.episodes.top_summaries.length < TOP_SUMMARIES) bot.episodes.top_summaries.push(row.summary.slice(0, 200));
    bot.cost_usd += row.cost_usd || 0;
    botMap.set(row.bot_id, bot);
  }
  const bots = [...botMap.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.episodes.count - a.episodes.count);

  const approvals = interruptsService
    .list({ status: ['open', 'snoozed'], limit: 200 })
    .filter((interrupt) => interrupt.kind === 'approval_pending' && botIdOfInterrupt(interrupt.meta))
    .slice(0, LIST_CAP)
    .map((interrupt) => ({
      interrupt_id: interrupt.interrupt_id,
      bot_id: botIdOfInterrupt(interrupt.meta),
      title: interrupt.title,
      kind: interrupt.kind,
      created_at: interrupt.created_at,
    }));
  const inQa = (db
    .prepare(`SELECT item_id, section_id AS bot_id, title FROM mc_items WHERE status = 'in_qa' ORDER BY created_at DESC LIMIT ?`)
    .all(LIST_CAP)) as BriefDoc['awaiting_you']['in_qa'];
  const gate = (db
    .prepare(
      `SELECT decision_id, bot_id, server, tool, risk, interrupt_id FROM bot_gate_decisions
       WHERE decision = 'ask' AND outcome IS NULL ORDER BY created_at DESC LIMIT ?`,
    )
    .all(LIST_CAP)) as BriefDoc['gate_decisions_awaiting'];
  const commitments = (db
    .prepare(
      `SELECT commitment_id, bot_id, description, due_at, waiting_on FROM bot_commitments
       WHERE status = 'open' AND due_at <= ? ORDER BY due_at ASC LIMIT ?`,
    )
    .all(new Date(now.getTime() + DAY_MS).toISOString(), LIST_CAP)) as BriefDoc['commitments_due'];
  const proposals = (db
    .prepare(
      `SELECT proposal_id, bot_id, kind, title, confidence FROM bot_learning_proposals
       WHERE status = 'proposed' ORDER BY created_at DESC LIMIT ?`,
    )
    .all(LIST_CAP)) as BriefDoc['learning_proposals'];
  const suppressed = (db
    .prepare(
      `SELECT bot_id, channel_kind AS channel, reason, created_at FROM bot_outbound_log
       WHERE delivered = 0 AND created_at >= ? AND (reason LIKE 'digest%' OR reason LIKE 'quiet_hours%')
       ORDER BY created_at ASC LIMIT 100`,
    )
    .all(since)) as Array<{ bot_id: string | null; channel: string; reason: string; created_at: string }>;

  const doc: BriefDoc = {
    generated_at: now.toISOString(),
    since,
    totals: {
      episodes: bots.reduce((sum, bot) => sum + bot.episodes.count, 0),
      failed: bots.reduce((sum, bot) => sum + bot.episodes.failed, 0),
      cost_usd: Math.round(bots.reduce((sum, bot) => sum + bot.cost_usd, 0) * 10_000) / 10_000,
    },
    bots: bots.map((bot) => ({ ...bot, cost_usd: Math.round(bot.cost_usd * 10_000) / 10_000 })),
    awaiting_you: { approvals, in_qa: inQa },
    gate_decisions_awaiting: gate,
    commitments_due: commitments,
    learning_proposals: proposals,
    suppressed,
    markdown: '',
  };
  doc.markdown = renderBriefMarkdown(doc, titleOf);
  return doc;
}

export function renderBriefMarkdown(doc: BriefDoc, titleOf: (botId: string | null) => string): string {
  const lines: string[] = [`# Morning brief`, `_Since ${doc.since}_`, ''];
  lines.push(`## What happened`);
  if (doc.bots.length === 0) lines.push('No bot activity.');
  for (const bot of doc.bots) {
    lines.push(`- **${bot.title}**: ${bot.episodes.count} episode(s), ${bot.episodes.failed} failed, ${usd(bot.cost_usd)}`);
    for (const summary of bot.episodes.top_summaries) lines.push(`  - ${summary}`);
  }
  lines.push('', `## Needs you`);
  const needs =
    doc.awaiting_you.approvals.length + doc.awaiting_you.in_qa.length + doc.gate_decisions_awaiting.length;
  if (needs === 0) lines.push('Nothing is waiting on you.');
  for (const a of doc.awaiting_you.approvals) lines.push(`- Approval (${titleOf(a.bot_id)}): ${a.title}`);
  for (const q of doc.awaiting_you.in_qa) lines.push(`- In QA (${titleOf(q.bot_id)}): ${q.title}`);
  for (const g of doc.gate_decisions_awaiting) lines.push(`- Gate (${titleOf(g.bot_id)}): ${g.server}/${g.tool} [${g.risk}]`);
  if (doc.commitments_due.length > 0) {
    lines.push('', `## Commitments due within 24h`);
    for (const c of doc.commitments_due) lines.push(`- ${titleOf(c.bot_id)}: ${c.description} (due ${c.due_at}${c.waiting_on ? `, waiting on ${c.waiting_on}` : ''})`);
  }
  if (doc.learning_proposals.length > 0) {
    lines.push('', `## Learning proposals to review`);
    for (const p of doc.learning_proposals) lines.push(`- ${titleOf(p.bot_id)} [${p.kind}]: ${p.title} (${Math.round(p.confidence * 100)}%)`);
  }
  lines.push('', `## Cost`, `Total ${usd(doc.totals.cost_usd)} across ${doc.totals.episodes} episode(s).`);
  if (doc.suppressed.length > 0) {
    lines.push('', `## Held back for this brief`);
    for (const s of doc.suppressed) lines.push(`- ${titleOf(s.bot_id)} (${s.channel}): ${s.reason.replace(/^[a-z_]+: ?/, '')}`);
  }
  return lines.join('\n');
}

/** Generate and deliver the brief through the notification policy; remembers the send time. */
export async function sendBrief(options: { since?: string; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const doc = generateBrief({ since: options.since, now });
  const result = await notifyOperator(
    { botId: null, title: 'Morning brief', body: doc.markdown.slice(0, 3_500), urgency: 0.5, href: '/bots', scheduled: true },
    { now },
  );
  appConfigDb.set(BRIEF_LAST_SENT_CONFIG, now.toISOString());
  return { brief: doc, ...result };
}

// ---- scheduler ------------------------------------------------------------------

let job: Cron | null = null;
let unsubscribe: (() => void) | null = null;

/** The first global channel policy that sets `brief_at`, as a cron pattern. */
export function resolveBriefSchedule(): { pattern: string; timezone?: string } | null {
  for (const channel of botChannelsDb.list(null)) {
    const policy = channel.policy as ChannelPolicy;
    if (!channel.enabled || !policy.brief_at) continue;
    const [hour, minute] = policy.brief_at.split(':').map(Number);
    const tz = policy.brief_tz ?? policy.quiet_hours?.tz;
    return { pattern: `${minute} ${hour} * * *`, ...(tz && isValidTimeZone(tz) ? { timezone: tz } : {}) };
  }
  return null;
}

export function syncBriefSchedule(): void {
  job?.stop();
  job = null;
  const schedule = resolveBriefSchedule();
  if (!schedule) return;
  job = new Cron(schedule.pattern, { timezone: schedule.timezone, protect: true }, () => {
    void sendBrief().catch((error) => console.warn('[BotChannels] brief failed', error instanceof Error ? error.message : error));
  });
}

export function startBriefScheduler(): void {
  syncBriefSchedule();
  unsubscribe ??= onChannelsChanged(syncBriefSchedule);
}

export function stopBriefScheduler(): void {
  job?.stop();
  job = null;
  unsubscribe?.();
  unsubscribe = null;
}

export const brief = { generate: generateBrief, send: sendBrief };
