/**
 * L2 bot kernel: one durable, restart-safe loop per bot.
 *
 *   notify → (FIFO, global concurrency cap) → wake:
 *     lease → claim events → episode → perceive → [triage] → act → reflect → sleep
 *
 * The kernel replaces `runSectionProduce` as the entry point while the `bots.runtime_v2` flag is
 * on. The post-parse pipeline (dedupe, resolve/work gates, notifications) is still Mission
 * Control's `ingestProduceDrafts`, so items look the same whichever path created them.
 */

import { randomBytes } from 'node:crypto';

import { isBotsRuntimeV2Enabled } from '@/modules/app-features/index.js';
import { getConnection } from '@/modules/database/index.js';
import {
  abortMissionControlRun,
  finishMissionControlSectionRun,
  ingestProduceDrafts,
  missionControlDb,
  recordSectionVersion,
  runMissionControlAgent,
  setMissionControlScheduleFilter,
  type McItem,
  type McSection,
  type ProduceRunResult,
} from '@/modules/mission-control/index.js';
import { AppError } from '@/shared/utils.js';
import { resolveProviderAuthFailure } from '@/shared/provider-auth-failure.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { readBotRuntimeConfig, type BotPhaseRoute } from '@/modules/bots/bots-runtime-config.js';
import type { BotEpisode, BotEpisodeStatus, BotEvent } from '@/modules/bots/bots.types.js';
import { budgets } from '@/modules/bots/gate/budgets.service.js';
import { botSpendDb } from '@/modules/bots/gate/bot-spend.repository.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';
import { botTriggersDb } from '@/modules/bots/signals/bot-triggers.repository.js';
import { botSignals } from '@/modules/bots/signals/signals.service.js';
import { botTriggers } from '@/modules/bots/signals/triggers.service.js';
import { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botLeasesDb } from '@/modules/bots/kernel/bot-leases.repository.js';
import { parseKernelEnvelope, parseTriageVerdict, type KernelEnvelope } from '@/modules/bots/kernel/envelope.js';
import { applyGoalProgress, createCommitmentChecked } from '@/modules/bots/kernel/kernel-actions.js';
import { dispatchKernelNotification } from '@/modules/bots/kernel/kernel-notifier.js';
import { buildKernelPrompt, buildTriagePrompt } from '@/modules/bots/kernel/perceive.js';

export interface KernelOptions {
  /** Max bots woken at once by `notify`. */
  maxConcurrency: number;
  episodeMaxMs: number;
  leaseTtlMs: number;
  leaseRenewMs: number;
  /** Max events claimed per episode. */
  batchMax: number;
  /** How long `stop()` lets running wakes finish before interrupting them. */
  stopGraceMs: number;
  /** Delay before re-trying a bot that hit its wakes-per-hour limit. */
  rateLimitRetryMs: number;
  /** Wakes per hour for a bot with no budget row (a configured budget overrides this). */
  defaultWakesPerHour: number;
}

const DEFAULT_OPTIONS: KernelOptions = {
  maxConcurrency: 3,
  episodeMaxMs: 20 * 60_000,
  leaseTtlMs: 15 * 60_000,
  leaseRenewMs: 60_000,
  batchMax: 50,
  stopGraceMs: 10_000,
  rateLimitRetryMs: 5 * 60_000,
  defaultWakesPerHour: 12,
};

let options: KernelOptions = { ...DEFAULT_OPTIONS };

/** Override tunables (tests, ops). Pass null to restore the defaults. */
export function setKernelOptions(patch: Partial<KernelOptions> | null): void {
  options = patch ? { ...options, ...patch } : { ...DEFAULT_OPTIONS };
}

export type WakeStatus = 'succeeded' | 'failed' | 'interrupted' | 'skipped';

export interface EpisodeResult {
  status: WakeStatus;
  episodeId: string | null;
  summary: string;
  /** Mission Control-compatible counters and message. */
  created: number;
  skipped: number;
  items: McItem[];
  message: string;
  error?: string;
  /** Why the wake did not run an episode (status 'skipped'). */
  reason?: string;
}

export interface WakeOptions {
  reason: string;
  /** Bypass the wakes-per-hour limit and run even when no events are queued. */
  force?: boolean;
}

export type EpisodeListener = (episode: BotEpisode) => void | Promise<void>;
const listeners = new Set<EpisodeListener>();

/** Called after every finished episode (succeeded, failed or interrupted). Errors are swallowed. */
export function onEpisodeFinished(listener: EpisodeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface EpisodeContext {
  botId: string;
  episodeId: string;
  runIds: Set<string>;
  /** Set on timeout or shutdown: no further side effects may be applied. */
  aborted: boolean;
  interrupted: boolean;
  abortReason: string;
}

type WorkOutcome = {
  status: BotEpisodeStatus;
  summary: string;
  plan: string;
  outcome: Record<string, unknown>;
  produce: ProduceRunResult | null;
};

const active = new Map<string, Promise<EpisodeResult>>();
const contexts = new Map<string, EpisodeContext>();
const heldLeases = new Map<string, string>();
const queue: string[] = [];
const queued = new Set<string>();
const rewake = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let accepting = true;
let started = false;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function skip(reason: string, message: string): EpisodeResult {
  return { status: 'skipped', episodeId: null, summary: '', created: 0, skipped: 0, items: [], message, reason };
}

function broadcastEpisode(botId: string, episodeId: string, status: string): void {
  try {
    broadcastSystemEvent({ kind: 'bot_episode_updated', bot_id: botId, episode_id: episodeId, status });
  } catch (error) {
    console.warn('[BotKernel] broadcast failed', errorText(error));
  }
}

// ---- routing helpers --------------------------------------------------------

/** The section as seen by one phase: a routing override swaps provider/model/effort. */
export function applyRoute(section: McSection, route: BotPhaseRoute | undefined): McSection {
  if (!route) return section;
  const sameProvider = route.provider === section.provider;
  return {
    ...section,
    provider: route.provider as McSection['provider'],
    model: route.model ?? (sameProvider ? section.model : null),
    effort: route.effort ?? (sameProvider ? section.effort : null),
  };
}

const SCHEDULE_KINDS = new Set(['schedule', 'cron', 'interval', 'nl_schedule']);
const EVENT_KINDS = new Set(['watch', 'webhook', 'run_completed', 'kanban_event', 'interrupt_created']);
const OPERATOR_KINDS = new Set(['operator_message', 'manual']);
const PEER_KINDS = new Set(['peer_message', 'ask_bot']);

/** Run-level trigger label for a batch; the most "human" cause wins. */
export function deriveTrigger(events: BotEvent[], reason: string): string {
  const kinds = events.map((event) => event.kind);
  if (kinds.some((kind) => OPERATOR_KINDS.has(kind))) return 'operator';
  if (kinds.includes('commitment_due')) return 'commitment';
  if (kinds.some((kind) => PEER_KINDS.has(kind))) return 'peer';
  if (kinds.some((kind) => EVENT_KINDS.has(kind))) return 'event';
  if (kinds.some((kind) => SCHEDULE_KINDS.has(kind))) return 'schedule';
  if (reason === 'schedule') return 'schedule';
  return reason === 'manual' ? 'operator' : 'manual';
}

// ---- run tracking -----------------------------------------------------------

async function runAgentTracked(
  ctx: EpisodeContext,
  params: Parameters<typeof runMissionControlAgent>[0],
): Promise<Awaited<ReturnType<typeof runMissionControlAgent>>> {
  return runMissionControlAgent({
    ...params,
    episodeId: ctx.episodeId,
    onRunCreated: ({ runId }) => {
      ctx.runIds.add(runId);
      // Aborted before the run even existed (timeout race): kill it straight away.
      if (ctx.aborted) void abortMissionControlRun(runId);
    },
  });
}

function episodeRuns(episodeId: string): { runIds: string[]; costUsd: number } {
  const rows = getConnection()
    .prepare(
      `SELECT run_id, cost_usd_estimate FROM agent_runs
       WHERE json_extract(meta_json, '$.episode_id') = ? ORDER BY created_at ASC`,
    )
    .all(episodeId) as { run_id: string; cost_usd_estimate: number | null }[];
  return {
    runIds: rows.map((row) => row.run_id),
    costUsd: rows.reduce((sum, row) => sum + (row.cost_usd_estimate ?? 0), 0),
  };
}

async function abortEpisodeRuns(ctx: EpisodeContext, reason: string): Promise<void> {
  ctx.aborted = true;
  ctx.abortReason = reason;
  await Promise.all([...ctx.runIds].map((runId) => abortMissionControlRun(runId).catch(() => undefined)));
}

// ---- phases -----------------------------------------------------------------

/** Cheap triage: returns the events worth waking the act phase for. Fails open. */
async function triage(ctx: EpisodeContext, section: McSection, events: BotEvent[], route: BotPhaseRoute): Promise<BotEvent[]> {
  try {
    const result = await runAgentTracked(ctx, {
      section: applyRoute(section, route),
      prompt: buildTriagePrompt(section, events),
      tools: [],
      sourceRef: section.section_id,
      trigger: 'event',
      phase: 'produce',
    });
    if (!result.success) return events;
    const verdict = parseTriageVerdict(result.text);
    if (!verdict) return events;
    const relevant = new Set(verdict.relevantEventIds);
    const keep = events.filter((event) => relevant.has(event.event_id));
    const drop = events.filter((event) => !relevant.has(event.event_id));
    if (drop.length > 0) {
      botSignals.markDropped(
        drop.map((event) => event.event_id),
        `triage: ${verdict.reason || 'not relevant'}`,
      );
    }
    return keep;
  } catch (error) {
    console.warn('[BotKernel] triage failed; keeping all events', { botId: section.section_id, error: errorText(error) });
    return events;
  }
}

function applyEnvelope(
  section: McSection,
  ctx: EpisodeContext,
  envelope: KernelEnvelope,
  produce: ProduceRunResult,
): { commitments: number; commitmentErrors: string[]; goalUpdates: number; goalErrors: string[] } {
  const botId = section.section_id;
  const recent = produce.items.map((item) => ({ item_id: item.item_id, dedupe_key: item.dedupe_key, title: item.title }));
  const commitmentErrors: string[] = [];
  let commitments = 0;
  for (const raw of envelope.commitments.slice(0, 10)) {
    try {
      const result = createCommitmentChecked(botId, raw, recent);
      if (result.ok) commitments += 1;
      else commitmentErrors.push(result.error);
    } catch (error) {
      commitmentErrors.push(errorText(error));
    }
  }
  const goalErrors: string[] = [];
  let goalUpdates = 0;
  for (const raw of envelope.goalProgress.slice(0, 20)) {
    try {
      const result = applyGoalProgress(botId, raw, ctx.episodeId);
      if (result.ok) goalUpdates += 1;
      else goalErrors.push(result.error);
    } catch (error) {
      goalErrors.push(errorText(error));
    }
  }
  return { commitments, commitmentErrors, goalUpdates, goalErrors };
}

async function act(ctx: EpisodeContext, section: McSection, events: BotEvent[], reason: string): Promise<WorkOutcome> {
  const botId = section.section_id;
  const runtime = readBotRuntimeConfig(botId);
  const trigger = deriveTrigger(events, reason);
  const { prompt } = buildKernelPrompt({ section, events, reason });
  const result = await runAgentTracked(ctx, {
    section: applyRoute(section, runtime?.routing?.act),
    prompt,
    tools: section.produce_tools,
    sourceRef: botId,
    trigger,
    phase: 'produce',
  });
  if (ctx.aborted) return { status: 'failed', summary: ctx.abortReason, plan: '', outcome: { aborted: true }, produce: null };

  if (!result.success) {
    const message =
      resolveProviderAuthFailure(section.provider, result.errorMessage, result.text)
      || result.errorMessage
      || result.text.slice(0, 500)
      || `Provider "${section.provider}" run failed`;
    finishMissionControlSectionRun(botId, message);
    return { status: 'failed', summary: `Run failed: ${message}`, plan: '', outcome: { error: message }, produce: null };
  }

  let envelope: KernelEnvelope;
  try {
    envelope = parseKernelEnvelope(result.text);
  } catch (error) {
    const authFailure = resolveProviderAuthFailure(section.provider, result.errorMessage, result.text);
    const message = authFailure ?? `Failed to parse kernel output: ${errorText(error)}`;
    finishMissionControlSectionRun(botId, message);
    return { status: 'failed', summary: message, plan: '', outcome: { error: message, raw: result.text.slice(0, 2_000) }, produce: null };
  }

  let produce: ProduceRunResult;
  try {
    produce = await ingestProduceDrafts(section, envelope.items, { trigger, episodeId: ctx.episodeId });
  } catch (error) {
    const message = errorText(error);
    finishMissionControlSectionRun(botId, message);
    return { status: 'failed', summary: `Produce pipeline failed: ${message}`, plan: envelope.plan, outcome: { error: message }, produce: null };
  }
  if (ctx.aborted) return { status: 'failed', summary: ctx.abortReason, plan: envelope.plan, outcome: { aborted: true }, produce };

  const applied = applyEnvelope(section, ctx, envelope, produce);
  let notified = false;
  if (envelope.notify) {
    try {
      await dispatchKernelNotification({ botId, episodeId: ctx.episodeId, ...envelope.notify });
      notified = true;
    } catch (error) {
      console.warn('[BotKernel] notifier failed', { botId, error: errorText(error) });
    }
  }
  return {
    status: produce.error ? 'failed' : 'succeeded',
    summary: envelope.summary || produce.message,
    plan: envelope.plan,
    produce,
    outcome: {
      created: produce.created,
      skipped: produce.skipped,
      item_ids: produce.items.map((item) => item.item_id),
      commitments: applied.commitments,
      ...(applied.commitmentErrors.length ? { commitment_errors: applied.commitmentErrors } : {}),
      goal_updates: applied.goalUpdates,
      ...(applied.goalErrors.length ? { goal_errors: applied.goalErrors } : {}),
      notified,
      ...(produce.error ? { error: produce.error } : {}),
    },
  };
}

async function notifyListeners(episode: BotEpisode): Promise<void> {
  for (const listener of [...listeners]) {
    try {
      await listener(episode);
    } catch (error) {
      console.warn('[BotKernel] episode listener failed', { episodeId: episode.episode_id, error: errorText(error) });
    }
  }
}

/** Reflect: persist the episode, settle its events, index it, tell the listeners. */
async function reflect(ctx: EpisodeContext, eventIds: string[], work: WorkOutcome): Promise<BotEpisode> {
  const botId = ctx.botId;
  const runs = episodeRuns(ctx.episodeId);
  const status: BotEpisodeStatus = ctx.interrupted ? 'interrupted' : work.status;
  const finished = botEpisodesDb.update(ctx.episodeId, {
    status,
    summary: work.summary.slice(0, 2_000),
    planText: work.plan,
    outcome: { ...work.outcome, run_ids: runs.runIds },
    runIds: runs.runIds,
    costUsd: runs.costUsd,
    finishedAt: new Date().toISOString(),
  })!;
  botEpisodesDb.indexEpisode(ctx.episodeId);

  if (ctx.interrupted) {
    // Shutdown mid-episode: hand the events back so the next start re-runs them.
    botEventsDb.releaseClaimed(botId);
  } else {
    const remaining = eventIds.filter((id) => botEventsDb.get(id)?.status === 'claimed');
    botSignals.markConsumed(remaining, ctx.episodeId);
    if (status === 'succeeded') completeDueCommitments(botId, eventIds);
  }
  broadcastEpisode(botId, ctx.episodeId, status);
  await notifyListeners(finished);
  return finished;
}

/** A `commitment_due` wake is the nudge: the commitment is done unless the bot makes a new one. */
function completeDueCommitments(botId: string, eventIds: string[]): void {
  for (const id of eventIds) {
    const event = botEventsDb.get(id);
    if (!event || event.kind !== 'commitment_due') continue;
    const commitmentId = typeof event.payload.commitment_id === 'string' ? event.payload.commitment_id : '';
    const commitment = commitmentId ? botCommitmentsDb.get(commitmentId) : null;
    if (commitment && commitment.bot_id === botId && commitment.status !== 'cancelled') botCommitmentsDb.complete(commitmentId);
  }
}

function toResult(episode: BotEpisode, produce: ProduceRunResult | null): EpisodeResult {
  const status: WakeStatus = episode.status === 'running' ? 'failed' : (episode.status as WakeStatus);
  return {
    status,
    episodeId: episode.episode_id,
    summary: episode.summary,
    created: produce?.created ?? 0,
    skipped: produce?.skipped ?? 0,
    items: produce?.items ?? [],
    message: produce?.message ?? episode.summary,
    ...(status === 'failed' ? { error: episode.summary } : {}),
  };
}

// ---- the wake ---------------------------------------------------------------

function uniqueKinds(events: BotEvent[], fallback: string): string {
  const kinds = [...new Set(events.map((event) => event.kind))];
  return kinds.length > 0 ? kinds.join(',') : fallback;
}

function botVersion(section: McSection): number | null {
  try {
    return recordSectionVersion(section, 'baseline').version;
  } catch {
    return null;
  }
}

/** The configured wakes-per-hour budget, or the kernel default when the bot has no budget row. */
function wakeAllowedNow(botId: string): boolean {
  if (!budgets.wakeAllowed(botId)) return false;
  if (budgets.get(botId)) return true;
  const since = new Date(Date.now() - 3_600_000).toISOString();
  return botSpendDb.episodesStartedSince(botId, since) < options.defaultWakesPerHour;
}

function scheduleRateLimitRetry(botId: string): void {
  if (retryTimers.has(botId) || botEventsDb.countQueued(botId) === 0) return;
  const timer = setTimeout(() => {
    retryTimers.delete(botId);
    kernel.notify(botId);
  }, options.rateLimitRetryMs);
  timer.unref?.();
  retryTimers.set(botId, timer);
}

async function runEpisode(botId: string, wakeOptions: WakeOptions): Promise<EpisodeResult> {
  const reason = wakeOptions.reason;
  if (!accepting) return skip('kernel_stopped', 'The bot runtime is shutting down.');
  if (!isBotsRuntimeV2Enabled()) return skip('flag_off', 'Bot runtime v2 is off.');
  const section = missionControlDb.getSection(botId);
  if (!section) return skip('unknown_bot', 'Bot not found.');
  if (!section.enabled) return skip('bot_disabled', 'Bot is disabled. Enable it to run.');

  const holder = `${process.pid}:${randomBytes(6).toString('hex')}`;
  if (!botLeasesDb.acquire(botId, holder, options.leaseTtlMs)) {
    return skip('lease_held', 'Another wake already holds this bot.');
  }
  heldLeases.set(botId, holder);
  const renewTimer = setInterval(() => {
    botLeasesDb.renew(botId, holder, options.leaseTtlMs);
  }, options.leaseRenewMs);
  renewTimer.unref?.();

  let ctx: EpisodeContext | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    if (!wakeOptions.force && !wakeAllowedNow(botId)) {
      scheduleRateLimitRetry(botId);
      return skip('wake_rate_limit', 'This bot reached its wakes-per-hour limit; events stay queued.');
    }

    const budget = budgets.check(botId);
    if (!budget.ok) {
      const events = botSignals.claimBatch(botId, { max: options.batchMax });
      if (events.length === 0 && reason === 'notify' && !wakeOptions.force) {
        return skip('budget_hard', budget.reason ?? 'Budget limit reached.');
      }
      const reasonText = `Skipped: ${budget.reason ?? 'budget limit reached'}`;
      botSignals.markDropped(events.map((event) => event.event_id), `budget: ${budget.reason ?? 'hard limit'}`);
      const episode = botEpisodesDb.create({
        botId,
        triggerKinds: uniqueKinds(events, reason),
        eventIds: events.map((event) => event.event_id),
        botVersion: botVersion(section),
      });
      const finished = botEpisodesDb.update(episode.episode_id, {
        status: 'failed',
        summary: reasonText,
        outcome: { skipped: true, reason: 'budget', dropped_events: events.length },
        finishedAt: new Date().toISOString(),
      })!;
      botEpisodesDb.indexEpisode(finished.episode_id);
      broadcastEpisode(botId, finished.episode_id, 'failed');
      return { ...skip('budget_hard', reasonText), episodeId: finished.episode_id, summary: reasonText };
    }

    const claimed = botSignals.claimBatch(botId, { max: options.batchMax });
    if (claimed.length === 0 && reason === 'notify' && !wakeOptions.force) {
      return skip('no_events', 'Nothing queued for this bot.');
    }

    const eventIds = claimed.map((event) => event.event_id);
    const episode = botEpisodesDb.create({
      botId,
      triggerKinds: uniqueKinds(claimed, reason),
      eventIds,
      botVersion: botVersion(section),
    });
    const episodeCtx: EpisodeContext = {
      botId,
      episodeId: episode.episode_id,
      runIds: new Set(),
      aborted: false,
      interrupted: false,
      abortReason: '',
    };
    ctx = episodeCtx;
    contexts.set(botId, episodeCtx);
    botEventsDb.attachToEpisode(eventIds, episode.episode_id);
    // Any external-trust event taints the whole episode up front: the gateway then requires a
    // human for floor-risk calls even before the run has read anything untrusted itself.
    if (claimed.some((event) => event.trust === 'external')) botEpisodesDb.update(episode.episode_id, { tainted: true });
    botLeasesDb.renew(botId, holder, options.leaseTtlMs, episode.episode_id);
    broadcastEpisode(botId, episode.episode_id, 'running');

    const work = (async (): Promise<WorkOutcome> => {
      let events = claimed;
      const runtime = readBotRuntimeConfig(botId);
      const perceiveRoute = runtime?.routing?.perceive;
      const triageable =
        perceiveRoute !== undefined
        && events.length > 0
        && events.every((event) => event.trust === 'external' && (event.kind === 'watch' || event.kind === 'webhook'));
      if (triageable && perceiveRoute) {
        events = await triage(episodeCtx, section, events, perceiveRoute);
        if (events.length === 0 && !episodeCtx.aborted) {
          finishMissionControlSectionRun(botId);
          return {
            status: 'succeeded',
            summary: 'Nothing relevant',
            plan: '',
            outcome: { triaged_out: claimed.length, created: 0, skipped: 0 },
            produce: null,
          };
        }
      }
      if (episodeCtx.aborted) return { status: 'failed', summary: episodeCtx.abortReason, plan: '', outcome: { aborted: true }, produce: null };
      return act(episodeCtx, section, events, reason);
    })();
    work.catch(() => undefined);

    const timeout = new Promise<'timeout'>((resolve) => {
      // Not unref'd: a pending episode deadline must keep the process alive until it fires or is cleared.
      timeoutTimer = setTimeout(() => resolve('timeout'), options.episodeMaxMs);
    });

    let outcome: WorkOutcome;
    try {
      const raced = await Promise.race([work, timeout]);
      if (raced === 'timeout') {
        const message = `Episode exceeded the maximum duration of ${Math.round(options.episodeMaxMs / 1000)}s and was aborted.`;
        await abortEpisodeRuns(episodeCtx, message);
        finishMissionControlSectionRun(botId, message);
        outcome = { status: 'failed', summary: message, plan: '', outcome: { timeout: true }, produce: null };
      } else {
        outcome = raced;
      }
    } catch (error) {
      const message = errorText(error);
      finishMissionControlSectionRun(botId, message);
      outcome = { status: 'failed', summary: `Episode failed: ${message}`, plan: '', outcome: { error: message }, produce: null };
    }

    const finished = await reflect(episodeCtx, eventIds, outcome);
    return toResult(finished, outcome.produce);
  } catch (error) {
    // Bookkeeping failed (e.g. database error): never leave the episode 'running'.
    const message = errorText(error);
    console.error('[BotKernel] episode crashed', { botId, error: message });
    if (ctx) {
      try {
        botEpisodesDb.update(ctx.episodeId, { status: 'failed', summary: `Kernel error: ${message}`, finishedAt: new Date().toISOString() });
        botSignals.markConsumed(botEventsDb.listForEpisode(ctx.episodeId).filter((e) => e.status === 'claimed').map((e) => e.event_id), ctx.episodeId);
        broadcastEpisode(botId, ctx.episodeId, 'failed');
      } catch {
        // best effort
      }
    }
    return { ...skip('kernel_error', message), status: 'failed', episodeId: ctx?.episodeId ?? null, error: message };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    clearInterval(renewTimer);
    contexts.delete(botId);
    heldLeases.delete(botId);
    botLeasesDb.release(botId, holder);
    if (accepting && botEventsDb.countQueued(botId) > 0 && ctx) rewake.add(botId);
  }
}

/**
 * Keep a bot's mirrored cron trigger in step with its `schedule_cron` after a section create or
 * edit (only while the kernel runs, i.e. the flag is on). Clearing the schedule removes the mirror.
 */
export function syncBotScheduleTrigger(sectionId: string): void {
  if (!started) return;
  try {
    const section = missionControlDb.getSection(sectionId);
    if (!section) return;
    const triggers = botTriggersDb.list(sectionId);
    const mirrored = triggers.find((t) => t.kind === 'cron' && t.config.mirrored_from === 'schedule_cron');
    if (!section.schedule_cron?.trim()) {
      if (mirrored) {
        botTriggersDb.delete(mirrored.trigger_id);
        botTriggers.sync();
      }
      return;
    }
    const hasSchedule = triggers.some((t) => t.kind === 'cron' || t.kind === 'interval' || t.kind === 'nl_schedule');
    if (mirrored || !hasSchedule) botTriggers.ensureCronTriggerFromSection(section);
  } catch (error) {
    console.error('[BotKernel] failed to sync schedule trigger', { sectionId, error: errorText(error) });
  }
}

function pump(): void {
  while (accepting && active.size < options.maxConcurrency && queue.length > 0) {
    const botId = queue.shift()!;
    queued.delete(botId);
    if (active.has(botId)) {
      rewake.add(botId);
      continue;
    }
    void kernel.wake(botId, { reason: 'notify' });
  }
}

export const kernel = {
  /** Queue a wake for a bot (FIFO, global concurrency cap). Cheap and idempotent. */
  notify(botId: string): void {
    if (!accepting) return;
    if (active.has(botId)) {
      rewake.add(botId);
      return;
    }
    if (queued.has(botId)) return;
    queued.add(botId);
    queue.push(botId);
    pump();
  },

  /** Run one wake to completion. A bot that is already running returns a 'skipped' result. */
  wake(botId: string, wakeOptions: WakeOptions): Promise<EpisodeResult> {
    if (active.has(botId)) {
      rewake.add(botId);
      return Promise.resolve(skip('already_running', 'This bot is already running an episode.'));
    }
    const tracked: Promise<EpisodeResult> = runEpisode(botId, wakeOptions)
      .catch((error): EpisodeResult => ({ ...skip('kernel_error', errorText(error)), status: 'failed', error: errorText(error) }))
      .finally(() => {
        active.delete(botId);
        if (rewake.delete(botId)) kernel.notify(botId);
        pump();
      });
    active.set(botId, tracked);
    return tracked;
  },

  /** Boot: recover from a crash, hand legacy cron to the signals scheduler, resume queued work. */
  start(): void {
    accepting = true;
    started = true;

    // Leases left by a previous process are stale by definition: nothing of ours is running yet.
    botLeasesDb.expireStale();
    for (const lease of botLeasesDb.list()) {
      if (heldLeases.get(lease.bot_id) !== lease.holder) botLeasesDb.release(lease.bot_id, lease.holder);
    }
    for (const episode of botEpisodesDb.listByStatus('running')) {
      if (contexts.has(episode.bot_id)) continue;
      botEpisodesDb.update(episode.episode_id, {
        status: 'interrupted',
        summary: episode.summary || 'Interrupted by a server restart; its events were re-queued.',
        finishedAt: new Date().toISOString(),
        outcome: { ...episode.outcome, interrupted: true },
      });
      botEpisodesDb.indexEpisode(episode.episode_id);
      broadcastEpisode(episode.bot_id, episode.episode_id, 'interrupted');
    }
    const released = botEventsDb.releaseAllClaimed();

    try {
      for (const section of missionControlDb.listEnabledScheduledSections()) {
        const triggers = botTriggersDb.list(section.section_id);
        const hasSchedule = triggers.some((t) => t.kind === 'cron' || t.kind === 'interval' || t.kind === 'nl_schedule');
        if (!hasSchedule) botTriggers.ensureCronTriggerFromSection(section);
      }
    } catch (error) {
      console.error('[BotKernel] failed to mirror schedules as triggers', errorText(error));
    }
    setMissionControlScheduleFilter((sectionId) => botTriggers.hasTriggers(sectionId));

    const wake = new Set([...released, ...botEventsDb.listBotsWithQueued()]);
    for (const botId of wake) {
      const bot = missionControlDb.getSection(botId);
      if (bot?.enabled) kernel.notify(botId);
    }
  },

  /** Stop accepting wakes, give running ones a moment to finish, then interrupt and release. */
  async stop(): Promise<void> {
    accepting = false;
    started = false;
    queue.length = 0;
    queued.clear();
    rewake.clear();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    setMissionControlScheduleFilter(null);

    if (active.size > 0) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, options.stopGraceMs);
      });
      await Promise.race([Promise.allSettled([...active.values()]).then(() => undefined), grace]);
      if (graceTimer) clearTimeout(graceTimer);
    }
    if (active.size > 0) {
      for (const ctx of contexts.values()) {
        ctx.interrupted = true;
        await abortEpisodeRuns(ctx, 'Interrupted by server shutdown');
      }
      await Promise.race([
        Promise.allSettled([...active.values()]).then(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    for (const [botId, holder] of [...heldLeases.entries()]) {
      botLeasesDb.release(botId, holder);
      heldLeases.delete(botId);
    }
  },

  isStarted(): boolean {
    return started;
  },

  status(): {
    enabled: boolean;
    running: string[];
    queuedWakes: number;
    queuedEvents: number;
    leases: ReturnType<typeof botLeasesDb.list>;
  } {
    const botsWithQueued = botEventsDb.listBotsWithQueued();
    return {
      enabled: isBotsRuntimeV2Enabled(),
      running: [...active.keys()],
      queuedWakes: queue.length,
      queuedEvents: botsWithQueued.reduce((sum, botId) => sum + botEventsDb.countQueued(botId), 0),
      leases: botLeasesDb.list(),
    };
  },
};

/**
 * `POST /sections/:id/run` under runtime v2: ingest a manual operator event and run the bot to
 * completion. Returns null when the runtime is off so the caller falls back to the legacy path;
 * otherwise the legacy `{ created, skipped, items, message }` shape.
 */
export async function runBotNow(botId: string): Promise<{
  created: number;
  skipped: number;
  items: McItem[];
  message: string;
  error?: string;
} | null> {
  if (!isBotsRuntimeV2Enabled() || !started) return null;
  const section = missionControlDb.getSection(botId);
  if (!section) throw new AppError('Section not found', { code: 'MC_SECTION_NOT_FOUND', statusCode: 404 });
  if (!section.produce_prompt.trim()) {
    throw new AppError('Section has no produce prompt', { code: 'MC_NO_PRODUCE_PROMPT', statusCode: 400 });
  }
  if (!section.enabled) {
    return { created: 0, skipped: 0, items: [], message: 'Section is disabled. Enable it to run.' };
  }
  botSignals.ingest({
    botId,
    source: 'operator',
    kind: 'manual',
    trust: 'operator',
    payload: { message: 'The operator asked for a run now.', requested_at: new Date().toISOString() },
  });
  const result = await kernel.wake(botId, { reason: 'manual', force: true });
  if (result.status === 'skipped' && result.reason === 'already_running') {
    return { created: 0, skipped: 0, items: [], message: 'The bot is already running; your request is queued for its next episode.' };
  }
  return {
    created: result.created,
    skipped: result.skipped,
    items: result.items,
    message: result.message || result.summary || 'Run finished.',
    ...(result.error ? { error: result.error } : {}),
  };
}
