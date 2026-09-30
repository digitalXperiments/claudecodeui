/**
 * Shadow evaluation: replay a candidate brief/memories against recent episodes (their recorded event
 * batches) in dry run with no tools, and score the item titles it would have produced against the
 * operator's verdicts on what the current version produced. Precision/recall use token-Jaccard >= 0.5
 * matching. Never runs a provider unless the default runner is used; tests inject a runner.
 */
import { randomUUID } from 'node:crypto';

import { missionControlDb, runMissionControlAgent, type McItem } from '@/modules/mission-control/index.js';
import type { BotEvent } from '@/modules/bots/bots.types.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { parseKernelEnvelope } from '@/modules/bots/kernel/envelope.js';
import { buildKernelPrompt } from '@/modules/bots/kernel/perceive.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
import { collectFeedback, NEGATIVE_KINDS, POSITIVE_KINDS } from '@/modules/bots/learning/feedback.js';
import { DAY_MS, jaccard, learningError } from '@/modules/bots/learning/learning.util.js';
import { episodeItems } from '@/modules/bots/learning/skill-draft.js';

export const MATCH_THRESHOLD = 0.5;

export interface ShadowCandidate {
  produce_prompt?: string;
  memories?: string[];
}

export interface ShadowRunnerInput {
  botId: string;
  episodeId: string;
  events: BotEvent[];
  candidate: ShadowCandidate;
}

/** Returns the item titles the candidate would have produced for the episode's events. */
export type ShadowRunner = (input: ShadowRunnerInput) => Promise<string[]>;

export interface ScoreLine {
  precision: number;
  recall: number;
  f1: number;
}

export interface EpisodeScore extends ScoreLine {
  episodeId: string;
  labeled: boolean;
  positives: number;
  negatives: number;
  produced: string[];
  truePositives: number;
  falsePositives: number;
}

export interface ShadowResult {
  botId: string;
  episodes: number;
  candidate: ScoreLine;
  baseline: ScoreLine;
  deltaF1: number;
  verdict: 'better' | 'same' | 'worse' | 'insufficient_data';
  perEpisode: Array<EpisodeScore & { baseline: ScoreLine }>;
}

const matches = (a: string, b: string): boolean => jaccard(a, b) >= MATCH_THRESHOLD;

function line(tp: number, fp: number, positives: number, matchedPositives: number): ScoreLine {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = positives === 0 ? 0 : matchedPositives / positives;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision: round(precision), recall: round(recall), f1: round(f1) };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

interface Raw {
  tp: number;
  fp: number;
  positives: number;
  matchedPositives: number;
}

function scoreTitles(titles: string[], positives: string[], negatives: string[]): Raw {
  let tp = 0;
  let fp = 0;
  for (const title of titles) {
    if (positives.some((p) => matches(title, p))) tp += 1;
    else if (negatives.some((n) => matches(title, n))) fp += 1;
  }
  const matchedPositives = positives.filter((p) => titles.some((t) => matches(t, p))).length;
  return { tp, fp, positives: positives.length, matchedPositives };
}

const addRaw = (a: Raw, b: Raw): Raw => ({
  tp: a.tp + b.tp,
  fp: a.fp + b.fp,
  positives: a.positives + b.positives,
  matchedPositives: a.matchedPositives + b.matchedPositives,
});
const toLine = (r: Raw): ScoreLine => line(r.tp, r.fp, r.positives, r.matchedPositives);

/** Default runner: the candidate brief (and memories) in a dry-run, tool-less produce run. */
export const defaultShadowRunner: ShadowRunner = async ({ botId, episodeId, events, candidate }) => {
  const section = missionControlDb.getSection(botId);
  if (!section) throw learningError('Bot not found', 404, 'BOT_NOT_FOUND');
  const overlay = { ...section, produce_prompt: candidate.produce_prompt ?? section.produce_prompt, dry_run: true };
  const { prompt } = buildKernelPrompt({ section: overlay, events, reason: 'shadow' });
  const memories = candidate.memories?.length
    ? `CANDIDATE MEMORIES (treat as operator-approved context)\n${candidate.memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}\n\n`
    : '';
  const result = await runMissionControlAgent({ section: overlay, prompt: `${memories}${prompt}`, tools: [], sourceRef: episodeId, trigger: 'shadow' });
  if (!result.success) throw new Error(result.errorMessage ?? 'Shadow run failed');
  return parseKernelEnvelope(result.text).items.flatMap((item) =>
    item && typeof item === 'object' && typeof (item as { title?: unknown }).title === 'string' ? [(item as { title: string }).title] : [],
  );
};

function episodeVerdicts(botId: string, episodeId: string, feedbackSince: number): { positives: string[]; negatives: string[]; actual: string[] } {
  const latest = new Map<string, { title: string; positive: boolean }>();
  for (const entry of collectFeedback(botId, feedbackSince)) {
    if (entry.actor !== 'human' || entry.episode_id !== episodeId || !entry.item_id || !entry.title) continue;
    if (POSITIVE_KINDS.has(entry.kind)) latest.set(entry.item_id, { title: entry.title, positive: true });
    else if (NEGATIVE_KINDS.has(entry.kind)) latest.set(entry.item_id, { title: entry.title, positive: false });
  }
  const verdicts = [...latest.values()];
  const actual = [...new Set([...episodeItems(botId, episodeId).map((i: McItem) => i.title), ...verdicts.map((v) => v.title)])];
  return {
    positives: verdicts.filter((v) => v.positive).map((v) => v.title),
    negatives: verdicts.filter((v) => !v.positive).map((v) => v.title),
    actual,
  };
}

export async function evaluate(
  botId: string,
  candidate: ShadowCandidate,
  options: { episodes?: number; runner?: ShadowRunner } = {},
): Promise<ShadowResult> {
  if (!missionControlDb.getSection(botId)) throw learningError('Bot not found', 404, 'BOT_NOT_FOUND');
  const runner = options.runner ?? defaultShadowRunner;
  const limit = Math.max(1, Math.min(options.episodes ?? 5, 25));
  const feedbackSince = Date.now() - 90 * DAY_MS;
  const candidates = botEpisodesDb
    .list(botId, 200)
    .filter((e) => e.status === 'succeeded')
    .map((episode) => ({ episode, events: botEventsDb.listForEpisode(episode.episode_id) }))
    .filter(({ events }) => events.length > 0)
    .slice(0, limit);

  let candidateTotal: Raw = { tp: 0, fp: 0, positives: 0, matchedPositives: 0 };
  let baselineTotal: Raw = { tp: 0, fp: 0, positives: 0, matchedPositives: 0 };
  const perEpisode: ShadowResult['perEpisode'] = [];
  for (const { episode, events } of candidates) {
    const { positives, negatives, actual } = episodeVerdicts(botId, episode.episode_id, feedbackSince);
    const produced = await runner({ botId, episodeId: episode.episode_id, events, candidate });
    const labeled = positives.length + negatives.length > 0;
    const raw = scoreTitles(produced, positives, negatives);
    const baseRaw = scoreTitles(actual, positives, negatives);
    if (labeled) {
      candidateTotal = addRaw(candidateTotal, raw);
      baselineTotal = addRaw(baselineTotal, baseRaw);
    }
    perEpisode.push({
      episodeId: episode.episode_id,
      labeled,
      positives: positives.length,
      negatives: negatives.length,
      produced,
      truePositives: raw.tp,
      falsePositives: raw.fp,
      ...toLine(raw),
      baseline: toLine(baseRaw),
    });
  }
  const candidateLine = toLine(candidateTotal);
  const baselineLine = toLine(baselineTotal);
  const deltaF1 = round(candidateLine.f1 - baselineLine.f1);
  const labeledCount = perEpisode.filter((e) => e.labeled).length;
  return {
    botId,
    episodes: perEpisode.length,
    candidate: candidateLine,
    baseline: baselineLine,
    deltaF1,
    verdict: labeledCount === 0 ? 'insufficient_data' : deltaF1 > 0.05 ? 'better' : deltaF1 < -0.05 ? 'worse' : 'same',
    perEpisode,
  };
}

// ---- in-memory jobs for the long-running route -------------------------------------------------

export interface ShadowJob {
  jobId: string;
  botId: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  result: ShadowResult | null;
  error: string | null;
}

const jobs = new Map<string, ShadowJob>();
const MAX_JOBS = 50;

export function startJob(botId: string, candidate: ShadowCandidate, options: { episodes?: number; runner?: ShadowRunner } = {}): ShadowJob {
  const job: ShadowJob = { jobId: randomUUID(), botId, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
  jobs.set(job.jobId, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value as string);
  evaluate(botId, candidate, options).then(
    (result) => Object.assign(job, { status: 'done', result, finishedAt: new Date().toISOString() }),
    (error: unknown) => Object.assign(job, { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }),
  );
  return job;
}

export const getJob = (jobId: string): ShadowJob | null => jobs.get(jobId) ?? null;

export const shadow = { evaluate, startJob, getJob };
