import os from 'node:os';

import { projectsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
// Import mission-control-agent.service directly (not the barrel) — the barrel
// re-exports mission-control-runner.service, which imports the kanban barrel,
// which would create a kanban <-> mission-control circular load path.
// eslint-disable-next-line boundaries/dependencies
import { extractRunOutcome, parseJsonFromAgentText } from '@/modules/mission-control/mission-control-agent.service.js';
import {
  getKanbanSpawnFn,
} from '@/modules/kanban/kanban-runner.service.js';
import { isKanbanProvider } from '@/modules/kanban/kanban.types.js';
import { DETACHED_CONNECTION, startProviderRun } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { resolveProviderAuthFailure } from '@/shared/provider-auth-failure.js';

export type GenerateTaskFieldsInput = {
  title: string;
  /** Optional seed notes the model should expand. */
  notes?: string;
  /** Existing description to refine (optional). */
  description?: string;
  /** Existing prompt to refine (optional). */
  prompt?: string;
  provider: LLMProvider;
  /** Optional project — used only as cwd/context for the provider session. */
  projectId?: string | null;
};

export type GenerateTaskFieldsResult = {
  description: string;
  prompt: string;
  provider: LLMProvider;
  appSessionId: string;
};

/**
 * Instruction handed to the provider. Asks for structured JSON only so we can
 * fill both TaskEditor fields without a second round-trip.
 */
export function buildGenerateTaskFieldsPrompt(input: {
  title: string;
  notes?: string;
  description?: string;
  prompt?: string;
}): string {
  const parts = [
    'You are drafting a Kanban engineering task for an autonomous coding agent.',
    'Do NOT use tools. Do NOT edit files. Reply with JSON only — no markdown fences, no preamble.',
    '',
    'Return exactly this shape:',
    '{',
    '  "description": string,',
    '  "prompt": string',
    '}',
    '',
    '## Field requirements',
    '',
    '### description',
    'Exhaustive human-readable task brief (markdown ok). Include when inferable:',
    '- Problem / goal and why it matters',
    '- Scope: in-scope and out-of-scope',
    '- Acceptance criteria (checklist)',
    '- Edge cases and constraints',
    '- Suggested approach or touch-points (files/areas) if you can guess from the title/notes',
    '- How to verify (tests, manual checks)',
    'Be specific and complete; prefer over-explaining over vague bullets.',
    '',
    '### prompt',
    'Implementation instructions the coding agent will receive on run. Must be',
    'actionable and self-contained: goal, requirements, steps, verification,',
    'and explicit "done when" criteria. Write in second person ("Implement…").',
    'Do not wrap the whole prompt in JSON or code fences.',
    '',
    '## Task input',
    `Title: ${input.title.trim()}`,
  ];

  if (input.notes?.trim()) {
    parts.push('', 'User notes:', input.notes.trim());
  }
  if (input.description?.trim()) {
    parts.push('', 'Existing description (refine/expand, do not discard useful detail):', input.description.trim());
  }
  if (input.prompt?.trim()) {
    parts.push('', 'Existing prompt (refine/expand, do not discard useful detail):', input.prompt.trim());
  }

  parts.push('', 'Return the JSON object now.');
  return parts.join('\n');
}

function buildHeadlessOptions(provider: LLMProvider): AnyRecord {
  // Headless text-only generation: no tools, plan/default where possible.
  const options: AnyRecord = {
    permissionMode: provider === 'claude' || provider === 'cursor' || provider === 'pi'
      ? 'plan'
      : 'default',
  };
  switch (provider) {
    case 'claude':
    case 'cursor':
      options.toolsSettings = {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      };
      break;
    case 'grok':
      options.toolsSettings = {
        allowedCommands: [],
        disallowedCommands: [],
      };
      break;
    default:
      break;
  }
  return options;
}

function resolveProjectPath(projectId?: string | null): string {
  if (projectId) {
    const path = projectsDb.getProjectPathById(projectId);
    if (path) return path;
  }
  return os.homedir();
}

function coerceGeneratedFields(raw: unknown): { description: string; prompt: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Generator did not return a JSON object', {
      code: 'KANBAN_GENERATE_BAD_SHAPE',
      statusCode: 502,
    });
  }
  const o = raw as Record<string, unknown>;
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  if (!description && !prompt) {
    throw new AppError('Generator returned empty description and prompt', {
      code: 'KANBAN_GENERATE_EMPTY',
      statusCode: 502,
    });
  }
  return {
    description: description || prompt,
    prompt: prompt || description,
  };
}

/**
 * Headless one-shot: ask the selected provider to expand a task title into an
 * exhaustive description + implementer prompt for the TaskEditor.
 */
export async function generateTaskFields(
  input: GenerateTaskFieldsInput,
): Promise<GenerateTaskFieldsResult> {
  const title = input.title?.trim();
  if (!title) {
    throw new AppError('title is required', {
      code: 'KANBAN_TITLE_REQUIRED',
      statusCode: 400,
    });
  }
  if (!isKanbanProvider(input.provider)) {
    throw new AppError(`Invalid provider: ${String(input.provider)}`, {
      code: 'KANBAN_INVALID_PROVIDER',
      statusCode: 400,
    });
  }

  const spawnFn = getKanbanSpawnFn(input.provider);
  if (!spawnFn) {
    throw new AppError(`Provider "${input.provider}" runtime is not available`, {
      code: 'KANBAN_RUNTIME_UNAVAILABLE',
      statusCode: 400,
    });
  }

  const projectPath = resolveProjectPath(input.projectId);
  const created = sessionsService.createAppSession(input.provider, projectPath);
  const appSessionId = created.sessionId;

  const content = buildGenerateTaskFieldsPrompt({
    title,
    notes: input.notes,
    description: input.description,
    prompt: input.prompt,
  });

  const result = await startProviderRun({
    appSessionId,
    provider: input.provider,
    providerSessionId: null,
    projectPath,
    spawnFn,
    content,
    options: buildHeadlessOptions(input.provider),
    connection: DETACHED_CONNECTION,
    userId: null,
  });

  if (!result.ok) {
    throw new AppError('A run is already in progress for this session', {
      code: 'KANBAN_RUN_IN_PROGRESS',
      statusCode: 409,
    });
  }

  await result.completion;
  const { text, failed, errorMessage } = extractRunOutcome(appSessionId);
  if (failed) {
    const authFailure = resolveProviderAuthFailure(input.provider, errorMessage, text);
    throw new AppError(
      authFailure || errorMessage || text.slice(0, 500) || `Provider "${input.provider}" run failed`,
      {
        code: authFailure ? 'KANBAN_GENERATE_AUTH' : 'KANBAN_GENERATE_FAILED',
        statusCode: authFailure ? 401 : 502,
      },
    );
  }
  if (!text.trim()) {
    throw new AppError('Generator returned no text', {
      code: 'KANBAN_GENERATE_EMPTY',
      statusCode: 502,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseJsonFromAgentText(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Unparseable output is often a provider auth dump rather than bad JSON.
    const authFailure = resolveProviderAuthFailure(input.provider, errorMessage, text);
    if (authFailure) {
      throw new AppError(authFailure, { code: 'KANBAN_GENERATE_AUTH', statusCode: 401 });
    }
    throw new AppError(`Failed to parse generator output: ${message}`, {
      code: 'KANBAN_GENERATE_PARSE',
      statusCode: 502,
    });
  }

  const fields = coerceGeneratedFields(parsed);
  return {
    description: fields.description,
    prompt: fields.prompt,
    provider: input.provider,
    appSessionId,
  };
}
