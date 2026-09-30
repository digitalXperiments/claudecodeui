import { missionControlDb } from '@/modules/mission-control/index.js';

import { botEpisodesDb } from '../kernel/bot-episodes.repository.js';
import { botGoalsDb } from '../kernel/bot-goals.repository.js';

import { getGatewayTool, listGatewayTools, textResult } from './first-party-tools.js';
import type {
  GatewayCallToolResult,
  GatewayGate,
  GatewayGateContext,
  GatewayGateVerdict,
  GatewaySessionBinding,
  GatewayToolDescriptor,
} from './gateway.types.js';
import { gatewaySessions } from './sessions.js';
import { buildToolNameMap, FIRST_PARTY_PREFIX, type ToolNameMap } from './tool-names.js';
import { gatewayUpstreamPool, type UpstreamPool } from './upstream-pool.js';

export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;

let gate: GatewayGate | null = null;
let pool: UpstreamPool = gatewayUpstreamPool;
let askTimeoutMs = DEFAULT_ASK_TIMEOUT_MS;

/** The lead wires the real Action Gate here. With no gate every upstream call is refused. */
export function setGatewayGate(next: GatewayGate | null): void {
  gate = next;
}

export function setGatewayUpstreamPool(next: UpstreamPool | null): void {
  pool = next ?? gatewayUpstreamPool;
}

export function setGatewayOptions(options: { askTimeoutMs?: number }): void {
  if (typeof options.askTimeoutMs === 'number' && options.askTimeoutMs > 0) askTimeoutMs = options.askTimeoutMs;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Listing {
  tools: GatewayToolDescriptor[];
  names: ToolNameMap;
  byExposed: Map<string, { server: string; descriptor: GatewayToolDescriptor }>;
  errors: Array<{ server: string; error: string }>;
}

async function listUpstream(binding: GatewaySessionBinding): Promise<Listing> {
  const errors: Listing['errors'] = [];
  const perServer = await Promise.all(binding.servers.map(async (server) => {
    try {
      return { server, tools: await pool.listTools(String(binding.provider), server, binding.botId) };
    } catch (error) {
      errors.push({ server, error: errorText(error) });
      return { server, tools: [] as GatewayToolDescriptor[] };
    }
  }));
  const names = buildToolNameMap(perServer.flatMap((entry) => entry.tools.map((tool) => ({ server: entry.server, tool: tool.name }))));
  const tools: GatewayToolDescriptor[] = [];
  const byExposed: Listing['byExposed'] = new Map();
  for (const entry of perServer) {
    for (const descriptor of entry.tools) {
      const exposed = names.exposedName(entry.server, descriptor.name);
      if (!exposed) continue;
      byExposed.set(exposed, { server: entry.server, descriptor });
      tools.push({
        name: exposed,
        description: `[${entry.server}] ${descriptor.description ?? ''}`.trim(),
        inputSchema: descriptor.inputSchema,
        ...(descriptor.annotations ? { annotations: descriptor.annotations } : {}),
      });
    }
  }
  return { tools, names, byExposed, errors };
}

/**
 * Whether the session must be treated as having read untrusted content: its own binding flag, or
 * its episode row (the kernel sets `tainted` when a batch contains external events). Persisting the
 * episode flag onto the binding means it is never forgotten mid-run.
 */
export function isSessionTainted(appSessionId: string): boolean {
  const binding = gatewaySessions.get(appSessionId);
  if (!binding) return false;
  if (binding.tainted) return true;
  if (binding.episodeId) {
    try {
      if (botEpisodesDb.get(binding.episodeId)?.tainted) {
        gatewaySessions.markTainted(appSessionId);
        return true;
      }
    } catch (error) {
      // Fail closed: an unreadable episode row reads as tainted.
      console.warn('[BotGateway] could not read episode taint; treating session as tainted:', errorText(error));
      return true;
    }
  }
  return false;
}

export async function listGatewayToolsForSession(appSessionId: string): Promise<GatewayToolDescriptor[]> {
  const binding = gatewaySessions.get(appSessionId);
  if (!binding) return [];
  isSessionTainted(appSessionId);
  const firstParty = listGatewayTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const upstream = await listUpstream(binding);
  for (const failure of upstream.errors) {
    console.warn(`[BotGateway] upstream "${failure.server}" unavailable: ${failure.error}`);
  }
  return [...firstParty, ...upstream.tools];
}

function buildGateContext(binding: GatewaySessionBinding): GatewayGateContext {
  let operatorInstructions = '';
  let goals: string[] = [];
  try {
    operatorInstructions = missionControlDb.getSection(binding.botId)?.produce_prompt ?? '';
  } catch {
    // Context is best effort; the gate still has the request itself.
  }
  try {
    goals = botGoalsDb.list(binding.botId, 'active').map((goal) => goal.statement);
  } catch {
    // Same: a missing goals table must not take the gateway down.
  }
  return {
    botId: binding.botId,
    episodeId: binding.episodeId,
    runId: binding.runId,
    tainted: binding.tainted,
    operatorInstructions,
    goals,
  };
}

function taintSession(appSessionId: string, binding: GatewaySessionBinding): void {
  gatewaySessions.markTainted(appSessionId);
  if (!binding.episodeId) return;
  try {
    botEpisodesDb.update(binding.episodeId, { tainted: true });
  } catch (error) {
    console.warn('[BotGateway] could not persist episode taint:', errorText(error));
  }
}

/**
 * First-party tools that hand back content written elsewhere (another bot's answer, an external
 * Space) call this so the caller's session and episode row read as tainted from then on.
 * `episodeId` is the tool context's episode, used when the session has no live binding.
 */
export function markSessionTainted(appSessionId: string, episodeId?: string): void {
  const binding = gatewaySessions.get(appSessionId);
  if (binding) {
    taintSession(appSessionId, binding);
    return;
  }
  if (!episodeId) return;
  try {
    botEpisodesDb.update(episodeId, { tainted: true });
  } catch (error) {
    console.warn('[BotGateway] could not persist episode taint:', errorText(error));
  }
}

function resultHasContent(result: GatewayCallToolResult): boolean {
  if (result.structuredContent && Object.keys(result.structuredContent).length > 0) return true;
  return (result.content ?? []).some((part) => {
    if (!part) return false;
    if (part.type === 'text') return typeof part.text === 'string' && part.text.trim().length > 0;
    return true;
  });
}

function summarize(result: GatewayCallToolResult): string {
  const text = (result.content ?? [])
    .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : `[${String(part?.type ?? 'content')}]`))
    .join(' ');
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

async function recordOutcome(decisionId: string, outcome: Parameters<GatewayGate['recordOutcome']>[1]): Promise<void> {
  try {
    await gate?.recordOutcome(decisionId, outcome);
  } catch (error) {
    console.warn('[BotGateway] recordOutcome failed:', errorText(error));
  }
}

async function callFirstParty(
  appSessionId: string,
  initialBinding: GatewaySessionBinding,
  name: string,
  args: Record<string, unknown>,
): Promise<GatewayCallToolResult> {
  const tool = getGatewayTool(name);
  if (!tool) return textResult(`Unknown gateway tool "${name}".`, true);
  const binding = gatewaySessions.get(appSessionId) ?? initialBinding;
  const ctx = {
    appSessionId,
    botId: binding.botId,
    episodeId: binding.episodeId,
    runId: binding.runId,
    provider: String(binding.provider),
    tainted: binding.tainted,
  };
  if (tool.risk !== 'read' && tool.risk !== 'draft') {
    if (!gate) return textResult('Tool gateway has no action gate configured; refusing the call.', true);
    const verdict = await gate.evaluate(buildGateContext(binding), { server: 'bot', tool: name.slice(FIRST_PARTY_PREFIX.length), args });
    const blocked = await resolveVerdict(appSessionId, verdict);
    if (blocked) return blocked;
    try {
      const result = await tool.handler(ctx, args);
      await recordOutcome(verdict.decisionId, { ok: !result.isError, summary: summarize(result) });
      return result;
    } catch (error) {
      await recordOutcome(verdict.decisionId, { ok: false, error: errorText(error) });
      return textResult(errorText(error), true);
    }
  }
  try {
    return await tool.handler(ctx, args);
  } catch (error) {
    return textResult(errorText(error), true);
  }
}

/** Returns an error result when the verdict (after any human wait) does not permit the call. */
async function resolveVerdict(appSessionId: string, verdict: GatewayGateVerdict): Promise<GatewayCallToolResult | null> {
  if (verdict.decision === 'deny') {
    return textResult(`Blocked by the action gate (${verdict.risk}): ${verdict.reason}`, true);
  }
  if (verdict.decision === 'ask') {
    const answer = await gate!.awaitHuman(verdict.decisionId, { timeoutMs: askTimeoutMs });
    if (answer === 'rejected') return textResult(`The operator rejected this call (${verdict.risk}): ${verdict.reason}`, true);
    if (answer === 'expired') return textResult(`No operator decision before the approval expired (${verdict.risk}); the call was not made.`, true);
    // The run may have ended (unbound) while the operator deliberated; never execute for a dead run.
    if (!gatewaySessions.get(appSessionId)) {
      await recordOutcome(verdict.decisionId, { ok: false, error: 'run ended before approval' });
      return textResult('The run ended before the approval arrived; the call was not made.', true);
    }
  }
  return null;
}

export async function callGatewayTool(
  appSessionId: string,
  name: string,
  rawArgs: unknown,
): Promise<GatewayCallToolResult> {
  const binding = gatewaySessions.get(appSessionId);
  if (!binding) {
    return textResult('This session is not bound to a bot; the tool gateway refused the call.', true);
  }
  isSessionTainted(appSessionId);
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};

  if (name.startsWith(FIRST_PARTY_PREFIX) && getGatewayTool(name)) {
    return callFirstParty(appSessionId, binding, name, args);
  }

  let listing: Listing;
  try {
    listing = await listUpstream(binding);
  } catch (error) {
    return textResult(errorText(error), true);
  }
  const target = listing.byExposed.get(name);
  const resolved = listing.names.resolve(name);
  if (!target || !resolved) {
    return textResult(`Unknown tool "${name}" for this bot.`, true);
  }
  if (!gate) {
    return textResult('Tool gateway has no action gate configured; refusing the call.', true);
  }

  let verdict: GatewayGateVerdict;
  try {
    verdict = await gate.evaluate(buildGateContext(gatewaySessions.get(appSessionId) ?? binding), {
      server: target.server,
      tool: resolved.tool,
      args,
      annotations: target.descriptor.annotations,
      description: target.descriptor.description,
    });
  } catch (error) {
    return textResult(`Action gate failed, call refused: ${errorText(error)}`, true);
  }
  const blocked = await resolveVerdict(appSessionId, verdict).catch((error) => textResult(`Approval failed, call refused: ${errorText(error)}`, true));
  if (blocked) return blocked;

  const started = Date.now();
  try {
    const result = await pool.callTool(String(binding.provider), target.server, resolved.tool, args, binding.botId);
    const ok = !result.isError;
    await recordOutcome(verdict.decisionId, { ok, durationMs: Date.now() - started, summary: summarize(result) });
    // Every non-first-party server is external: what it brings back is untrusted input.
    // Any successful result that carries content can carry an injection, whatever the call's risk.
    if (ok && resultHasContent(result)) taintSession(appSessionId, binding);
    return result;
  } catch (error) {
    await recordOutcome(verdict.decisionId, { ok: false, durationMs: Date.now() - started, error: errorText(error) });
    return textResult(`Upstream call failed: ${errorText(error)}`, true);
  }
}
