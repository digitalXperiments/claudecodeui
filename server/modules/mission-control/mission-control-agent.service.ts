import os from 'node:os';

import { jsonrepair } from 'jsonrepair';

import { projectsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { expandMcpSelectionsToTools } from '@/shared/mcp-tool-expand.js';
import { AppError } from '@/shared/utils.js';
import type { McSection } from '@/modules/mission-control/mission-control.types.js';

export { expandMcpSelectionsToTools };

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function configureMissionControlRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

const PRODUCE_ENVELOPE =
  'Return ONLY a JSON array of items, each exactly ' +
  '{ "title": string, "summary": string, "body": object, "dedupeKey": string (a STABLE source id), "confidence": number }. ' +
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
  // Global sections run from the user home by default (MCP / personal tools).
  return os.homedir();
}

function buildRuntimeOptions(section: McSection, tools: string[]): AnyRecord {
  const provider = section.provider;
  const permissionMode = section.permission_mode || 'bypassPermissions';
  // Mission Control sections always run detached (no websocket/human on the
  // other end) — see startProviderRun's DETACHED_CONNECTION below. Providers
  // use this to fail fast on an interactive permission prompt instead of
  // hanging forever.
  const options: AnyRecord = { permissionMode, unattended: true };
  if (section.model) {
    options.model = section.model;
  }
  if (tools.length > 0) {
    options.mcpServers = tools;
  }

  const expandedTools = expandMcpSelectionsToTools(tools, provider);

  switch (provider) {
    case 'claude':
    case 'cursor':
      options.toolsSettings = {
        allowedTools: expandedTools,
        disallowedTools: [],
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
  text: string;
  /** False when the provider run itself failed (non-zero exit), e.g. API errors. */
  success: boolean;
  /** Provider/runtime error text when the run failed, otherwise null. */
  errorMessage: string | null;
};

/**
 * Headless provider run via CloudCLI's shared startProviderRun path.
 * Creates a fresh app session, awaits completion, and returns the assistant
 * text plus a success flag: `success: false` means the provider runtime
 * itself failed (API error, CLI crash), so `text` is an error dump rather
 * than model output and callers should not turn it into queue items.
 */
export async function runMissionControlAgent(params: {
  section: McSection;
  prompt: string;
  tools: string[];
}): Promise<McAgentRunResult> {
  const { section, prompt, tools } = params;
  const provider = section.provider as LLMProvider;
  const spawnFn = runtimeSpawnFns[provider];
  if (!spawnFn) {
    throw new AppError(`Provider "${provider}" runtime is not available`, {
      code: 'MC_RUNTIME_UNAVAILABLE',
      statusCode: 400,
    });
  }

  const projectPath = resolveProjectPath(section);
  const created = sessionsService.createAppSession(provider, projectPath);
  const appSessionId = created.sessionId;

  const result = await startProviderRun({
    appSessionId,
    provider,
    providerSessionId: null,
    projectPath,
    spawnFn,
    content: prompt,
    options: buildRuntimeOptions(section, tools),
    connection: DETACHED_CONNECTION,
    userId: null,
  });

  if (!result.ok) {
    throw new AppError('A run is already in progress for this session', {
      code: 'MC_RUN_IN_PROGRESS',
      statusCode: 409,
    });
  }

  await result.completion;
  const { text, failed, errorMessage } = extractRunOutcome(appSessionId);
  return { appSessionId, text, success: !failed, errorMessage };
}

export function buildProducePrompt(section: McSection): string {
  const now = new Date().toISOString();
  if (section.mode === 'fire_and_forget') {
    return `Current time (ISO 8601): ${now}\n\n${section.produce_prompt}`;
  }
  return `Current time (ISO 8601): ${now}\n\n${section.produce_prompt}\n\n${PRODUCE_ENVELOPE}`;
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
