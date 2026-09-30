import type { BotEpisode, BotEpisodeRun, BotEpisodeSearchHit, BotEpisodeStatus } from '../../../../types/botRuntime';
import type { BotRun } from '../../../../api/botStudioApi';

export type EpisodeStatusFilter = 'all' | BotEpisodeStatus;

export const EPISODE_STATUS_FILTERS: Array<{ value: EpisodeStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'interrupted', label: 'Interrupted' },
];

export function countEpisodesByStatus(episodes: BotEpisode[]): Record<EpisodeStatusFilter, number> {
  const counts: Record<EpisodeStatusFilter, number> = { all: episodes.length, running: 0, succeeded: 0, failed: 0, interrupted: 0 };
  for (const episode of episodes) if (episode.status in counts) counts[episode.status] += 1;
  return counts;
}

/**
 * Apply the status filter and, when a search is active, restrict to (and rank by) the search hits.
 * `hits === null` means no search; an empty array means a search with no results.
 * Hits for episodes that are not in the loaded list are returned as `extra` so they can still be shown.
 */
export function filterEpisodes(
  episodes: BotEpisode[],
  status: EpisodeStatusFilter,
  hits: BotEpisodeSearchHit[] | null,
): { episodes: BotEpisode[]; extra: BotEpisodeSearchHit[] } {
  const byStatus = status === 'all' ? episodes : episodes.filter((episode) => episode.status === status);
  if (hits === null) return { episodes: byStatus, extra: [] };
  const rank = new Map<string, number>();
  hits.forEach((hit, index) => { if (!rank.has(hit.episode_id)) rank.set(hit.episode_id, index); });
  const matched = byStatus
    .filter((episode) => rank.has(episode.episode_id))
    .sort((a, b) => (rank.get(a.episode_id) ?? 0) - (rank.get(b.episode_id) ?? 0));
  // Only surface hits outside the loaded page when no status filter could have excluded them.
  const loaded = new Set(episodes.map((episode) => episode.episode_id));
  const extra = status === 'all' ? hits.filter((hit) => !loaded.has(hit.episode_id)) : [];
  return { episodes: matched, extra };
}

export type EpisodeOutcomeView = {
  created: number;
  skipped: number;
  itemIds: string[];
  commitments: number;
  goalUpdates: number;
  reply: string | null;
  notified: boolean;
  error: string | null;
  notes: string[];
  flags: string[];
};

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

/** Normalise the kernel's free-form `outcome` object into the fields the detail panel shows. */
export function parseEpisodeOutcome(outcome: Record<string, unknown> | null | undefined): EpisodeOutcomeView {
  const source = outcome ?? {};
  const flags: string[] = [];
  if (source.aborted === true) flags.push('aborted');
  if (source.interrupted === true) flags.push('interrupted');
  if (source.timeout === true) flags.push('timed out');
  if (source.skipped === true) flags.push(typeof source.reason === 'string' ? `skipped (${source.reason})` : 'skipped');
  if (typeof source.triaged_out === 'number' && source.triaged_out > 0) flags.push(`triaged out ${source.triaged_out}`);
  return {
    created: num(source.created),
    skipped: typeof source.skipped === 'number' ? source.skipped : 0,
    itemIds: strings(source.item_ids),
    commitments: num(source.commitments),
    goalUpdates: num(source.goal_updates),
    reply: text(source.reply),
    notified: source.notified === true,
    error: text(source.error),
    notes: [...strings(source.goal_notes), ...strings(source.commitment_errors), ...strings(source.goal_errors)],
    flags,
  };
}

/** True when the outcome has anything worth a section in the panel. */
export function outcomeHasContent(view: EpisodeOutcomeView): boolean {
  return Boolean(view.created || view.skipped || view.itemIds.length || view.commitments || view.goalUpdates || view.reply
    || view.error || view.notes.length || view.flags.length || view.notified);
}

/** Adapt an episode's run summary to the BotRun shape RunTimeline expects. */
export function episodeRunToBotRun(run: BotEpisodeRun): BotRun {
  const start = run.started_at ? Date.parse(run.started_at) : NaN;
  const end = run.finished_at ? Date.parse(run.finished_at) : NaN;
  return {
    run_id: run.run_id,
    status: run.status,
    trigger: run.trigger ?? undefined,
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? null,
    duration_ms: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
    error_summary: run.error_summary ?? null,
    cost_usd: run.cost_usd ?? null,
  };
}

// ---- display safety -----------------------------------------------------------------------------

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[-_]?key|credential|cookie|bearer/i;
const MAX_DEPTH = 6;

/**
 * Copy a payload for display with values under credential-looking keys masked. The episode detail
 * endpoint returns gate args unredacted, so the UI must not render them raw.
 */
export function redactForDisplay(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '…';
  if (Array.isArray(value)) return value.map((entry) => redactForDisplay(entry, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactForDisplay(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/** One-line `key=value` summary of tool args (redacted, truncated) for the gate decision list. */
export function summarizeArgs(args: Record<string, unknown> | null | undefined, max = 140): string {
  if (!args || typeof args !== 'object') return '';
  const safe = redactForDisplay(args) as Record<string, unknown>;
  const parts = Object.entries(safe).map(([key, value]) => {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    return `${key}=${(rendered ?? '').replace(/\s+/g, ' ')}`;
  });
  return truncateText(parts.join(' '), max);
}

export function prettyJson(value: unknown, max = 8_000): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(redactForDisplay(value), null, 2) ?? '';
  } catch {
    rendered = String(value);
  }
  return truncateText(rendered, max);
}
