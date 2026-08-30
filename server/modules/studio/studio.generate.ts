import { getKanbanSpawnFn } from '@/modules/kanban/index.js';
import { extractRunOutcome, parseJsonFromAgentText } from '@/modules/mission-control/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { getStudioSeats } from '@/modules/studio/studio.profiles.js';
import type {
  StudioGenerateFn,
  StudioGenerateRequest,
  StudioGenerateResult,
  StudioSelectedElement,
} from '@/modules/studio/studio.types.js';
import { DETACHED_CONNECTION, startProviderRun, type ProviderSpawnFn } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export const VARIANT_DIRECTIONS: Array<{ label: string; direction: string }> = [
  {
    label: 'Warm editorial',
    direction:
      'Warm editorial magazine: serif headlines, cream paper, generous whitespace, tactile type, restrained accent.',
  },
  {
    label: 'Dense dashboard',
    direction:
      'Dense product dashboard: tight grid, tabular data, utility chrome, compact density, information-first.',
  },
  {
    label: 'Brutalist contrast',
    direction:
      'Brutalist high-contrast: stark black/white, oversized type, hard edges, no shadows, poster-like hierarchy.',
  },
  {
    label: 'Soft consumer',
    direction:
      'Soft consumer app: pastel surfaces, large rounded cards, friendly copy, lots of breathing room.',
  },
  {
    label: 'Dark cinematic',
    direction:
      'Dark cinematic: near-black canvas, emissive accent, filmic spacing, glowing highlights.',
  },
];

let injectedGenerate: StudioGenerateFn | null = null;
let studioSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function setStudioGenerateFn(fn: StudioGenerateFn | null): void {
  injectedGenerate = fn;
}

export function configureStudioRuntimes(spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>): void {
  studioSpawnFns = spawnFns;
}

export function formatSelectedElement(element: StudioSelectedElement | null | undefined): string {
  if (!element?.tag) return '';
  const classes = element.classes?.filter(Boolean).join('.') ?? '';
  const path = element.path?.trim() ?? '';
  const text = element.text?.trim() ?? '';
  return [
    `tag: ${element.tag}`,
    classes ? `classes: ${classes}` : '',
    path ? `path: ${path}` : '',
    text ? `text: ${text.slice(0, 280)}` : '',
  ].filter(Boolean).join('\n');
}

export function buildGenerationPrompt(input: StudioGenerateRequest): string {
  const historyLines = input.history.map((entry, index) => {
    const n = index + 1;
    return `${n}. [${entry.kind}] ${entry.message}`;
  });
  const selected = formatSelectedElement(input.selectedElement);
  const variantBlock = input.variantDirection
    ? [
        '## Variant direction',
        `Label: ${input.variantDirection.label}`,
        input.variantDirection.direction,
        'Keep the same information architecture and copy intent as the parent.',
        'Make the visual treatment DISTINCT from the parent HTML.',
      ].join('\n')
    : '';

  return [
    'You are editing an existing self-contained HTML prototype in CloudCLI Design Studio.',
    'Do NOT start from scratch. Do NOT use tools. Do NOT edit files on disk.',
    'Apply the latest user request as a focused EDIT to the parent HTML.',
    'Preserve working interactions (in-page navigation, forms, toasts) unless the user asked to change them.',
    'Honor the design tokens exactly — map them onto CSS custom properties in :root.',
    input.skills.length ? `Also follow these skills: ${input.skills.join(', ')}.` : '',
    '',
    'Return ONLY JSON (no markdown fences, no preamble) with this shape:',
    '{ "html": string, "notes": string, "handoff": string }',
    '`html` is a full self-contained document (inline CSS + JS).',
    '`notes` is markdown IA / tokens / open questions.',
    '`handoff` is markdown for an implementer building the real app.',
    '',
    `Title: ${input.title}`,
    '',
    '## Brief',
    input.brief,
    '',
    '## Conversation history (oldest first)',
    historyLines.join('\n') || '(none)',
    '',
    '## Latest user request',
    input.message,
    '',
    '## Design tokens',
    JSON.stringify(input.tokens, null, 2),
    '',
    selected ? `## Selected element (primary edit target)\n${selected}` : '',
    variantBlock,
    '',
    '## Parent HTML (edit this; do not regenerate from zero)',
    '```html',
    input.parentHtml,
    '```',
    '',
    '## Parent notes.md',
    input.parentNotes,
    '',
    '## Parent handoff.md',
    input.parentHandoff,
    '',
    'Return the JSON object now.',
  ].filter((line) => line !== '').join('\n');
}

function coerceGenerateResult(raw: unknown, fallbackNotes: string, fallbackHandoff: string): StudioGenerateResult {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/<!doctype html|<html/i.test(trimmed)) {
      return { html: trimmed, notes: fallbackNotes, handoff: fallbackHandoff };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Generator did not return a JSON object', {
      code: 'STUDIO_GENERATE_BAD_SHAPE',
      statusCode: 502,
    });
  }
  const row = raw as Record<string, unknown>;
  const html = typeof row.html === 'string' ? row.html.trim() : '';
  if (!html) {
    throw new AppError('Generator returned empty html', {
      code: 'STUDIO_GENERATE_EMPTY',
      statusCode: 502,
    });
  }
  return {
    html,
    notes: typeof row.notes === 'string' && row.notes.trim() ? row.notes : fallbackNotes,
    handoff: typeof row.handoff === 'string' && row.handoff.trim() ? row.handoff : fallbackHandoff,
  };
}

function parseGenerateText(text: string, fallbackNotes: string, fallbackHandoff: string): StudioGenerateResult {
  const trimmed = text.trim();
  if (/^<!doctype html|^<html/i.test(trimmed)) {
    return { html: trimmed, notes: fallbackNotes, handoff: fallbackHandoff };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonFromAgentText(trimmed);
  } catch {
    const htmlMatch = trimmed.match(/<!doctype html[\s\S]*<\/html>/i) ?? trimmed.match(/<html[\s\S]*<\/html>/i);
    if (htmlMatch) {
      return { html: htmlMatch[0], notes: fallbackNotes, handoff: fallbackHandoff };
    }
    throw new AppError('Failed to parse generator output', {
      code: 'STUDIO_GENERATE_PARSE',
      statusCode: 502,
    });
  }
  return coerceGenerateResult(parsed, fallbackNotes, fallbackHandoff);
}

function buildHeadlessOptions(provider: LLMProvider): AnyRecord {
  const options: AnyRecord = {
    permissionMode: provider === 'claude' || provider === 'cursor' || provider === 'pi' || provider === 'omp'
      ? 'plan'
      : 'default',
    unattended: true,
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

function resolveStudioProvider(): { provider: LLMProvider; model: string | null } {
  const builder = getStudioSeats().find((seat) => seat.id === 'builder');
  const provider = (builder?.provider ?? 'claude') as LLMProvider;
  return { provider, model: builder?.model ?? null };
}

function getStudioSpawnFn(provider: LLMProvider): ProviderSpawnFn | undefined {
  return studioSpawnFns[provider] ?? getKanbanSpawnFn(provider);
}

export async function defaultStudioGenerate(input: StudioGenerateRequest): Promise<StudioGenerateResult> {
  const { provider, model } = resolveStudioProvider();
  const spawnFn = getStudioSpawnFn(provider);
  if (!spawnFn) {
    throw new AppError(`Provider "${provider}" runtime is not available`, {
      code: 'STUDIO_RUNTIME_UNAVAILABLE',
      statusCode: 400,
    });
  }

  const created = sessionsService.createAppSession(provider, input.projectPath);
  const appSessionId = created.sessionId;
  const content = buildGenerationPrompt(input);
  const options = buildHeadlessOptions(provider);
  if (model) options.model = model;

  const result = await startProviderRun({
    appSessionId,
    provider,
    providerSessionId: null,
    projectPath: input.projectPath,
    spawnFn,
    content,
    options,
    connection: DETACHED_CONNECTION,
    userId: null,
  });

  if (!result.ok) {
    throw new AppError('A run is already in progress for this session', {
      code: 'STUDIO_GENERATE_BUSY',
      statusCode: 409,
    });
  }

  await result.completion;
  const { text, failed, errorMessage } = extractRunOutcome(appSessionId);
  if (failed) {
    throw new AppError(errorMessage || text.slice(0, 500) || 'Studio generation failed', {
      code: 'STUDIO_GENERATE_FAILED',
      statusCode: 502,
    });
  }
  if (!text.trim()) {
    throw new AppError('Generator returned no text', {
      code: 'STUDIO_GENERATE_EMPTY',
      statusCode: 502,
    });
  }
  return parseGenerateText(text, input.parentNotes, input.parentHandoff);
}

export async function runStudioGenerate(input: StudioGenerateRequest): Promise<StudioGenerateResult> {
  const fn = injectedGenerate ?? defaultStudioGenerate;
  return fn(input);
}
