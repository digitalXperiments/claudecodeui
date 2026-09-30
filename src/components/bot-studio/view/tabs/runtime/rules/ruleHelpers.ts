/**
 * Pure logic for the Rules tab: rule match summaries, the rule form draft and its conversion to
 * API input, floor warnings, budget meters, credential and failover validation. The server is the
 * authority (gate.routes.ts validates everything again); this gives instant feedback.
 */

import { MC_PROVIDERS } from '../../../../../mission-control/api/missionControlApi';
import {
  BOT_SAFETY_FLOOR,
  type BotBudget,
  type BotBudgetInput,
  type BotBudgetStatus,
  type BotCredentialName,
  type BotGateDecisionView,
  type BotPhaseRoute,
  type BotRisk,
  type BotRule,
  type BotRuleArgPredicate,
  type BotRuleDecision,
  type BotRuleInput,
  type BotRuleMatch,
  type BotRulePatch,
  type BotRuleScope,
} from '../../../../types/botRuntime';

// ---- risks ---------------------------------------------------------------------------------

export const ALL_RISKS: BotRisk[] = ['read', 'draft', 'send', 'publish', 'delete', 'purchase', 'credential', 'prod_change', 'unknown'];

export const RISK_DESCRIPTIONS: Record<string, string> = {
  read: 'Reads data; no side effects.',
  draft: 'Prepares something without sending it.',
  send: 'Sends a message or email to someone.',
  publish: 'Makes content public.',
  delete: 'Deletes or destroys data.',
  purchase: 'Spends money.',
  credential: 'Touches secrets, tokens or access.',
  prod_change: 'Changes a production system.',
  unknown: 'Not classified; treated as a risk and asks.',
};

export const isFloorRisk = (risk: string): boolean => (BOT_SAFETY_FLOOR as string[]).includes(risk);

export const FLOOR_LIST_TEXT = BOT_SAFETY_FLOOR.join(', ');

/** Tailwind classes for a risk chip. */
export function riskTone(risk: string): string {
  if (isFloorRisk(risk)) return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (risk === 'unknown') return 'bg-violet-500/10 text-violet-700 dark:text-violet-300';
  return 'bg-muted text-muted-foreground';
}

export function decisionTone(decision: string): string {
  if (decision === 'allow') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (decision === 'deny') return 'bg-destructive/10 text-destructive';
  return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
}

export const CREATED_FROM_LABELS: Record<string, string> = {
  manual: 'Created by you',
  always_allow_click: 'Always-allow click',
  learning: 'Learned',
};

export const createdFromLabel = (value: string): string => CREATED_FROM_LABELS[value] ?? value.replace(/_/g, ' ');

// ---- summaries -----------------------------------------------------------------------------

const PREDICATE_OP_LABELS: Record<BotRuleArgPredicate['op'], string> = { eq: '=', contains: 'contains', regex: 'matches', in: 'in' };

/** JSON-ish display: strings plain, everything else JSON. */
export function formatPredicateValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(', ');
  return JSON.stringify(value);
}

export function summarizePredicate(predicate: BotRuleArgPredicate): string {
  const value = predicate.op === 'in' ? `[${formatPredicateValue(predicate.value)}]` : predicate.op === 'regex' ? `/${String(predicate.value)}/` : JSON.stringify(predicate.value);
  return `${predicate.path} ${PREDICATE_OP_LABELS[predicate.op] ?? predicate.op} ${value}`;
}

export type RuleMatchSummary = {
  /** `server · tool` with "any" for a missing part. */
  target: string;
  risks: string[];
  predicates: string[];
  allowWhenTainted: boolean;
  /** True when nothing narrows the rule: it matches every tool call. */
  matchesEverything: boolean;
};

export function summarizeRuleMatch(match: BotRuleMatch | null | undefined): RuleMatchSummary {
  const m = match ?? {};
  const server = m.server?.trim();
  const tool = m.tool?.trim();
  const risks = m.risk ?? [];
  const predicates = (m.args ?? []).map(summarizePredicate);
  const target = server && tool ? `${server} · ${tool}` : server ? `${server} · any tool` : tool ? `any server · ${tool}` : 'any tool';
  return {
    target,
    risks,
    predicates,
    allowWhenTainted: m.allow_when_tainted === true,
    matchesEverything: !server && !tool && risks.length === 0 && predicates.length === 0,
  };
}

/** Rules for display: bot rules first, then global; highest priority first within each. */
export function sortRules(rules: BotRule[]): BotRule[] {
  const rank = (rule: BotRule): number => (rule.scope === 'bot' ? 0 : 1);
  return [...rules].sort((a, b) => rank(a) - rank(b) || b.priority - a.priority || b.created_at.localeCompare(a.created_at));
}

// ---- floor warnings ------------------------------------------------------------------------

export type FloorCheck = { level: 'none' | 'info' | 'warn' | 'blocked'; message: string | null };

/**
 * What saving this rule would do to the safety floor. A bot-scoped allow on a floor risk (or with no
 * risk filter, which covers them) loosens it: warn loudly. A global allow on a floor risk is refused
 * by the server; a global allow with no risk filter still asks for floor risks.
 */
export function floorCheck(input: { scope: BotRuleScope; decision: BotRuleDecision; risks: string[]; classifiedFloor?: boolean }): FloorCheck {
  if (input.decision !== 'allow') return { level: 'none', message: null };
  const floorRisks = input.risks.filter(isFloorRisk);
  if (input.scope === 'global') {
    if (floorRisks.length > 0) {
      return { level: 'blocked', message: `A global allow cannot cover ${floorRisks.join(', ')}. Only a rule scoped to one bot can loosen the safety floor.` };
    }
    if (input.risks.length === 0) {
      return { level: 'info', message: `This global allow has no risk filter: calls classified as ${FLOOR_LIST_TEXT} will still ask for approval.` };
    }
    return { level: 'none', message: null };
  }
  if (floorRisks.length > 0) {
    return { level: 'warn', message: `This bot will run ${floorRisks.join(', ')} actions WITHOUT asking you first. These are the actions the safety floor exists to catch.` };
  }
  if (input.risks.length === 0) {
    return { level: 'warn', message: `With no risk filter this allow also covers ${FLOOR_LIST_TEXT}. The bot would do those without asking. Add a risk filter unless that is what you want.` };
  }
  if (input.classifiedFloor) {
    return { level: 'warn', message: 'The tool you typed is classified as a safety-floor risk, so allowing it lets this bot act without asking.' };
  }
  return { level: 'none', message: null };
}

// ---- rule draft ----------------------------------------------------------------------------

export type ExpiryChoice = 'keep' | 'never' | '1h' | '1d' | '7d' | '30d';

export const EXPIRY_CHOICES: Array<{ value: ExpiryChoice; label: string; ms: number | null }> = [
  { value: 'never', label: 'Never expires', ms: null },
  { value: '1h', label: 'In 1 hour', ms: 3_600_000 },
  { value: '1d', label: 'In 1 day', ms: 86_400_000 },
  { value: '7d', label: 'In 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'In 30 days', ms: 30 * 86_400_000 },
];

export type PredicateDraft = { path: string; op: BotRuleArgPredicate['op']; value: string };

export type RuleDraft = {
  scope: BotRuleScope;
  decision: BotRuleDecision;
  server: string;
  tool: string;
  risks: string[];
  predicates: PredicateDraft[];
  allowWhenTainted: boolean;
  priority: string;
  note: string;
  expiry: ExpiryChoice;
};

export function emptyRuleDraft(scope: BotRuleScope = 'bot'): RuleDraft {
  return { scope, decision: 'ask', server: '', tool: '', risks: [], predicates: [], allowWhenTainted: false, priority: '', note: '', expiry: 'never' };
}

export function draftFromRule(rule: BotRule): RuleDraft {
  const match = rule.match ?? {};
  return {
    scope: rule.scope,
    decision: rule.decision,
    server: match.server ?? '',
    tool: match.tool ?? '',
    risks: [...(match.risk ?? [])],
    predicates: (match.args ?? []).map((p) => ({ path: p.path, op: p.op, value: p.op === 'in' ? formatPredicateValue(p.value) : p.op === 'regex' ? String(p.value) : typeof p.value === 'string' ? p.value : JSON.stringify(p.value) })),
    allowWhenTainted: match.allow_when_tainted === true,
    priority: rule.priority ? String(rule.priority) : '',
    note: rule.note ?? '',
    expiry: rule.expires_at ? 'keep' : 'never',
  };
}

/** One scalar typed as the user wrote it: 5 -> number, true/false/null, "quoted" -> string, else text. */
export function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // fall through to the raw text
    }
  }
  return text;
}

export function parsePredicateValue(op: BotRuleArgPredicate['op'], text: string): unknown {
  if (op === 'regex') return text;
  if (op === 'in') return text.split(',').map((part) => part.trim()).filter(Boolean).map(parseScalar);
  return parseScalar(text);
}

export function expiresAtFromChoice(choice: ExpiryChoice, current: string | null, now = Date.now()): string | null {
  if (choice === 'keep') return current;
  const ms = EXPIRY_CHOICES.find((entry) => entry.value === choice)?.ms ?? null;
  return ms === null ? null : new Date(now + ms).toISOString();
}

export function matchFromDraft(draft: RuleDraft): BotRuleMatch {
  const match: BotRuleMatch = {};
  if (draft.server.trim()) match.server = draft.server.trim();
  if (draft.tool.trim()) match.tool = draft.tool.trim();
  if (draft.risks.length > 0) match.risk = [...draft.risks];
  const predicates = draft.predicates.filter((p) => p.path.trim());
  if (predicates.length > 0) match.args = predicates.map((p) => ({ path: p.path.trim(), op: p.op, value: parsePredicateValue(p.op, p.value) }));
  if (draft.allowWhenTainted) match.allow_when_tainted = true;
  return match;
}

export function validateRuleDraft(draft: RuleDraft): string | null {
  if (draft.priority.trim()) {
    const n = Number(draft.priority);
    if (!Number.isInteger(n) || n < -1000 || n > 1000) return 'Priority must be a whole number between -1000 and 1000.';
  }
  if (draft.predicates.length > 10) return 'A rule can have at most 10 argument conditions.';
  for (const [index, predicate] of draft.predicates.entries()) {
    if (!predicate.path.trim()) return `Condition ${index + 1} needs an argument path.`;
    if (predicate.op === 'regex') {
      try {
        new RegExp(predicate.value);
      } catch {
        return `Condition ${index + 1} is not a valid regular expression.`;
      }
    }
    if (predicate.op === 'in' && (parsePredicateValue('in', predicate.value) as unknown[]).length === 0) return `Condition ${index + 1} needs at least one value.`;
    if ((predicate.op === 'contains' || predicate.op === 'eq') && !predicate.value.trim()) return `Condition ${index + 1} needs a value.`;
  }
  if (draft.note.length > 500) return 'Note is too long (max 500 characters).';
  const floor = floorCheck({ scope: draft.scope, decision: draft.decision, risks: draft.risks });
  if (floor.level === 'blocked') return floor.message;
  return null;
}

export function ruleInputFromDraft(draft: RuleDraft, botId: string | null, now = Date.now()): BotRuleInput {
  return {
    scope: draft.scope,
    ...(draft.scope === 'bot' ? { botId } : {}),
    decision: draft.decision,
    match: matchFromDraft(draft),
    ...(draft.priority.trim() ? { priority: Number(draft.priority) } : {}),
    note: draft.note.trim(),
    expiresAt: expiresAtFromChoice(draft.expiry === 'keep' ? 'never' : draft.expiry, null, now),
  };
}

export function rulePatchFromDraft(draft: RuleDraft, rule: BotRule, now = Date.now()): BotRulePatch {
  return {
    decision: draft.decision,
    match: matchFromDraft(draft),
    priority: draft.priority.trim() ? Number(draft.priority) : 0,
    note: draft.note.trim(),
    expiresAt: expiresAtFromChoice(draft.expiry, rule.expires_at, now),
  };
}

// ---- risk preview --------------------------------------------------------------------------

/** The tool name can be classified only when it is a concrete name, not a glob. */
export const canClassifyTool = (tool: string): boolean => Boolean(tool.trim()) && !/[*?]/.test(tool);

// ---- budget --------------------------------------------------------------------------------

export type MeterTone = 'none' | 'ok' | 'soft' | 'hard';

export type Meter = { used: number; cap: number | null; ratio: number; percent: number; tone: MeterTone };

/** Usage vs a cap: the bar ratio is clamped to 0..1, the percent is not. Soft at softRatio, hard at 100%. */
export function meter(used: number, cap: number | null | undefined, softRatio: number): Meter {
  if (cap === null || cap === undefined) return { used, cap: null, ratio: 0, percent: 0, tone: 'none' };
  if (cap <= 0) return { used, cap, ratio: 1, percent: 100, tone: 'hard' };
  const raw = used / cap;
  const tone: MeterTone = raw >= 1 ? 'hard' : raw >= softRatio ? 'soft' : 'ok';
  return { used, cap, ratio: Math.min(1, Math.max(0, raw)), percent: Math.round(raw * 100), tone };
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value >= 100 ? value.toFixed(0) : value.toFixed(2)}`;
}

export type BudgetMeterRow = { id: string; label: string; meter: Meter; format: (n: number) => string };

export function budgetMeters(status: BotBudgetStatus): BudgetMeterRow[] {
  const budget = status.budget;
  const soft = budget?.soft_ratio ?? 0.8;
  const count = (n: number): string => String(Math.round(n));
  return [
    { id: 'daily_usd', label: 'Spend today', meter: meter(status.spend.today_usd, budget?.daily_usd, soft), format: formatUsd },
    { id: 'monthly_usd', label: 'Spend this month', meter: meter(status.spend.month_usd, budget?.monthly_usd, soft), format: formatUsd },
    { id: 'daily_actions', label: 'Actions today', meter: meter(status.spend.actions_today, budget?.daily_actions, soft), format: count },
    { id: 'wakes', label: 'Wakes in the last hour', meter: meter(status.spend.wakes_last_hour, budget?.max_wakes_per_hour, soft), format: count },
  ];
}

export function budgetStateText(status: BotBudgetStatus): { tone: MeterTone; text: string } {
  if (!status.wake_allowed) return { tone: 'hard', text: 'Paused by budget: the bot will not wake until the limit resets.' };
  if (!status.check.ok) return { tone: 'hard', text: status.check.reason || 'A budget limit has been reached.' };
  if (status.check.soft) return { tone: 'soft', text: status.check.reason || 'Close to a budget limit: the bot may be downgraded to a cheaper model.' };
  return { tone: 'ok', text: status.budget ? 'Within budget.' : 'No limits set.' };
}

export type BudgetDraft = { dailyUsd: string; monthlyUsd: string; dailyActions: string; maxWakes: string; softPercent: string };

export function budgetDraftFromBudget(budget: BotBudget | null): BudgetDraft {
  const text = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n));
  return {
    dailyUsd: text(budget?.daily_usd),
    monthlyUsd: text(budget?.monthly_usd),
    dailyActions: text(budget?.daily_actions),
    maxWakes: text(budget?.max_wakes_per_hour),
    softPercent: String(Math.round((budget?.soft_ratio ?? 0.8) * 100)),
  };
}

function capValue(text: string, label: string, integer: boolean): { value: number | null } | { error: string } {
  if (!text.trim()) return { value: null };
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a number of 0 or more, or empty for no limit.` };
  if (integer && !Number.isInteger(n)) return { error: `${label} must be a whole number.` };
  return { value: n };
}

/** The PUT body, or an error string. Empty caps mean "no limit" (null). */
export function budgetInputFromDraft(draft: BudgetDraft): BotBudgetInput | { error: string } {
  const fields = [
    ['daily_usd', capValue(draft.dailyUsd, 'Daily spend', false)],
    ['monthly_usd', capValue(draft.monthlyUsd, 'Monthly spend', false)],
    ['daily_actions', capValue(draft.dailyActions, 'Daily actions', true)],
    ['max_wakes_per_hour', capValue(draft.maxWakes, 'Wakes per hour', true)],
  ] as const;
  const input: BotBudgetInput = {};
  for (const [key, result] of fields) {
    if ('error' in result) return { error: result.error };
    input[key] = result.value;
  }
  const soft = Number(draft.softPercent);
  if (!Number.isFinite(soft) || soft <= 0 || soft > 100) return { error: 'Soft limit must be between 1 and 100 percent.' };
  input.soft_ratio = soft / 100;
  const daily = input.daily_usd;
  const monthly = input.monthly_usd;
  if (daily != null && monthly != null && daily > monthly) return { error: 'The daily spend limit is higher than the monthly one.' };
  return input;
}

// ---- gate decision log ---------------------------------------------------------------------

export const isPendingAsk = (d: Pick<BotGateDecisionView, 'decision' | 'outcome'>): boolean => d.decision === 'ask' && d.outcome === null;

export function outcomeLabel(d: Pick<BotGateDecisionView, 'decision' | 'outcome'>): string {
  if (d.outcome) return d.outcome;
  return d.decision === 'ask' ? 'waiting for you' : 'pending';
}

const DECIDED_BY: Record<string, string> = {
  floor: 'safety floor',
  default: 'default policy',
  dry_run: 'dry run',
  budget: 'budget',
  taint: 'untrusted-input check',
  reviewer: 'auto-reviewer',
};

/** `rule:abc123` -> "rule abc123"; known deciders get a readable name. */
export function decidedByLabel(value: string): string {
  if (value.startsWith('rule:')) return `rule ${value.slice(5, 13)}`;
  return DECIDED_BY[value] ?? value.replace(/_/g, ' ');
}

// ---- credentials ---------------------------------------------------------------------------

/** Mirrors server normalizeServerKey: `jira-cloud` -> `JIRA_CLOUD`. */
export function normalizeServerKey(server: string): string {
  return server.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export function validateCredentialInput(input: { server: string; key: string; value: string }): string | null {
  if (!normalizeServerKey(input.server)) return 'Enter the MCP server name, for example jira-cloud.';
  if (!CREDENTIAL_KEY_PATTERN.test(input.key) || input.key.includes('__')) {
    return 'The key is the env var or header name: letters, digits, "_", "-", "." only, and no "__".';
  }
  if (!input.value) return 'Enter the value.';
  if (input.value.length > 16_384) return 'The value is too long.';
  return null;
}

export function groupCredentials(list: BotCredentialName[]): Array<{ server: string; entries: BotCredentialName[] }> {
  const groups = new Map<string, BotCredentialName[]>();
  for (const entry of list) groups.set(entry.server, [...(groups.get(entry.server) ?? []), entry]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([server, entries]) => ({ server, entries }));
}

// ---- failover chain ------------------------------------------------------------------------

export const MAX_FALLBACK_ROUTES = 5;

export function moveRoute<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function validateRoutes(routes: BotPhaseRoute[]): string | null {
  if (routes.length > MAX_FALLBACK_ROUTES) return `At most ${MAX_FALLBACK_ROUTES} fallbacks; more is a config mistake, not resilience.`;
  for (const [index, route] of routes.entries()) {
    if (!(MC_PROVIDERS as readonly string[]).includes(route.provider)) return `Fallback ${index + 1} needs a provider.`;
  }
  return null;
}

/** Drop blank model/effort so the PUT body matches what the server stores. */
export const cleanRoutes = (routes: BotPhaseRoute[]): BotPhaseRoute[] =>
  routes.map((route) => ({
    provider: route.provider,
    ...(route.model?.trim() ? { model: route.model.trim() } : {}),
    ...(route.effort?.trim() ? { effort: route.effort.trim() } : {}),
  }));

export const routesEqual = (a: BotPhaseRoute[], b: BotPhaseRoute[]): boolean => JSON.stringify(cleanRoutes(a)) === JSON.stringify(cleanRoutes(b));

export function routeLabel(route: BotPhaseRoute): string {
  return [route.provider, route.model, route.effort].filter(Boolean).join(' · ');
}

// ---- enforcement ---------------------------------------------------------------------------

export type EnforcementView = {
  level: 'enforced' | 'advisory';
  headline: string;
  notes: string[];
  phases: Array<{ phase: string; provider: string; level: 'enforced' | 'advisory'; explanation: string }>;
};

function phaseExplanation(provider: string, level: 'enforced' | 'advisory'): string {
  if (level === 'enforced') return `${provider}: every tool call and built-in action goes through the gate.`;
  if (provider === 'claude') return 'claude: the gateway is attached, but this run lacks the built-in tool gate, so some actions can bypass it.';
  return `${provider}: MCP calls through the gateway are gated, but ${provider} can also use its own built-in tools or connectors, which the gate cannot see.`;
}

/** Plain-language reading of GET /:botId/enforcement. */
export function describeEnforcement(input: { level: 'enforced' | 'advisory'; builtin_tool_gate: boolean; gateway: boolean; configured: 'enforced' | 'advisory' | null; phases: Array<{ phase: string; provider: string; level: 'enforced' | 'advisory' }> }): EnforcementView {
  const notes: string[] = [];
  if (!input.gateway) notes.push('The tool gateway is switched off for this bot, so MCP calls are not gated at all.');
  if (input.configured === 'enforced' && input.level !== 'enforced') {
    notes.push('This bot is configured to require enforcement, but its current providers cannot guarantee it.');
  }
  const weak = input.phases.filter((phase) => phase.level !== 'enforced');
  if (input.level === 'advisory' && weak.length > 0) {
    notes.push(`Advisory in: ${weak.map((phase) => `${phase.phase} (${phase.provider})`).join(', ')}.`);
  }
  return {
    level: input.level,
    headline: input.level === 'enforced'
      ? 'Enforced: the action gate governs every tool call this bot makes.'
      : 'Advisory: the gate governs what it can see, but this provider can act around it.',
    notes,
    phases: input.phases.map((phase) => ({ ...phase, explanation: phaseExplanation(phase.provider, phase.level) })),
  };
}
