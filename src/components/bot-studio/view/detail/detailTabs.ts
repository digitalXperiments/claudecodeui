export type DetailTab = 'overview' | 'pipeline' | 'test' | 'history' | 'settings';

/** Where to land inside a tab: a Pipeline stage, the Architect drawer, or a sub-section. */
export type DetailFocus = 'propose' | 'resolve' | 'work' | 'architect' | 'versions' | null;

export const DETAIL_TABS: Array<{ value: DetailTab; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'test', label: 'Test' },
  { value: 'history', label: 'History' },
  { value: 'settings', label: 'Settings' },
];

const LEGACY: Record<string, { tab: DetailTab; focus: DetailFocus }> = {
  inbox: { tab: 'overview', focus: null },
  brief: { tab: 'pipeline', focus: null },
  tools: { tab: 'pipeline', focus: 'propose' },
  triggers: { tab: 'pipeline', focus: 'propose' },
  outputs: { tab: 'pipeline', focus: 'resolve' },
  iterate: { tab: 'pipeline', focus: 'architect' },
  simulator: { tab: 'test', focus: null },
  ticks: { tab: 'history', focus: null },
  versions: { tab: 'history', focus: 'versions' },
  trust: { tab: 'settings', focus: null },
  memory: { tab: 'settings', focus: null },
  danger: { tab: 'settings', focus: null },
};

/** Maps a URL tab id (current or pre-consolidation) to a tab plus optional focus. */
export function resolveDetailTab(raw: string | null | undefined): { tab: DetailTab; focus: DetailFocus; legacy: boolean } {
  const value = raw?.trim().toLowerCase() ?? '';
  if (DETAIL_TABS.some((entry) => entry.value === value)) return { tab: value as DetailTab, focus: null, legacy: false };
  const legacy = LEGACY[value];
  return legacy ? { ...legacy, legacy: true } : { tab: 'overview', focus: null, legacy: false };
}
