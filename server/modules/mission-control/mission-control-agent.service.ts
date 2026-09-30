import os from 'node:os';

import { jsonrepair } from 'jsonrepair';

import { isBotsRuntimeV2Enabled } from '@/modules/app-features/index.js';
import { botGateDecisionsDb, buildGatewayRunGuards, readBotRuntimeConfig, resolveBotHome } from '@/modules/bots/index.js';
import { gatewaySessions } from '@/shared/bot-gateway-sessions.js';
import { projectsDb } from '@/modules/database/index.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  getProviderAbortFn,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import { TERMINAL_RUN_STATUSES } from '@/shared/run-events.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { expandMcpSelectionsToTools } from '@/shared/mcp-tool-expand.js';
import { AppError } from '@/shared/utils.js';
import type { McSection, McToolPolicyDecision } from '@/modules/mission-control/mission-control.types.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import { recordSectionVersion } from '@/modules/mission-control/mission-control-versions.service.js';
import { approvedMemoryContext } from '@/modules/mission-control/mission-control-memory.service.js';
import {
  classifyFailoverError,
  classifyFailoverFailure,
  runShowsSideEffects,
  type FailoverReason,
} from '@/modules/mission-control/mission-control-failover.js';

export { expandMcpSelectionsToTools };

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function configureMissionControlRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

export function getMissionControlRuntime(provider: LLMProvider): ProviderSpawnFn {
  const runtime = runtimeSpawnFns[provider];
  if (!runtime) throw new AppError(`Provider "${provider}" runtime is not available`, { code: 'MC_RUNTIME_UNAVAILABLE', statusCode: 400 });
  return runtime;
}

/** The shape of one produce draft; the bot kernel embeds it in its own envelope. */
export const PRODUCE_ITEM_SHAPE =
  '{ "title": string, "summary": string, "body": object, "dedupeKey": string (a STABLE source id), "confidence": number }';

const PRODUCE_ENVELOPE =
  'Return ONLY a JSON array of items, each exactly ' +
  `${PRODUCE_ITEM_SHAPE}. ` +
  'If there is nothing to produce, return [] (empty array) — do not invent items and do not write prose. ' +
  'No tool narration, no code fences. ' +
  'Strict JSON only: escape every " and \\ and newline inside strings (use \\n for line breaks). ' +
  'Quotes that appear in Slack/message text must be escaped as \\".';
function stripCodeFences(text: string): string {
  return text.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();
}

/** Prefer ```json ... ``` / ``` ... ``` bodies when the model wrapped output. */
function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

/**
 * Walk text and collect balanced `{...}` / `[...]` slices.
 * Agents often emit tool narration before the real payload; we try every
 * top-level candidate (preferring later ones via reverse iteration at parse time).
 */
function findBalancedJsonSlices(text: string): string[] {
  const slices: string[] = [];
  for (let startIdx = 0; startIdx < text.length; startIdx++) {
    const open = text[startIdx];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = startIdx; i < text.length; i++) {
      const c = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\' && inStr) {
        escape = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          slices.push(text.slice(startIdx, i + 1));
          // Skip past this value so we don't re-scan every nested `{`.
          startIdx = i;
          break;
        }
      }
    }
  }
  return slices;
}

function looksLikeJsonValue(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

/**
 * Escape quote characters that are clearly prose inside a JSON string.
 *
 * `jsonrepair` handles most model mistakes, but it cannot always distinguish
 * a quote in prose from a string terminator when the prose quote is followed
 * by punctuation (for example, a quoted phrase followed by `).`). A Slack
 * summary hit exactly that case. Only use this after jsonrepair has already
 * failed, so strict JSON and normal repair behavior remain unchanged.
 */
function escapeLikelyUnescapedQuotes(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  let stringIsObjectKey = false;
  let previousSignificant = '';
  const containers: string[] = [];

  const startsJsonValue = (index: number): boolean => {
    const first = text[index] ?? '';
    if (first === '"' || first === '{' || first === '[') return true;

    for (const literal of ['true', 'false', 'null']) {
      if (!text.startsWith(literal, index)) continue;
      let end = index + literal.length;
      while (end < text.length && /\s/.test(text[end] ?? '')) end += 1;
      if (text[end] === ',' || text[end] === '}' || text[end] === ']') {
        return true;
      }
    }

    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (!number) return false;
    let end = index + number[0].length;
    while (end < text.length && /\s/.test(text[end] ?? '')) end += 1;
    return text[end] === ',' || text[end] === '}' || text[end] === ']';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (inString && char === '\\') {
      output += char;
      escaped = true;
      continue;
    }

    if (char !== '"') {
      output += char;
      if (!inString && !/\s/.test(char)) {
        if (char === '{' || char === '[') containers.push(char);
        if (char === '}' || char === ']') containers.pop();
        previousSignificant = char;
      }
      continue;
    }

    if (!inString) {
      output += char;
      inString = true;
      stringIsObjectKey =
        containers.at(-1) === '{'
        && (previousSignificant === '{' || previousSignificant === ',');
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < text.length && /\s/.test(text[nextIndex] ?? '')) {
      nextIndex += 1;
    }
    const next = text[nextIndex] ?? '';

    // A comma is only a likely JSON delimiter when what follows can begin a
    // JSON value/key. A comma followed by prose means the quote is still part
    // of the current string.
    let afterDelimiterIndex = nextIndex + 1;
    while (
      afterDelimiterIndex < text.length
      && /\s/.test(text[afterDelimiterIndex] ?? '')
    ) {
      afterDelimiterIndex += 1;
    }
    const afterDelimiter = text[afterDelimiterIndex] ?? '';
    const closesAfterComma = next === ',' && startsJsonValue(afterDelimiterIndex);
    const looksLikeTerminator = stringIsObjectKey
      ? next === ':'
      : next === '}'
        || next === ']'
        || next === ''
        || closesAfterComma;

    // `"quoted text"}` inside a string is still prose when the actual JSON
    // string terminator follows the brace. Keep both prose quotes escaped.
    const delimiterFollowedByQuote =
      (next === '}' || next === ']') && text[afterDelimiterIndex] === '"';

    if (!looksLikeTerminator || delimiterFollowedByQuote) {
      output += '\\"';
      continue;
    }

    output += char;
    inString = false;
    stringIsObjectKey = false;
  }

  return output;
}

function tryParseJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    // Only repair when the candidate already looks like a JSON value.
    // Running jsonrepair on prose+JSON invents garbage arrays like
    // ["Now I'll fetch…", [actual payload]].
    if (!looksLikeJsonValue(candidate)) {
      throw new Error('candidate is not JSON-shaped');
    }
    // Models frequently emit almost-JSON: unescaped " in prose, trailing commas,
    // single quotes, raw newlines inside strings.
    try {
      return JSON.parse(jsonrepair(candidate));
    } catch (repairError) {
      const quoteEscaped = escapeLikelyUnescapedQuotes(candidate);
      if (quoteEscaped === candidate) {
        throw repairError;
      }
      return JSON.parse(jsonrepair(quoteEscaped));
    }
  }
}

/** Higher is better — prefer draft arrays over nested fragments / junk. */
function scoreParsedJson(value: unknown): number {
  if (Array.isArray(value)) {
    if (value.length === 0) return 50;
    let score = 100 + Math.min(value.length, 20);
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        // String/primitive elements usually mean repair glued narration into an array.
        score -= 80;
        continue;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.title === 'string') score += 20;
      if (typeof e.dedupeKey === 'string' || typeof e.dedupe_key === 'string') score += 30;
      if (e.body && typeof e.body === 'object') score += 10;
    }
    return score;
  }
  if (value && typeof value === 'object') {
    const e = value as Record<string, unknown>;
    let score = 40;
    if (typeof e.title === 'string') score += 20;
    if (typeof e.dedupeKey === 'string' || typeof e.dedupe_key === 'string') score += 30;
    return score;
  }
  return 0;
}

/**
 * Parse structured output from a Mission Control agent turn.
 * Tolerates preamble prose, code fences, and common LLM JSON mistakes.
 */
export function parseJsonFromAgentText(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('no JSON object or array found in text');
  }

  const candidates: string[] = [];
  const pushUnique = (s: string) => {
    const t = s.trim();
    if (t && !candidates.includes(t)) candidates.push(t);
  };

  for (const block of extractFencedBlocks(trimmed)) pushUnique(block);
  pushUnique(trimmed);
  pushUnique(stripCodeFences(trimmed));
  for (const slice of findBalancedJsonSlices(stripCodeFences(trimmed))) {
    pushUnique(slice);
  }
  // Also scan the raw (un-stripped) text for balanced JSON in case fences
  // were incomplete.
  for (const slice of findBalancedJsonSlices(trimmed)) {
    pushUnique(slice);
  }

  let lastError: Error | null = null;
  let best: { value: unknown; score: number; length: number } | null = null;

  for (const text of candidates) {
    try {
      const value = tryParseJson(text);
      const score = scoreParsedJson(value);
      if (
        !best ||
        score > best.score ||
        (score === best.score && text.length > best.length)
      ) {
        best = { value, score, length: text.length };
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (best) return best.value;
  throw lastError ?? new Error('no JSON object or array found in text');
}

type McRunOutcome = {
  /** Assistant text output (error events are NOT mixed in). */
  text: string;
  /**
   * True when the run's terminal `complete` carried a non-zero exit code —
   * i.e. the provider runtime itself failed (API unreachable, CLI crash, …).
   * Mid-run `error`-kind events alone do NOT mark failure: some providers
   * forward benign stderr noise under that kind while the run still succeeds.
   */
  failed: boolean;
  /** Provider error text (error-kind events), when present. */
  errorMessage: string | null;
};

/** Exported for tests. */
export function extractRunOutcome(appSessionId: string): McRunOutcome {
  const events = chatRunRegistry.replayEvents(appSessionId, 0);
  const textChunks: string[] = [];
  const deltaChunks: string[] = [];
  const errorChunks: string[] = [];
  let failed = false;
  for (const event of events) {
    if (event.kind === 'complete') {
      if (typeof event.exitCode === 'number' && event.exitCode !== 0) {
        failed = true;
      }
      continue;
    }
    if (typeof event.content !== 'string') continue;
    if (event.kind === 'error') {
      errorChunks.push(event.content);
    } else if (event.kind === 'text') {
      textChunks.push(event.content);
    } else if (event.kind === 'stream_delta') {
      deltaChunks.push(event.content);
    }
  }
  return {
    text: (textChunks.length > 0 ? textChunks.join('\n') : deltaChunks.join('')).trim(),
    failed,
    errorMessage: errorChunks.join('\n').trim() || null,
  };
}

function resolveProjectPath(section: McSection): string {
  if (section.scope === 'project' && section.project_id) {
    const path = projectsDb.getProjectPathById(section.project_id);
    if (!path) {
      throw new AppError('Project path not found for section', {
        code: 'MC_PROJECT_PATH_MISSING',
        statusCode: 400,
      });
    }
    return path;
  }
  // Bot runtime v2: a global bot works in its own home (created on demand, outside Documents /
  // Desktop / Downloads) instead of the user's home directory.
  if (isBotsRuntimeV2Enabled()) return resolveBotHome(section.section_id);
  // Global sections run from the user home by default (MCP / personal tools).
  return os.homedir();
}

function policyToolPattern(server: string, tool: string): string | null {
  const wildcard = expandMcpSelectionsToTools([server], 'claude')
    .find((entry) => entry.startsWith('mcp__') && entry.endsWith('__*'));
  return wildcard ? `${wildcard.slice(0, -3)}__${tool}` : null;
}

function policyEntries(section: McSection, tools: string[]): Array<{
  pattern: string;
  decision: McToolPolicyDecision;
}> {
  const entries: Array<{ pattern: string; decision: McToolPolicyDecision }> = [];
  for (const server of tools) {
    const policy = section.tool_policy?.[server];
    if (!policy) continue;
    for (const [tool, decision] of Object.entries(policy)) {
      const pattern = policyToolPattern(server, tool);
      if (pattern) entries.push({ pattern, decision });
    }
  }
  return entries;
}

export function buildToolPolicyAdvisoryPrompt(section: McSection, tools: string[] = []): string {
  const entries = policyEntries(section, tools);
  const denied = entries.filter((entry) => entry.decision === 'deny').map((entry) => entry.pattern);
  const held = entries.filter((entry) => entry.decision === 'ask').map((entry) => entry.pattern);
  if (denied.length === 0 && held.length === 0) return '';
  return [
    'TOOL POLICY (advisory)',
    denied.length > 0 ? `Denied tools: ${denied.join(', ')}` : null,
    held.length > 0 ? `Held tools (ask): ${held.join(', ')}` : null,
    'This provider cannot enforce per-tool MCP policy. Do not call denied or held tools.',
  ].filter(Boolean).join('\n');
}

export const BOT_GATEWAY_SERVER_NAME = 'cloudcli-tool-gateway';

/** Bot runtime v2 routes a section's MCP tools through the Tool Gateway unless the bot opted out. */
export function shouldUseToolGateway(section: McSection): boolean {
  if (!isBotsRuntimeV2Enabled()) return false;
  try {
    return readBotRuntimeConfig(section.section_id)?.gateway !== false;
  } catch {
    return false;
  }
}

export function buildRuntimeOptions(section: McSection, tools: string[]): AnyRecord {
  const provider = section.provider;
  const useGateway = shouldUseToolGateway(section);
  const permissionMode = section.permission_mode || 'bypassPermissions';
  // Mission Control sections always run detached (no websocket/human on the
  // other end) — see startProviderRun's DETACHED_CONNECTION below. Providers
  // use this to fail fast on an interactive permission prompt instead of
  // hanging forever.
  const options: AnyRecord = { permissionMode, unattended: true };
  if (section.model) {
    options.model = section.model;
  }
  if (section.effort) {
    options.effort = section.effort;
  }
  if (useGateway) {
    // The gateway is the only MCP server the run may use; the real servers sit behind it.
    options.mcpServers = [BOT_GATEWAY_SERVER_NAME];
    options.strictMcpSelection = true;
    options.botGatewayStrict = true;
  } else if (tools.length > 0) {
    options.mcpServers = tools;
  }

  const expandedTools = expandMcpSelectionsToTools(useGateway ? [BOT_GATEWAY_SERVER_NAME] : tools, provider);
  const entries = policyEntries(section, tools);
  const policyServers = new Set(
    tools.filter((server) => Object.keys(section.tool_policy?.[server] ?? {}).length > 0),
  );
  const fallbackTools = useGateway
    ? ['mcp__cloudcli-tool-gateway__*']
    : expandMcpSelectionsToTools(
      tools.filter((server) => !policyServers.has(server)),
      provider,
    );
  const allowedPolicyTools = entries
    .filter((entry) => entry.decision === 'allow')
    .map((entry) => entry.pattern);
  const deniedPolicyTools = entries
    .filter((entry) => entry.decision === 'deny')
    .map((entry) => entry.pattern);
  const hasRestrictedPolicy = policyServers.size > 0;
  const effectivePermissionMode =
    provider === 'claude' && permissionMode === 'bypassPermissions' && hasRestrictedPolicy
      ? 'default'
      : permissionMode;
  options.permissionMode = effectivePermissionMode;

  switch (provider) {
    case 'claude':
      options.toolsSettings = {
        // Ask tools are intentionally omitted from allowedTools. Restricted
        // policies also downgrade bypassPermissions above, so Claude's
        // unattended default mode cannot auto-allow omitted tools.
        allowedTools: [...new Set(useGateway ? fallbackTools : [...fallbackTools, ...allowedPolicyTools])],
        // Mission Control runs are always headless (no human on the other
        // end to answer). AskUserQuestion/ExitPlanMode must never be reached:
        // deny them outright instead of stalling on an approval nobody can
        // grant. Prompts already instruct the model to ask via plain text.
        disallowedTools: [...new Set(['AskUserQuestion', 'ExitPlanMode', ...deniedPolicyTools])],
        skipPermissions: effectivePermissionMode === 'bypassPermissions',
      };
      break;
    case 'cursor':
      options.toolsSettings = {
        allowedTools: expandedTools,
        // Cursor's tool settings are advisory; its runtime does not enforce
        // per-tool MCP allow/ask/deny decisions. The policy is repeated in the prompt.
        disallowedTools: ['AskUserQuestion', 'ExitPlanMode'],
        skipPermissions: permissionMode === 'bypassPermissions',
      };
      break;
    case 'grok':
      options.toolsSettings = {
        allowedCommands: expandedTools,
        disallowedCommands: [],
      };
      break;
    default:
      break;
  }
  return options;
}

export type McAgentRunResult = {
  appSessionId: string;
  runId: string;
  text: string;
  /** False when the provider run itself failed (non-zero exit), e.g. API errors. */
  success: boolean;
  /** Provider/runtime error text when the run failed, otherwise null. */
  errorMessage: string | null;
  /**
   * Bot runtime v2 provider failover: every attempt in order (the primary first). Only present when
   * the bot has `routing.fallback` entries; each attempt is its own agent run.
   */
  attempts?: McAgentAttempt[];
};

export type McAgentAttempt = {
  runId: string | null;
  provider: string;
  model: string | null;
  success: boolean;
  /** Why this attempt was abandoned for the next fallback (absent on the last attempt). */
  failoverReason?: FailoverReason;
};

/** `meta.fallback_from` on a fallback attempt's agent run. */
export type McFallbackFrom = {
  run_id: string | null;
  provider: string;
  model: string | null;
  reason: FailoverReason;
  detail: string;
  attempt: number;
};

/**
 * Headless provider run via CloudCLI's shared startProviderRun path.
 * Creates a fresh app session, awaits completion, and returns the assistant
 * text plus a success flag: `success: false` means the provider runtime
 * itself failed (API error, CLI crash), so `text` is an error dump rather
 * than model output and callers should not turn it into queue items.
 */
/**
 * The section as seen by one pipeline stage: Resolve may run on its own
 * agent/model/effort; everything else uses the Propose agent.
 */
export function sectionForPhase(section: McSection, phase?: string): McSection {
  if (phase !== 'resolve' || !section.resolve_provider) return section;
  return { ...section, provider: section.resolve_provider, model: section.resolve_model, effort: section.resolve_effort };
}

export type RunMissionControlAgentParams = {
  section: McSection;
  prompt: string;
  tools: string[];
  sourceRef?: string;
  trigger?: string;
  phase?: 'produce' | 'resolve' | 'retry' | 'architect';
  /** Bot runtime v2 episode this run belongs to (bound to the gateway session for taint tracking). */
  episodeId?: string;
  /** Called once the canonical run exists (before the provider starts) so callers can abort it. */
  onRunCreated?: (run: { runId: string; appSessionId: string }) => void;
};

const MAX_FALLBACK_ATTEMPTS = 5;

function sameAgent(a: McSection, b: McSection): boolean {
  return a.provider === b.provider && (a.model ?? null) === (b.model ?? null) && (a.effort ?? null) === (b.effort ?? null);
}

/** The section as seen by one fallback route; a same-provider route inherits model/effort it leaves unset. */
function sectionForFallback(base: McSection, route: { provider: string; model?: string; effort?: string }): McSection {
  const same = route.provider === base.provider;
  return {
    ...base,
    provider: route.provider as McSection['provider'],
    model: route.model ?? (same ? base.model : null),
    effort: route.effort ?? (same ? base.effort : null),
  };
}

/** Ordered fallback agents for a section (runtime flag on), minus any identical to the primary. */
function fallbackSections(primary: McSection): McSection[] {
  let routes: Array<{ provider: string; model?: string; effort?: string }> = [];
  try {
    routes = readBotRuntimeConfig(primary.section_id)?.routing?.fallback ?? [];
  } catch {
    return [];
  }
  const chain: McSection[] = [];
  let previous = primary;
  for (const route of routes.slice(0, MAX_FALLBACK_ATTEMPTS)) {
    const candidate = sectionForFallback(primary, route);
    if (sameAgent(candidate, previous)) continue;
    chain.push(candidate);
    previous = candidate;
  }
  return chain;
}

const TOOL_EVENT_PAGE = 500;
const TOOL_EVENT_MAX_PAGES = 40;

/** Names of every `tool.call` event recorded for a run (paged, bounded). */
function recordedToolNames(runId: string): unknown[] {
  const names: unknown[] = [];
  let afterSeq = 0;
  for (let page = 0; page < TOOL_EVENT_MAX_PAGES; page += 1) {
    const events = runService.listEvents(runId, { afterSeq, limit: TOOL_EVENT_PAGE });
    for (const event of events) {
      if (event.type === 'tool.call') names.push(event.payload?.tool ?? null);
    }
    if (events.length < TOOL_EVENT_PAGE) return names;
    afterSeq = events[events.length - 1].seq ?? afterSeq;
  }
  // More events than we are willing to scan: assume the run acted.
  names.push(null);
  return names;
}

/**
 * True when the failed run may already have acted; retrying on another provider could repeat it.
 * Combines the Action Gate's decision rows (any non-read call that was allowed or approved,
 * including built-in and first-party bot__ calls) with the run's recorded tool calls (native
 * Bash/Write/Edit/WebFetch..., first-party writes that bypass the gate). Unknown is "maybe".
 */
function failedRunHadSideEffects(botId: string, runId: string | null): boolean {
  if (!runId) return false;
  try {
    const run = runService.get(runId);
    return runShowsSideEffects({
      provider: String(run?.provider ?? ''),
      decisions: botGateDecisionsDb
        .listForBot(botId, 2000)
        .filter((decision) => decision.run_id === runId)
        .map((decision) => ({ decision: decision.decision, outcome: decision.outcome, risk: decision.risk })),
      toolNames: recordedToolNames(runId),
    });
  } catch {
    // Unknown is treated as "maybe": never risk a duplicate send on a failed diagnostic.
    return true;
  }
}

function wasAborted(runId: string | null): boolean {
  if (!runId) return false;
  try {
    return runService.get(runId)?.status === 'aborted';
  } catch {
    return false;
  }
}

/**
 * Headless provider run. With the bot runtime flag on and `routing.fallback` configured, a run
 * that fails on an auth failure, rate/usage limit or unavailable provider is retried once per
 * fallback entry in order (each attempt is its own agent run carrying `meta.fallback_from`) and
 * stops at the first success. A normal task failure, a gate denial, an aborted run, or a failed
 * run that already executed a write-class tool never falls over.
 */
export async function runMissionControlAgent(params: RunMissionControlAgentParams): Promise<McAgentRunResult> {
  const primary = sectionForPhase(params.section, params.phase);
  const chain = isBotsRuntimeV2Enabled() ? fallbackSections(primary) : [];
  if (chain.length === 0) return runAgentAttempt(params, { section: primary });

  const attempts: McAgentAttempt[] = [];
  const all = [primary, ...chain];
  let fallbackFrom: McFallbackFrom | undefined;
  let lastResult: McAgentRunResult | null = null;
  let lastError: unknown;
  let hasError = false;

  for (let index = 0; index < all.length; index += 1) {
    const section = all[index];
    let runId: string | null = null;
    const attemptParams: RunMissionControlAgentParams = {
      ...params,
      onRunCreated: (run) => {
        runId = run.runId;
        params.onRunCreated?.(run);
      },
    };
    let classification: ReturnType<typeof classifyFailoverFailure> = null;
    try {
      const result = await runAgentAttempt(attemptParams, { section, fallbackFrom });
      lastResult = result;
      hasError = false;
      attempts.push({ runId: result.runId, provider: section.provider, model: section.model ?? null, success: result.success });
      if (result.success) return { ...result, attempts };
      classification = classifyFailoverFailure(section.provider, result.errorMessage);
    } catch (error) {
      lastError = error;
      hasError = true;
      attempts.push({ runId, provider: section.provider, model: section.model ?? null, success: false });
      classification = classifyFailoverError(section.provider, error);
    }

    const last = index === all.length - 1;
    if (!classification || last || wasAborted(runId) || failedRunHadSideEffects(primary.section_id, runId)) break;
    attempts[attempts.length - 1].failoverReason = classification.reason;
    fallbackFrom = {
      run_id: runId ?? lastResult?.runId ?? null,
      provider: section.provider,
      model: section.model ?? null,
      reason: classification.reason,
      detail: classification.detail,
      attempt: index + 1,
    };
  }

  if (hasError) throw lastError;
  return { ...(lastResult as McAgentRunResult), attempts };
}

async function runAgentAttempt(
  params: RunMissionControlAgentParams,
  attempt: { section: McSection; fallbackFrom?: McFallbackFrom },
): Promise<McAgentRunResult> {
  const { prompt, tools } = params;
  const section = attempt.section;
  const provider = section.provider as LLMProvider;
  const spawnFn = runtimeSpawnFns[provider];
  if (!spawnFn) {
    throw new AppError(`Provider "${provider}" runtime is not available`, {
      code: 'MC_RUNTIME_UNAVAILABLE',
      statusCode: 400,
    });
  }

  const projectPath = resolveProjectPath(section);
  // Produce/resolve/workshop turns are headless automation. Keep their app
  // sessions out of the interactive session picker and provider watcher
  // adoption path; they must never be mistaken for the selected chat's run.
  const created = sessionsService.createAppSession(provider, projectPath, { internal: true });
  const appSessionId = created.sessionId;
  const persistedSection = missionControlDb.getSection(section.section_id);
  const botVersion = persistedSection ? recordSectionVersion(persistedSection, 'baseline').version : null;

  const canonicalRun = runService.create({
    source: 'mission_control',
    projectId: section.project_id,
    sourceRef: params.sourceRef ?? section.section_id,
    appSessionId,
    provider,
    model: section.model,
    permissionMode: section.permission_mode,
    title: section.title,
    trigger: params.trigger ?? 'manual',
    meta: {
      section_id: section.section_id,
      ...(botVersion != null ? { bot_version: botVersion } : {}),
      ...(params.sourceRef && params.sourceRef !== section.section_id ? { item_id: params.sourceRef } : {}),
      phase: params.phase ?? 'produce',
      ...(params.episodeId ? { runtime: 'v2', episode_id: params.episodeId } : {}),
      ...(attempt.fallbackFrom ? { fallback_from: attempt.fallbackFrom } : {}),
    },
  });
  params.onRunCreated?.({ runId: canonicalRun.run_id, appSessionId });

  // Bot runtime v2: bind this app session to its bot so the Tool Gateway (spawned by the
  // provider as a stdio child) knows which servers and gate context apply. Unbound in finally.
  const gatewayBound = shouldUseToolGateway(section);
  if (gatewayBound) {
    gatewaySessions.bind(appSessionId, {
      botId: section.section_id,
      episodeId: params.episodeId,
      runId: canonicalRun.run_id,
      servers: tools,
      provider,
    });
  }
  // Gateway-bound runs also route Claude's built-in tools through the gate and prove their
  // binding with a per-run secret (see gateway/ENFORCEMENT.md).
  const runOptions = buildRuntimeOptions(section, tools);
  if (gatewayBound) {
    const guards = buildGatewayRunGuards(section, { appSessionId, episodeId: params.episodeId, runId: canonicalRun.run_id, projectPath });
    runOptions.builtinToolGate = guards.builtinToolGate;
    runOptions.botGatewaySecret = guards.bindingSecret;
  }
  try {
    let result: Awaited<ReturnType<typeof startProviderRun>>;
    try {
      runService.updateStatus(canonicalRun.run_id, 'starting');
      result = await startProviderRun({
        appSessionId,
        provider,
        providerSessionId: null,
        projectPath,
        spawnFn,
        content: ['codex', 'grok', 'opencode', 'kimi', 'cursor'].includes(provider)
          ? [prompt, buildToolPolicyAdvisoryPrompt(section, tools)].filter(Boolean).join('\n\n')
          : prompt,
        options: runOptions,
        connection: DETACHED_CONNECTION,
        userId: null,
        onEvent: (message) => recordNormalizedRunEvent(canonicalRun.run_id, message, 'mission_control'),
      });
    } catch (error) {
      runService.markTerminal(canonicalRun.run_id, {
        status: 'failed',
        errorSummary: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (!result.ok) {
      runService.markTerminal(canonicalRun.run_id, {
        status: 'failed',
        errorSummary: 'A run is already in progress for this session',
      });
      throw new AppError('A run is already in progress for this session', {
        code: 'MC_RUN_IN_PROGRESS',
        statusCode: 409,
      });
    }

    runService.linkSession(canonicalRun.run_id, appSessionId);
    if (runService.get(canonicalRun.run_id)?.status === 'starting') {
      runService.updateStatus(canonicalRun.run_id, 'running');
    }

    await result.completion;
    const { text, failed, errorMessage } = extractRunOutcome(appSessionId);
    return { appSessionId, runId: canonicalRun.run_id, text, success: !failed, errorMessage };
  } finally {
    if (gatewayBound) gatewaySessions.unbind(appSessionId);
  }
}

/**
 * Best-effort cancel of a live Mission Control run (same path as the runs API cancel):
 * kill the provider process, complete the registry entry and flip the DB status.
 */
export async function abortMissionControlRun(runId: string): Promise<void> {
  const run = runService.get(runId);
  if (!run) return;
  const appSessionId = run.app_session_id;
  const registryRun = appSessionId ? chatRunRegistry.getRun(appSessionId) : undefined;
  if (appSessionId && registryRun && registryRun.status === 'running') {
    const abortFn = run.provider ? getProviderAbortFn(run.provider) : undefined;
    let success = false;
    if (abortFn) {
      try {
        success = Boolean(await abortFn(registryRun.providerSessionId || appSessionId));
      } catch (error) {
        console.error(`[MissionControl] provider abort failed for run ${runId}:`, error);
      }
    }
    chatRunRegistry.completeRun(appSessionId, { exitCode: success ? 0 : 1, aborted: true });
  }
  const current = runService.get(runId);
  if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
    try {
      runService.markTerminal(runId, { status: 'aborted', errorSummary: 'aborted by bot kernel (episode timeout)' });
    } catch {
      // already terminal
    }
  }
}

export function buildProducePrompt(section: McSection): string {
  const now = new Date().toISOString();
  const memory = missionControlDb.getSection(section.section_id) ? approvedMemoryContext(section.section_id) : '';
  return `Current time (ISO 8601): ${now}\n\n${section.produce_prompt}${memory ? `\n\n${memory}` : ''}\n\n${PRODUCE_ENVELOPE}`;
}

export function buildResolvePrompt(
  section: McSection,
  actionId: string,
  actionLabel: string,
  body: Record<string, unknown>,
): string {
  return (
    `${section.resolve_prompt}\n\n` +
    `Action invoked: "${actionId}" (${actionLabel})\n\n` +
    `Approved item fields (JSON):\n${JSON.stringify(body)}\n\n` +
    'Perform the action, then return ONLY a JSON object describing the result.'
  );
}
