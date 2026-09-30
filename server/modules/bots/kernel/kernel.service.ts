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
import { buildKernelPromptAsync, buildTriagePrompt } from '@/modules/bots/kernel/perceive.js';

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
  /** Wakes per hour for a bot with no budget row, or a row without a wakes cap (a configured cap overrides this). */
  defaultWakesPerHour: number;
  /** Longest an episode-finished listener may run before the kernel stops waiting for it. */
  listenerTimeoutMs: number;
}

/** An event claimed this many times without its episode finishing is dropped as poison. */
export const MAX_EVENT_ATTEMPTS = 3;

const DEFAULT_OPTIONS: KernelOptions = {
  maxConcurrency: 3,
  episodeMaxMs: 20 * 60_000,
  leaseTtlMs: 15 * 60_000,
  leaseRenewMs: 60_000,
  batchMax: 50,
  stopGraceMs: 10_000,
  rateLimitRetryMs: 5 * 60_000,
  defaultWakesPerHour: 12,
  listenerTimeoutMs: 30_000,
};

/** Live episodes' deadline extenders, keyed by episode id (cleared when the episode settles). */
const episodeDeadlines = new Map<string, (atLeastMs: number) => void>();

/**
 * Keep a running episode alive for at least `atLeastMs` more (e.g. while waiting on a human
 * handoff). No-op for unknown or finished episodes. Returns whether an episode was extended.
 */
export function extendEpisodeDeadline(episodeId: string, atLeastMs: number): boolean {
  const extend = episodeDeadlines.get(episodeId);
  if (!extend || !Number.isFinite(atLeastMs) || atLeastMs <= 0) return false;
  extend(atLeastMs);
  return true;
}


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
  /** Resolves once the episode was interrupted (shutdown, lost lease), so the wake need not wait for a stuck run. */
  interruptSignal: Promise<'interrupted'>;
  triggerInterrupt: () => void;
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

/** Record a run under the episode; a run that appears after an abort is killed straight away. */
function trackRun(ctx: EpisodeContext): (run: { runId: string }) => void {
  return ({ runId }) => {
    ctx.runIds.add(runId);
    if (ctx.aborted) void abortMissionControlRun(runId);
  };
}

async function runAgentTracked(
  ctx: EpisodeContext,
  params: Parameters<typeof runMissionControlAgent>[0],
): Promise<Awaited<ReturnType<typeof runMissionControlAgent>>> {
  return runMissionControlAgent({ ...params, episodeId: ctx.episodeId, onRunCreated: trackRun(ctx) });
}

/** Cost and run ids of the runs this episode tracked (no scan of the runs table). */
function episodeRuns(ctx: EpisodeContext): { runIds: string[]; costUsd: number } {
  const ids = [...ctx.runIds];
  if (ids.length === 0) return { runIds: [], costUsd: 0 };
  const rows = getConnection()
    .prepare(
      `SELECT run_id, cost_usd_estimate FROM agent_runs WHERE run_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`,
    )
    .all(...ids) as { run_id: string; cost_usd_estimate: number | null }[];
  const found = new Set(rows.map((row) => row.run_id));
  return {
    runIds: [...rows.map((row) => row.run_id), ...ids.filter((id) => !found.has(id))],
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
): { commitments: number; commitmentErrors: string[]; goalUpdates: number; goalErrors: string[]; goalNotes: string[] } {
  const botId = section.section_id;
  const recent = produce.items.map((item) => ({ item_id: item.item_id, dedupe_key: item.dedupe_key, title: item.title }));
  const commitmentErrors: string[] = [];
  let commitments = 0;
  for (const raw of envelope.commitments.slice(0, 10)) {
    try {
      const result = createCommitmentChecked(botId, raw, recent, new Date(), { episodeId: ctx.episodeId });
      if (result.ok) commitments += 1;
      else commitmentErrors.push(result.error);
    } catch (error) {
      commitmentErrors.push(errorText(error));
    }
  }
  const goalErrors: string[] = [];
  const goalNotes: string[] = [];
  let goalUpdates = 0;
  for (const raw of envelope.goalProgress.slice(0, 20)) {
    try {
      const result = applyGoalProgress(botId, raw, ctx.episodeId);
      if (result.ok) {
        goalUpdates += 1;
        if (result.ignoredStatus) goalNotes.push(`${result.goal.goal_id}: status "${result.ignoredStatus}" ignored (tainted episode)`);
      } else goalErrors.push(result.error);
    } catch (error) {
      goalErrors.push(errorText(error));
    }
  }
  return { commitments, commitmentErrors, goalUpdates, goalErrors, goalNotes };
}

async function act(ctx: EpisodeContext, section: McSection, events: BotEvent[], reason: string): Promise<WorkOutcome> {
  const botId = section.section_id;
  const runtime = readBotRuntimeConfig(botId);
  const trigger = deriveTrigger(events, reason);
  const { prompt } = await buildKernelPromptAsync({ section, events, reason });
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
    produce = await ingestProduceDrafts(section, envelope.items, {
      trigger,
      episodeId: ctx.episodeId,
      onRunCreated: trackRun(ctx),
      isAborted: () => ctx.aborted,
    });
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
      ...(applied.goalNotes.length ? { goal_notes: applied.goalNotes } : {}),
      notified,
      ...(envelope.reply ? { reply: envelope.reply } : {}),
      ...(produce.error ? { error: produce.error } : {}),
    },
  };
}

/** One listener at a time, each given `listenerTimeoutMs`; a hung or throwing listener is skipped. */
async function notifyListeners(episode: BotEpisode): Promise<void> {
  for (const listener of [...listeners]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        // Not unref'd: the timeout is bounded, and an unref'd timer lets the process exit while
        // a hung listener is still being waited on.
        timer = setTimeout(() => resolve('timeout'), options.listenerTimeoutMs);
      });
      const outcome = await Promise.race([Promise.resolve().then(() => listener(episode)).then(() => 'done' as const), timeout]);
      if (outcome === 'timeout') console.warn('[BotKernel] episode listener timed out', { episodeId: episode.episode_id });
    } catch (error) {
      console.warn('[BotKernel] episode listener failed', { episodeId: episode.episode_id, error: errorText(error) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Reflect: persist the episode, settle its events, index it, tell the listeners. */
async function reflect(ctx: EpisodeContext, eventIds: string[], work: WorkOutcome): Promise<BotEpisode> {
  const botId = ctx.botId;
  const runs = episodeRuns(ctx);
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
    // Shutdown (or a lost lease) mid-episode: hand this episode's events back so a later wake re-runs
    // them. Scoped to the episode: another process may already hold the bot and its own claims.
    botEventsDb.releaseClaimedForEpisode(ctx.episodeId);
  } else {
    const remaining = eventIds.filter((id) => botEventsDb.get(id)?.status === 'claimed');
    botSignals.markConsumed(remaining, ctx.episodeId);
    if (status === 'succeeded') completeDueCommitments(botId, eventIds);
  }
  broadcastEpisode(botId, ctx.episodeId, status);
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

// ---- recovery -----------------------------------------------------------------

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else, so it is alive. ESRCH: gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * A foreign lease is dead only when its holder (`${pid}:${random}`) names a process that no longer
 * exists. The same pid with another random part is a previous in-process runtime: dead as well.
 */
function holderIsDead(holder: string): boolean {
  const pid = Number.parseInt(holder.split(':')[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if ([...heldLeases.values()].includes(holder)) return false;
  if (pid === process.pid) return true;
  return !pidAlive(pid);
}

/**
 * Boot-time recovery that never touches work another live process owns: expired leases and leases
 * of dead holders are freed, only episodes whose lease is gone become 'interrupted', and only the
 * events of those episodes are re-queued (or dropped as poison once they have been claimed
 * `MAX_EVENT_ATTEMPTS` times). Returns the bots that have events to re-run.
 */
function recoverAbandonedWork(): Set<string> {
  botLeasesDb.expireStale();
  for (const lease of botLeasesDb.list()) {
    if (heldLeases.get(lease.bot_id) === lease.holder) continue;
    if (holderIsDead(lease.holder)) botLeasesDb.release(lease.bot_id, lease.holder);
  }

  const interruptedIds: string[] = [];
  for (const episode of botEpisodesDb.listByStatus('running')) {
    if (contexts.has(episode.bot_id)) continue;
    const lease = botLeasesDb.get(episode.bot_id);
    if (lease && lease.episode_id === episode.episode_id) continue; // a live process is still running it
    botEpisodesDb.update(episode.episode_id, {
      status: 'interrupted',
      summary: episode.summary || 'Interrupted by a server restart; its events were re-queued.',
      finishedAt: new Date().toISOString(),
      outcome: { ...episode.outcome, interrupted: true },
    });
    botEpisodesDb.indexEpisode(episode.episode_id);
    broadcastEpisode(episode.bot_id, episode.episode_id, 'interrupted');
    interruptedIds.push(episode.episode_id);
  }

  const leasedBots = botLeasesDb.list().map((lease) => lease.bot_id);
  const fromEpisodes = botEventsDb.requeueClaimedForEpisodes(interruptedIds, MAX_EVENT_ATTEMPTS);
  const orphaned = botEventsDb.requeueOrphanedClaimed([...leasedBots, ...active.keys()], MAX_EVENT_ATTEMPTS);
  const poisoned = [...fromEpisodes.poisoned, ...orphaned.poisoned];
  if (poisoned.length > 0) console.warn('[BotKernel] dropped poison events after repeated crashes', { eventIds: poisoned });
  return new Set([...fromEpisodes.botIds, ...orphaned.botIds]);
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

/** The configured wakes-per-hour cap, or the kernel default when the bot has no budget row or the row sets no cap. */
function wakeAllowedNow(botId: string): boolean {
  if (!budgets.wakeAllowed(botId)) return false;
  const budget = budgets.get(botId);
  if (budget && budget.max_wakes_per_hour !== null && budget.max_wakes_per_hour !== undefined) return true;
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

/** Filled by `runEpisode` with the finished episode so `wake` can notify listeners after releasing the slot. */
interface EpisodeHandoff {
  finished: BotEpisode | null;
}

async function runEpisode(botId: string, wakeOptions: WakeOptions, handoff: EpisodeHandoff): Promise<EpisodeResult> {
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
  let ctx: EpisodeContext | null = null;
  const renewTimer = setInterval(() => {
    let renewed = false;
    try {
      renewed = botLeasesDb.renew(botId, holder, options.leaseTtlMs);
    } catch (error) {
      console.warn('[BotKernel] lease renew failed', { botId, error: errorText(error) });
    }
    if (renewed) return;
    // The lease expired under us or was taken over: another process may now own this bot, so this
    // episode must stop producing side effects and hand its events back.
    clearInterval(renewTimer);
    const running = ctx;
    if (!running || running.aborted) return;
    running.interrupted = true;
    console.warn('[BotKernel] lease lost; interrupting the episode', { botId, episodeId: running.episodeId });
    const aborting = abortEpisodeRuns(running, 'Interrupted: the bot lease was lost');
    running.triggerInterrupt();
    void aborting;
  }, options.leaseRenewMs);
  renewTimer.unref?.();

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
    let triggerInterrupt: () => void = () => undefined;
    const interruptSignal = new Promise<'interrupted'>((resolve) => {
      triggerInterrupt = () => resolve('interrupted');
    });
    const episodeCtx: EpisodeContext = {
      interruptSignal,
      triggerInterrupt,
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
      let deadlineAt = Date.now() + options.episodeMaxMs;
      const arm = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        timeoutTimer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineAt - Date.now()));
      };
      arm();
      // A human handoff (or anything else that legitimately blocks on the operator) may push the
      // deadline out; it can never shorten it.
      episodeDeadlines.set(episodeCtx.episodeId, (atLeastMs: number) => {
        const wanted = Date.now() + atLeastMs;
        if (wanted > deadlineAt) {
          deadlineAt = wanted;
          arm();
        }
      });
    });

    let outcome: WorkOutcome;
    try {
      const raced = await Promise.race([work, timeout, episodeCtx.interruptSignal]);
      if (raced === 'interrupted') {
        outcome = { status: 'failed', summary: episodeCtx.abortReason, plan: '', outcome: { aborted: true, interrupted: true }, produce: null };
      } else if (raced === 'timeout') {
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
    handoff.finished = finished;
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
    if (ctx) episodeDeadlines.delete(ctx.episodeId);
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
    const handoff: EpisodeHandoff = { finished: null };
    const tracked: Promise<EpisodeResult> = runEpisode(botId, wakeOptions, handoff)
      .catch((error): EpisodeResult => ({ ...skip('kernel_error', errorText(error)), status: 'failed', error: errorText(error) }))
      .finally(() => {
        active.delete(botId);
        if (rewake.delete(botId)) kernel.notify(botId);
        pump();
      });
    active.set(botId, tracked);
    // Listeners run once the concurrency slot and the lease are free (the lease is released in
    // `runEpisode`'s finally), so a slow listener cannot hold a slot; the caller still awaits them.
    return tracked.then(async (result) => {
      if (handoff.finished) await notifyListeners(handoff.finished);
      return result;
    });
  },

  /** Boot: recover from a crash, hand legacy cron to the signals scheduler, resume queued work. */
  start(): void {
    accepting = true;
    started = true;

    const recovered = recoverAbandonedWork();

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

    const wake = new Set([...recovered, ...botEventsDb.listBotsWithQueued()]);
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
        const aborting = abortEpisodeRuns(ctx, 'Interrupted by server shutdown');
        ctx.triggerInterrupt();
        await aborting;
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
