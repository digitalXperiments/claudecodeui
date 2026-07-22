import os from 'node:os';

import { projectsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import type { McSection } from '@/modules/mission-control/mission-control.types.js';

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function configureMissionControlRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

const PRODUCE_ENVELOPE =
  'Return ONLY a JSON array of items, each exactly ' +
  '{ "title": string, "summary": string, "body": object, "dedupeKey": string (a STABLE source id), "confidence": number }. ' +
  'No prose, no code fences.';

function stripCodeFences(text: string): string {
  return text.replace(/^```[\w]*\n?/gm, '').replace(/^```$/gm, '').trim();
}

function findBalancedJson(text: string): string {
  const startIdx = text.search(/[{[]/);
  if (startIdx === -1) {
    throw new Error('no JSON object or array found in text');
  }
  const open = text[startIdx];
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
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  throw new Error('unbalanced JSON in agent output');
}

export function parseJsonFromAgentText(raw: string): unknown {
  const cleaned = stripCodeFences(raw.trim());
  try {
    return JSON.parse(cleaned);
  } catch {
    const slice = findBalancedJson(cleaned);
    return JSON.parse(slice);
  }
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

/**
 * Expand selected MCP server names into provider tool allow-list entries.
 * Values that already look like tool patterns (mcp__, Bash(, etc.) are kept as-is.
 */
export function expandMcpSelectionsToTools(selections: string[], provider: string): string[] {
  const out = new Set<string>();
  for (const raw of selections) {
    const entry = raw.trim();
    if (!entry) continue;
    if (
      entry.startsWith('mcp__') ||
      entry.startsWith('Bash(') ||
      entry.includes('*') ||
      entry.includes('(')
    ) {
      out.add(entry);
      continue;
    }
    // Normalize server display names into Claude-style MCP tool prefixes.
    // Claude tool names look like mcp__Server_Name__tool_name.
    const normalized = entry.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!normalized) continue;
    if (provider === 'claude' || provider === 'cursor') {
      out.add(`mcp__${normalized}`);
      out.add(`mcp__${normalized}__*`);
    } else {
      // Other providers typically key MCP by server name or free-form allow list.
      out.add(entry);
      out.add(normalized);
    }
  }
  return [...out];
}

function buildRuntimeOptions(section: McSection, tools: string[]): AnyRecord {
  const provider = section.provider;
  const permissionMode = section.permission_mode || 'bypassPermissions';
  const options: AnyRecord = { permissionMode };
  if (section.model) {
    options.model = section.model;
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

  const result = startProviderRun({
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
