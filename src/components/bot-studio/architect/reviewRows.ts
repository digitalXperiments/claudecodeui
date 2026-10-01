/** One-line summaries of the runtime v2 choices, for the Review step and the live preview card. */

import type { BotChannel, BotGateLevel } from '../types/botRuntime';
import { autonomyLabel, permissionModeWords, showProviderPermissionMode } from '../view/tabs/runtime/abilities/abilitiesModel';
import { budgetInputFromDraft, formatUsd, routeLabel } from '../view/tabs/runtime/rules/ruleHelpers';
import { KIND_LABELS, configFromDraft, summarizeTrigger } from '../view/tabs/runtime/triggers/triggerForm';

import { describeChannelChoices } from './channelPlan';
import { activeGoals, readyFallback, type RuntimeDraft } from './runtimeDraft';
import { cronSummary } from './types';

export function scheduleSummary(cron: string | null | undefined, manual: boolean): string {
  return manual || !cron?.trim() ? 'Only when you message it (no schedule)' : cronSummary(cron);
}

/** The extra wake-ups beyond the schedule, one line each. */
export function extraWakeSummary(runtime: RuntimeDraft): string[] {
  return runtime.triggers.map((draft) => `${KIND_LABELS[draft.kind] ?? draft.kind}${draft.enabled ? '' : ' (off)'}: ${summarizeTrigger({ kind: draft.kind, config: configFromDraft(draft) })}`);
}

/** The schedule first, then every extra wake-up. */
export function wakeSummary(cron: string | null | undefined, manual: boolean, runtime: RuntimeDraft): string[] {
  return [scheduleSummary(cron, manual), ...extraWakeSummary(runtime)];
}

export function budgetSummary(runtime: RuntimeDraft): string {
  if (!runtime.budget.enabled) return 'No limits set';
  const result = budgetInputFromDraft(runtime.budget.draft);
  if ('error' in result) return `Not valid yet: ${result.error}`;
  const parts: string[] = [];
  if (result.daily_usd != null) parts.push(`${formatUsd(result.daily_usd)}/day`);
  if (result.monthly_usd != null) parts.push(`${formatUsd(result.monthly_usd)}/month`);
  if (result.daily_actions != null) parts.push(`${result.daily_actions} actions/day`);
  if (result.max_wakes_per_hour != null) parts.push(`${result.max_wakes_per_hour} wake-ups/hour`);
  return parts.length ? parts.join(' · ') : 'No limits set';
}

export function rulesSummary(runtime: RuntimeDraft): string {
  if (runtime.autonomy === 'unrestricted') return 'None: with no gate, rules are never checked';
  const parts: string[] = [];
  if (runtime.rules.allow.length) parts.push(`${runtime.rules.allow.length} tool${runtime.rules.allow.length === 1 ? '' : 's'} allowed without asking (${runtime.rules.allow.map((choice) => choice.tool).join(', ')})`);
  if (runtime.rules.neverDelete) parts.push('never delete');
  if (runtime.rules.neverPurchase) parts.push('never purchase');
  if (parts.length) return parts.join(' · ');
  return runtime.autonomy === 'trusted'
    ? 'Trusted: it acts on its own; credentials and login files stay off limits'
    : 'Safety floor only: sending, publishing, deleting, buying, credentials and production changes always ask';
}

export function goalsSummary(runtime: RuntimeDraft): string {
  const goals = activeGoals(runtime.goals);
  return goals.length ? goals.map((goal) => goal.statement.trim()).join(' · ') : 'None yet (you can add goals later)';
}

export function learningSummary(runtime: RuntimeDraft): string {
  return runtime.learning.autoApply
    ? `Suggests memories, rules and skills for your approval; memories above ${Math.round(runtime.learning.minConfidence * 100)}% confidence apply automatically`
    : 'Suggests memories, rules and skills; nothing applies until you approve it';
}

export function enforcementSummary(provider: string, level: BotGateLevel | null): string {
  if (!level) return 'Checking…';
  if (level === 'off') return 'No gate (Unrestricted): nothing is checked';
  return level === 'enforced' ? `Enforced on ${provider}` : `Advisory on ${provider} (the gate cannot see everything it does)`;
}

/** The labelled rows added to the Review step when the runtime wizard is on. */
export function runtimeReviewRows(input: {
  runtime: RuntimeDraft;
  cron: string | null | undefined;
  manualSchedule: boolean;
  provider: string;
  enforcement: BotGateLevel | null;
  /** The provider permission mode; shown only when it matters (Unrestricted, or a provider the gate can only advise). */
  permissionMode?: string;
  globalChannels: BotChannel[];
}): Array<[string, string]> {
  const { runtime } = input;
  const fallback = readyFallback(runtime);
  const watcher = runtime.watcher.enabled && runtime.watcher.route.provider
    ? routeLabel({ provider: runtime.watcher.route.provider, model: runtime.watcher.route.model ?? undefined, effort: runtime.watcher.route.effort ?? undefined })
    : null;
  const permissionRow: Array<[string, string]> = input.permissionMode !== undefined && showProviderPermissionMode(runtime.autonomy, input.enforcement)
    ? [['Provider permission', `${input.permissionMode || 'default'}: ${permissionModeWords(input.permissionMode)}`]]
    : [];
  return [
    ['Autonomy', autonomyLabel(runtime.autonomy)],
    ['More wake-ups', extraWakeSummary(runtime).join(' · ') || 'None (the schedule above, and when you message it)'],
    ['Goals', goalsSummary(runtime)],
    ['Rules', rulesSummary(runtime)],
    ['Budget', budgetSummary(runtime)],
    ['Enforcement', enforcementSummary(input.provider, input.enforcement)],
    ...permissionRow,
    ['Backup providers', fallback.length ? [input.provider, ...fallback.map(routeLabel)].join(' → ') : 'None'],
    ['Triage model', watcher ?? 'Off (the main model reads every signal)'],
    ['Reaches you on', describeChannelChoices(runtime.channels, input.globalChannels).join(' · ')],
    ['Learning', learningSummary(runtime)],
  ];
}
