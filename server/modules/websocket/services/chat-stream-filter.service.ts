import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';

/**
 * Read results for a skill are useful to the provider but not to the chat
 * transcript. In particular, exposing the result for SKILL.md makes the
 * complete skill instructions appear as a large tool result/user turn.
 */
export const SKILL_BODY_REDACTION = '[SKILL.md contents hidden]';

const SKILL_BODY_PREFIX = 'Base directory for this skill:';
const READ_TOOL_NAMES = new Set([
  'read',
  'read-file',
  'read_file',
  'readfile',
  'readtextfile',
]);
const TOOL_PATH_KEYS = ['file_path', 'filePath', 'path', 'filename'] as const;

function readRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : null;
}

function parseToolInput(value: unknown): AnyRecord | null {
  const record = readRecord(value);
  if (record) {
    return record;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    return readRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function isReadToolName(toolName: unknown): boolean {
  if (typeof toolName !== 'string') {
    return false;
  }

  const normalized = toolName.trim().toLowerCase();
  return READ_TOOL_NAMES.has(normalized)
    || Array.from(READ_TOOL_NAMES).some((name) => normalized.endsWith(`__${name}`));
}

/**
 * A skill path is identified by its filename, not by a provider-specific
 * skills directory. This covers global, project, bundled, and Windows paths.
 */
export function isSkillMarkdownPath(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  const normalized = value.trim().replace(/\\/g, '/');
  const pathWithoutSuffix = normalized.split(/[?#]/, 1)[0] ?? normalized;
  return /(?:^|\/)skill\.md$/i.test(pathWithoutSuffix);
}

function toolInputTargetsSkill(value: unknown): boolean {
  const record = parseToolInput(value);
  if (!record) {
    return isSkillMarkdownPath(value);
  }

  return TOOL_PATH_KEYS.some((key) => isSkillMarkdownPath(record[key]));
}

function isSkillReadInvocation(message: NormalizedMessage): boolean {
  return message.kind === 'tool_use'
    && isReadToolName(message.toolName)
    && toolInputTargetsSkill(message.toolInput);
}

function isSkillBodyText(value: unknown): boolean {
  return typeof value === 'string' && value.trimStart().startsWith(SKILL_BODY_PREFIX);
}

function redactSkillResult(message: NormalizedMessage): NormalizedMessage {
  const redacted: NormalizedMessage = {
    ...message,
    content: SKILL_BODY_REDACTION,
  };

  // Some adapters attach the result to the tool-use event and some emit a
  // separate tool_result event. Remove provider-specific result payloads as
  // well, since they can contain the same body under a different key.
  if (message.toolResult) {
    redacted.toolResult = {
      ...message.toolResult,
      content: SKILL_BODY_REDACTION,
    };
    delete redacted.toolResult.toolUseResult;
  }
  delete redacted.toolUseResult;
  delete redacted.output;
  delete redacted.result;
  delete redacted.rawOutput;

  return redacted;
}

/**
 * Filters one normalized event at the chat-run boundary.
 *
 * `skillReadToolIds` carries the Read invocation across adapters that emit a
 * separate tool_result without repeating the tool name or input. It is owned
 * by one live run and is intentionally not shared between sessions.
 */
export function filterSkillBodyEvent(
  message: NormalizedMessage,
  skillReadToolIds: Set<string>,
): NormalizedMessage | null {
  if (isSkillReadInvocation(message)) {
    if (message.toolId) {
      skillReadToolIds.add(message.toolId);
    }

    return message.toolResult ? redactSkillResult(message) : message;
  }

  if (message.kind === 'tool_result') {
    const isAssociatedSkillRead = Boolean(message.toolId && skillReadToolIds.has(message.toolId));
    const isSelfDescribingSkillRead = isReadToolName(message.toolName)
      && toolInputTargetsSkill(message.toolInput);
    if (isAssociatedSkillRead || isSelfDescribingSkillRead || isSkillBodyText(message.content)) {
      return redactSkillResult(message);
    }
  }

  // Claude emits the injected SKILL.md as a synthetic user text event rather
  // than a Read/tool_result pair. Drop that event completely; a placeholder
  // would still render as a misleading user message in the transcript.
  if ((message.kind === 'text' || message.kind === 'stream_delta') && isSkillBodyText(message.content)) {
    return null;
  }

  return message;
}
