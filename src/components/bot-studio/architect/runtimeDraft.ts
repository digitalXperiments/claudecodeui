/**
 * Everything the Bot Architect collects for runtime v2 that is NOT part of the mission-control
 * section: extra wake-up triggers, goals, rules, budget, backup providers, a triage model, channels
 * and learning. Pure so it runs under `node --test`: defaults, normalization of stored drafts (old and
 * partial drafts must keep restoring), the goal suggestion and validation.
 */

import type { BotAutonomy, BotPhaseRoute } from '../types/botRuntime';
import { DEFAULT_AUTONOMY, normalizeAutonomy } from '../view/tabs/runtime/abilities/abilitiesModel';
import { emptyDraft, validateDraft, type TriggerDraft } from '../view/tabs/runtime/triggers/triggerForm';
import { budgetInputFromDraft, cleanRoutes, validateRoutes, type BudgetDraft } from '../view/tabs/runtime/rules/ruleHelpers';
import { validateQuietHours, type ConfigDraft } from '../view/runtime/channelsModel';

import type { ArchitectStepId } from './steps';

export const MAX_EXTRA_TRIGGERS = 10;
export const MAX_GOALS = 5;

export type GoalDraftItem = { id: string; statement: string; successCriteria: string; horizon: string };

/** "Let this tool run without asking" for one concrete MCP tool, chosen in Guardrails. */
export type AllowChoice = { server: string; tool: string; risk: string };

export type RouteChoice = { provider: string | null; model: string | null; effort: string | null };

export type OwnChannelKind = 'slack' | 'telegram';

export type OwnChannelDraft = { enabled: boolean; config: ConfigDraft };

export type QuietHoursDraft = { enabled: boolean; start: string; end: string; tz: string };

export type RuntimeDraft = {
  /** How much the bot may do without asking. New bots start Careful. */
  autonomy: BotAutonomy;
  /** Wake-up triggers beyond the section's schedule (which keeps using `schedule_cron`). */
  triggers: TriggerDraft[];
  goals: GoalDraftItem[];
  /** The user dismissed the suggested goal; do not offer it again. */
  goalSuggestionDismissed: boolean;
  /** A cheaper model that screens incoming signals before the main model wakes (`routing.perceive`). */
  watcher: { enabled: boolean; route: RouteChoice };
  /** Backup providers tried in order when the main one errors (`routing.fallback`). */
  fallback: BotPhaseRoute[];
  rules: { allow: AllowChoice[]; neverDelete: boolean; neverPurchase: boolean };
  budget: { enabled: boolean; draft: BudgetDraft };
  channels: {
    /** Global channel ids this bot should NOT use (saved as a disabled bot-specific copy). */
    skipGlobal: string[];
    own: Partial<Record<OwnChannelKind, OwnChannelDraft>>;
    quiet: QuietHoursDraft;
  };
  learning: { autoApply: boolean; minConfidence: number };
};

export const DEFAULT_BUDGET_DRAFT: BudgetDraft = { dailyUsd: '5', monthlyUsd: '100', dailyActions: '', maxWakes: '12', softPercent: '80' };

export const DEFAULT_AUTO_APPLY_CONFIDENCE = 0.9;

export const EMPTY_CHANNEL_CONFIG: ConfigDraft = {
  slackMode: 'bot', tokenRef: '', channelId: '', webhookUrlRef: '', chatId: '', inbound: false, actionBaseUrl: '',
};

export function emptyRuntimeDraft(): RuntimeDraft {
  return {
    autonomy: DEFAULT_AUTONOMY,
    triggers: [],
    goals: [],
    goalSuggestionDismissed: false,
    watcher: { enabled: false, route: { provider: null, model: null, effort: null } },
    fallback: [],
    rules: { allow: [], neverDelete: false, neverPurchase: false },
    budget: { enabled: true, draft: { ...DEFAULT_BUDGET_DRAFT } },
    channels: { skipGlobal: [], own: {}, quiet: { enabled: false, start: '22:00', end: '07:00', tz: '' } },
    learning: { autoApply: false, minConfidence: DEFAULT_AUTO_APPLY_CONFIDENCE },
  };
}

// ---- normalization -------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const nullableText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * Merge a stored (possibly old, partial or hand-edited) value over the defaults. Unknown keys are
 * dropped and wrong types fall back to the default, so a stale draft can never crash the wizard.
 */
export function normalizeRuntimeDraft(raw: unknown): RuntimeDraft {
  const base = emptyRuntimeDraft();
  if (!isObject(raw)) return base;

  const triggers = Array.isArray(raw.triggers)
    ? raw.triggers.filter(isObject).slice(0, MAX_EXTRA_TRIGGERS).map((entry) => ({ ...emptyDraft('nl_schedule'), ...(entry as Partial<TriggerDraft>) }))
    : [];

  const goals = Array.isArray(raw.goals)
    ? raw.goals.filter(isObject).slice(0, MAX_GOALS).map((entry, index): GoalDraftItem => ({
      id: text(entry.id, `goal-${index + 1}`) || `goal-${index + 1}`,
      statement: text(entry.statement),
      successCriteria: text(entry.successCriteria),
      horizon: text(entry.horizon),
    }))
    : [];

  const watcher = isObject(raw.watcher) ? raw.watcher : {};
  const route = isObject(watcher.route) ? watcher.route : {};

  const fallback = Array.isArray(raw.fallback)
    ? raw.fallback.filter(isObject).filter((entry) => typeof entry.provider === 'string').map((entry): BotPhaseRoute => ({
      provider: String(entry.provider),
      ...(typeof entry.model === 'string' && entry.model ? { model: entry.model } : {}),
      ...(typeof entry.effort === 'string' && entry.effort ? { effort: entry.effort } : {}),
    }))
    : [];

  const rules = isObject(raw.rules) ? raw.rules : {};
  const allow = Array.isArray(rules.allow)
    ? rules.allow.filter(isObject)
      .filter((entry) => typeof entry.server === 'string' && typeof entry.tool === 'string' && typeof entry.risk === 'string')
      .map((entry): AllowChoice => ({ server: String(entry.server), tool: String(entry.tool), risk: String(entry.risk) }))
    : [];

  const budget = isObject(raw.budget) ? raw.budget : {};
  const budgetDraft = isObject(budget.draft) ? budget.draft : {};

  const channels = isObject(raw.channels) ? raw.channels : {};
  const own: RuntimeDraft['channels']['own'] = {};
  if (isObject(channels.own)) {
    for (const kind of ['slack', 'telegram'] as const) {
      const entry = channels.own[kind];
      if (!isObject(entry)) continue;
      const config = isObject(entry.config) ? entry.config : {};
      own[kind] = {
        enabled: bool(entry.enabled, false),
        config: {
          ...EMPTY_CHANNEL_CONFIG,
          slackMode: config.slackMode === 'webhook' ? 'webhook' : 'bot',
          tokenRef: text(config.tokenRef),
          channelId: text(config.channelId),
          webhookUrlRef: text(config.webhookUrlRef),
          chatId: text(config.chatId),
          inbound: bool(config.inbound, false),
          actionBaseUrl: text(config.actionBaseUrl),
        },
      };
    }
  }
  const quiet = isObject(channels.quiet) ? channels.quiet : {};

  const learning = isObject(raw.learning) ? raw.learning : {};
  const confidence = typeof learning.minConfidence === 'number' && Number.isFinite(learning.minConfidence) ? learning.minConfidence : DEFAULT_AUTO_APPLY_CONFIDENCE;

  return {
    autonomy: normalizeAutonomy(raw.autonomy),
    triggers,
    goals,
    goalSuggestionDismissed: bool(raw.goalSuggestionDismissed, false),
    watcher: {
      enabled: bool(watcher.enabled, false),
      route: { provider: nullableText(route.provider), model: nullableText(route.model), effort: nullableText(route.effort) },
    },
    fallback,
    rules: { allow, neverDelete: bool(rules.neverDelete, false), neverPurchase: bool(rules.neverPurchase, false) },
    budget: {
      enabled: bool(budget.enabled, base.budget.enabled),
      draft: {
        dailyUsd: text(budgetDraft.dailyUsd, base.budget.draft.dailyUsd),
        monthlyUsd: text(budgetDraft.monthlyUsd, base.budget.draft.monthlyUsd),
        dailyActions: text(budgetDraft.dailyActions, base.budget.draft.dailyActions),
        maxWakes: text(budgetDraft.maxWakes, base.budget.draft.maxWakes),
        softPercent: text(budgetDraft.softPercent, base.budget.draft.softPercent),
      },
    },
    channels: {
      skipGlobal: Array.isArray(channels.skipGlobal) ? channels.skipGlobal.filter((id): id is string => typeof id === 'string') : [],
      own,
      quiet: {
        enabled: bool(quiet.enabled, false),
        start: text(quiet.start, base.channels.quiet.start) || base.channels.quiet.start,
        end: text(quiet.end, base.channels.quiet.end) || base.channels.quiet.end,
        tz: text(quiet.tz),
      },
    },
    learning: { autoApply: bool(learning.autoApply, false), minConfidence: Math.min(1, Math.max(0, confidence)) },
  };
}

// ---- goal suggestion -----------------------------------------------------------------------

export type GoalSuggestion = { statement: string; successCriteria: string };

const MIN_PURPOSE_LENGTH = 12;

const CRITERIA: Array<{ pattern: RegExp; criteria: string }> = [
  { pattern: /triage|classif|urgen|priorit|categori|sort/i, criteria: 'Every new item is classified with evidence, and I rarely have to correct a label.' },
  { pattern: /summar|digest|report|recap|brief/i, criteria: 'A short, accurate summary reaches me on time, and I rarely have to ask for more detail.' },
  { pattern: /watch|monitor|track|alert|notify|detect|spot/i, criteria: 'Anything important is flagged soon after it appears, with no noise or duplicates.' },
  { pattern: /draft|repl|respond|write|compose/i, criteria: 'Drafts need little editing before I approve them, and none go out without my say-so.' },
];
const DEFAULT_CRITERIA = 'Each wake-up gives me something I can act on, backed by evidence, so I can approve it without redoing the work.';

/** The first sentence of the purpose, tidied and capped. */
export function firstSentence(value: string, max = 180): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = (end >= 0 ? flat.slice(0, end) : flat).trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/**
 * One starter goal derived from the purpose text with plain string rules (no model call). Returns
 * null when there is not enough purpose to say anything useful.
 */
export function suggestGoal(title: string, purpose: string): GoalSuggestion | null {
  const sentence = firstSentence(purpose);
  if (sentence.length < MIN_PURPOSE_LENGTH) return null;
  const lead = sentence[0].toLowerCase() + sentence.slice(1);
  const name = title.trim();
  const statement = name ? `${name}: ${lead}, consistently` : `${sentence[0].toUpperCase()}${sentence.slice(1)}, consistently`;
  const criteria = CRITERIA.find((entry) => entry.pattern.test(purpose))?.criteria ?? DEFAULT_CRITERIA;
  return { statement: statement.slice(0, 500), successCriteria: criteria };
}

export function newGoalId(existing: GoalDraftItem[]): string {
  let n = existing.length + 1;
  while (existing.some((goal) => goal.id === `goal-${n}`)) n += 1;
  return `goal-${n}`;
}

// ---- validation ----------------------------------------------------------------------------

export type DraftProblem = { step: ArchitectStepId; message: string };

export const GOAL_LIMITS = { statement: 500, criteria: 2000, horizon: 100 } as const;

/** Goals with no statement are dropped on create; a half-filled one is a mistake worth flagging. */
export function goalProblems(goals: GoalDraftItem[]): string[] {
  const problems: string[] = [];
  goals.forEach((goal, index) => {
    const label = `Goal ${index + 1}`;
    if (!goal.statement.trim()) {
      if (goal.successCriteria.trim() || goal.horizon.trim()) problems.push(`${label} needs a statement (or remove it).`);
      return;
    }
    if (goal.statement.trim().length > GOAL_LIMITS.statement) problems.push(`${label}: the statement is too long (max ${GOAL_LIMITS.statement} characters).`);
    if (goal.successCriteria.length > GOAL_LIMITS.criteria) problems.push(`${label}: the success criteria are too long (max ${GOAL_LIMITS.criteria} characters).`);
    if (goal.horizon.length > GOAL_LIMITS.horizon) problems.push(`${label}: the horizon is too long (max ${GOAL_LIMITS.horizon} characters).`);
  });
  return problems;
}

/** Goals that will actually be created. */
export const activeGoals = (goals: GoalDraftItem[]): GoalDraftItem[] => goals.filter((goal) => goal.statement.trim());

/**
 * Problems that must be fixed before Create, each tagged with the step that fixes it. Channel
 * credentials are validated by the channel plan (it needs the global channel list), not here.
 */
export function validateRuntimeDraft(runtime: RuntimeDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const push = (step: ArchitectStepId, message: string) => problems.push({ step, message });

  if (runtime.triggers.length > MAX_EXTRA_TRIGGERS) push('triggers', `At most ${MAX_EXTRA_TRIGGERS} extra wake-ups.`);
  runtime.triggers.forEach((trigger, index) => {
    const message = validateDraft(trigger);
    if (message) push('triggers', `Wake-up ${index + 1}: ${message}`);
  });

  for (const message of goalProblems(runtime.goals)) push('goals', message);

  if (runtime.watcher.enabled && !runtime.watcher.route.provider) push('agent', 'Pick a provider for the triage model, or turn it off.');
  const routeError = validateRoutes(runtime.fallback);
  if (routeError) push('agent', routeError);

  if (runtime.budget.enabled) {
    const result = budgetInputFromDraft(runtime.budget.draft);
    if ('error' in result) push('guardrails', result.error);
  }

  const quiet = runtime.channels.quiet;
  if (quiet.enabled) {
    const message = validateQuietHours(quiet.start, quiet.end, quiet.tz);
    if (message) push('reach', message);
  }

  const { minConfidence } = runtime.learning;
  if (runtime.learning.autoApply && !(minConfidence >= 0.5 && minConfidence <= 1)) push('reach', 'Auto-apply confidence must be between 50% and 100%.');
  return problems;
}

/** Same routes, ready to send (blank model/effort dropped). */
export const readyFallback = (runtime: RuntimeDraft): BotPhaseRoute[] => cleanRoutes(runtime.fallback);
