import type { McItem } from '@/modules/mission-control/mission-control.types.js';

/**
 * Human/automatic review signals on Mission Control items. The bot learning loop subscribes;
 * nothing here depends on it. Listeners run synchronously and can never break the review flow.
 */
export type ItemFeedbackKind = 'approve' | 'deny' | 'dismiss' | 'delete' | 'action' | 'accept' | 'send_back' | 'edit';

export type ItemFeedbackEvent = {
  itemId: string;
  sectionId: string;
  kind: ItemFeedbackKind;
  /** `auto` = the pipeline acted (auto-approve); those are not learning signals. */
  actor: 'human' | 'auto';
  at: string;
  actionId?: string;
  actionKind?: string;
  /** Send-back text, or a short summary of the operator's edit. */
  text?: string;
  /** The item as it was when the operator acted (deleted items are gone afterwards). */
  item: McItem;
};

export type ItemFeedbackListener = (event: ItemFeedbackEvent) => void | Promise<void>;

const listeners = new Set<ItemFeedbackListener>();

export function onItemFeedback(listener: ItemFeedbackListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitItemFeedback(event: Omit<ItemFeedbackEvent, 'at' | 'actor'> & { actor?: ItemFeedbackEvent['actor']; at?: string }): void {
  const full: ItemFeedbackEvent = { ...event, actor: event.actor ?? 'human', at: event.at ?? new Date().toISOString() };
  for (const listener of [...listeners]) {
    try {
      const result = listener(full);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((error: unknown) => console.warn('[mission-control] feedback listener failed', error));
      }
    } catch (error) {
      console.warn('[mission-control] feedback listener failed', error);
    }
  }
}

const clip = (value: unknown, max: number): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

/** One-line description of how an operator's edited body differs from the drafted one. */
export function summarizeBodyEdit(before: Record<string, unknown>, after: Record<string, unknown>): string | null {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes = keys
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .slice(0, 6)
    .map((key) => `${key}: ${clip(before[key], 80)} -> ${clip(after[key], 80)}`);
  return changes.length ? changes.join('; ') : null;
}
