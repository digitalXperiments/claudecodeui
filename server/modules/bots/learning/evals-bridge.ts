/**
 * Evals bridge: a per-bot regression suite built from the operator's own verdicts. Accepted items are
 * cases that must be produced, dismissed items are cases that must not be. The only honest grader
 * available is human review, so that is what each case carries.
 */
import { DEFAULT_EVAL_ACTION_POLICY, evalsService, type EvalCaseDraft, type EvalSuite } from '@/modules/evals/index.js';
import { collectFeedback, NEGATIVE_KINDS, POSITIVE_KINDS } from '@/modules/bots/learning/feedback.js';
import { DAY_MS, learningError } from '@/modules/bots/learning/learning.util.js';
import { missionControlDb } from '@/modules/mission-control/index.js';

const SUITE_WINDOW_DAYS = 90;
const MAX_CASES_PER_SIDE = 50;

export interface LabeledItem {
  itemId: string;
  title: string;
  episodeId: string | null;
  positive: boolean;
  at: string;
}

/** Latest human verdict per item (accept/approve = positive; dismiss/deny/delete/send back = negative). */
export function labeledItems(botId: string, sinceMs: number): LabeledItem[] {
  const latest = new Map<string, LabeledItem>();
  for (const entry of collectFeedback(botId, sinceMs)) {
    if (entry.actor !== 'human' || !entry.item_id || !entry.title) continue;
    const positive = POSITIVE_KINDS.has(entry.kind);
    if (!positive && !NEGATIVE_KINDS.has(entry.kind)) continue;
    latest.set(entry.item_id, { itemId: entry.item_id, title: entry.title, episodeId: entry.episode_id ?? null, positive, at: entry.at });
  }
  return [...latest.values()].sort((a, b) => b.at.localeCompare(a.at));
}

const suiteTag = (botId: string): string => `bot:${botId}`;

export function findSuite(botId: string): EvalSuite | null {
  return evalsService.list({ scope: 'mission_control' }).find((suite) => suite.tags.includes(suiteTag(botId))) ?? null;
}

function toCase(item: LabeledItem): EvalCaseDraft {
  return {
    name: `${item.positive ? 'Should produce' : 'Should not produce'}: ${item.title}`.slice(0, 160),
    description: item.positive ? 'The operator accepted this item.' : 'The operator dismissed or sent back this item.',
    prompt: `Would the bot produce an item like "${item.title}" for the same inputs? Expected: ${item.positive ? 'present' : 'absent'}.`,
    difficulty: 'basic',
    expectedOutcome: { present: item.positive, title: item.title },
    tags: [item.positive ? 'positive' : 'negative'],
    metadata: { item_id: item.itemId, episode_id: item.episodeId },
    graders: [{ name: 'Operator review', type: 'human_review', config: { question: item.positive ? 'Is an equivalent item present?' : 'Is the item absent?' }, required: true, weight: 1 }],
  };
}

export const evalsBridge = {
  /** Create the bot's suite, or replace its cases with the latest history (the suite is rebuilt). */
  buildSuite(botId: string): EvalSuite {
    const section = missionControlDb.getSection(botId);
    if (!section) throw learningError('Bot not found', 404, 'BOT_NOT_FOUND');
    const labeled = labeledItems(botId, Date.now() - SUITE_WINDOW_DAYS * DAY_MS);
    const cases = [
      ...labeled.filter((i) => i.positive).slice(0, MAX_CASES_PER_SIDE),
      ...labeled.filter((i) => !i.positive).slice(0, MAX_CASES_PER_SIDE),
    ].map(toCase);
    const existing = findSuite(botId);
    if (existing) evalsService.delete(existing.suite_id);
    return evalsService.create({
      name: `${section.title} regression`,
      description: `Built from ${cases.length} operator verdicts on ${section.title}.`,
      objective: 'Accepted items are still produced; dismissed items stay out.',
      scope: 'mission_control',
      trigger: 'manual',
      actionPolicy: DEFAULT_EVAL_ACTION_POLICY,
      tags: [suiteTag(botId)],
      cases,
      status: 'draft',
      source: 'manual',
    });
  },
  findSuite,
};
