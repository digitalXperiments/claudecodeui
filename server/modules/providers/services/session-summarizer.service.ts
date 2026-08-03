import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { LLMProvider } from '@/shared/types.js';

export type SummarizeConversationInput = {
  projectPath: string;
  transcriptMarkdown: string;
  sourceProvider: string;
  targetProvider: string;
  targetModel?: string | null;
};

const SUMMARIZER_TIMEOUT_MS = 90_000;
// Roughly 400k chars ~= 100k tokens, comfortably inside any of these
// providers' context windows even after the prompt wrapper. Sessions rarely
// exceed this; when they do, the caller falls back to the mechanical
// windowed summary instead of truncating silently mid-transcript.
const MAX_TRANSCRIPT_CHARS = 400_000;
// Guards against a runaway subprocess flooding memory with stdout.
const MAX_CAPTURED_OUTPUT_CHARS = 500_000;

const buildSummarizerPrompt = (input: SummarizeConversationInput): string => {
  const transcript = input.transcriptMarkdown.length > MAX_TRANSCRIPT_CHARS
    ? input.transcriptMarkdown.slice(-MAX_TRANSCRIPT_CHARS)
    : input.transcriptMarkdown;

  return [
    'You are producing a handoff document so another AI coding assistant can continue this work with no other context.',
    `The new assistant will run under provider "${input.targetProvider}"${input.targetModel ? ` (model: ${input.targetModel})` : ''}, replacing this "${input.sourceProvider}" session.`,
    '',
    'Read the full conversation transcript below and write a thorough summary that preserves every nuance a continuation needs. Specifically capture:',
    '- The original goal and how it evolved',
    '- Key decisions made and, importantly, WHY (tradeoffs, constraints, things ruled out)',
    '- Corrections, pivots, or dead ends — do not just describe the final state, describe the path taken and what was learned',
    '- Concrete current state: what is done, what is verified, what is left',
    '- Any gotchas, bugs, or non-obvious constraints discovered along the way',
    '- Explicit next steps',
    '',
    'Write plain markdown with headers. Do not pad with generic filler — every sentence should carry information the next assistant needs. There is no length cap; a long, detail-preserving summary is better than a short, lossy one. Do not use any tools — just respond with the summary text.',
    '',
    '## Transcript',
    '',
    transcript,
  ].join('\n');
};

const summarizeWithClaudeSdk = async (prompt: string, projectPath: string): Promise<string | null> => {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), SUMMARIZER_TIMEOUT_MS);

  try {
    const instance = query({
      prompt,
      options: {
        cwd: projectPath,
        tools: [],
        maxTurns: 1,
        abortController,
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      },
    });

    for await (const message of instance) {
      if (message.type === 'result') {
        return message.subtype === 'success' && message.result.trim() ? message.result.trim() : null;
      }
    }

    return null;
  } finally {
    clearTimeout(timeout);
  }
};

type OneShotSpawnConfig = {
  command: string;
  buildArgs: (prompt: string, projectPath: string, outputFile?: string) => string[];
  /** Read the summary from a file this run wrote instead of stdout, when stdout may be noisy. */
  outputFile?: (tempDir: string) => string;
  /** Extract the answer text from captured stdout. Defaults to a plain trim. */
  parseOutput?: (rawOutput: string) => string | null;
};

/**
 * Some CLIs' plain-text mode appends session-resume footers ("To resume this
 * session: ...") to stdout alongside the real answer. Their NDJSON mode
 * keeps the two separate, so parse that instead: concatenate every
 * `{"role":"assistant", ...}` line's content and ignore everything else.
 */
const parseAssistantContentFromJsonLines = (rawOutput: string): string | null => {
  const parts: string[] = [];
  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { role?: string; content?: unknown };
      if (parsed.role === 'assistant' && typeof parsed.content === 'string') {
        parts.push(parsed.content);
      }
    } catch {
      // Non-JSON line (progress/log noise) — skip it.
    }
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
};

// Every provider CLI here ships its own non-interactive "single prompt in,
// text out" mode built for scripting — verified against each binary's
// `--help` output. We use the SOURCE session's own provider to summarize so
// a switch away from a provider with no Claude auth still gets a real
// semantic summary, not a silent fallback to mechanical truncation.
const ONE_SHOT_CONFIGS: Partial<Record<LLMProvider, OneShotSpawnConfig>> = {
  grok: {
    command: 'grok',
    buildArgs: (prompt, projectPath) => [
      '--single', prompt,
      '--cwd', projectPath,
      '--output-format', 'plain',
      '--permission-mode', 'dontAsk',
    ],
  },
  kimi: {
    command: 'kimi',
    // Plain "text" mode appends a "To resume this session: ..." footer to
    // stdout; stream-json keeps the real answer in its own line.
    buildArgs: (prompt) => ['--prompt', prompt, '--output-format', 'stream-json'],
    parseOutput: parseAssistantContentFromJsonLines,
  },
  pi: {
    command: 'pi',
    buildArgs: (prompt) => ['--print', '--no-tools', '--no-session', prompt],
  },
  agy: {
    command: 'agy',
    buildArgs: (prompt) => ['--print', prompt],
  },
  codex: {
    command: 'codex',
    buildArgs: (prompt, projectPath, outputFile) => [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--cd', projectPath,
      '--output-last-message', outputFile as string,
      prompt,
    ],
    outputFile: (tempDir) => path.join(tempDir, 'codex-summary.txt'),
  },
  opencode: {
    command: 'opencode',
    buildArgs: (prompt, projectPath) => ['run', '--dir', projectPath, '--format', 'default', prompt],
  },
};

const spawnOneShot = (
  config: OneShotSpawnConfig,
  prompt: string,
  projectPath: string,
  outputFilePath: string | undefined,
): Promise<string | null> => new Promise((resolve) => {
  const args = config.buildArgs(prompt, projectPath, outputFilePath);

  const child = spawn(config.command, args, {
    cwd: projectPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      child.kill('SIGKILL');
    }
  }, SUMMARIZER_TIMEOUT_MS);

  const finish = (result: string | null) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < MAX_CAPTURED_OUTPUT_CHARS) {
      stdout += chunk.toString('utf8');
    }
  });

  child.on('error', () => finish(null));
  child.on('close', (code) => {
    if (code !== 0) {
      finish(null);
      return;
    }

    if (outputFilePath) {
      readFile(outputFilePath, 'utf8')
        .then((text) => finish(text.trim() || null))
        .catch(() => finish(null));
      return;
    }

    finish(config.parseOutput ? config.parseOutput(stdout) : (stdout.trim() || null));
  });
});

const summarizeWithProviderCli = async (
  provider: LLMProvider,
  prompt: string,
  projectPath: string,
): Promise<string | null> => {
  const config = ONE_SHOT_CONFIGS[provider];
  if (!config) {
    return null;
  }

  if (!config.outputFile) {
    return spawnOneShot(config, prompt, projectPath, undefined);
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'session-summarizer-'));
  try {
    const outputFilePath = config.outputFile(tempDir);
    return await spawnOneShot(config, prompt, projectPath, outputFilePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Generates a semantic (LLM-written) summary of a conversation transcript for
 * provider/model handoff, replacing the mechanical recency-window truncation
 * that would otherwise drop everything outside the last few turns.
 *
 * Summarizes using the SOURCE session's own provider — not a fixed provider —
 * since that is the one guaranteed to already be installed/authenticated for
 * this session, regardless of what the user is switching to. Returns null on
 * any failure (not installed, not authenticated, unsupported provider,
 * timeout, non-zero exit) so callers fall back to the mechanical summary.
 */
export const sessionSummarizerService = {
  async summarizeConversation(input: SummarizeConversationInput): Promise<string | null> {
    const sourceProvider = input.sourceProvider as LLMProvider;
    const installed = await providerAuthService.isProviderInstalled(sourceProvider);
    if (!installed) {
      return null;
    }

    const prompt = buildSummarizerPrompt(input);

    try {
      if (sourceProvider === 'claude') {
        return await summarizeWithClaudeSdk(prompt, input.projectPath);
      }
      return await summarizeWithProviderCli(sourceProvider, prompt, input.projectPath);
    } catch (error) {
      console.warn('Session summarizer failed, falling back to mechanical summary:', (error as Error)?.message ?? error);
      return null;
    }
  },
};
