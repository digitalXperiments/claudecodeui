/**
 * Bridges automation-kernel events (run_completed, kanban_event,
 * interrupt_created, webhook_inbound) onto bot triggers so recipes and bots
 * observe the same stream. Registered through `configureAutomationEventSink`.
 */

import { configureAutomationEventSink, type AutomationFireInput } from '@/modules/automation/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { kanbanDb } from '@/modules/kanban/index.js';
import { runService } from '@/modules/runs/index.js';
import type { BotTrigger, BotTrust } from '@/modules/bots/bots.types.js';
import { botTriggersDb } from '@/modules/bots/signals/bot-triggers.repository.js';
import { botSignals } from '@/modules/bots/signals/signals.service.js';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The bot id recorded in a run/interrupt `meta`, if the bot created it. */
function botIdFromMeta(meta: unknown): string {
  if (!meta || typeof meta !== 'object') return '';
  const m = meta as Record<string, unknown>;
  return str(m.botId) || str(m.bot_id) || str(m.sectionId) || str(m.section_id);
}

function matches(filter: unknown, actual: unknown): boolean {
  const expected = str(filter);
  return !expected || expected === str(actual);
}

function originBotOfRun(runId: string): string {
  if (!runId) return '';
  try {
    const run = runService.get(runId);
    if (!run) return '';
    const fromMeta = botIdFromMeta(run.meta);
    if (fromMeta) return fromMeta;
    // Bot runs are Mission Control runs whose sourceRef is the bot (section) id.
    return run.source === 'mission_control' ? str(run.source_ref) : '';
  } catch {
    return '';
  }
}

/** Marker a bot-authored kanban task carries in its title/description/prompt: `[bot:<id>]`. */
const BOT_TASK_MARKER = /\[bot:[^\]\s]+\]/i;

/** True when the kanban task (or its event payload) says a bot created it. Fails open (false) only when nothing says so. */
function taskCreatedByBot(taskId: string, payload: Record<string, unknown>): boolean {
  const origin = str(payload.source) || str(payload.createdBy) || str(payload.created_by) || str(payload.origin);
  if (/^bot(?::|$)/i.test(origin) || botIdFromMeta(payload.meta)) return true;
  if (!taskId) return false;
  try {
    const task = kanbanDb.getTask(taskId);
    if (!task) return false;
    return [task.title, task.description, task.prompt].some((text) => BOT_TASK_MARKER.test(str(text)));
  } catch {
    return false;
  }
}

/** Bot-origin events wake a trigger only when it opts in with `allow_bot_origin: true` (loop guard). */
const allowsBotOrigin = (trigger: BotTrigger): boolean => trigger.config.allow_bot_origin === true;

function originBotOfInterrupt(interruptId: string): string {
  if (!interruptId) return '';
  try {
    return botIdFromMeta(interruptsService.get(interruptId)?.meta);
  } catch {
    return '';
  }
}

interface Mapped {
  source: string;
  kind: string;
  trust: BotTrust;
  dedupeKey?: string;
  payload: Record<string, unknown>;
}

function map(trigger: BotTrigger, input: AutomationFireInput): Mapped | null {
  const payload = input.payload ?? {};
  const projectId = str(input.projectId) || str(payload.projectId);
  switch (input.type) {
    case 'run_completed': {
      if (trigger.kind !== 'run_completed') return null;
      if (!matches(trigger.config.status, payload.status)) return null;
      if (!matches(trigger.config.source, payload.source)) return null;
      if (!matches(trigger.config.project_id, projectId)) return null;
      const runId = str(payload.runId);
      // Loop guard: a bot must not wake on runs of ANY bot unless the trigger opts in.
      if (originBotOfRun(runId) && !allowsBotOrigin(trigger)) return null;
      return {
        source: 'automation:run_completed',
        kind: 'run_completed',
        trust: 'internal',
        dedupeKey: runId ? `run_completed:${runId}` : undefined,
        payload: { run_id: runId, status: payload.status, run_source: payload.source, project_id: projectId || null },
      };
    }
    case 'kanban_event': {
      if (trigger.kind !== 'kanban_event') return null;
      if (!matches(trigger.config.event, input.event)) return null;
      if (!matches(trigger.config.project_id, projectId)) return null;
      const taskId = str(payload.taskId);
      // Loop guard: a task a bot created must not wake a bot (same opt-in as runs).
      if (taskCreatedByBot(taskId, payload) && !allowsBotOrigin(trigger)) return null;
      return {
        source: 'automation:kanban_event',
        kind: 'kanban_event',
        trust: 'internal',
        dedupeKey: taskId && input.event ? `kanban:${taskId}:${input.event}` : undefined,
        payload: { event: input.event ?? null, task_id: taskId || null, title: payload.title ?? null, status: payload.status ?? null, project_id: projectId || null },
      };
    }
    case 'interrupt_created': {
      if (trigger.kind !== 'interrupt_created') return null;
      if (!matches(trigger.config.kind, payload.kind)) return null;
      if (!matches(trigger.config.severity, payload.severity)) return null;
      const interruptId = str(payload.interruptId);
      if (originBotOfInterrupt(interruptId) && !allowsBotOrigin(trigger)) return null;
      return {
        source: 'automation:interrupt_created',
        kind: 'interrupt_created',
        trust: 'internal',
        dedupeKey: interruptId ? `interrupt:${interruptId}` : undefined,
        payload: { interrupt_id: interruptId, interrupt_kind: payload.kind ?? null, severity: payload.severity ?? null, run_id: payload.runId ?? null, task_id: payload.taskId ?? null },
      };
    }
    case 'webhook_inbound': {
      // Only bot webhook triggers that explicitly subscribe to a legacy webhook source.
      if (trigger.kind !== 'webhook') return null;
      const wanted = str(trigger.config.source);
      if (!wanted || wanted !== str(payload.source)) return null;
      const deliveryId = str(payload.deliveryId);
      return {
        source: 'automation:webhook_inbound',
        kind: 'webhook',
        // The body comes from outside CloudCLI, so it is treated as untrusted content.
        trust: 'external',
        dedupeKey: deliveryId ? `webhook_delivery:${deliveryId}` : undefined,
        payload: { delivery_id: deliveryId || null, source: payload.source, title: payload.title ?? null, text: payload.text ?? null, payload: payload.payload ?? null },
      };
    }
    default:
      return null;
  }
}

/** Maps one automation event to matching bot triggers and ingests it. Never throws. */
export function handleAutomationEvent(input: AutomationFireInput): number {
  if (input.type === 'cron' || input.type === 'manual') return 0;
  let ingested = 0;
  let triggers: BotTrigger[];
  try {
    triggers = botTriggersDb.listEnabled();
  } catch {
    return 0;
  }
  for (const trigger of triggers) {
    try {
      const mapped = map(trigger, input);
      if (!mapped) continue;
      const result = botSignals.ingest({
        botId: trigger.bot_id,
        triggerId: trigger.trigger_id,
        source: mapped.source,
        kind: mapped.kind,
        dedupeKey: mapped.dedupeKey,
        trust: mapped.trust,
        payload: mapped.payload,
      });
      if (!result.duplicate) ingested += 1;
    } catch (error) {
      console.error('[BotSignals] automation bridge ingest failed', {
        triggerId: trigger.trigger_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ingested;
}

export function startAutomationBridge(): void {
  configureAutomationEventSink((input) => {
    handleAutomationEvent(input);
  });
}

export function stopAutomationBridge(): void {
  configureAutomationEventSink(null);
}
