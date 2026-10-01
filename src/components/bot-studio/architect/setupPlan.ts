/**
 * Draft -> API payload mapping and the "create, then configure" executor for a new bot.
 *
 * The section is created first (as today). Everything runtime v2 needs afterwards is a list of small
 * tasks, each one API call, so progress and failure are reported per task and "retry remaining" re-runs
 * only what did not finish. When the user wants the bot enabled, creation leaves it paused and a final
 * `enable` task turns it on only after every other task succeeded, so a bot never runs its first wake
 * before its budget and rules exist.
 */

import type {
  BotAutonomy, BotBudgetInput, BotChannel, BotChannelInput, BotGoalInput, BotPhaseRoute, BotRuleInput,
} from '../types/botRuntime';
import { botRuntimeApi } from '../api/botRuntimeApi';
import { budgetInputFromDraft } from '../view/tabs/runtime/rules/ruleHelpers';
import {
  KIND_LABELS, configFromDraft, summarizeTrigger, type TriggerDraft,
} from '../view/tabs/runtime/triggers/triggerForm';

import { planChannels } from './channelPlan';
import {
  activeGoals, readyFallback, validateRuntimeDraft, type RuntimeDraft,
} from './runtimeDraft';
import { allowRuleInput, denyRiskRuleInput } from './toolRisk';

export type SetupGroup = 'autonomy' | 'triggers' | 'goals' | 'rules' | 'budget' | 'routing' | 'learning' | 'channels' | 'enable';

export type SetupCall =
  | { type: 'autonomy'; autonomy: BotAutonomy }
  | { type: 'trigger'; input: { kind: string; config: Record<string, unknown>; enabled: boolean } }
  | { type: 'goal'; input: BotGoalInput }
  | { type: 'rule'; input: BotRuleInput }
  | { type: 'budget'; input: BotBudgetInput }
  | { type: 'perceive'; route: BotPhaseRoute }
  | { type: 'fallback'; routes: BotPhaseRoute[] }
  | { type: 'learning'; minConfidence: number }
  | { type: 'channel'; input: Omit<BotChannelInput, 'botId'> }
  | { type: 'enable' };

export type SetupTask = { id: string; group: SetupGroup; label: string; call: SetupCall };

export type SetupStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export type SetupTaskState = { status: SetupStatus; error?: string; result?: unknown };

export type SetupState = Record<string, SetupTaskState>;

/** What the executor needs from the outside world; the real one is `defaultSetupApi`. */
export interface SetupApi {
  setAutonomy(botId: string, autonomy: BotAutonomy): Promise<unknown>;
  createTrigger(botId: string, input: { kind: string; config: Record<string, unknown>; enabled: boolean }): Promise<unknown>;
  createGoal(botId: string, input: BotGoalInput): Promise<unknown>;
  createRule(botId: string, input: BotRuleInput): Promise<unknown>;
  putBudget(botId: string, input: BotBudgetInput): Promise<unknown>;
  setPerceive(botId: string, route: BotPhaseRoute): Promise<unknown>;
  setFallback(botId: string, routes: BotPhaseRoute[]): Promise<unknown>;
  setLearning(botId: string, minConfidence: number): Promise<unknown>;
  createChannel(botId: string, input: Omit<BotChannelInput, 'botId'>): Promise<unknown>;
  enableBot(botId: string): Promise<unknown>;
}

// ---- building the plan ---------------------------------------------------------------------

export type SetupPlanInput = {
  runtime: RuntimeDraft;
  /** Shared channels as returned by GET /channels (needed to copy/override by kind). */
  globalChannels: BotChannel[];
  /** The user wants the bot running right after setup (the wizard's "Enabled after save"). */
  enableAfter: boolean;
};

export type SetupPlan = { tasks: SetupTask[]; errors: string[] };

function triggerLabel(draft: TriggerDraft): string {
  const summary = summarizeTrigger({ kind: draft.kind, config: configFromDraft(draft) });
  return `${KIND_LABELS[draft.kind] ?? draft.kind}: ${summary}`;
}

/**
 * Every task needed to configure the bot, in a safe order (limits and rules before anything that can
 * wake it). `errors` are validation problems; the caller must not create the bot while any remain.
 */
export function buildSetupPlan(input: SetupPlanInput): SetupPlan {
  const { runtime } = input;
  const errors = validateRuntimeDraft(runtime).map((problem) => problem.message);
  const tasks: SetupTask[] = [];
  const bypass = runtime.autonomy === 'bypass';

  // Ask is the server default, so it needs no call. Anything else is saved before rules, budget or wake-ups exist.
  if (runtime.autonomy !== 'ask') {
    tasks.push({ id: 'autonomy', group: 'autonomy', label: runtime.autonomy === 'auto' ? 'Let it act on its own (Auto)' : 'Remove the action gate (Bypass)', call: { type: 'autonomy', autonomy: runtime.autonomy } });
  }

  if (runtime.budget.enabled) {
    const budget = budgetInputFromDraft(runtime.budget.draft);
    if (!('error' in budget)) tasks.push({ id: 'budget', group: 'budget', label: 'Set spending and wake-up limits', call: { type: 'budget', input: budget } });
  }

  // With no gate (Bypass) rules would never be consulted, so none are created.
  if (!bypass) {
    runtime.rules.allow.forEach((choice, index) => {
      tasks.push({ id: `rule-allow-${index}`, group: 'rules', label: `Let it run ${choice.tool} without asking`, call: { type: 'rule', input: allowRuleInput(choice) } });
    });
    if (runtime.rules.neverDelete) tasks.push({ id: 'rule-deny-delete', group: 'rules', label: 'Never allow deleting', call: { type: 'rule', input: denyRiskRuleInput('delete') } });
    if (runtime.rules.neverPurchase) tasks.push({ id: 'rule-deny-purchase', group: 'rules', label: 'Never allow purchases', call: { type: 'rule', input: denyRiskRuleInput('purchase') } });
  }

  if (runtime.watcher.enabled && runtime.watcher.route.provider) {
    const { provider, model, effort } = runtime.watcher.route;
    const route: BotPhaseRoute = { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    tasks.push({ id: 'perceive', group: 'routing', label: `Use ${[provider, model].filter(Boolean).join(' · ')} to screen signals`, call: { type: 'perceive', route } });
  }
  const fallback = readyFallback(runtime);
  if (fallback.length > 0) tasks.push({ id: 'fallback', group: 'routing', label: `Set ${fallback.length} backup provider${fallback.length === 1 ? '' : 's'}`, call: { type: 'fallback', routes: fallback } });
  if (runtime.learning.autoApply) {
    tasks.push({ id: 'learning', group: 'learning', label: `Auto-apply memories at ${Math.round(runtime.learning.minConfidence * 100)}% confidence`, call: { type: 'learning', minConfidence: runtime.learning.minConfidence } });
  }

  const channels = planChannels(runtime.channels, input.globalChannels);
  for (const message of channels.errors) if (!errors.includes(message)) errors.push(message);
  channels.ops.forEach((op, index) => tasks.push({ id: `channel-${index}`, group: 'channels', label: op.label, call: { type: 'channel', input: op.input } }));

  activeGoals(runtime.goals).forEach((goal, index) => {
    tasks.push({
      id: `goal-${index}`,
      group: 'goals',
      label: `Goal: ${goal.statement.trim().slice(0, 70)}`,
      call: {
        type: 'goal',
        input: {
          statement: goal.statement.trim(),
          ...(goal.successCriteria.trim() ? { success_criteria: goal.successCriteria.trim() } : {}),
          ...(goal.horizon.trim() ? { horizon: goal.horizon.trim() } : {}),
          sort_order: index,
        },
      },
    });
  });

  runtime.triggers.forEach((draft, index) => {
    tasks.push({ id: `trigger-${index}`, group: 'triggers', label: triggerLabel(draft), call: { type: 'trigger', input: { kind: draft.kind, config: configFromDraft(draft), enabled: draft.enabled } } });
  });

  if (input.enableAfter) tasks.push({ id: 'enable', group: 'enable', label: 'Turn the bot on', call: { type: 'enable' } });
  return { tasks, errors };
}

/** True when creating the bot must leave it paused until setup completes. */
export const needsDeferredEnable = (tasks: SetupTask[]): boolean => tasks.some((task) => task.group === 'enable');

// ---- running the plan ----------------------------------------------------------------------

export const initialSetupState = (tasks: SetupTask[]): SetupState =>
  Object.fromEntries(tasks.map((task) => [task.id, { status: 'pending' as SetupStatus }]));

const errorMessage = (caught: unknown): string => (caught instanceof Error && caught.message ? caught.message : 'Request failed.');

function dispatch(api: SetupApi, botId: string, call: SetupCall): Promise<unknown> {
  switch (call.type) {
    case 'autonomy': return api.setAutonomy(botId, call.autonomy);
    case 'trigger': return api.createTrigger(botId, call.input);
    case 'goal': return api.createGoal(botId, call.input);
    case 'rule': return api.createRule(botId, call.input);
    case 'budget': return api.putBudget(botId, call.input);
    case 'perceive': return api.setPerceive(botId, call.route);
    case 'fallback': return api.setFallback(botId, call.routes);
    case 'learning': return api.setLearning(botId, call.minConfidence);
    case 'channel': return api.createChannel(botId, call.input);
    case 'enable': return api.enableBot(botId);
  }
}

/**
 * Run every task that is not already done, one at a time. A failed task does not stop the others
 * (they are independent), but the `enable` task is `blocked` unless everything else is done. Resolves
 * to the final state; `onChange` fires after every transition so the UI can show live progress.
 */
export async function runSetup(args: {
  botId: string;
  tasks: SetupTask[];
  api: SetupApi;
  previous?: SetupState;
  onChange?: (state: SetupState) => void;
}): Promise<SetupState> {
  const { botId, tasks, api } = args;
  let state: SetupState = { ...initialSetupState(tasks), ...(args.previous ?? {}) };
  const set = (id: string, next: SetupTaskState) => {
    state = { ...state, [id]: next };
    args.onChange?.(state);
  };
  const ordered = [...tasks.filter((task) => task.group !== 'enable'), ...tasks.filter((task) => task.group === 'enable')];
  for (const task of ordered) {
    if (state[task.id]?.status === 'done') continue;
    if (task.group === 'enable') {
      const unfinished = tasks.filter((other) => other.group !== 'enable' && state[other.id]?.status !== 'done');
      if (unfinished.length > 0) {
        set(task.id, { status: 'blocked', error: 'setup is not finished, so the bot stays off. Retry once the steps above succeed.' });
        continue;
      }
    }
    set(task.id, { status: 'running' });
    try {
      const result = await dispatch(api, botId, task.call);
      set(task.id, { status: 'done', result });
    } catch (caught) {
      set(task.id, { status: 'failed', error: errorMessage(caught) });
    }
  }
  return state;
}

export type SetupSummary = {
  total: number;
  done: number;
  failed: number;
  blocked: number;
  running: number;
  allDone: boolean;
  /** Tasks that still need a retry (failed or blocked). */
  remaining: SetupTask[];
};

export function summarizeSetup(tasks: SetupTask[], state: SetupState): SetupSummary {
  const count = (status: SetupStatus) => tasks.filter((task) => (state[task.id]?.status ?? 'pending') === status).length;
  const remaining = tasks.filter((task) => {
    const status = state[task.id]?.status ?? 'pending';
    return status === 'failed' || status === 'blocked' || status === 'pending';
  });
  return {
    total: tasks.length,
    done: count('done'),
    failed: count('failed'),
    blocked: count('blocked'),
    running: count('running'),
    allDone: tasks.length > 0 && count('done') === tasks.length,
    remaining,
  };
}

/** One clear sentence about where setup stands, never "something went wrong". */
export function setupMessage(tasks: SetupTask[], state: SetupState, botEnabled: boolean): string {
  const summary = summarizeSetup(tasks, state);
  if (summary.total === 0) return 'Nothing extra to set up.';
  if (summary.running > 0) return `Setting up… ${summary.done} of ${summary.total} done.`;
  if (summary.allDone) return botEnabled ? 'Everything is set up and the bot is on.' : 'Everything is set up. The bot is paused until you turn it on.';
  const unfinished = summary.failed + summary.blocked;
  const enableBlocked = tasks.some((task) => task.group === 'enable' && state[task.id]?.status === 'blocked');
  return `The bot was created, but ${unfinished} of ${summary.total} setup step${summary.total === 1 ? '' : 's'} did not finish${enableBlocked ? ', so it is paused' : ''}. `
    + 'Use Retry remaining, or finish them later from the bot\'s Triggers, Goals, Rules and Learning tabs.';
}

// ---- real API ------------------------------------------------------------------------------

export function createSetupApi(deps: { enableBot: (botId: string) => Promise<unknown> }): SetupApi {
  return {
    setAutonomy: (botId, autonomy) => botRuntimeApi.runtime.setAutonomy(botId, autonomy),
    createTrigger: (botId, input) => botRuntimeApi.triggers.create(botId, input),
    createGoal: (botId, input) => botRuntimeApi.goals.create(botId, input),
    createRule: (botId, input) => botRuntimeApi.gate.createRule({ ...input, botId }),
    putBudget: (botId, input) => botRuntimeApi.budget.put(botId, input),
    setPerceive: (botId, route) => botRuntimeApi.runtime.patchConfig(botId, { routing: { perceive: route } }),
    setFallback: (botId, routes) => botRuntimeApi.exec.setFallback(botId, routes),
    setLearning: (botId, minConfidence) => botRuntimeApi.runtime.patchConfig(botId, { learning: { auto_promote_memory_min_confidence: minConfidence } }),
    createChannel: (botId, input) => botRuntimeApi.channels.create({ ...input, botId }),
    enableBot: deps.enableBot,
  };
}
