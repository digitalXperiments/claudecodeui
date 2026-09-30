/**
 * Human handoff: `bot__request_handoff` lets a bot stop and ask the operator to do something only
 * a person can (log in, solve a captcha, approve in another app). It raises a `bot_handoff`
 * interrupt (fans out to channels like an approval), blocks until the operator answers Done or
 * Cancel, the wait times out, or the bot's run ends, then returns the operator's note.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { browserUseService } from '@/modules/browser-use/index.js';
import { interruptsDb, interruptsService } from '@/modules/interrupt-queue/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { gatewaySessions } from '@/shared/bot-gateway-sessions.js';

import { resolveBotBrowserProfileDir } from '../bots-home.js';
import { registerGatewayTool, textResult } from '../gateway/first-party-tools.js';
import { extendEpisodeDeadline } from '../kernel/kernel.service.js';
import type { GatewayCallToolResult, GatewayToolContext } from '../gateway/gateway.types.js';

export const DEFAULT_HANDOFF_TIMEOUT_MS = 30 * 60_000;
const MIN_HANDOFF_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 1_000;
/** The stdio gateway child gives up on a call after this (see bot-tool-gateway-mcp.ts). */
const DEFAULT_GATEWAY_API_TIMEOUT_MS = 2_100_000;
const GATEWAY_MARGIN_MS = 30_000;

export type HandoffOutcome = 'done' | 'cancelled' | 'timeout' | 'run_ended';

/** Most human handoffs one episode may raise. */
export const MAX_HANDOFFS_PER_EPISODE = 2;
/** Room left for the bot to finish its turn after a handoff (and the clamp when the episode's cap is near). */
const HANDOFF_FINISH_MARGIN_MS = 5 * 60_000;

/** The slice of browser-use a handoff needs to give the operator the wheel of a live session. */
export interface HandoffBrowser {
  /** Owner (profile directory) and current driver of a session; throws when it does not exist. */
  describeAgentSession(sessionId: string): Promise<{ profileDir: string | null; controller: 'agent' | 'human' }>;
  takeHumanControl(sessionId: string): Promise<unknown>;
  returnAgentControl(sessionId: string): Promise<unknown>;
}

export interface HandoffOptions {
  timeoutMs?: number;
  pollMs?: number;
  browser?: HandoffBrowser;
}

let options: HandoffOptions = {};

/** Tests and embedders tune the default wait and poll cadence; null restores the defaults. */
export function setHandoffOptions(next: HandoffOptions | null): void {
  options = next ?? {};
}

interface EpisodeHandoffs {
  count: number;
  cancelled: boolean;
}
/** Per-episode handoff ledger (key: episode id, else run id, else app session). Bounded, in memory. */
const ledgers = new Map<string, EpisodeHandoffs>();
const LEDGER_MAX = 500;

function ledgerFor(ctx: GatewayToolContext): EpisodeHandoffs {
  const key = ctx.episodeId ?? ctx.runId ?? ctx.appSessionId;
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = { count: 0, cancelled: false };
    ledgers.set(key, ledger);
    if (ledgers.size > LEDGER_MAX) {
      const oldest = ledgers.keys().next().value;
      if (oldest !== undefined) ledgers.delete(oldest);
    }
  }
  return ledger;
}

/** Tests reset the per-episode ledger between cases. */
export function resetHandoffLedgerForTests(): void {
  ledgers.clear();
}

interface Waiter {
  finish(outcome: HandoffOutcome, note: string): void;
}
const waiters = new Map<string, Waiter>();

/** Called by the interrupt queue when the operator answers Done / Cancel. */
export function resolveBotHandoff(handoffId: string, outcome: 'done' | 'cancelled', details: { note: string }): void {
  waiters.get(handoffId)?.finish(outcome, details.note);
}

/** Wire the interrupt queue's `done` / `cancel` actions to the waiting tool call. Idempotent. */
export function initBotHandoff(): void {
  interruptsService.configureBotHandoffResolver((handoffId, outcome, details) => resolveBotHandoff(handoffId, outcome, details));
}

function gatewayApiTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.CLOUDCLI_BOT_GATEWAY_API_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GATEWAY_API_TIMEOUT_MS;
}

/** Default 30 min (or `CLOUDCLI_BOT_HANDOFF_TIMEOUT_MINUTES`), never more than the gateway call can wait. */
export function resolveHandoffTimeoutMs(requestedMinutes?: unknown): number {
  const fromEnv = Number(process.env.CLOUDCLI_BOT_HANDOFF_TIMEOUT_MINUTES);
  const configured = options.timeoutMs
    ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv * 60_000 : DEFAULT_HANDOFF_TIMEOUT_MS);
  const asked = typeof requestedMinutes === 'number' && Number.isFinite(requestedMinutes) && requestedMinutes > 0
    ? requestedMinutes * 60_000
    : configured;
  const ceiling = Math.max(MIN_HANDOFF_TIMEOUT_MS, gatewayApiTimeoutMs() - GATEWAY_MARGIN_MS);
  return Math.min(Math.max(asked, options.timeoutMs ? 1 : MIN_HANDOFF_TIMEOUT_MS), ceiling);
}

/**
 * Fit a handoff wait into what the kernel granted. When the episode's hard cap cut the extension
 * short, the wait shrinks to leave the bot time to finish its turn; with no room left it is refused.
 */
export function clampHandoffWindow(
  timeoutMs: number,
  extension: { remainingMs: number; capped: boolean } | null,
): { timeoutMs: number } | { refuse: string } {
  if (!extension?.capped) return { timeoutMs };
  const available = extension.remainingMs - HANDOFF_FINISH_MARGIN_MS;
  if (available < MIN_HANDOFF_TIMEOUT_MS) {
    return { refuse: 'Handoff refused: this episode has no time left for a human handoff. Finish with what you have.' };
  }
  return { timeoutMs: Math.min(timeoutMs, available) };
}

const clip = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);

function validUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function botTitle(botId: string): string {
  try {
    return missionControlDb.getSection(botId)?.title?.trim() || 'Bot';
  } catch {
    return 'Bot';
  }
}

function outcomeFromInterrupt(interruptId: string): { outcome: HandoffOutcome; note: string } | null {
  const interrupt = interruptsDb.get(interruptId);
  if (!interrupt) return { outcome: 'cancelled', note: '' };
  if (interrupt.status === 'expired') return { outcome: 'timeout', note: '' };
  if (interrupt.status === 'resolved' || interrupt.status === 'dismissed') {
    return { outcome: interrupt.resolution === 'handoff_done' ? 'done' : 'cancelled', note: '' };
  }
  return null;
}

function describeResult(outcome: HandoffOutcome, note: string): GatewayCallToolResult {
  const guidance: Record<HandoffOutcome, string> = {
    done: 'The operator did what you asked. Continue, and verify the result before relying on it.',
    cancelled: 'The operator declined or cannot help. Do not ask again for the same thing; work around it or stop.',
    timeout: 'No answer arrived in time. Do not assume it was done; stop or continue without it.',
    run_ended: 'Your run ended while waiting.',
  };
  return textResult(JSON.stringify({ outcome, note, guidance: guidance[outcome] }), outcome !== 'done');
}

export async function requestHandoff(
  ctx: GatewayToolContext,
  args: Record<string, unknown>,
): Promise<GatewayCallToolResult> {
  const reason = clip(args.reason, 500);
  const instructions = clip(args.instructions, 2_000);
  if (!reason) return textResult('reason is required.', true);
  if (!instructions) return textResult('instructions is required.', true);
  if (args.url !== undefined && args.url !== null && args.url !== '' && !validUrl(args.url)) {
    return textResult('url must be an http(s) URL.', true);
  }
  const url = validUrl(args.url);
  const browserSessionId = clip(args.browserSessionId ?? args.browser_session_id, 100) || null;
  const browser = options.browser ?? (browserUseService as unknown as HandoffBrowser);

  // A human handoff parks the episode for up to ~30 minutes, so a bot (or an injected prompt) must
  // not be able to chain them: two per episode, and none after the operator declined one.
  const ledger = ledgerFor(ctx);
  if (ledger.cancelled) {
    return textResult('Handoff refused: the operator already declined a handoff in this episode. Do not ask again; work around it or stop.', true);
  }
  if (ledger.count >= MAX_HANDOFFS_PER_EPISODE) {
    return textResult(`Handoff refused: at most ${MAX_HANDOFFS_PER_EPISODE} handoffs per episode. Continue without the operator or stop.`, true);
  }

  // Only a browser session this bot owns may be handed over (launched with the bot's own profile).
  let takeControl = false;
  if (browserSessionId) {
    let info: Awaited<ReturnType<HandoffBrowser['describeAgentSession']>>;
    try {
      info = await browser.describeAgentSession(browserSessionId);
    } catch {
      return textResult('browserSessionId does not match a browser session of this bot.', true);
    }
    const expected = path.resolve(resolveBotBrowserProfileDir(ctx.botId));
    if (!info.profileDir || path.resolve(info.profileDir) !== expected) {
      return textResult('browserSessionId does not match a browser session of this bot.', true);
    }
    // Only give control back at the end if this handoff is what took it from the agent.
    takeControl = info.controller !== 'human';
  }

  let timeoutMs = resolveHandoffTimeoutMs(args.timeout_minutes);
  // Waiting on a human must not trip the kernel's episode deadline: keep the episode alive for the
  // handoff window plus a margin to finish the turn afterwards. The kernel caps the total stretch
  // (episodeMaxMs + 35 min from the episode start), so clamp the wait to what is left.
  if (ctx.episodeId) {
    const window = clampHandoffWindow(timeoutMs, extendEpisodeDeadline(ctx.episodeId, timeoutMs + HANDOFF_FINISH_MARGIN_MS));
    if ('refuse' in window) return textResult(window.refuse, true);
    timeoutMs = window.timeoutMs;
  }
  ledger.count += 1;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const handoffId = `bho_${randomUUID()}`;

  let liveView = false;
  let tookControl = false;
  if (browserSessionId) {
    if (takeControl) {
      try {
        await browser.takeHumanControl(browserSessionId);
        liveView = true;
        tookControl = true;
      } catch {
        liveView = false;
      }
    } else {
      liveView = true; // the operator already has the wheel; leave it with them afterwards
    }
  }

  const title = `${botTitle(ctx.botId)} needs you`;
  const body = [
    reason,
    '',
    `What to do: ${instructions}`,
    url ? `Open: ${url}` : '',
    liveView ? `Live browser: open the Browser panel; session ${browserSessionId} is under your control. Tap Done when you are finished.` : '',
    'Tap Done when it is handled, or Cancel if you cannot.',
  ].filter((line, index, all) => line || (index > 0 && all[index - 1])).join('\n');

  const interrupt = interruptsService.create({
    kind: 'bot_handoff',
    severity: 'warning',
    title,
    body,
    href: `/bots/b/${ctx.botId}/overview`,
    actions: [
      { id: 'done', label: 'Done', style: 'primary' },
      { id: 'cancel', label: 'Cancel', style: 'destructive' },
    ],
    dedupeKey: `bot_handoff:${handoffId}`,
    meta: {
      botId: ctx.botId,
      handoffId,
      ...(ctx.episodeId ? { episodeId: ctx.episodeId } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(url ? { url } : {}),
      ...(liveView ? { browserSessionId } : {}),
    },
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
  });

  const outcome = await new Promise<{ outcome: HandoffOutcome; note: string }>((resolve) => {
    let poll: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (next: HandoffOutcome, note: string) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      waiters.delete(handoffId);
      resolve({ outcome: next, note });
    };
    const expireInterrupt = (resolution: string) => {
      const expired = interruptsDb.expire(interrupt.interrupt_id, resolution);
      if (expired) broadcastSystemEvent({ kind: 'interrupt_updated', interrupt: expired });
    };
    waiters.set(handoffId, { finish });
    // Fallback: the operator may resolve the interrupt through any path (HTTP without the
    // resolver wired, a signed link, the sweep expiring it). Also notices a run that has ended.
    poll = setInterval(() => {
      const fromInterrupt = outcomeFromInterrupt(interrupt.interrupt_id);
      if (fromInterrupt) {
        finish(fromInterrupt.outcome, fromInterrupt.note);
        return;
      }
      if (!gatewaySessions.get(ctx.appSessionId)) {
        expireInterrupt('bot_handoff_run_ended');
        finish('run_ended', '');
      }
    }, pollMs);
    timer = setTimeout(() => {
      expireInterrupt('bot_handoff_timeout');
      finish('timeout', '');
    }, timeoutMs);
  });

  if (tookControl && browserSessionId) {
    await browser.returnAgentControl(browserSessionId).catch(() => undefined);
  }
  if (outcome.outcome === 'cancelled') ledger.cancelled = true;
  return describeResult(outcome.outcome, outcome.note);
}

let registered = false;

/** Idempotent; called from `installExec`. */
export function registerHandoffGatewayTool(): void {
  if (registered) return;
  registered = true;
  registerGatewayTool('bot__request_handoff', {
    description:
      'Stop and ask the operator to do something only a person can do (sign in, solve a captcha, approve in another app). ' +
      'Blocks until they tap Done or Cancel (up to about 30 minutes) and returns their note. Give exact instructions. ' +
      'If a browser session is open and they need to drive it, pass its sessionId as browserSessionId.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you are blocked, one or two sentences.' },
        instructions: { type: 'string', description: 'Exactly what the operator should do.' },
        url: { type: 'string', description: 'Optional http(s) page the operator should open.' },
        browserSessionId: { type: 'string', description: 'Optional cloudcli-browser session to hand to the operator.' },
        timeout_minutes: { type: 'number', description: 'Optional wait limit in minutes (default 30).' },
      },
      required: ['reason', 'instructions'],
    },
    risk: 'draft',
    handler: (ctx, args) => requestHandoff(ctx, args),
  });
}
