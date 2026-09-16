import type { McItem, McSection } from '../../mission-control/api/missionControlApi';

export const BOT_STUDIO_CENTRE_COLLAPSE_THRESHOLD = 620;

/** Narrow centres need the context pane hidden until the operator picks a context. */
export function shouldTemporarilyCollapseContext(centerWidth: number, hasSelection: boolean): boolean {
  return !hasSelection && centerWidth > 0 && centerWidth < BOT_STUDIO_CENTRE_COLLAPSE_THRESHOLD;
}

/** Replace one inbox item's status without mutating the hook's current list. */
export function setItemStatus(items: McItem[], itemId: string, status: McItem['status']): McItem[] {
  return items.map((item) => item.item_id === itemId ? { ...item, status } : item);
}

/** Apply an item returned by an action/retry response, preserving list order. */
export function upsertItem(items: McItem[], nextItem: McItem): McItem[] {
  const index = items.findIndex((item) => item.item_id === nextItem.item_id);
  if (index < 0) return [nextItem, ...items];
  return items.map((item) => item.item_id === nextItem.item_id ? nextItem : item);
}

/** Remove an item deleted by a terminal action. */
export function removeItem(items: McItem[], itemId: string): McItem[] {
  return items.filter((item) => item.item_id !== itemId);
}

/** Keep a section update local until the next summary refresh catches up. */
export function upsertSection(sections: McSection[], nextSection: McSection): McSection[] {
  const index = sections.findIndex((section) => section.section_id === nextSection.section_id);
  if (index < 0) return [...sections, nextSection];
  return sections.map((section) => section.section_id === nextSection.section_id ? nextSection : section);
}
