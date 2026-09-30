import type { BotRun } from '../../api/botStudioApi';
import type { Bot } from '../../types';
import { isRunActive } from '../../ui/runFormatting';

export type CommandCenterRun = {
  bot: Bot;
  run: BotRun;
};

export type CommandCenterSnapshot = {
  attentionBots: Bot[];
  runningRuns: CommandCenterRun[];
  recentRuns: CommandCenterRun[];
  healthyBots: number;
  pausedBots: number;
  resolvedToday: number;
  ticksToday: number;
  failedToday: number;
  costToday: number;
};

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function localDay(value: Date): string {
  return [value.getFullYear(), value.getMonth(), value.getDate()].join('-');
}

function happenedToday(run: BotRun, now: Date): boolean {
  if (!run.started_at) return false;
  const startedAt = new Date(run.started_at);
  return Number.isFinite(startedAt.getTime()) && localDay(startedAt) === localDay(now);
}

function failedRun(run: BotRun): boolean {
  return run.status.toLowerCase() === 'failed' || Boolean(run.error_summary);
}

/** Builds the operator-facing fleet snapshot entirely from existing Bot Studio data. */
export function selectCommandCenterSnapshot(
  bots: Bot[],
  runsBySection: Record<string, BotRun[]>,
  now = new Date(),
): CommandCenterSnapshot {
  const rows = bots.flatMap((bot) => (runsBySection[bot.section_id] ?? []).map((run) => ({ bot, run })))
    .sort((a, b) => timestamp(b.run.started_at) - timestamp(a.run.started_at));
  const todayRows = rows.filter(({ run }) => happenedToday(run, now));

  return {
    attentionBots: bots
      .filter((bot) => bot.health === 'needs' || bot.health === 'failing')
      .sort((a, b) => {
        if (a.health !== b.health) return a.health === 'failing' ? -1 : 1;
        return b.failed - a.failed || b.pending - a.pending || a.title.localeCompare(b.title);
      }),
    runningRuns: rows.filter(({ run }) => isRunActive(run.status)),
    recentRuns: rows.slice(0, 8),
    healthyBots: bots.filter((bot) => bot.health === 'healthy').length,
    pausedBots: bots.filter((bot) => bot.health === 'paused').length,
    resolvedToday: bots.reduce((total, bot) => total + bot.resolvedToday, 0),
    ticksToday: todayRows.length,
    failedToday: todayRows.filter(({ run }) => failedRun(run)).length,
    costToday: todayRows.reduce((total, { run }) => total + (run.cost_usd ?? 0), 0),
  };
}
