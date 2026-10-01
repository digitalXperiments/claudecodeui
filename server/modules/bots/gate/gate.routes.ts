/**
 * Action Gate REST surface, mounted behind authenticateToken at /api/bots (before the `/:botId`
 * routers): rules, gate decisions, budgets, risk preview and per-bot enforcement level.
 */

import express from 'express';

import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { readBotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
import type { BotGateDecision, BotRuleDecision, BotRuleMatch, BotRuleScope } from '@/modules/bots/bots.types.js';
import { describeGatewayEnforcement, getGatewayEnforcement } from '@/modules/bots/gateway/enforcement.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { botSpendDb } from '@/modules/bots/gate/bot-spend.repository.js';
import { summarizeArgs } from '@/modules/bots/gate/action-gate.service.js';
import { budgets } from '@/modules/bots/gate/budgets.service.js';
import { SAFETY_FLOOR, type Risk } from '@/modules/bots/gate/gate.types.js';
import { rules } from '@/modules/bots/gate/rules.service.js';
import { classifyToolRisk } from '@/modules/bots/gate/tool-risk.js';
import { SECRET_KEY } from '@/modules/bots/learning/learning.util.js';

export const botGateRouter = express.Router();

const param = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));
const queryText = (value: unknown): string => (typeof value === 'string' ? value : '');

const RISKS: Risk[] = ['read', 'draft', 'send', 'publish', 'delete', 'purchase', 'credential', 'prod_change', 'unknown'];
const DECISIONS: BotRuleDecision[] = ['allow', 'ask', 'deny'];
const SCOPES: BotRuleScope[] = ['global', 'bot'];
const OPS = ['eq', 'contains', 'regex', 'in'] as const;
const OUTCOMES = ['executed', 'denied', 'approved', 'rejected', 'expired', 'error', 'pending'];
const FLOOR_LIST = SAFETY_FLOOR.join(', ');

const MAX_PATTERN = 200;
const MAX_PREDICATES = 10;
const MAX_NOTE = 500;
const ARG_VALUE_LIMIT = 500;

const invalid = (message: string): AppError => new AppError(message, { code: 'BOT_GATE_INVALID', statusCode: 400 });
const notFound = (what: string): AppError => new AppError(`${what} not found`, { code: 'BOT_NOT_FOUND', statusCode: 404 });

function body(req: express.Request): Record<string, unknown> {
  const value = req.body as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requireBotId(botId: string): string {
  if (!botId || !missionControlDb.getSection(botId)) throw notFound('Bot');
  return botId;
}

const requireBot = (req: express.Request): string => requireBotId(param(req.params.botId));

function parseLimit(value: unknown, fallback: number, max = 200): number {
  const n = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback;
}

// ---- rule validation ---------------------------------------------------------------------------

function optionalPattern(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`match.${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_PATTERN) throw invalid(`match.${field} is too long (max ${MAX_PATTERN})`);
  return trimmed;
}

/** Validate and normalize a rule match; unknown keys are dropped. */
export function validateRuleMatch(raw: unknown): BotRuleMatch {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('match must be an object');
  const source = raw as Record<string, unknown>;
  const match: BotRuleMatch = {};
  const server = optionalPattern(source.server, 'server');
  const tool = optionalPattern(source.tool, 'tool');
  if (server) match.server = server;
  if (tool) match.tool = tool;
  if (source.risk !== undefined && source.risk !== null) {
    if (!Array.isArray(source.risk)) throw invalid('match.risk must be an array of risks');
    const risks = [...new Set(source.risk.map(String))];
    const bad = risks.find((risk) => !RISKS.includes(risk as Risk));
    if (bad) throw invalid(`match.risk contains unknown risk "${bad}" (expected ${RISKS.join(', ')})`);
    if (risks.length) match.risk = risks;
  }
  if (source.args !== undefined && source.args !== null) {
    if (!Array.isArray(source.args)) throw invalid('match.args must be an array');
    if (source.args.length > MAX_PREDICATES) throw invalid(`match.args allows at most ${MAX_PREDICATES} predicates`);
    match.args = source.args.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid(`match.args[${index}] must be an object`);
      const predicate = entry as Record<string, unknown>;
      const path = typeof predicate.path === 'string' ? predicate.path.trim() : '';
      if (!path || path.length > MAX_PATTERN) throw invalid(`match.args[${index}].path is required (max ${MAX_PATTERN} chars)`);
      if (!OPS.includes(predicate.op as (typeof OPS)[number])) throw invalid(`match.args[${index}].op must be one of ${OPS.join(', ')}`);
      const op = predicate.op as (typeof OPS)[number];
      if (op === 'in' && !Array.isArray(predicate.value)) throw invalid(`match.args[${index}].value must be an array for "in"`);
      if (op === 'regex') {
        if (typeof predicate.value !== 'string' || predicate.value.length > MAX_PATTERN) {
          throw invalid(`match.args[${index}].value must be a regex string (max ${MAX_PATTERN} chars)`);
        }
        try {
          new RegExp(predicate.value);
        } catch {
          throw invalid(`match.args[${index}].value is not a valid regular expression`);
        }
      }
      if (op === 'contains' && predicate.value === undefined) {
        throw invalid(`match.args[${index}].value is required for "contains"`);
      }
      return { path, op, value: predicate.value };
    });
    if (!match.args.length) delete match.args;
  }
  if (source.allow_when_tainted !== undefined) {
    if (typeof source.allow_when_tainted !== 'boolean') throw invalid('match.allow_when_tainted must be a boolean');
    if (source.allow_when_tainted) match.allow_when_tainted = true;
  }
  return match;
}

function validateDecision(value: unknown): BotRuleDecision {
  if (typeof value !== 'string' || !DECISIONS.includes(value as BotRuleDecision)) {
    throw invalid(`decision must be one of ${DECISIONS.join(', ')}`);
  }
  return value as BotRuleDecision;
}

function validatePriority(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -1000 || value > 1000) {
    throw invalid('priority must be an integer between -1000 and 1000');
  }
  return value;
}

function validateNote(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid('note must be a string');
  return value.trim().slice(0, MAX_NOTE);
}

function validateExpiry(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid('expiresAt must be an ISO timestamp or null');
  return new Date(value).toISOString();
}

/**
 * The global floor: a global `allow` can never cover a floor risk (send, publish, delete, purchase,
 * credential, prod_change). The gate ignores such a rule at runtime anyway, so saving one would
 * only mislead the operator. Only a bot-scoped rule may loosen a floor risk.
 */
function assertFloorHolds(scope: BotRuleScope, decision: BotRuleDecision, match: BotRuleMatch): string[] {
  if (scope !== 'global' || decision !== 'allow') return [];
  const floorRisks = (match.risk ?? []).filter((risk) => SAFETY_FLOOR.includes(risk as Risk));
  if (floorRisks.length > 0) {
    throw invalid(
      `A global allow rule cannot cover floor risks (${floorRisks.join(', ')}). The safety floor (${FLOOR_LIST}) always asks for approval; ` +
        'only a bot-scoped rule can loosen it.',
    );
  }
  if (!match.risk || match.risk.length === 0) {
    return [`This global allow has no risk filter: calls classified as ${FLOOR_LIST} will still ask for approval (the safety floor).`];
  }
  return [];
}

// ---- rules -------------------------------------------------------------------------------------

/** `?botId` lists that bot's rules (add `includeGlobal=1` for the global ones too); otherwise global rules. */
botGateRouter.get(
  '/rules',
  asyncHandler(async (req, res) => {
    const botId = queryText(req.query.botId);
    if (!botId) {
      res.json({ rules: rules.list({ scope: 'global' }) });
      return;
    }
    requireBotId(botId);
    const botRules = rules.list({ scope: 'bot', botId });
    const includeGlobal = ['1', 'true'].includes(queryText(req.query.includeGlobal));
    res.json({ rules: includeGlobal ? [...botRules, ...rules.list({ scope: 'global' })] : botRules });
  }),
);

botGateRouter.post(
  '/rules',
  asyncHandler(async (req, res) => {
    const input = body(req);
    const botId = typeof input.botId === 'string' && input.botId ? input.botId : null;
    const scope = (input.scope === undefined ? (botId ? 'bot' : 'global') : input.scope) as BotRuleScope;
    if (!SCOPES.includes(scope)) throw invalid(`scope must be one of ${SCOPES.join(', ')}`);
    if (scope === 'bot') {
      if (!botId) throw invalid('A bot-scoped rule requires botId');
      requireBotId(botId);
    }
    const decision = validateDecision(input.decision);
    const match = validateRuleMatch(input.match);
    const warnings = assertFloorHolds(scope, decision, match);
    const rule = rules.create({
      scope,
      botId: scope === 'bot' ? botId : null,
      match,
      decision,
      priority: validatePriority(input.priority),
      note: validateNote(input.note),
      expiresAt: validateExpiry(input.expiresAt),
      createdFrom: 'manual',
    });
    res.status(201).json({ rule, ...(warnings.length ? { warnings } : {}) });
  }),
);

botGateRouter.patch(
  '/rules/:ruleId',
  asyncHandler(async (req, res) => {
    const existing = rules.get(param(req.params.ruleId));
    if (!existing) throw notFound('Rule');
    const input = body(req);
    const decision = input.decision === undefined ? undefined : validateDecision(input.decision);
    const match = input.match === undefined ? undefined : validateRuleMatch(input.match);
    const warnings = assertFloorHolds(existing.scope, decision ?? existing.decision, match ?? existing.match);
    const rule = rules.update(existing.rule_id, {
      decision,
      match,
      priority: validatePriority(input.priority),
      note: validateNote(input.note),
      expiresAt: validateExpiry(input.expiresAt),
    });
    res.json({ rule, ...(warnings.length ? { warnings } : {}) });
  }),
);

botGateRouter.delete(
  '/rules/:ruleId',
  asyncHandler(async (req, res) => {
    if (!rules.delete(param(req.params.ruleId))) throw notFound('Rule');
    res.json({ success: true });
  }),
);

// ---- risk preview ------------------------------------------------------------------------------

botGateRouter.get(
  '/risk/classify',
  asyncHandler(async (req, res) => {
    const tool = queryText(req.query.tool).trim();
    if (!tool) throw invalid('tool is required');
    const server = queryText(req.query.server).trim();
    const risk = classifyToolRisk({ server, tool });
    res.json({ risk, floor: SAFETY_FLOOR.includes(risk), default_decision: SAFETY_FLOOR.includes(risk) || risk === 'unknown' ? 'ask' : 'allow' });
  }),
);

// ---- gate decisions ----------------------------------------------------------------------------

/** Masks secret-looking keys and truncates long values for display (exported for other routers). */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > ARG_VALUE_LIMIT ? `${value.slice(0, ARG_VALUE_LIMIT)}... (${value.length} chars)` : value;
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactValue(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? '[redacted]' : redactValue(entry, depth + 1),
    ]),
  );
}

export type GateDecisionView = Omit<BotGateDecision, 'args'> & { args: Record<string, unknown>; args_summary: string };

/** Args with secret-looking keys masked and long values truncated, plus the gate's own one-line summary. */
export function toGateDecisionView(decision: BotGateDecision): GateDecisionView {
  const args = redactValue(decision.args) as Record<string, unknown>;
  return { ...decision, args, args_summary: summarizeArgs(args).trim() };
}

botGateRouter.get(
  '/:botId/gate-decisions',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const decision = queryText(req.query.decision);
    if (decision && !DECISIONS.includes(decision as BotRuleDecision)) throw invalid(`decision must be one of ${DECISIONS.join(', ')}`);
    const outcome = queryText(req.query.outcome);
    if (outcome && !OUTCOMES.includes(outcome)) throw invalid(`outcome must be one of ${OUTCOMES.join(', ')}`);
    const limit = parseLimit(req.query.limit, 50);
    const filtered = decision || outcome;
    // Filter after the query so `limit` counts matching rows, not raw rows.
    const rows = botGateDecisionsDb.listForBot(botId, filtered ? 1000 : limit);
    const matches = filtered
      ? rows.filter(
          (row) =>
            (!decision || row.decision === decision) &&
            (!outcome || (outcome === 'pending' ? row.outcome === null : row.outcome === outcome)),
        )
      : rows;
    res.json({ decisions: matches.slice(0, limit).map(toGateDecisionView) });
  }),
);

// ---- budget ------------------------------------------------------------------------------------

const startOfLocalDay = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
const startOfLocalMonth = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

function budgetNumber(value: unknown, field: string, integer: boolean): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid(`${field} must be a number >= 0 or null`);
  if (integer && !Number.isInteger(value)) throw invalid(`${field} must be a whole number`);
  return value;
}

botGateRouter.get(
  '/:botId/budget',
  asyncHandler(async (req, res) => {
    res.json({ budget: budgets.get(requireBot(req)) });
  }),
);

botGateRouter.put(
  '/:botId/budget',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const input = body(req);
    let softRatio: number | undefined;
    if (input.soft_ratio !== undefined) {
      if (typeof input.soft_ratio !== 'number' || !Number.isFinite(input.soft_ratio) || input.soft_ratio <= 0 || input.soft_ratio > 1) {
        throw invalid('soft_ratio must be a number in (0, 1]');
      }
      softRatio = input.soft_ratio;
    }
    const budget = budgets.put(botId, {
      dailyUsd: budgetNumber(input.daily_usd, 'daily_usd', false),
      monthlyUsd: budgetNumber(input.monthly_usd, 'monthly_usd', false),
      dailyActions: budgetNumber(input.daily_actions, 'daily_actions', true),
      maxWakesPerHour: budgetNumber(input.max_wakes_per_hour, 'max_wakes_per_hour', true),
      softRatio,
    });
    res.json({ budget });
  }),
);

botGateRouter.get(
  '/:botId/budget/status',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const now = new Date();
    res.json({
      status: {
        budget: budgets.get(botId),
        check: budgets.check(botId, now),
        spend: {
          today_usd: botSpendDb.costSince(botId, startOfLocalDay(now)),
          month_usd: botSpendDb.costSince(botId, startOfLocalMonth(now)),
          actions_today: botSpendDb.executedActionsSince(botId, startOfLocalDay(now)),
          wakes_last_hour: botSpendDb.episodesStartedSince(botId, new Date(now.getTime() - 3_600_000).toISOString()),
        },
        wake_allowed: budgets.wakeAllowed(botId, now),
      },
    });
  }),
);

// ---- enforcement -------------------------------------------------------------------------------

/**
 * How strongly the gate governs this bot: 'enforced' only when every phase runs on a provider with
 * a full enforcement path (Claude with the built-in tool gate); otherwise 'advisory'.
 */
const GATED_RUN = { builtinToolGate: true } as const;

botGateRouter.get(
  '/:botId/enforcement',
  asyncHandler(async (req, res) => {
    const botId = requireBot(req);
    const section = missionControlDb.getSection(botId)!;
    const runtime = readBotRuntimeConfig(botId) ?? {};
    const phaseProvider = (phase: 'perceive' | 'act' | 'reflect'): string => runtime.routing?.[phase]?.provider ?? section.provider;
    const phases = (['perceive', 'act', 'reflect'] as const).map((phase) => {
      const provider = phaseProvider(phase);
      // Every gateway-bound run carries the built-in tool gate; the provider adapter decides
      // whether that provider can actually honour it.
      return { phase, provider, level: getGatewayEnforcement(provider, GATED_RUN), detail: describeGatewayEnforcement(provider, GATED_RUN) };
    });
    const provider = phaseProvider('act');
    res.json({
      enforcement: {
        provider,
        level: getGatewayEnforcement(provider, GATED_RUN),
        detail: describeGatewayEnforcement(provider, GATED_RUN),
        builtin_tool_gate: getGatewayEnforcement(provider, GATED_RUN) === 'enforced',
        gateway: runtime.gateway ?? true,
        configured: runtime.enforcement ?? null,
        phases,
      },
    });
  }),
);
