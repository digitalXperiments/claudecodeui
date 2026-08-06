import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import { sessionsDb } from '@/modules/database/index.js';
import { kanbanDb } from '@/modules/kanban/index.js';
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
  /** Working-tree git state appended as its own handoff section, when available. */
  gitState?: string | null;
  /** Active kanban cards appended as its own handoff section, when available. */
  kanbanState?: string | null;
};

export type CreateHandoffSessionInput = {
  sourceSessionId: string;
  targetProvider: LLMProvider;
  targetModel?: string | null;
  mode?: SessionHandoffMode;
  saveToFile?: boolean;
  saveToMemory?: boolean;
  includeGitState?: boolean;
  includeKanbanState?: boolean;
};

export type ReverseHandoffInput = {
  sessionId: string;
  targetProvider?: LLMProvider;
  targetModel?: string | null;
  mode?: SessionHandoffMode;
  saveToFile?: boolean;
  saveToMemory?: boolean;
  includeGitState?: boolean;
  includeKanbanState?: boolean;
};

export type MergeSessionsInput = {
  sessionIds: string[];
  targetProvider?: LLMProvider;
  targetModel?: string | null;
  mode?: SessionHandoffMode;
  saveToFile?: boolean;
  saveToMemory?: boolean;
  includeGitState?: boolean;
  includeKanbanState?: boolean;
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
// Keeps the git/kanban handoff sections compact enough to be a useful prompt
// primer instead of a transcript dump.
const GIT_STATE_MAX_CHARS = 4000;
const KANBAN_CARD_LIMIT = 10;
const GIT_COMMAND_TIMEOUT_MS = 10_000;

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
  return lines.join('\n') + buildHandoffContextSections(input.gitState, input.kanbanState);
};

const buildLlmSummaryDocument = (input: BuildHandoffDocumentInput, summaryText: string): string => {
  const lines = buildHeader(input);
  lines.push('## Summary', '', summaryText, '');
  return lines.join('\n') + buildHandoffContextSections(input.gitState, input.kanbanState);
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
  return lines.join('\n') + buildHandoffContextSections(input.gitState, input.kanbanState);
};

/**
 * Runs a short-lived child process and resolves with its trimmed stdout, or
 * null on any failure (missing binary, non-zero exit, timeout, spawn error).
 * Used only for best-effort context capture — callers always guard on null.
 */
const runProcess = (
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<string | null> => new Promise((resolve) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      child.kill('SIGKILL');
    }
  }, GIT_COMMAND_TIMEOUT_MS);

  const finish = (result: string | null) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });

  child.on('error', () => finish(null));
  child.on('close', (code) => {
    if (code !== 0) {
      finish(null);
      return;
    }
    const trimmed = stdout.trim();
    finish(trimmed.length > 0 ? trimmed : null);
  });
});

/**
 * Best-effort working-tree state for the handoff document. Always resolves
 * (never throws) so a non-git directory or a flaky git process degrades the
 * handoff gracefully instead of breaking it.
 */
const captureGitState = async (projectPath: string): Promise<string | null> => {
  try {
    const diffStat = await runProcess('git', ['diff', 'HEAD', '--stat'], { cwd: projectPath });
    const status = await runProcess('git', ['status', '--porcelain'], { cwd: projectPath });

    const sections: string[] = [];
    if (diffStat) {
      sections.push('Changes since HEAD:');
      sections.push('```');
      sections.push(diffStat);
      sections.push('```');
    }
    if (status) {
      sections.push('Working tree status:');
      sections.push('```');
      sections.push(status);
      sections.push('```');
    }

    const joined = sections.join('\n\n').trim();
    return joined.length > 0 ? truncate(joined, GIT_STATE_MAX_CHARS) : null;
  } catch {
    return null;
  }
};

/**
 * Best-effort kanban context for one project: the titles and statuses of its
 * active cards on the global board. Always resolves (never throws) so kanban
 * failures degrade the handoff gracefully.
 */
const captureKanbanState = async (projectPath: string): Promise<string | null> => {
  try {
    const board = kanbanDb.getOrCreateGlobalBoard();
    const tasks = kanbanDb.listTasksByBoard(board.board_id);
    const activeTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'failed');

    if (activeTasks.length === 0) {
      return null;
    }

    const cards = activeTasks
      .filter((task) => task.project_id === projectPath)
      .slice(0, KANBAN_CARD_LIMIT)
      .map((task) => {
        const title = truncate(task.title, 200);
        return `${title} [${task.status}]`;
      });

    if (cards.length === 0) {
      return null;
    }

    return `Active kanban cards for this project:\n- ${cards.join('\n- ')}`;
  } catch {
    return null;
  }
};

/**
 * Renders the optional working-tree and kanban context sections appended to
 * handoff documents. Pure and exported so tests can exercise it without a git
 * repo or a kanban board; sections render only when non-empty.
 */
export const buildHandoffContextSections = (
  gitState: string | null | undefined,
  kanbanState: string | null | undefined,
): string => {
  const sections: string[] = [];

  const gitSection = gitState?.trim();
  if (gitSection) {
    sections.push(`## Working tree state\n\n${gitSection}`);
  }

  const kanbanSection = kanbanState?.trim();
  if (kanbanSection) {
    sections.push(`## Kanban context\n\n${kanbanSection}`);
  }

  return sections.length === 0 ? '' : `\n${sections.join('\n\n')}`;
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

const buildReverseHandoffPrompt = (options: {
  markdown: string;
  handoffFilePath?: string;
  backupFilePath?: string;
  saveToMemory: boolean;
}): string => {
  const sections: string[] = [];

  if (options.saveToMemory) {
    sections.push(
      "First, persist the handoff summary below to this project's long-term memory "
      + '(e.g. your memory skill / Obsidian MCP under a Handoffs note), then continue.',
    );
  }

  sections.push(
    'This conversation hands the work back to the provider that originally started it. '
    + 'The summary below covers what changed since the work left this provider.\n\n'
    + options.markdown,
  );

  if (options.backupFilePath) {
    sections.push(
      'This summary was generated automatically and may have missed something. The full '
      + `transcript of the handing-back session is saved at:\n${options.backupFilePath}\n\n`
      + 'If anything below seems incomplete or unclear, read that file to check before asking.',
    );
  }

  sections.push('Continue the work from where it left off. If anything is unclear, say so before acting.');

  return sections.join('\n\n');
};

const buildMergeHandoffPrompt = (options: {
  mode: 'summary' | 'full';
  markdown: string;
  handoffFilePath?: string;
  backupFilePath?: string;
  saveToMemory: boolean;
  sourceProviderCount: number;
}): string => {
  const sections: string[] = [];

  if (options.saveToMemory) {
    sections.push(
      "First, persist the handoff summary below to this project's long-term memory "
      + '(e.g. your memory skill / Obsidian MCP under a Handoffs note), then continue.',
    );
  }

  sections.push(
    `This conversation continues the work of ${options.sourceProviderCount} previous session(s), merged into one.`,
  );

  if (options.mode === 'summary') {
    sections.push(`Here is the handoff summary of the merged work so far:\n\n${options.markdown}`);
    if (options.backupFilePath) {
      sections.push(
        'This summary was generated automatically and may have missed something. The full '
        + `merged transcript is saved at:\n${options.backupFilePath}\n\n`
        + 'If anything below seems incomplete or unclear, read that file to check before asking.',
      );
    }
  } else {
    sections.push(
      `The full merged transcript is saved at:\n${options.handoffFilePath}\n\n`
      + 'Read that file before doing anything else so you understand the work so far.',
    );
  }

  sections.push('Continue the work from where it left off. If anything is unclear, say so before acting.');

  return sections.join('\n\n');
};

type MergedSession = {
  sessionId: string;
  provider: string;
  projectPath: string;
  messages: NormalizedMessage[];
};

const buildMergeDocument = (input: {
  sessions: MergedSession[];
  targetProvider: string;
  targetModel?: string | null;
  mode: 'summary' | 'full';
  gitState?: string | null;
  kanbanState?: string | null;
}): string => {
  const first = input.sessions[0];
  const lines = buildHeader({
    sourceSession: {
      sessionId: first.sessionId,
      provider: first.provider,
      projectPath: first.projectPath,
    },
    messages: [],
    targetProvider: input.targetProvider,
    targetModel: input.targetModel ?? null,
    mode: input.mode,
  });

  if (input.mode === 'summary') {
    const goal = input.sessions
      .flatMap((session) => session.messages)
      .find((message) => isDocumentTextMessage(message, { skipCompactSummary: true }) && message.role === 'user');
    lines.push('## Goal', '', goal
      ? truncate(goal.content as string, GOAL_MAX_CHARS)
      : '_(no user goal message found)_', '');
  }

  lines.push('## Merged sessions', '');
  input.sessions.forEach((session, index) => {
    lines.push(`${index + 1}. ${session.provider} session \`${session.sessionId}\``);
  });
  lines.push('');

  input.sessions.forEach((session, index) => {
    lines.push(`## Session ${index + 1} (${session.provider})`, '');

    const textMessages = session.messages.filter((message) =>
      isDocumentTextMessage(message, { skipCompactSummary: input.mode === 'summary' }));

    if (input.mode === 'summary') {
      const recentTextMessages = textMessages.slice(-RECENT_MESSAGE_COUNT);
      const windowStart = recentTextMessages.length > 0
        ? session.messages.indexOf(recentTextMessages[0])
        : session.messages.length;
      const recentWindow = session.messages.slice(windowStart);

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
      }
      if (rendered === 0) {
        lines.push('_(no recent text messages)_');
      }
    } else if (textMessages.length === 0) {
      lines.push('_(no text messages)_');
    } else {
      for (const message of textMessages) {
        lines.push(`- **${roleLabel(message)}:** ${truncate(message.content as string, FULL_MESSAGE_MAX_CHARS)}`);
      }
    }

    lines.push('');
  });

  return lines.join('\n') + buildHandoffContextSections(input.gitState, input.kanbanState);
};

const createContinuationSession = (
  provider: LLMProvider,
  projectPath: string,
  continuedFromSessionId: string,
): { sessionId: string; provider: LLMProvider; projectPath: string } => {
  const appSession = sessionsService.createAppSession(provider, projectPath);
  sessionsDb.setContinuedFrom(appSession.sessionId, continuedFromSessionId);
  return appSession;
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

    const includeGitState = input.includeGitState ?? false;
    const includeKanbanState = input.includeKanbanState ?? false;

    const gitState = includeGitState ? await captureGitState(projectPath) : null;
    const kanbanState = includeKanbanState ? await captureKanbanState(projectPath) : null;

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
        gitState,
        kanbanState,
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

  /**
   * Reverse handoff: returns the work to the provider that originally started
   * it. The original provider is discovered by walking the
   * `continued_from_session_id` lineage chain from the current session back to
   * the root; an explicit `targetProvider` overrides discovery. The new session
   * is created under that provider and linked back to the handing-back session.
   */
  async reverseHandoffSession(input: ReverseHandoffInput): Promise<CreateHandoffSessionResult> {
    const sourceSession = sessionsDb.getSessionById(input.sessionId);
    if (!sourceSession) {
      throw new AppError(`Session "${input.sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const projectPath = (sourceSession.project_path ?? '').trim();
    if (!projectPath) {
      throw new AppError(`Session "${input.sessionId}" has no project path to hand back from.`, {
        code: 'HANDOFF_PROJECT_PATH_MISSING',
        statusCode: 400,
      });
    }

    let originProvider: string | null = null;
    let cursorId = sourceSession.continued_from_session_id ?? null;
    const seen = new Set<string>();
    while (cursorId && !seen.has(cursorId)) {
      seen.add(cursorId);
      const ancestor = sessionsDb.getSessionById(cursorId);
      if (!ancestor) {
        break;
      }
      originProvider = ancestor.provider;
      cursorId = ancestor.continued_from_session_id ?? null;
    }

    const targetProvider = (input.targetProvider ?? originProvider ?? sourceSession.provider) as LLMProvider;

    const mode = input.mode ?? 'summary';
    const saveToFile = input.saveToFile ?? false;
    const saveToMemory = input.saveToMemory ?? false;

    const includeGitState = input.includeGitState ?? false;
    const includeKanbanState = input.includeKanbanState ?? false;

    const gitState = includeGitState ? await captureGitState(projectPath) : null;
    const kanbanState = includeKanbanState ? await captureKanbanState(projectPath) : null;

    let markdown: string | null = null;
    let handoffFilePath: string | undefined;
    let backupFilePath: string | undefined;

    if (mode !== 'fresh') {
      const { messages } = await sessionsService.fetchHistory(input.sessionId, {
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
        targetProvider,
        targetModel: input.targetModel ?? null,
        mode,
        gitState,
        kanbanState,
      };

      if (mode === 'summary') {
        const fullDocument = sessionHandoffService.buildHandoffDocument({ ...documentInput, mode: 'full' });
        const summaryText = await sessionSummarizerService.summarizeConversation({
          projectPath,
          transcriptMarkdown: fullDocument,
          sourceProvider: sourceSession.provider,
          targetProvider,
          targetModel: input.targetModel ?? null,
        });

        if (summaryText) {
          markdown = buildLlmSummaryDocument(documentInput, summaryText);
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

    const appSession = createContinuationSession(targetProvider, projectPath, input.sessionId);

    const handoffPrompt = markdown === null
      ? null
      : buildReverseHandoffPrompt({
        markdown,
        handoffFilePath,
        backupFilePath,
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

  /**
   * Merges the work of one or more previous sessions into a single
   * continuation session under one provider. Every source session's messages
   * are rendered into one handoff document (summary mode: goal + last turns
   * per session; full mode: every text message), with git/kanban context when
   * requested. The new session is linked back to the first source session.
   */
  async mergeSessions(input: MergeSessionsInput): Promise<CreateHandoffSessionResult> {
    if (!Array.isArray(input.sessionIds) || input.sessionIds.length === 0) {
      throw new AppError('At least one source session id is required to merge.', {
        code: 'HANDOFF_MERGE_EMPTY',
        statusCode: 400,
      });
    }

    const resolved: MergedSession[] = [];
    for (const sessionId of input.sessionIds) {
      const session = sessionsDb.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }
      const projectPath = (session.project_path ?? '').trim();
      if (!projectPath) {
        throw new AppError(`Session "${sessionId}" has no project path to merge from.`, {
          code: 'HANDOFF_PROJECT_PATH_MISSING',
          statusCode: 400,
        });
      }
      const { messages } = await sessionsService.fetchHistory(sessionId, {
        limit: null,
        offset: 0,
      });
      resolved.push({ sessionId: session.session_id, provider: session.provider, projectPath, messages });
    }

    const projectPaths = new Set(resolved.map((s) => s.projectPath));
    if (projectPaths.size > 1) {
      throw new AppError('Merged sessions must all belong to the same project.', {
        code: 'HANDOFF_MERGE_PROJECT_MISMATCH',
        statusCode: 400,
      });
    }
    const projectPath = resolved[0].projectPath;

    const mode = input.mode ?? 'summary';
    const docMode: 'summary' | 'full' = mode === 'full' ? 'full' : 'summary';
    const saveToFile = input.saveToFile ?? false;
    const saveToMemory = input.saveToMemory ?? false;
    const targetProvider = (input.targetProvider ?? resolved[0].provider) as LLMProvider;

    const includeGitState = input.includeGitState ?? false;
    const includeKanbanState = input.includeKanbanState ?? false;

    const gitState = includeGitState ? await captureGitState(projectPath) : null;
    const kanbanState = includeKanbanState ? await captureKanbanState(projectPath) : null;

    let markdown: string | null = null;
    let handoffFilePath: string | undefined;
    let backupFilePath: string | undefined;

    if (mode !== 'fresh') {
      markdown = buildMergeDocument({
        sessions: resolved,
        targetProvider,
        targetModel: input.targetModel ?? null,
        mode: docMode,
        gitState,
        kanbanState,
      });

      if (mode === 'full' || saveToFile) {
        handoffFilePath = await sessionHandoffService.writeHandoffFile(projectPath, markdown);
      } else {
        // The mechanical summary is lossy; keep the full merged transcript on
        // disk as a safety net the continuation can fall back to.
        backupFilePath = await sessionHandoffService.writeHandoffFile(
          projectPath,
          buildMergeDocument({
            sessions: resolved,
            targetProvider,
            targetModel: input.targetModel ?? null,
            mode: 'full',
            gitState,
            kanbanState,
          }),
        );
      }
    }

    const appSession = createContinuationSession(targetProvider, projectPath, resolved[0].sessionId);

    const handoffPrompt = markdown === null
      ? null
      : buildMergeHandoffPrompt({
        mode: docMode,
        markdown,
        handoffFilePath,
        backupFilePath,
        saveToMemory,
        sourceProviderCount: resolved.length,
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
