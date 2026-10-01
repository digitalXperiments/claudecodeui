/** Approvals everywhere: bot interrupts fan out to the operator's channels as signed action links. */

import { addAutomationEventSink, type AutomationFireInput } from '@/modules/automation/index.js';
import { systemNotificationsDb } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { expiredApprovalMessage, formatWait } from '@/modules/bots/gate/approval-text.js';
import type { HumanWaitInfo } from '@/modules/bots/gate/action-gate.service.js';
import { notifyOperator, type NotifyResult } from '@/modules/bots/channels/notify.service.js';
import { thread } from '@/modules/bots/channels/thread.service.js';

export const APPROVAL_INTERRUPT_KINDS: readonly string[] = ['bot_gate', 'approval_pending', 'bot_handoff'];
export const APPROVAL_URGENCY = 0.8;
/** An approval, its reminder and its expiry notice reach every enabled channel whatever the quiet-hours policy. */
const SEEN_CAP = 500;

const seen = new Set<string>();

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Notify for one interrupt. Null when it is not a bot approval, not open, or already announced. */
export async function fanOutInterrupt(interruptId: string): Promise<NotifyResult | null> {
  if (!interruptId || seen.has(interruptId)) return null;
  const interrupt = interruptsService.get(interruptId);
  if (!interrupt || interrupt.status !== 'open' || !APPROVAL_INTERRUPT_KINDS.includes(interrupt.kind)) return null;
  const botId = str(interrupt.meta.botId) || str(interrupt.meta.bot_id) || str(interrupt.meta.sectionId) || str(interrupt.meta.section_id);
  if (!botId) return null;
  seen.add(interruptId);
  if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
  const result = await notifyOperator({
    botId,
    title: interrupt.title,
    body: interrupt.body || interrupt.title,
    urgency: APPROVAL_URGENCY,
    actions: interrupt.actions,
    interruptId: interrupt.interrupt_id,
    href: interrupt.href ?? undefined,
    critical: true,
  });
  reportUnreachable(result, { botId, interruptId: interrupt.interrupt_id, href: interrupt.href ?? undefined, what: 'approve here' });
  return result;
}

const FAILED_CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', slack: 'Slack', webpush: 'web push', email: 'email' };

/**
 * Delivery guarantee: when every external channel that was tried failed, say so in the app (a system
 * notification) with the reason, so a silent phone is never the only trace that an approval is waiting.
 */
export function reportUnreachable(
  result: NotifyResult,
  context: { botId: string; interruptId: string; href?: string; what: string },
): boolean {
  const external = result.failures.filter((failure) => failure.kind !== 'inapp');
  const reached = result.delivered.some((kind) => kind !== 'inapp');
  if (external.length === 0 || reached) return false;
  const kinds = [...new Set(external.map((failure) => FAILED_CHANNEL_LABEL[failure.kind] ?? failure.kind))];
  const reason = external.map((failure) => failure.detail).filter(Boolean)[0] ?? 'delivery failed';
  try {
    systemNotificationsDb.create({
      kind: 'bot_notice',
      severity: 'warning',
      title: `Couldn't reach you on ${kinds.join(' and ')}: ${reason.slice(0, 160)} \u2014 ${context.what}`,
      body: 'The approval is still waiting in CloudCLI.',
      source: 'bot',
      href: context.href ?? `/bots/b/${encodeURIComponent(context.botId)}/overview`,
      meta: { botId: context.botId, interruptId: context.interruptId, kind: 'approval_delivery_failed', channels: kinds },
      dedupeKey: `approval-delivery-failed:${context.interruptId}`,
    });
    broadcastSystemEvent({ kind: 'notification_created' });
  } catch (error) {
    console.warn('[BotChannels] could not record the delivery failure', error instanceof Error ? error.message : error);
  }
  return true;
}

const botTitleOf = (botId: string): string => {
  try {
    return missionControlDb.getSection(botId)?.title?.trim() || 'Bot';
  } catch {
    return 'Bot';
  }
};

/** Half the wait is gone and the approval is still open: one more ping, with the same buttons. */
export async function announceApprovalReminder(info: HumanWaitInfo): Promise<NotifyResult | null> {
  const interrupt = interruptsService.get(info.interruptId);
  if (!interrupt || interrupt.status !== 'open') return null;
  const left = Math.max(0, info.timeoutMs - info.waitedMs);
  const result = await notifyOperator({
    botId: info.botId,
    title: `Reminder: ${interrupt.title}`,
    body: `Still waiting for your OK to ${info.action}. I will stop waiting in about ${formatWait(left)}.\n\n${interrupt.body || ''}`.trim(),
    urgency: APPROVAL_URGENCY,
    actions: interrupt.actions,
    interruptId: interrupt.interrupt_id,
    href: interrupt.href ?? undefined,
    critical: true,
  });
  reportUnreachable(result, { botId: info.botId, interruptId: info.interruptId, href: interrupt.href ?? undefined, what: 'approve here' });
  return result;
}

/** Nobody answered: the bot says so in its thread and the operator is told on every channel. */
export async function announceApprovalExpired(info: HumanWaitInfo): Promise<NotifyResult | null> {
  const body = expiredApprovalMessage(info.action, info.waitedMs);
  try {
    thread.post(info.botId, {
      role: 'bot',
      body,
      meta: { kind: 'approval_expired', decision_id: info.decisionId, interrupt_id: info.interruptId, episode_id: info.episodeId },
    });
  } catch (error) {
    console.warn('[BotChannels] could not post the expired approval', error instanceof Error ? error.message : error);
  }
  const result = await notifyOperator({
    botId: info.botId,
    title: `${botTitleOf(info.botId)} stopped waiting for your OK`,
    body,
    urgency: APPROVAL_URGENCY,
    href: `/bots/b/${encodeURIComponent(info.botId)}/overview`,
    critical: true,
  });
  reportUnreachable(result, { botId: info.botId, interruptId: `${info.interruptId}:expired`, what: 'open the bot' });
  return result;
}

function onAutomationEvent(input: AutomationFireInput): void {
  if (input.type !== 'interrupt_created') return;
  const kind = str(input.payload?.kind);
  if (!APPROVAL_INTERRUPT_KINDS.includes(kind)) return;
  void fanOutInterrupt(str(input.payload?.interruptId)).catch((error) => {
    console.warn('[BotChannels] approval fan-out failed', error instanceof Error ? error.message : error);
  });
}

let unsubscribe: (() => void) | null = null;

export function startApprovalFanout(): void {
  unsubscribe?.();
  unsubscribe = addAutomationEventSink(onAutomationEvent);
}

export function stopApprovalFanout(): void {
  unsubscribe?.();
  unsubscribe = null;
}

export function resetApprovalFanoutState(): void {
  seen.clear();
}
