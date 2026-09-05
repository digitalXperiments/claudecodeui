import { TOOL_CONFIGS } from './configs/toolConfigs';

export type ToolPresentationKind = 'shell' | 'configured' | 'generic';

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'shell_command',
]);

const PREVIEW_KEYS = [
  'command',
  'cmd',
  'file_path',
  'path',
  'query',
  'pattern',
  'url',
  'name',
] as const;

const DEFAULT_PREVIEW_LENGTH = 120;

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncatePreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(' ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

export function getToolPresentationKind(toolName: string): ToolPresentationKind {
  if (isShellToolName(toolName)) return 'shell';
  if (Object.prototype.hasOwnProperty.call(TOOL_CONFIGS, toolName) && toolName !== 'Default') {
    return 'configured';
  }
  return 'generic';
}

export function usesIntegratedToolResult(toolName: string): boolean {
  const kind = getToolPresentationKind(toolName);
  return kind === 'shell' || kind === 'generic';
}

export function extractShellCommand(toolInput: unknown): string {
  const parsed = parseJsonValue(toolInput);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    return stringValue(record.command) || stringValue(record.cmd);
  }
  return typeof parsed === 'string' ? parsed : '';
}

/**
 * Produces a short, inert preview for a collapsed generic tool row. This only
 * inspects values and text; in particular, Codex `exec` JavaScript is never
 * evaluated.
 */
export function getSafeToolPreview(
  toolName: string,
  toolInput: unknown,
  maxLength = DEFAULT_PREVIEW_LENGTH,
): string {
  const parsed = parseJsonValue(toolInput);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of PREVIEW_KEYS) {
      const value = normalizeWhitespace(stringValue(record[key]));
      if (value) return truncatePreview(value, maxLength);
    }

    const keys = Object.keys(record).slice(0, 3);
    return keys.length > 0 ? truncatePreview(keys.join(', '), maxLength) : 'No parameters';
  }

  const text = normalizeWhitespace(stringValue(parsed));
  if (!text) return 'No parameters';

  // Codex orchestration calls are JavaScript snippets. A tool-name summary is
  // more useful than showing the code, and matching identifiers is safe because
  // the source is never executed or dynamically imported.
  if (toolName.trim().toLowerCase() === 'exec') {
    const calledTools = Array.from(text.matchAll(/\btools\.([A-Za-z_$][\w$]*)/g))
      .map((match) => match[1])
      .filter((name, index, names) => names.indexOf(name) === index)
      .slice(0, 3);
    if (calledTools.length > 0) {
      return truncatePreview(calledTools.join(', '), maxLength);
    }
  }

  return truncatePreview(text, maxLength);
}

export function formatToolDetail(value: unknown): string {
  const parsed = parseJsonValue(value);
  if (typeof parsed === 'string') return parsed;
  if (parsed === undefined) return '';

  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(parsed);
  }
}
