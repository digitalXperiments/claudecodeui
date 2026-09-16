import type { McAction } from '../../../mission-control/api/missionControlApi';

export const ACTION_KINDS = ['approve', 'dismiss', 'delete', 'work', 'reply', 'custom'] as const;
export const ACTION_STYLES = ['primary', 'secondary', 'destructive'] as const;
export type ActionKind = typeof ACTION_KINDS[number];

const SYSTEM_KINDS = new Set(['delete', 'work']);

export function isSystemAction(action: Pick<McAction, 'id' | 'kind'>): boolean {
  return SYSTEM_KINDS.has(action.kind.toLowerCase()) || SYSTEM_KINDS.has(action.id.toLowerCase());
}

export function reorderActions(actions: McAction[], from: number, to: number): McAction[] {
  if (from < 0 || from >= actions.length || to < 0 || to >= actions.length || from === to) return actions;
  const next = [...actions];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function addAction(actions: McAction[], seed?: Partial<McAction>): McAction[] {
  const id = seed?.id?.trim() || `action-${Date.now()}`;
  return [...actions, {
    id,
    label: seed?.label?.trim() || 'New action',
    kind: seed?.kind || 'custom',
    style: seed?.style || 'secondary',
    terminal: seed?.terminal ?? false,
  }];
}

export function removeAction(actions: McAction[], index: number): McAction[] {
  if (!actions[index] || isSystemAction(actions[index])) return actions;
  return actions.filter((_, actionIndex) => actionIndex !== index);
}

export function updateAction(actions: McAction[], index: number, patch: Partial<McAction>): McAction[] {
  const action = actions[index];
  if (!action || isSystemAction(action)) return actions;
  return actions.map((entry, actionIndex) => actionIndex === index ? { ...entry, ...patch } : entry);
}
