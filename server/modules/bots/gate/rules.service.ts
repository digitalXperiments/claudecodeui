import { missionControlDb } from '@/modules/mission-control/index.js';
import { botRulesDb, type CreateBotRuleInput, type UpdateBotRuleInput } from '@/modules/bots/gate/bot-rules.repository.js';
import type { GateRequest, Risk } from '@/modules/bots/gate/gate.types.js';
import type { BotRule, BotRuleDecision, BotRuleMatch, BotRuleScope } from '@/modules/bots/bots.types.js';

const DECISIONS: BotRuleDecision[] = ['allow', 'ask', 'deny'];
const SCOPES: BotRuleScope[] = ['global', 'bot'];

function assertRule(input: { scope?: string; decision?: string; botId?: string | null }, requireScope: boolean): void {
  if (requireScope) {
    if (!input.scope || !SCOPES.includes(input.scope as BotRuleScope)) {
      throw new Error(`Invalid rule scope: ${String(input.scope)}`);
    }
    if (input.scope === 'bot' && !input.botId) throw new Error('A bot-scoped rule requires botId');
  }
  if (input.decision !== undefined && !DECISIONS.includes(input.decision as BotRuleDecision)) {
    throw new Error(`Invalid rule decision: ${String(input.decision)}`);
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function globMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern.toLowerCase() === value.toLowerCase();
  return globToRegExp(pattern).test(value);
}

function getPath(source: unknown, dotPath: string): unknown {
  let current: unknown = source;
  for (const segment of dotPath.split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b));

function argPredicateMatches(
  args: Record<string, unknown>,
  predicate: NonNullable<BotRuleMatch['args']>[number],
): boolean {
  const actual = getPath(args, predicate.path);
  switch (predicate.op) {
    case 'eq':
      return sameValue(actual, predicate.value);
    case 'contains':
      if (typeof actual === 'string') return typeof predicate.value === 'string' && actual.includes(predicate.value);
      if (Array.isArray(actual)) return actual.some((entry) => sameValue(entry, predicate.value));
      return false;
    case 'regex': {
      if (actual === undefined || actual === null || typeof predicate.value !== 'string') return false;
      try {
        return new RegExp(predicate.value).test(typeof actual === 'string' ? actual : JSON.stringify(actual));
      } catch {
        return false;
      }
    }
    case 'in':
      return Array.isArray(predicate.value) && predicate.value.some((entry) => sameValue(entry, actual));
    default:
      return false;
  }
}

export function ruleMatchesRequest(match: BotRuleMatch, req: GateRequest, risk: Risk): boolean {
  if (match.server && !globMatches(match.server, req.server)) return false;
  if (match.tool && !globMatches(match.tool, req.tool)) return false;
  if (match.risk && match.risk.length > 0 && !match.risk.includes(risk)) return false;
  if (match.args && match.args.length > 0) {
    return match.args.every((predicate) => argPredicateMatches(req.args ?? {}, predicate));
  }
  return true;
}

/**
 * The section's existing per-tool `tool_policy_json` ({server: {tool: allow|ask|deny}}) read as
 * implicit bot-scoped manual rules, so the policy operators already set keeps working.
 */
function implicitPolicyRules(botId: string): BotRule[] {
  let policy: Record<string, Record<string, BotRuleDecision>> = {};
  try {
    policy = missionControlDb.getSection(botId)?.tool_policy ?? {};
  } catch {
    return [];
  }
  const rules: BotRule[] = [];
  for (const [server, tools] of Object.entries(policy)) {
    for (const [tool, decision] of Object.entries(tools)) {
      rules.push({
        rule_id: `policy:${server}:${tool}`,
        scope: 'bot',
        bot_id: botId,
        match: { server, tool },
        decision,
        priority: 0,
        created_from: 'manual',
        note: 'Section tool policy',
        expires_at: null,
        created_at: '',
        updated_at: '',
      });
    }
  }
  return rules;
}

const DECISION_STRENGTH: Record<BotRuleDecision, number> = { deny: 2, ask: 1, allow: 0 };

function compareRules(a: BotRule, b: BotRule): number {
  const scopeDelta = Number(b.scope === 'bot') - Number(a.scope === 'bot');
  if (scopeDelta !== 0) return scopeDelta;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return DECISION_STRENGTH[b.decision] - DECISION_STRENGTH[a.decision];
}

export const rules = {
  list: (filter: { scope?: BotRuleScope; botId?: string } = {}): BotRule[] => botRulesDb.list(filter),
  get: (ruleId: string): BotRule | null => botRulesDb.get(ruleId),
  create(input: CreateBotRuleInput): BotRule {
    assertRule(input, true);
    return botRulesDb.create(input);
  },
  update(ruleId: string, patch: UpdateBotRuleInput): BotRule | null {
    assertRule(patch, false);
    return botRulesDb.update(ruleId, patch);
  },
  delete: (ruleId: string): boolean => botRulesDb.delete(ruleId),

  /**
   * Best matching rule: bot scope beats global, then higher priority, then deny > ask > allow.
   * Expired rules are skipped. Section tool policy participates as implicit bot-scoped rules.
   */
  match(botId: string, req: GateRequest, risk: Risk, now: Date = new Date()): BotRule | null {
    const candidates = [...botRulesDb.listApplicable(botId, now), ...implicitPolicyRules(botId)].filter((rule) =>
      ruleMatchesRequest(rule.match, req, risk),
    );
    if (candidates.length === 0) return null;
    candidates.sort(compareRules);
    return candidates[0];
  },
};

export const matchRules = (botId: string, req: GateRequest, risk: Risk, now?: Date): BotRule | null =>
  rules.match(botId, req, risk, now);
