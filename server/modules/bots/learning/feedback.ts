/**
 * Feedback capture: turns Mission Control review events into entries on the episode that produced
 * the item (`feedback_json`), or, for items without an episode, into a per-bot rolling log kept as
 * the evidence of a hidden sentinel row in bot_learning_proposals.
 */
import { isBotsRuntimeV2Enabled } from '@/modules/app-features/index.js';
import type { ItemFeedbackEvent, McItem } from '@/modules/mission-control/index.js';
import type { BotLearningProposal } from '@/modules/bots/bots.types.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botProposalsDb } from '@/modules/bots/learning/bot-proposals.repository.js';
import { clip, isRecord, tokenize } from '@/modules/bots/learning/learning.util.js';

export interface FeedbackEntry {
  kind: string;
  at: string;
  actor: 'human' | 'auto';
  text?: string;
  action?: string;
  item_id?: string;
  title?: string;
  features?: string[];
  episode_id?: string;
}

export const FEEDBACK_LOG_TITLE = '__bot_feedback_log__';
const FEEDBACK_LOG_KIND = 'goal';
const MAX_BOT_LOG = 300;
const MAX_EPISODE_FEEDBACK = 200;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/;
const SENDER_KEYS = ['from', 'sender', 'fromEmail', 'from_email', 'email', 'author'];
const SOURCE_KEYS = ['type', 'kind', 'system', 'provider', 'channel', 'source'];

function firstEmail(item: McItem): { email: string; domain: string } | null {
  for (const holder of [item.source, item.body]) {
    for (const key of SENDER_KEYS) {
      const value = holder[key];
      const text = typeof value === 'string' ? value : isRecord(value) ? JSON.stringify(value) : '';
      const match = EMAIL.exec(text);
      if (match) return { email: match[0].toLowerCase(), domain: match[1].toLowerCase() };
    }
  }
  const blob = clip(`${item.summary} ${JSON.stringify(item.body)} ${JSON.stringify(item.source)}`, 4_000);
  const match = EMAIL.exec(blob);
  return match ? { email: match[0].toLowerCase(), domain: match[1].toLowerCase() } : null;
}

/** Comparable features of an item: sender / domain / source / title keywords. */
export function deriveFeatures(item: McItem): string[] {
  const features: string[] = [];
  const sender = firstEmail(item);
  if (sender) features.push(`sender:${sender.email}`, `domain:${sender.domain}`);
  for (const key of SOURCE_KEYS) {
    const value = item.source[key];
    if (typeof value === 'string' && value.trim() && value.length <= 60) {
      features.push(`source:${value.trim().toLowerCase()}`);
      break;
    }
  }
  for (const token of new Set(tokenize(item.title))) if (token.length >= 4) features.push(`kw:${token}`);
  return features;
}

function getOrCreateLog(botId: string): BotLearningProposal {
  const existing = botProposalsDb.list(botId).find((p) => p.title === FEEDBACK_LOG_TITLE && p.kind === FEEDBACK_LOG_KIND);
  if (existing) return existing;
  const created = botProposalsDb.create({ botId, kind: FEEDBACK_LOG_KIND as 'goal', title: FEEDBACK_LOG_TITLE, evidence: [] });
  return botProposalsDb.setStatus(created.proposal_id, 'superseded') ?? created;
}

export function readBotFeedbackLog(botId: string): FeedbackEntry[] {
  return getLogEntries(botId);
}

function getLogEntries(botId: string): FeedbackEntry[] {
  const log = botProposalsDb.list(botId).find((p) => p.title === FEEDBACK_LOG_TITLE && p.kind === FEEDBACK_LOG_KIND);
  return (log?.evidence ?? []).filter(isRecord) as unknown as FeedbackEntry[];
}

function appendBotLog(botId: string, entry: FeedbackEntry): void {
  const log = getOrCreateLog(botId);
  const next = [...log.evidence, entry].slice(-MAX_BOT_LOG);
  botProposalsDb.setEvidence(log.proposal_id, next);
}

export function isHiddenProposal(proposal: BotLearningProposal): boolean {
  return proposal.title === FEEDBACK_LOG_TITLE && proposal.kind === (FEEDBACK_LOG_KIND as string);
}

export function buildFeedbackEntry(event: ItemFeedbackEvent): FeedbackEntry {
  return {
    kind: event.kind,
    at: event.at,
    actor: event.actor,
    ...(event.text ? { text: clip(event.text, 2_000) } : {}),
    ...(event.actionId ? { action: event.actionId } : {}),
    item_id: event.itemId,
    title: clip(event.item.title, 200),
    features: deriveFeatures(event.item),
  };
}

/** Persist one feedback event. Returns the entry and where it was stored. */
export function captureItemFeedback(event: ItemFeedbackEvent): { entry: FeedbackEntry; episodeId: string | null } | null {
  if (!isBotsRuntimeV2Enabled()) return null;
  const entry = buildFeedbackEntry(event);
  const episodeId = typeof event.item.source.episodeId === 'string' ? event.item.source.episodeId : null;
  const episode = episodeId ? botEpisodesDb.get(episodeId) : null;
  if (episode && episode.bot_id === event.sectionId) {
    botEpisodesDb.update(episode.episode_id, { feedback: [...episode.feedback, entry].slice(-MAX_EPISODE_FEEDBACK) });
    return { entry, episodeId: episode.episode_id };
  }
  appendBotLog(event.sectionId, entry);
  return { entry, episodeId: null };
}

/** Every feedback entry for a bot at or after `sinceMs` (episode feedback + the bot-level log). */
export function collectFeedback(botId: string, sinceMs: number): FeedbackEntry[] {
  const out: FeedbackEntry[] = [];
  for (const episode of botEpisodesDb.list(botId, 500)) {
    for (const raw of episode.feedback) {
      if (isRecord(raw)) out.push({ ...(raw as unknown as FeedbackEntry), episode_id: episode.episode_id });
    }
  }
  out.push(...getLogEntries(botId));
  return out
    .filter((entry) => typeof entry.at === 'string' && Date.parse(entry.at) >= sinceMs)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export const POSITIVE_KINDS = new Set(['approve', 'accept']);
export const NEGATIVE_KINDS = new Set(['deny', 'dismiss', 'delete', 'send_back']);
