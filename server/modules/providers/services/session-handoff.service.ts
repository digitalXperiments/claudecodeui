import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { sessionSummarizerService } from '@/modules/providers/services/session-summarizer.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export type SessionHandoffMode = 'summary' | 'full' | 'fresh';

export type BuildHandoffDocumentInput = {
  sourceSession: {
    sessionId: string;
    provider: string;
    projectPath: string | null;
  };
  messages: NormalizedMessage[];
  targetProvider: string;
  targetModel?: string | null;
  mode: 'summary' | 'full';
};

export type CreateHandoffSessionInput = {
  sourceSessionId: string;
  targetProvider: LLMProvider;
  targetModel?: string | null;
  mode?: SessionHandoffMode;
  saveToFile?: boolean;
  saveToMemory?: boolean;
};

export type CreateHandoffSessionResult = {
  sessionId: string;
  provider: LLMProvider;
  projectPath: string;
  handoffPrompt: string | null;
  handoffFilePath?: string;
  backupFilePath?: string;
};

const GOAL_MAX_CHARS = 1500;
const RECENT_MESSAGE_MAX_CHARS = 1200;
const FULL_MESSAGE_MAX_CHARS = 4000;
const RECENT_MESSAGE_COUNT = 15;

const truncate = (text: string, maxChars: number): string => {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}…`;
};

/**
 * A message enters the handoff document when it is a user/assistant text
 * message with non-empty content. Compact summaries are synthetic duplicates
 * of the earlier conversation, so summary mode skips them (full mode keeps
 * every text message for transcript completeness).
 */
const isDocumentTextMessage = (
  message: NormalizedMessage,
  options: { skipCompactSummary: boolean },
): boolean => (
  message.kind === 'text'
  && (message.role === 'user' || message.role === 'assistant')
  && typeof message.content === 'string'
  && message.content.trim().length > 0
  && !(options.skipCompactSummary && message.isCompactSummary)
);

const roleLabel = (message: NormalizedMessage): string =>
  message.role === 'user' ? 'User' : 'Assistant';

const buildHeader = (input: BuildHandoffDocumentInput): string[] => [
  '# Session handoff',
  '',
  `- **Date:** ${new Date().toISOString()}`,
  `- **Source provider:** ${input.sourceSession.provider}`,
  `- **Source session id:** ${input.sourceSession.sessionId}`,
  `- **Project path:** ${input.sourceSession.projectPath ?? 'unknown'}`,
  `- **Target provider:** ${input.targetProvider}`,
  `- **Target model:** ${input.targetModel?.trim() || 'provider default'}`,
  `- **Handoff mode:** ${input.mode}`,
  '',
];

const buildSummaryDocument = (input: BuildHandoffDocumentInput): string => {
  const lines = buildHeader(input);

  const textMessages = input.messages.filter((message) =>
    isDocumentTextMessage(message, { skipCompactSummary: true }));

  const goalMessage = textMessages.find((message) => message.role === 'user');
  lines.push('## Goal', '', goalMessage
    ? truncate(goalMessage.content as string, GOAL_MAX_CHARS)
    : '_(no user goal message found)_', '');

  // The window starts at the first of the last N text messages so tool calls
  // interleaved between them keep their chronological position in the output.
  const recentTextMessages = textMessages.slice(-RECENT_MESSAGE_COUNT);
  const windowStart = recentTextMessages.length > 0
    ? input.messages.indexOf(recentTextMessages[0])
    : input.messages.length;
  const recentWindow = input.messages.slice(windowStart);

  lines.push('## Recent conversation', '');

  let rendered = 0;
  for (const message of recentWindow) {
    if (isDocumentTextMessage(message, { skipCompactSummary: true })) {
      lines.push(`- **${roleLabel(message)}:** ${truncate(message.content as string, RECENT_MESSAGE_MAX_CHARS)}`);
      rendered += 1;
    } else if (message.kind === 'tool_use') {
      const toolName = typeof message.toolName === 'string' && message.toolName.trim()
        ? message.toolName.trim()
        : 'unknown';
      lines.push(`- _Used tool: ${toolName}_`);
      rendered += 1;
    }
    // tool_result and every other kind are dropped from the summary on purpose.
  }

  if (rendered === 0) {
    lines.push('_(no recent text messages)_');
  }

  lines.push('');
  return lines.join('\n');
};

const buildLlmSummaryDocument = (input: BuildHandoffDocumentInput, summaryText: string): string => {
  const lines = buildHeader(input);
  lines.push('## Summary', '', summaryText, '');
  return lines.join('\n');
};

const buildFullDocument = (input: BuildHandoffDocumentInput): string => {
  const lines = buildHeader(input);
  lines.push('## Full transcript', '');

  const transcript = input.messages.filter((message) =>
    isDocumentTextMessage(message, { skipCompactSummary: false }));

  if (transcript.length === 0) {
    lines.push('_(no text messages)_');
  } else {
    for (const message of transcript) {
      lines.push(`- **${roleLabel(message)}:** ${truncate(message.content as string, FULL_MESSAGE_MAX_CHARS)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

const formatFileTimestamp = (date: Date): string =>
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
  + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;

const buildHandoffPrompt = (options: {
  mode: 'summary' | 'full';
  markdown: string;
  handoffFilePath?: string;
  backupFilePath?: string;
  sourceProvider: string;
  saveToMemory: boolean;
}): string => {
  const sections: string[] = [];

  if (options.saveToMemory) {
    sections.push(
      "First, persist the handoff summary below to this project's long-term memory "
      + '(e.g. your memory skill / Obsidian MCP under a Handoffs note), then continue.',
    );
  }

  sections.push(`This conversation continues from a previous ${options.sourceProvider} session.`);

  if (options.mode === 'summary') {
    sections.push(`Here is the handoff summary of the work so far:\n\n${options.markdown}`);
    if (options.backupFilePath) {
      sections.push(
        'This summary was generated automatically and may have missed something. The full '
        + `transcript of the previous session is saved at:\n${options.backupFilePath}\n\n`
        + 'If anything below seems incomplete or unclear, read that file to check before asking.',
      );
    }
  } else {
    sections.push(
      `The full transcript of the previous session is saved at:\n${options.handoffFilePath}\n\n`
      + 'Read that file before doing anything else so you understand the work so far.',
    );
  }

  sections.push('Continue the work from where it left off. If anything is unclear, say so before acting.');

  return sections.join('\n\n');
};

/**
 * Session handoff service.
 *
 * Builds a portable markdown handoff document from one session's history and
 * allocates a fresh app session (possibly under another provider/model) that
 * continues the same work. The new session row is linked back to the source
 * via `continued_from_session_id`, and the returned `handoffPrompt` is meant
 * to be sent as the first user message of the new session.
 */
export const sessionHandoffService = {
  /**
   * Renders the mechanical (non-LLM) markdown handoff document for one source
   * session. Used directly for full mode, and as the fallback for summary
   * mode when LLM summarization is unavailable or fails.
   *
   * Summary mode keeps the first user message as the goal plus the last few
   * conversation turns; full mode renders every user/assistant text message.
   */
  buildHandoffDocument(input: BuildHandoffDocumentInput): string {
    return input.mode === 'full' ? buildFullDocument(input) : buildSummaryDocument(input);
  },

  /**
   * Persists one handoff document under `<projectPath>/.cloudcli/handoffs/`
   * and returns the absolute file path.
   */
  async writeHandoffFile(projectPath: string, markdown: string): Promise<string> {
    const handoffsDirectory = path.join(projectPath, '.cloudcli', 'handoffs');
    await fsp.mkdir(handoffsDirectory, { recursive: true });

    const filePath = path.join(
      handoffsDirectory,
      `${formatFileTimestamp(new Date())}-${randomUUID().slice(0, 8)}.md`,
    );
    await fsp.writeFile(filePath, markdown, 'utf8');

    return filePath;
  },

  /**
   * Creates the continuation session for one handoff request.
   *
   * Modes:
   * - `summary`: the full transcript is sent to an LLM (`sessionSummarizerService`)
   *   which writes a nuance-preserving summary; that summary is inlined into
   *   the handoff prompt, and the full transcript it was built from is always
   *   written to disk as a backup (`backupFilePath`) since the summary is a
   *   lossy compression. If the summarizer is unavailable or fails, falls
   *   back to the mechanical goal + last-N-turns summary.
   * - `full`: the entire transcript is rendered; because it is far too large
   *   for a prompt it is always written to disk and the prompt only points at
   *   the file.
   * - `fresh`: no history is read; the new session starts with an empty
   *   prompt while still recording the lineage link.
   */
  async createHandoffSession(input: CreateHandoffSessionInput): Promise<CreateHandoffSessionResult> {
    const mode = input.mode ?? 'summary';
    const saveToFile = input.saveToFile ?? false;
    const saveToMemory = input.saveToMemory ?? false;

    const sourceSession = sessionsDb.getSessionById(input.sourceSessionId);
    if (!sourceSession) {
      throw new AppError(`Session "${input.sourceSessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = (sourceSession.project_path ?? '').trim();
    if (!projectPath) {
      throw new AppError(`Session "${input.sourceSessionId}" has no project path to hand off into.`, {
        code: 'HANDOFF_PROJECT_PATH_MISSING',
        statusCode: 400,
      });
    }

    let markdown: string | null = null;
    let handoffFilePath: string | undefined;
    let backupFilePath: string | undefined;

    if (mode !== 'fresh') {
      const { messages } = await sessionsService.fetchHistory(input.sourceSessionId, {
        limit: null,
        offset: 0,
      });

      const documentInput: BuildHandoffDocumentInput = {
        sourceSession: {
          sessionId: sourceSession.session_id,
          provider: sourceSession.provider,
          projectPath: sourceSession.project_path,
        },
        messages,
        targetProvider: input.targetProvider,
        targetModel: input.targetModel ?? null,
        mode,
      };

      if (mode === 'summary') {
        const fullDocument = sessionHandoffService.buildHandoffDocument({ ...documentInput, mode: 'full' });
        const summaryText = await sessionSummarizerService.summarizeConversation({
          projectPath,
          transcriptMarkdown: fullDocument,
          sourceProvider: sourceSession.provider,
          targetProvider: input.targetProvider,
          targetModel: input.targetModel ?? null,
        });

        if (summaryText) {
          markdown = buildLlmSummaryDocument(documentInput, summaryText);
          // The LLM summary is a lossy compression of the transcript above, so
          // the full transcript is always kept on disk as a safety net the
          // continuation can fall back to, independent of `saveToFile`.
          backupFilePath = await sessionHandoffService.writeHandoffFile(projectPath, fullDocument);
        } else {
          markdown = sessionHandoffService.buildHandoffDocument(documentInput);
        }
      } else {
        markdown = sessionHandoffService.buildHandoffDocument(documentInput);
      }

      if (saveToFile || mode === 'full') {
        handoffFilePath = await sessionHandoffService.writeHandoffFile(projectPath, markdown);
      }
    }

    const appSession = sessionsService.createAppSession(input.targetProvider, projectPath);
    sessionsDb.setContinuedFrom(appSession.sessionId, input.sourceSessionId);

    const handoffPrompt = markdown === null
      ? null
      : buildHandoffPrompt({
        mode: mode === 'full' ? 'full' : 'summary',
        markdown,
        handoffFilePath,
        backupFilePath,
        sourceProvider: sourceSession.provider,
        saveToMemory,
      });

    return {
      sessionId: appSession.sessionId,
      provider: appSession.provider,
      projectPath: appSession.projectPath,
      handoffPrompt,
      ...(handoffFilePath ? { handoffFilePath } : {}),
      ...(backupFilePath ? { backupFilePath } : {}),
    };
  },
};
