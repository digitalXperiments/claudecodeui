/** Pure shaping for the Brief view: presets, title lookup, section lists, formatting. */

import type { BotBrief } from '../../types/botRuntime';

export type BriefPresetId = '24h' | '3d' | '7d';

const HOUR_MS = 3_600_000;

export const BRIEF_PRESETS: Array<{ id: BriefPresetId; label: string; ms: number }> = [
  { id: '24h', label: '24 hours', ms: 24 * HOUR_MS },
  { id: '3d', label: '3 days', ms: 72 * HOUR_MS },
  { id: '7d', label: '7 days', ms: 168 * HOUR_MS },
];

export const DEFAULT_BRIEF_PRESET: BriefPresetId = '24h';

/** ISO timestamp `preset` ago, sent as the brief's `since`. */
export function briefSince(preset: BriefPresetId, now: Date = new Date()): string {
  const match = BRIEF_PRESETS.find((entry) => entry.id === preset) ?? BRIEF_PRESETS[0];
  return new Date(now.getTime() - match.ms).toISOString();
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

/** "overdue 2h", "due in 3h", "due now". Falls back to the raw text on an unparseable date. */
export function formatDue(dueAt: string, now: Date = new Date()): { label: string; overdue: boolean } {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return { label: dueAt, overdue: false };
  const diff = due - now.getTime();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const amount = minutes < 1 ? '' : minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
  if (!amount) return { label: 'due now', overdue: false };
  return diff < 0 ? { label: `overdue ${amount}`, overdue: true } : { label: `due in ${amount}`, overdue: false };
}

export function titleLookup(bots: Array<{ section_id: string; title: string }>): (botId: string | null | undefined) => string {
  const map = new Map(bots.map((bot) => [bot.section_id, bot.title]));
  return (botId) => (botId ? (map.get(botId) ?? botId) : 'All bots');
}

export type BriefBotRow = {
  botId: string;
  title: string;
  count: number;
  succeeded: number;
  failed: number;
  hasFailures: boolean;
  summaries: string[];
  costUsd: number;
  /** Share of the total cost, 0-1. */
  costShare: number;
};

/** Per-bot rows: failing bots first, then by episode count. */
export function botRows(brief: BotBrief, titleOf: (botId: string) => string): BriefBotRow[] {
  const totalCost = brief.bots.reduce((sum, bot) => sum + (bot.cost_usd || 0), 0);
  return brief.bots
    .map((bot): BriefBotRow => ({
      botId: bot.bot_id,
      title: bot.title || titleOf(bot.bot_id),
      count: bot.episodes.count,
      succeeded: bot.episodes.succeeded,
      failed: bot.episodes.failed,
      hasFailures: bot.episodes.failed > 0,
      summaries: bot.episodes.top_summaries,
      costUsd: bot.cost_usd || 0,
      costShare: totalCost > 0 ? (bot.cost_usd || 0) / totalCost : 0,
    }))
    .sort((a, b) => Number(b.hasFailures) - Number(a.hasFailures) || b.failed - a.failed || b.count - a.count);
}

/** Bots with spend, highest first (the cost section). */
export function costRows(rows: BriefBotRow[]): BriefBotRow[] {
  return rows.filter((row) => row.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd);
}

export type LearningGroup = {
  botId: string;
  title: string;
  proposals: BotBrief['learning_proposals'];
};

/** Learning proposals grouped per bot so each group can link to that bot's Learning tab. */
export function learningGroups(brief: BotBrief, titleOf: (botId: string) => string): LearningGroup[] {
  const groups = new Map<string, LearningGroup>();
  for (const proposal of brief.learning_proposals) {
    const group = groups.get(proposal.bot_id) ?? { botId: proposal.bot_id, title: titleOf(proposal.bot_id), proposals: [] };
    group.proposals.push(proposal);
    groups.set(proposal.bot_id, group);
  }
  return [...groups.values()].sort((a, b) => b.proposals.length - a.proposals.length || a.title.localeCompare(b.title));
}

export type HeldBackPing = {
  botId: string | null;
  channel: string;
  /** `quiet_hours`, `digest`, ... (the part before the first colon). */
  why: string;
  title: string;
  createdAt: string;
};

/** The server logs held-back pings as `<reason>: <title>`; split that back apart. */
export function heldBackPings(brief: BotBrief): HeldBackPing[] {
  return brief.suppressed.map((entry) => {
    const index = entry.reason.indexOf(':');
    const why = (index >= 0 ? entry.reason.slice(0, index) : entry.reason).trim();
    const title = index >= 0 ? entry.reason.slice(index + 1).trim() : '';
    return { botId: entry.bot_id, channel: entry.channel, why: why.replace(/_/g, ' '), title, createdAt: entry.created_at };
  });
}

export type BriefCommitment = BotBrief['commitments_due'][number] & { due: { label: string; overdue: boolean } };

export function commitmentRows(brief: BotBrief, now: Date = new Date()): BriefCommitment[] {
  return brief.commitments_due.map((entry) => ({ ...entry, due: formatDue(entry.due_at, now) }));
}

export type BriefSummary = {
  awaitingCount: number;
  gateCount: number;
  commitmentCount: number;
  learningCount: number;
  heldBackCount: number;
  /** True when there is nothing to report at all. */
  quiet: boolean;
};

export function summarizeBrief(brief: BotBrief): BriefSummary {
  const awaitingCount = brief.awaiting_you.approvals.length + brief.awaiting_you.in_qa.length;
  const gateCount = brief.gate_decisions_awaiting.length;
  const commitmentCount = brief.commitments_due.length;
  const learningCount = brief.learning_proposals.length;
  const heldBackCount = brief.suppressed.length;
  return {
    awaitingCount,
    gateCount,
    commitmentCount,
    learningCount,
    heldBackCount,
    quiet: brief.totals.episodes === 0 && awaitingCount + gateCount + commitmentCount + learningCount + heldBackCount === 0,
  };
}

/** "3 sent, 1 held back, 1 failed" from POST /brief/send's `{ delivered, suppressed, failed }`. */
export function describeSendResult(result: Record<string, unknown>): { text: string; ok: boolean } {
  const list = (key: string): string[] => (Array.isArray(result[key]) ? (result[key] as unknown[]).map(String) : []);
  const delivered = list('delivered');
  const suppressed = list('suppressed');
  const failed = list('failed');
  const parts: string[] = [];
  if (delivered.length) parts.push(`delivered on ${delivered.join(', ')}`);
  if (suppressed.length) parts.push(`held back on ${suppressed.join(', ')}`);
  if (failed.length) parts.push(`failed on ${failed.join(', ')}`);
  const text = parts.length ? `Brief ${parts.join('; ')}.` : 'No channels are configured to receive the brief.';
  return { text, ok: failed.length === 0 && delivered.length > 0 };
}
