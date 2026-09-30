/** Pure model for the Command Center runtime strip (flag on). */

import type { BotEpisode, BotRuntimeStatus } from '../../types/botRuntime';

const DAY_MS = 86_400_000;

export type RuntimeState = {
  state: 'running' | 'stopped' | 'unknown';
  label: string;
  detail: string;
  tone: 'success' | 'warning' | 'default';
};

/**
 * The feature flag is on whenever this strip renders, so a runtime that reports `enabled: false`
 * is one the process refused to start (CLOUDCLI_BOTS_RUNTIME=off, or a boot failure). The API does
 * not distinguish those, so the detail names the likely cause without claiming it.
 */
export function runtimeState(status: BotRuntimeStatus | null, error: string | null): RuntimeState {
  if (!status) {
    return error
      ? { state: 'unknown', label: 'Unknown', detail: error, tone: 'warning' }
      : { state: 'unknown', label: 'Checking', detail: 'Reading runtime status', tone: 'default' };
  }
  if (status.enabled) {
    return { state: 'running', label: 'Running', detail: status.running.length ? `${status.running.length} active` : 'Idle', tone: 'success' };
  }
  return {
    state: 'stopped',
    label: 'Stopped',
    detail: 'Flag is on but the runtime is not running (forced off by CLOUDCLI_BOTS_RUNTIME=off?)',
    tone: 'warning',
  };
}

export type EpisodeSummary = {
  taintedLast24h: number;
  failedLast24h: number;
  /** Cost of episodes that started on the local calendar day of `now`. */
  costToday: number;
};

const localDay = (date: Date): string => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function summarizeEpisodes(episodesByBot: Record<string, BotEpisode[]>, now: Date = new Date()): EpisodeSummary {
  const cutoff = now.getTime() - DAY_MS;
  const today = localDay(now);
  const summary: EpisodeSummary = { taintedLast24h: 0, failedLast24h: 0, costToday: 0 };
  for (const episodes of Object.values(episodesByBot)) {
    for (const episode of episodes) {
      const started = Date.parse(episode.started_at);
      if (Number.isNaN(started)) continue;
      if (started >= cutoff) {
        if (episode.tainted) summary.taintedLast24h += 1;
        if (episode.status === 'failed') summary.failedLast24h += 1;
      }
      if (localDay(new Date(started)) === today) summary.costToday += episode.cost_usd || 0;
    }
  }
  summary.costToday = Math.round(summary.costToday * 10_000) / 10_000;
  return summary;
}

/** Titles of the bots currently running an episode (unknown ids are shown as-is). */
export function runningTitles(status: BotRuntimeStatus | null, titleOf: (botId: string) => string): string[] {
  return (status?.running ?? []).map((botId) => titleOf(botId));
}

/** Cap on bots sampled for the tainted/cost figures, so a large fleet does not fan out unboundedly. */
export const STRIP_EPISODE_BOT_CAP = 25;

export function botsToSample<T extends { section_id: string; enabled?: boolean }>(bots: T[]): T[] {
  return bots.slice(0, STRIP_EPISODE_BOT_CAP);
}
