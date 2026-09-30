import { interruptsDb, interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { runAutoReviewer } from '@/modules/bots/gate/auto-reviewer.js';
import { budgets } from '@/modules/bots/gate/budgets.service.js';
import {
  SAFETY_FLOOR,
  type GateContext,
  type GateRequest,
  type GateVerdict,
  type HumanGateOutcome,
  type Risk,
} from '@/modules/bots/gate/gate.types.js';
import { rules } from '@/modules/bots/gate/rules.service.js';
import { classifyToolRisk } from '@/modules/bots/gate/tool-risk.js';
import type { BotRule } from '@/modules/bots/bots.types.js';

type Verdict = Pick<GateVerdict, 'decision' | 'decidedBy' | 'reason'>;

const isFloor = (risk: Risk): boolean => SAFETY_FLOOR.includes(risk);
const isSafe = (risk: Risk): boolean => risk === 'read' || risk === 'draft';

/** Only the operator's own bot-scoped rules may loosen a floor risk to allow. */
function canLoosenFloor(rule: BotRule): boolean {
  return rule.scope === 'bot' && (rule.created_from === 'always_allow_click' || rule.created_from === 'manual');
}

function provisionalDecision(risk: Risk, rule: BotRule | null): { verdict: Verdict; rule: BotRule | null } {
  if (rule) {
    if (rule.decision === 'allow' && isFloor(risk) && !canLoosenFloor(rule)) {
      return {
        verdict: {
          decision: 'ask',
          decidedBy: 'floor',
          reason: `Risk "${risk}" needs approval; a global rule cannot loosen it (rule ${rule.rule_id})`,
        },
        rule: null,
      };
    }
    return {
      verdict: {
        decision: rule.decision,
        decidedBy: `rule:${rule.rule_id}`,
        reason: rule.note || `Matched rule ${rule.rule_id}`,
      },
      rule,
    };
  }
  if (isFloor(risk)) return { verdict: { decision: 'ask', decidedBy: 'floor', reason: `Risk "${risk}" needs approval` }, rule: null };
  if (risk === 'unknown') {
    return { verdict: { decision: 'ask', decidedBy: 'default', reason: 'Unclassified tool needs approval' }, rule: null };
  }
  return { verdict: { decision: 'allow', decidedBy: 'default', reason: `Risk "${risk}" is allowed by default` }, rule: null };
}

function persistAndBroadcast(ctx: GateContext, req: GateRequest, risk: Risk, verdict: Verdict, soft: boolean): GateVerdict {
  const row = botGateDecisionsDb.create({
    botId: ctx.botId,
    episodeId: ctx.episodeId ?? null,
    runId: ctx.runId ?? null,
    server: req.server,
    tool: req.tool,
    risk,
    args: req.args ?? {},
    decision: verdict.decision,
    decidedBy: verdict.decidedBy,
    reason: verdict.reason,
  });
  if (verdict.decision === 'deny') botGateDecisionsDb.recordOutcome(row.decision_id, 'denied');
  broadcastSystemEvent({
    kind: 'bot_gate_decision',
    bot_id: ctx.botId,
    decision_id: row.decision_id,
    decision: verdict.decision,
    tool: req.tool,
  });
  return { ...verdict, risk, decisionId: row.decision_id, ...(soft ? { soft: true } : {}) };
}

async function evaluate(ctx: GateContext, req: GateRequest): Promise<GateVerdict> {
  const risk = classifyToolRisk({
    server: req.server,
    tool: req.tool,
    annotations: req.annotations,
    description: req.description,
  });
  const finish = (verdict: Verdict, soft = false) => persistAndBroadcast(ctx, req, risk, verdict, soft);

  // 1. Dry run: nothing but reads and drafts may act.
  let dryRun = false;
  try {
    dryRun = Boolean(missionControlDb.getSection(ctx.botId)?.dry_run);
  } catch {
    dryRun = false;
  }
  if (dryRun && !isSafe(risk)) {
    return finish({ decision: 'deny', decidedBy: 'dry_run', reason: `Dry run is on; "${req.tool}" (${risk}) was not executed` });
  }

  // 2. Budget.
  const budget = budgets.check(ctx.botId);
  if (!budget.ok) {
    return finish({ decision: 'deny', decidedBy: 'budget', reason: budget.reason ?? 'Budget exhausted' });
  }
  const soft = budget.soft;

  // 3-4. Rules and the safety floor.
  const { verdict: provisional, rule } = provisionalDecision(risk, rules.match(ctx.botId, req, risk));
  if (provisional.decision !== 'allow') return finish(provisional, soft);

  // 5. Taint: untrusted content read earlier cannot authorize a consequential call.
  if (ctx.tainted && isFloor(risk) && rule?.match.allow_when_tainted !== true) {
    return finish(
      { decision: 'ask', decidedBy: 'taint', reason: `The run read untrusted content; "${req.tool}" (${risk}) needs a human` },
      soft,
    );
  }

  // 6. Auto-review: allow on unknown risk, or a tainted call that is neither read-only nor floor.
  const needsReview = risk === 'unknown' || (ctx.tainted && risk === 'draft');
  if (needsReview) {
    const review = await runAutoReviewer(ctx, req, risk);
    if (!review.ok) {
      return finish({ decision: 'ask', decidedBy: 'reviewer', reason: review.reason || 'Reviewer did not approve' }, soft);
    }
    return finish({ decision: 'allow', decidedBy: 'reviewer', reason: review.reason || 'Reviewer approved' }, soft);
  }

  return finish(provisional, soft);
}

// ---------------------------------------------------------------------------
// Human approval

interface Waiter {
  resolve: (outcome: HumanGateOutcome) => void;
}
const waiters = new Map<string, Waiter>();
let pollIntervalMs = 1_000;

/** Test hook: how often awaitHuman re-reads the DB when no resolver fired. */
export function setGateHumanPollInterval(ms: number | null): void {
  pollIntervalMs = ms ?? 1_000;
}

function summarizeArgs(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    text = '[unserializable]';
  }
  if (text.length > 600) text = `${text.slice(0, 600)}...`;
  try {
    return secretsService.redact(text);
  } catch {
    return text;
  }
}

/**
 * Settle a human decision. Idempotent: the first caller wins, later calls are ignored.
 * `alwaysAllow` also writes a bot-scoped rule so the next identical call needs no approval.
 */
export function resolveBotGateDecision(
  decisionId: string,
  decision: 'approved' | 'rejected',
  options: { alwaysAllow?: boolean } = {},
): void {
  const row = botGateDecisionsDb.get(decisionId);
  if (!row) return;
  const settled = row.outcome === 'approved' || row.outcome === 'rejected' || row.outcome === 'expired' || row.outcome === 'executed';
  if (settled) return;
  botGateDecisionsDb.recordOutcome(decisionId, decision);
  if (decision === 'approved' && options.alwaysAllow) {
    rules.create({
      scope: 'bot',
      botId: row.bot_id,
      match: { server: row.server, tool: row.tool },
      decision: 'allow',
      createdFrom: 'always_allow_click',
      note: `Always allow ${row.server}/${row.tool}`,
    });
  }
  waiters.get(decisionId)?.resolve(decision);
}

/** Wire the interrupt queue's bot_gate actions to `resolveBotGateDecision`. Call once at boot. */
export function initBotGate(): void {
  interruptsService.configureBotGateResolver((decisionId, decision, options) => {
    resolveBotGateDecision(decisionId, decision, options);
  });
}

function outcomeFromInterrupt(interruptId: string): { outcome: HumanGateOutcome; alwaysAllow: boolean } | null {
  const interrupt = interruptsDb.get(interruptId);
  if (!interrupt) return { outcome: 'rejected', alwaysAllow: false };
  if (interrupt.status === 'expired') return { outcome: 'expired', alwaysAllow: false };
  if (interrupt.status === 'resolved' || interrupt.status === 'dismissed') {
    if (interrupt.resolution === 'approve_once') return { outcome: 'approved', alwaysAllow: false };
    if (interrupt.resolution === 'always_allow') return { outcome: 'approved', alwaysAllow: true };
    return { outcome: 'rejected', alwaysAllow: false };
  }
  return null;
}

async function awaitHuman(decisionId: string, options: { timeoutMs: number }): Promise<HumanGateOutcome> {
  const row = botGateDecisionsDb.get(decisionId);
  if (!row) throw new Error(`Unknown gate decision: ${decisionId}`);
  const existing = row.outcome;
  if (existing === 'approved' || existing === 'rejected' || existing === 'expired') return existing;

  const bot = (() => {
    try {
      return missionControlDb.getSection(row.bot_id);
    } catch {
      return null;
    }
  })();
  const botTitle = bot?.title?.trim() || 'Bot';
  const interrupt = interruptsService.create({
    kind: 'bot_gate',
    severity: 'warning',
    title: `${botTitle} wants to ${row.tool}`,
    body: [
      `Server: ${row.server}`,
      `Tool: ${row.tool}`,
      `Risk: ${row.risk}`,
      `Args: ${summarizeArgs(row.args)}`,
      row.reason ? `Why: ${row.reason}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    href: `/bots/b/${row.bot_id}/overview`,
    actions: [
      { id: 'approve_once', label: 'Approve once', style: 'primary' },
      { id: 'always_allow', label: 'Always allow', style: 'secondary' },
      { id: 'deny', label: 'Deny', style: 'destructive' },
    ],
    dedupeKey: `bot_gate:${decisionId}`,
    meta: { botId: row.bot_id, decisionId },
    expiresAt: new Date(Date.now() + Math.max(options.timeoutMs, 1_000)).toISOString(),
  });
  botGateDecisionsDb.setInterrupt(decisionId, interrupt.interrupt_id);

  return new Promise<HumanGateOutcome>((resolve) => {
    let poll: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: HumanGateOutcome) => {
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      waiters.delete(decisionId);
      resolve(outcome);
    };
    waiters.set(decisionId, { resolve: finish });

    const expire = () => {
      const current = botGateDecisionsDb.get(decisionId);
      if (current?.outcome === 'approved' || current?.outcome === 'rejected') {
        finish(current.outcome);
        return;
      }
      botGateDecisionsDb.recordOutcome(decisionId, 'expired');
      const expired = interruptsDb.expire(interrupt.interrupt_id, 'bot_gate_timeout');
      if (expired) broadcastSystemEvent({ kind: 'interrupt_updated', interrupt: expired });
      finish('expired');
    };

    // Fallback: resolution through any path (HTTP act without a configured resolver, direct DB).
    poll = setInterval(() => {
      const current = botGateDecisionsDb.get(decisionId);
      if (current?.outcome === 'approved' || current?.outcome === 'rejected' || current?.outcome === 'expired') {
        finish(current.outcome);
        return;
      }
      const fromInterrupt = outcomeFromInterrupt(interrupt.interrupt_id);
      if (!fromInterrupt) return;
      if (fromInterrupt.outcome === 'expired') {
        botGateDecisionsDb.recordOutcome(decisionId, 'expired');
        finish('expired');
        return;
      }
      resolveBotGateDecision(decisionId, fromInterrupt.outcome, { alwaysAllow: fromInterrupt.alwaysAllow });
      finish(fromInterrupt.outcome);
    }, pollIntervalMs);
    timer = setTimeout(expire, Math.max(options.timeoutMs, 0));
  });
}

function recordOutcome(decisionId: string, outcome: string): void {
  botGateDecisionsDb.recordOutcome(decisionId, outcome);
}

export const actionGate = { evaluate, awaitHuman, recordOutcome };
