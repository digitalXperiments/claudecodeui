/**
 * Bot triggers: validated CRUD over `bot_triggers` plus the scheduler that
 * turns cron / interval / nl_schedule / watch triggers and due commitments into
 * `bot_events`. Event-driven kinds (webhook, kanban_event, ...) are fed by
 * `automation-bridge.ts` and `signals.routes.ts`.
 */

import { Cron } from 'croner';

import { missionControlDb, type McSection } from '@/modules/mission-control/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { AppError } from '@/shared/utils.js';
import type { BotTrigger, BotTriggerKind } from '@/modules/bots/bots.types.js';
import { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
import { getWatchAdapter } from '@/modules/bots/signals/adapters/registry.js';
import { registerBuiltInWatchAdapters } from '@/modules/bots/signals/adapters/index.js';
import { startAutomationBridge, stopAutomationBridge } from '@/modules/bots/signals/automation-bridge.js';
import { botTriggersDb } from '@/modules/bots/signals/bot-triggers.repository.js';
import { compileNaturalSchedule, isScheduleExcluded, type ScheduleExclusions } from '@/modules/bots/signals/nl-schedule.js';
import { clampCoalesceMs, botSignals } from '@/modules/bots/signals/signals.service.js';

export const TRIGGER_KINDS: readonly BotTriggerKind[] = [
  'cron', 'interval', 'nl_schedule', 'webhook', 'kanban_event', 'run_completed', 'interrupt_created',
  'watch', 'peer_message', 'ask_bot', 'commitment_due', 'operator_message', 'manual',
];

export const MIN_INTERVAL_S = 60;
export const DEFAULT_WATCH_INTERVAL_S = 300;
const COMMITMENT_SCAN_MS = 60_000;

const invalid = (message: string): AppError => new AppError(message, { code: 'BOT_TRIGGER_INVALID', statusCode: 400 });

function optString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid(`${key} must be a string`);
  return value.trim();
}

function validateCronExpression(expr: string, timezone?: string): void {
  try {
    new Cron(expr, { paused: true, timezone }).stop();
  } catch (error) {
    throw invalid(`Invalid cron expression "${expr}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateTimezone(timezone: string | undefined): void {
  if (!timezone) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw invalid(`Unknown timezone "${timezone}"`);
  }
}

function positiveInterval(value: unknown, field: string, fallback?: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (n === undefined || !Number.isFinite(n)) throw invalid(`${field} is required`);
  if (n < MIN_INTERVAL_S) throw invalid(`${field} must be at least ${MIN_INTERVAL_S} seconds`);
  return Math.floor(n);
}

/** Validates and normalizes a trigger config for its kind. Throws AppError(400) when invalid. */
export function validateTriggerConfig(kind: string, rawConfig: unknown): Record<string, unknown> {
  if (!(TRIGGER_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`Unknown trigger kind "${kind}". Use one of: ${TRIGGER_KINDS.join(', ')}`);
  }
  if (rawConfig !== undefined && (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig))) {
    throw invalid('config must be an object');
  }
  const config: Record<string, unknown> = { ...((rawConfig as Record<string, unknown> | undefined) ?? {}) };
  if (config.coalesce_ms !== undefined) config.coalesce_ms = clampCoalesceMs(config.coalesce_ms);

  switch (kind as BotTriggerKind) {
    case 'cron': {
      const expr = optString(config, 'cron');
      if (!expr) throw invalid('cron trigger needs config.cron (e.g. "0 9 * * 1-5")');
      const timezone = optString(config, 'timezone');
      validateTimezone(timezone);
      validateCronExpression(expr, timezone);
      config.cron = expr;
      break;
    }
    case 'interval':
      config.every_s = positiveInterval(config.every_s, 'every_s');
      break;
    case 'nl_schedule': {
      const text = optString(config, 'text');
      if (!text) throw invalid('nl_schedule trigger needs config.text (e.g. "weekdays at 9am")');
      const timezone = optString(config, 'timezone');
      validateTimezone(timezone);
      const compiled = compileNaturalSchedule(text, timezone);
      if ('error' in compiled) throw invalid(compiled.error);
      config.compiled = { cron: compiled.cron, exclusions: compiled.exclusions, description: compiled.description };
      break;
    }
    case 'webhook': {
      const ref = optString(config, 'secret_ref');
      if (!ref) throw invalid('webhook trigger needs config.secret_ref (a vault secret name used for HMAC-SHA256 signing)');
      config.secret_ref = ref;
      break;
    }
    case 'watch': {
      registerBuiltInWatchAdapters();
      const adapterKind = optString(config, 'adapter');
      if (!adapterKind) throw invalid('watch trigger needs config.adapter (rss, directory, github, http_json)');
      const adapter = getWatchAdapter(adapterKind);
      if (!adapter) throw invalid(`Unknown watch adapter "${adapterKind}"`);
      config.interval_s = positiveInterval(config.interval_s, 'interval_s', DEFAULT_WATCH_INTERVAL_S);
      const adapterError = adapter.validate?.(config);
      if (adapterError) throw invalid(`${adapterKind}: ${adapterError}`);
      break;
    }
    case 'run_completed':
      optString(config, 'status');
      optString(config, 'source');
      optString(config, 'project_id');
      break;
    case 'kanban_event':
      optString(config, 'event');
      optString(config, 'project_id');
      break;
    case 'interrupt_created':
      optString(config, 'kind');
      optString(config, 'severity');
      break;
    default:
      break;
  }
  return config;
}

// ---- scheduler state ---------------------------------------------------------

interface Scheduled {
  signature: string;
  stop: () => void;
}

const scheduled = new Map<string, Scheduled>();
const pollingNow = new Set<string>();
let started = false;
let commitmentTimer: ReturnType<typeof setInterval> | null = null;

const signatureOf = (trigger: BotTrigger): string => JSON.stringify([trigger.kind, trigger.enabled, trigger.config]);

function scheduleTime(at: Date): string {
  return at.toISOString().slice(0, 16);
}

/** Emit a schedule-fired event for a trigger; honours nl_schedule exclusions. Returns true when ingested. */
export function fireScheduledTrigger(trigger: BotTrigger, now: Date = new Date()): boolean {
  if (trigger.kind === 'nl_schedule') {
    const compiled = (trigger.config.compiled ?? {}) as { exclusions?: ScheduleExclusions; description?: string };
    const tz = typeof trigger.config.timezone === 'string' ? trigger.config.timezone : undefined;
    if (isScheduleExcluded(compiled.exclusions, now, tz)) return false;
  }
  const bucket = trigger.kind === 'interval'
    ? String(Math.floor(now.getTime() / (Number(trigger.config.every_s) * 1000)))
    : scheduleTime(now);
  try {
    botSignals.ingest({
      botId: trigger.bot_id,
      triggerId: trigger.trigger_id,
      source: `trigger:${trigger.kind}`,
      kind: 'schedule',
      dedupeKey: `${trigger.trigger_id}:${bucket}`,
      trust: 'internal',
      payload: {
        trigger_kind: trigger.kind,
        scheduled_at: now.toISOString(),
        schedule: trigger.config.cron ?? trigger.config.text ?? `every ${trigger.config.every_s}s`,
      },
    });
    return true;
  } catch (error) {
    console.error('[BotSignals] scheduled ingest failed', { triggerId: trigger.trigger_id, error: errorMessage(error) });
    return false;
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    return secretsService.redact(raw);
  } catch {
    return raw;
  }
}

/** Poll one watch trigger: run its adapter, ingest events, persist the cursor. Never throws. */
export async function pollWatchTrigger(triggerId: string): Promise<{ ingested: number; error?: string }> {
  if (pollingNow.has(triggerId)) return { ingested: 0, error: 'poll already running' };
  const trigger = botTriggersDb.get(triggerId);
  if (!trigger || trigger.kind !== 'watch') return { ingested: 0, error: 'not a watch trigger' };
  pollingNow.add(triggerId);
  try {
    registerBuiltInWatchAdapters();
    const adapterKind = String(trigger.config.adapter ?? '');
    const adapter = getWatchAdapter(adapterKind);
    if (!adapter) throw new Error(`Unknown watch adapter "${adapterKind}"`);
    const { events, cursor } = await adapter.poll(trigger.config, trigger.cursor);
    let ingested = 0;
    for (const draft of events) {
      const result = botSignals.ingest({ ...draft, botId: trigger.bot_id, triggerId: trigger.trigger_id, trust: 'external' });
      if (!result.duplicate) ingested += 1;
    }
    botTriggersDb.update(triggerId, {
      cursor: { ...cursor, last_error: null, last_polled_at: new Date().toISOString() },
    });
    return { ingested };
  } catch (error) {
    const message = errorMessage(error);
    try {
      const latest = botTriggersDb.get(triggerId);
      if (latest) {
        botTriggersDb.update(triggerId, {
          cursor: { ...latest.cursor, last_error: message, last_error_at: new Date().toISOString() },
        });
      }
    } catch {
      // trigger deleted mid-poll
    }
    console.warn('[BotSignals] watch poll failed', { triggerId, error: message });
    return { ingested: 0, error: message };
  } finally {
    pollingNow.delete(triggerId);
  }
}

function startTrigger(trigger: BotTrigger): Scheduled | null {
  const signature = signatureOf(trigger);
  const tz = typeof trigger.config.timezone === 'string' ? trigger.config.timezone : undefined;
  if (trigger.kind === 'cron' || trigger.kind === 'nl_schedule') {
    const expr = trigger.kind === 'cron'
      ? String(trigger.config.cron ?? '')
      : String(((trigger.config.compiled ?? {}) as { cron?: string }).cron ?? '');
    if (!expr) return null;
    const job = new Cron(expr, { timezone: tz }, () => {
      const fresh = botTriggersDb.get(trigger.trigger_id);
      if (fresh?.enabled) fireScheduledTrigger(fresh);
    });
    return { signature, stop: () => job.stop() };
  }
  if (trigger.kind === 'interval') {
    const every = Number(trigger.config.every_s);
    if (!Number.isFinite(every) || every < MIN_INTERVAL_S) return null;
    const timer = setInterval(() => {
      const fresh = botTriggersDb.get(trigger.trigger_id);
      if (fresh?.enabled) fireScheduledTrigger(fresh);
    }, every * 1000);
    timer.unref?.();
    return { signature, stop: () => clearInterval(timer) };
  }
  if (trigger.kind === 'watch') {
    const every = Math.max(MIN_INTERVAL_S, Number(trigger.config.interval_s) || DEFAULT_WATCH_INTERVAL_S);
    const timer = setInterval(() => void pollWatchTrigger(trigger.trigger_id), every * 1000);
    timer.unref?.();
    // Baseline a never-polled watch soon after scheduling instead of waiting a full interval.
    const first = trigger.cursor.initialized === true
      ? null
      : setTimeout(() => void pollWatchTrigger(trigger.trigger_id), 2_000);
    first?.unref?.();
    return {
      signature,
      stop: () => {
        clearInterval(timer);
        if (first) clearTimeout(first);
      },
    };
  }
  return null;
}

/** (Re)schedules cron / interval / nl_schedule / watch timers from the enabled trigger rows. No-op until startSignals(). */
function sync(): void {
  if (!started) return;
  const wanted = new Map(botTriggersDb.listEnabled().map((t) => [t.trigger_id, t]));
  for (const [id, entry] of [...scheduled.entries()]) {
    const trigger = wanted.get(id);
    if (!trigger || entry.signature !== signatureOf(trigger)) {
      entry.stop();
      scheduled.delete(id);
    }
  }
  for (const trigger of wanted.values()) {
    if (scheduled.has(trigger.trigger_id)) continue;
    try {
      const entry = startTrigger(trigger);
      if (entry) scheduled.set(trigger.trigger_id, entry);
    } catch (error) {
      console.error('[BotSignals] failed to schedule trigger', { triggerId: trigger.trigger_id, error: errorMessage(error) });
    }
  }
}

/**
 * Turn open commitments that are due into `commitment_due` events and mark them
 * `fired`. Commitments of disabled bots stay open until the bot is re-enabled.
 */
export function scanCommitments(now: Date = new Date()): number {
  let fired = 0;
  for (const commitment of botCommitmentsDb.listDue(now)) {
    try {
      const bot = missionControlDb.getSection(commitment.bot_id);
      if (!bot || !bot.enabled) continue;
      botSignals.ingest({
        botId: commitment.bot_id,
        source: 'commitment',
        kind: 'commitment_due',
        dedupeKey: `commitment:${commitment.commitment_id}:${commitment.due_at}`,
        trust: 'internal',
        payload: {
          commitment_id: commitment.commitment_id,
          description: commitment.description,
          due_at: commitment.due_at,
          waiting_on: commitment.waiting_on,
          item_id: commitment.item_id,
          goal_id: commitment.goal_id,
        },
      });
      botCommitmentsDb.setStatus(commitment.commitment_id, 'fired');
      fired += 1;
    } catch (error) {
      console.error('[BotSignals] commitment scan failed', { commitmentId: commitment.commitment_id, error: errorMessage(error) });
    }
  }
  return fired;
}

export function startSignals(): void {
  if (started) return;
  registerBuiltInWatchAdapters();
  started = true;
  startAutomationBridge();
  sync();
  scanCommitments();
  commitmentTimer = setInterval(() => scanCommitments(), COMMITMENT_SCAN_MS);
  commitmentTimer.unref?.();
}

export function stopSignals(): void {
  for (const entry of scheduled.values()) entry.stop();
  scheduled.clear();
  if (commitmentTimer) clearInterval(commitmentTimer);
  commitmentTimer = null;
  botSignals.cancelWakes();
  stopAutomationBridge();
  started = false;
}

export function getScheduledTriggerCount(): number {
  return scheduled.size;
}

function requireBot(botId: string): void {
  if (!missionControlDb.getSection(botId)) {
    throw new AppError(`Bot not found: ${botId}`, { code: 'BOT_NOT_FOUND', statusCode: 404 });
  }
}

export interface CreateTriggerInput {
  botId: string;
  kind: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export const botTriggers = {
  list(botId?: string): BotTrigger[] {
    return botTriggersDb.list(botId);
  },

  get(triggerId: string): BotTrigger | null {
    return botTriggersDb.get(triggerId);
  },

  create(input: CreateTriggerInput): BotTrigger {
    requireBot(input.botId);
    const config = validateTriggerConfig(input.kind, input.config);
    const trigger = botTriggersDb.create({ botId: input.botId, kind: input.kind, config, enabled: input.enabled });
    sync();
    return trigger;
  },

  update(triggerId: string, patch: { config?: Record<string, unknown>; enabled?: boolean }): BotTrigger | null {
    const current = botTriggersDb.get(triggerId);
    if (!current) return null;
    const config = patch.config !== undefined ? validateTriggerConfig(current.kind, patch.config) : undefined;
    const updated = botTriggersDb.update(triggerId, {
      config,
      enabled: patch.enabled,
      // A changed watch source invalidates the old cursor.
      cursor: current.kind === 'watch' && config ? {} : undefined,
    });
    sync();
    return updated;
  },

  delete(triggerId: string): boolean {
    const removed = botTriggersDb.delete(triggerId);
    sync();
    return removed;
  },

  /** Re-schedules timers from the database. Safe after any trigger or bot change. */
  sync,

  /** True when the bot has at least one trigger row (kernel uses this to retire the legacy MC scheduler for that bot). */
  hasTriggers(botId: string): boolean {
    return botTriggersDb.list(botId).length > 0;
  },

  /**
   * Mirror a section's legacy `schedule_cron` as a cron trigger (idempotent).
   * Returns the trigger, or null when the section has no (valid) schedule.
   */
  ensureCronTriggerFromSection(section: Pick<McSection, 'section_id' | 'schedule_cron'>): BotTrigger | null {
    const expr = section.schedule_cron?.trim();
    const existing = botTriggersDb
      .list(section.section_id)
      .find((t) => t.kind === 'cron' && t.config.mirrored_from === 'schedule_cron');
    if (!expr) return existing ?? null;
    try {
      validateCronExpression(expr);
    } catch {
      return existing ?? null;
    }
    if (existing) {
      if (existing.config.cron === expr) return existing;
      const updated = botTriggersDb.update(existing.trigger_id, { config: { ...existing.config, cron: expr } });
      sync();
      return updated;
    }
    const created = botTriggersDb.create({
      botId: section.section_id,
      kind: 'cron',
      config: { cron: expr, mirrored_from: 'schedule_cron' },
    });
    sync();
    return created;
  },
};

export const ensureCronTriggerFromSection = botTriggers.ensureCronTriggerFromSection;
