/** Approvals everywhere: bot interrupts fan out to the operator's channels as signed action links. */

import { addAutomationEventSink, type AutomationFireInput } from '@/modules/automation/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { notifyOperator, type NotifyResult } from '@/modules/bots/channels/notify.service.js';

export const APPROVAL_INTERRUPT_KINDS: readonly string[] = ['bot_gate', 'approval_pending', 'bot_handoff'];
export const APPROVAL_URGENCY = 0.8;
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
  return notifyOperator({
    botId,
    title: interrupt.title,
    body: interrupt.body || interrupt.title,
    urgency: APPROVAL_URGENCY,
    actions: interrupt.actions,
    interruptId: interrupt.interrupt_id,
    href: interrupt.href ?? undefined,
  });
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
