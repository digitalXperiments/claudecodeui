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

/** Escape `*` and `\` so a literal tool/server name can be used as a glob pattern. */
export function escapeGlobLiteral(value: string): string {
  return value.replace(/[\\*]/g, '\\$&');
}

/** Split a glob into literal text and wildcards; a backslash makes the next character literal. */
function parseGlob(glob: string): Array<{ wildcard: true } | { literal: string }> {
  const parts: Array<{ wildcard: true } | { literal: string }> = [];
  let literal = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '\\' && i + 1 < glob.length) {
      literal += glob[i + 1];
      i += 1;
    } else if (ch === '*') {
      if (literal) parts.push({ literal });
      literal = '';
      if (!parts.length || !('wildcard' in parts[parts.length - 1])) parts.push({ wildcard: true });
    } else {
      literal += ch;
    }
  }
  if (literal) parts.push({ literal });
  return parts;
}

export function globMatches(pattern: string, value: string): boolean {
  const parts = parseGlob(pattern);
  if (!parts.some((part) => 'wildcard' in part)) {
    return parts.map((part) => ('literal' in part ? part.literal : '')).join('').toLowerCase() === value.toLowerCase();
  }
  const source = parts
    .map((part) => ('wildcard' in part ? '.*' : part.literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'i').test(value);
}

const MAX_REGEX_PATTERN = 200;
const MAX_REGEX_INPUT = 10_000;

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
  decision?: BotRuleDecision,
): boolean {
  const actual = getPath(args, predicate.path);
  switch (predicate.op) {
    case 'eq':
      return sameValue(actual, predicate.value);
    case 'contains':
      if (typeof actual === 'string') {
        return typeof predicate.value === 'string' && actual.toLowerCase().includes(predicate.value.toLowerCase());
      }
      if (Array.isArray(actual)) return actual.some((entry) => sameValue(entry, predicate.value));
      return false;
    case 'regex': {
      if (actual === undefined || actual === null || typeof predicate.value !== 'string') return false;
      // A deny rule whose pattern cannot be evaluated safely must still fire (fail closed).
      const unusable = decision === 'deny';
      if (predicate.value.length > MAX_REGEX_PATTERN) {
        console.warn('[BotGate] regex pattern too long; ignoring predicate', { path: predicate.path, unusable });
        return unusable;
      }
      try {
        const text = typeof actual === 'string' ? actual : JSON.stringify(actual);
        return new RegExp(predicate.value).test(text.slice(0, MAX_REGEX_INPUT));
      } catch (error) {
        console.warn('[BotGate] invalid regex in rule predicate', {
          path: predicate.path,
          unusable,
          error: error instanceof Error ? error.message : String(error),
        });
        return unusable;
      }
    }
    case 'in':
      return Array.isArray(predicate.value) && predicate.value.some((entry) => sameValue(entry, actual));
    default:
      return false;
  }
}

export function ruleMatchesRequest(match: BotRuleMatch, req: GateRequest, risk: Risk, decision?: BotRuleDecision): boolean {
  if (match.server && !globMatches(match.server, req.server)) return false;
  if (match.tool && !globMatches(match.tool, req.tool)) return false;
  if (match.risk && match.risk.length > 0 && !match.risk.includes(risk)) return false;
  if (match.args && match.args.length > 0) {
    return match.args.every((predicate) => argPredicateMatches(req.args ?? {}, predicate, decision));
  }
  return true;
}

/**
 * The section's existing per-tool `tool_policy_json` ({server: {tool: allow|ask|deny}}) read as
 * implicit bot-scoped rules, so the policy operators already set keeps working. They carry
 * `created_from: 'section_policy'`: their ask/deny apply, but their allow never loosens a floor risk.
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
        created_from: 'section_policy',
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
  const strength = DECISION_STRENGTH[b.decision] - DECISION_STRENGTH[a.decision];
  if (strength !== 0) return strength;
  // Equal strength: an explicit operator rule outranks an implicit section policy entry.
  return Number(a.created_from === 'section_policy') - Number(b.created_from === 'section_policy');
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
   * Best matching rule. A matching global deny is absolute and wins over everything. Otherwise bot
   * scope beats global, then higher priority, then deny > ask > allow. Expired rules are skipped.
   * Section tool policy participates as implicit bot-scoped rules.
   */
  match(botId: string, req: GateRequest, risk: Risk, now: Date = new Date()): BotRule | null {
    const candidates = [...botRulesDb.listApplicable(botId, now), ...implicitPolicyRules(botId)].filter((rule) =>
      ruleMatchesRequest(rule.match, req, risk, rule.decision),
    );
    if (candidates.length === 0) return null;
    const globalDeny = candidates
      .filter((rule) => rule.scope === 'global' && rule.decision === 'deny')
      .sort((a, b) => b.priority - a.priority)[0];
    if (globalDeny) return globalDeny;
    candidates.sort(compareRules);
    return candidates[0];
  },
};

export const matchRules = (botId: string, req: GateRequest, risk: Risk, now?: Date): BotRule | null =>
  rules.match(botId, req, risk, now);
