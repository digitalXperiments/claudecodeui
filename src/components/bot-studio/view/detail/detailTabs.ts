export type RuntimeDetailTab = 'abilities' | 'activity' | 'thread' | 'goals' | 'triggers' | 'rules' | 'learning';
export type DetailTab = 'overview' | 'pipeline' | 'test' | 'history' | 'settings' | RuntimeDetailTab;

export type DetailTabOptions = {
  /** `bots.runtimeV2`: adds the runtime tabs and makes `triggers` a real tab instead of a legacy redirect. */
  runtimeV2?: boolean;
};

/** Where to land inside a tab: a Pipeline stage, the Architect drawer, or a sub-section. */
export type DetailFocus =
  | 'propose' | 'resolve' | 'work' | 'architect' | 'versions'
  /** Abilities sections; `skill:<name>` also opens that skill. */
  | 'autonomy' | 'apps' | 'skills' | 'spaces' | 'accounts' | `skill:${string}`
  | null;

export const DETAIL_TABS: Array<{ value: DetailTab; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'test', label: 'Test' },
  { value: 'history', label: 'History' },
  { value: 'settings', label: 'Settings' },
];

/** Tabs that only exist while the Bot Runtime v2 flag is on, in display order (after Overview). */
export const RUNTIME_TABS: Array<{ value: RuntimeDetailTab; label: string }> = [
  { value: 'abilities', label: 'Abilities' },
  { value: 'activity', label: 'Activity' },
  { value: 'thread', label: 'Thread' },
  { value: 'goals', label: 'Goals' },
  { value: 'triggers', label: 'Triggers' },
  { value: 'rules', label: 'Rules' },
  { value: 'learning', label: 'Learning' },
];

/** The tab strip: exactly DETAIL_TABS when the flag is off; runtime tabs slot in after Overview when on. */
export function detailTabsFor(runtimeV2: boolean): Array<{ value: DetailTab; label: string }> {
  if (!runtimeV2) return DETAIL_TABS;
  const [overview, ...rest] = DETAIL_TABS;
  return [overview, ...RUNTIME_TABS, ...rest];
}

/** True for ids whose meaning depends on the flag (so a caller may wait for the flag to load). */
export function isRuntimeTabId(raw: string | null | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? '';
  return RUNTIME_TABS.some((entry) => entry.value === value);
}

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
export function resolveDetailTab(
  raw: string | null | undefined,
  options: DetailTabOptions = {},
): { tab: DetailTab; focus: DetailFocus; legacy: boolean } {
  const value = raw?.trim().toLowerCase() ?? '';
  if (detailTabsFor(Boolean(options.runtimeV2)).some((entry) => entry.value === value)) return { tab: value as DetailTab, focus: null, legacy: false };
  const legacy = LEGACY[value];
  return legacy ? { ...legacy, legacy: true } : { tab: 'overview', focus: null, legacy: false };
}
