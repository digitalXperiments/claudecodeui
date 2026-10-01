/**
 * Per-bot autonomy: the plain-language side of `runtime_json.autonomy` (labels, what the level
 * means for enforcement, and the version + thread trail an autonomy change leaves).
 */
import { missionControlDb, recordSectionVersion } from '@/modules/mission-control/index.js';
import { thread } from '@/modules/bots/channels/thread.service.js';
import type { BotAutonomy } from '@/modules/bots/bots-runtime-config.js';

export const AUTONOMY_LABELS: Record<BotAutonomy, string> = {
  ask: 'Ask',
  auto: 'Auto',
  bypass: 'Bypass',
};

/** One sentence per level for the UI. */
export const AUTONOMY_SUMMARIES: Record<BotAutonomy, string> = {
  ask: 'Reads freely. Asks you before anything with side effects: sending, publishing, deleting, buying, sign-ins, or changing things outside its own folder.',
  auto:
    'Does everything on its own except buying, sign-ins and passwords, and deleting, which always ask. After it reads outside content (an email or web page), an automatic reviewer checks risky actions and asks you when it is unsure.',
  bypass:
    "CloudCLI does not check this bot's tool calls and never asks. Only the provider's own permission mode applies, so it can do anything its tools allow.",
};

/** Why a run that was ungated is stopped when the bot is tightened. */
export const AUTONOMY_TIGHTENED_REASON = 'Autonomy tightened \u2014 stopped the ungated run';

export interface AutonomyChangeEffect {
  /** `now`: the next tool call is already judged at the new level. `next_run`: only a run that starts later is. */
  applied: 'now' | 'next_run';
  /** The bot's in-progress run was stopped because it was running without CloudCLI's checks. */
  stopped_run: boolean;
  /** Plain-English line for the operator (the PATCH response). */
  message: string;
  /** Short clause for the thread line: "Autonomy changed to X by you (<note>)". */
  note: string;
}

/**
 * What an autonomy change does to the run that is in progress. The tool gateway and built-in tool
 * gate are wired when a run is built, so a run that started `bypass` has neither and cannot be
 * tightened in place (it is stopped and its events requeue); a gated run reads the level on every
 * tool call, so ask <-> auto is live; and a run that started gated cannot become ungated
 * mid-flight, so loosening to `bypass` takes effect with the next run.
 */
export function describeAutonomyChange(
  before: BotAutonomy,
  after: BotAutonomy,
  state: { runActive: boolean; stoppedRun: boolean },
): AutonomyChangeEffect {
  const label = AUTONOMY_LABELS[after];
  if (before === 'bypass' && after !== 'bypass') {
    return state.stoppedRun
      ? {
          applied: 'now',
          stopped_run: true,
          message: `Saved. This bot is now ${label}. Its current run was stopped because it was running without checks; the work is queued again and will run with ${label} checks.`,
          note: 'its run in progress was stopped because it was running without checks; the work runs again with checks on',
        }
      : { applied: 'now', stopped_run: false, message: `Saved. This bot is now ${label}; every run from here on is checked.`, note: 'applies right away' };
  }
  if (after === 'bypass' && state.runActive) {
    return {
      applied: 'next_run',
      stopped_run: false,
      message: 'Saved. This bot is now Bypass from its next run; the run in progress keeps its checks until it finishes.',
      note: 'applies from its next run; the run in progress keeps its checks',
    };
  }
  return { applied: 'now', stopped_run: false, message: `Saved. This bot is now ${label}; it applies right away.`, note: 'applies right away' };
}

/** Record an autonomy change: a section version (before and after) and a system thread message. */
export function recordAutonomyChange(botId: string, before: BotAutonomy, after: BotAutonomy, effect?: AutonomyChangeEffect): void {
  if (before === after) return;
  try {
    const section = missionControlDb.getSection(botId);
    if (section) recordSectionVersion(section, 'edited');
  } catch (error) {
    console.warn('[bots] could not record the autonomy version', { botId, error: error instanceof Error ? error.message : String(error) });
  }
  try {
    thread.post(botId, {
      role: 'system',
      body: `Autonomy changed to ${AUTONOMY_LABELS[after]} by you${effect ? ` (${effect.note})` : ''}`,
      meta: {
        kind: 'autonomy_changed',
        from: before,
        to: after,
        ...(effect ? { applied: effect.applied, stopped_run: effect.stopped_run } : {}),
      },
    });
  } catch (error) {
    console.warn('[bots] could not post the autonomy change', { botId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Call BEFORE patching autonomy so the version history holds the old level as a baseline. */
export function recordAutonomyBaseline(botId: string): void {
  try {
    const section = missionControlDb.getSection(botId);
    if (section) recordSectionVersion(section, 'baseline');
  } catch {
    // Best effort; the change itself must not fail because history could not be written.
  }
}
