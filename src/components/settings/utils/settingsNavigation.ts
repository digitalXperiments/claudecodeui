import type { SettingsMainTab } from '../types/types';

const KNOWN_MAIN_TABS: SettingsMainTab[] = [
  'agents',
  'agent-profiles',
  'continuity',
  'studio',
  'evals',
  'mcp',
  'skills',
  'memory',
  'appearance',
  'git',
  'api',
  'secrets',
  'voice',
  'tasks',
  'browser',
  'notifications',
  'plugins',
  'webhooks',
  'security',
  'about',
];

export function normalizeSettingsMainTab(tab: string): SettingsMainTab {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') return 'agents';
  // Former Global skills tab is merged into Skills.
  if (tab === 'global-skills') return 'skills';
  // Model profiles / Agent Relay live on the Agent Relay sidebar page now.
  if (tab === 'model-registry' || tab === 'agent-relay') return 'agents';

  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'agents';
}
