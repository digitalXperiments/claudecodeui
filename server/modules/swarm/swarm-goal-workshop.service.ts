/**
 * Pre-start goal workshop: chat with the orchestrator model to turn a rough
 * idea into a pasteable swarm contract (problem, goal, in/out of scope, done-when).
 */

import { projectsDb } from '@/modules/database/index.js';
import { runService } from '@/modules/runs/index.js';
import {
  getSwarmSpawnFn,
  resolveSwarmProvider,
  runSwarmAgent,
} from '@/modules/swarm/swarm-agent.service.js';
import { providerCapabilitiesService } from '@/modules/providers/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export type GoalWorkshopMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type GoalWorkshopResult = {
  reply: string;
  draftGoal: string | null;
  ready: boolean;
};

const SWARM_GOAL_FENCE = /```swarm-goal\s*\n([\s\S]*?)```/i;
// This runs behind an ordinary HTTP request, so it must finish comfortably
// inside common reverse-proxy timeouts. A goal coach is a short text turn, not
// a coding-agent run; anything silent for 25s is already unhealthy.
const WORKSHOP_TIMEOUT_MS = 45_000;
const WORKSHOP_STALL_TIMEOUT_MS = 25_000;

type WorkshopRunner = (input: {
  projectId: string;
  projectPath: string;
  provider: LLMProvider;
  model: string | null;
  prompt: string;
  runId: string;
  permissionMode: string;
  signal?: AbortSignal | null;
}) => Promise<{ success: boolean; text: string; errorMessage?: string | null }>;

let runnerOverride: WorkshopRunner | null = null;

/** Test hook: skip the live provider spawn. */
export function configureGoalWorkshopRunner(runner: WorkshopRunner | null): void {
  runnerOverride = runner;
}

export function parseGoalDraft(text: string): { draftGoal: string | null; ready: boolean } {
  const match = text.match(SWARM_GOAL_FENCE);
  if (!match) return { draftGoal: null, ready: false };
  const draftGoal = match[1].trim();
  return { draftGoal: draftGoal || null, ready: Boolean(draftGoal) };
}

export function buildGoalWorkshopPrompt(input: {
  messages: GoalWorkshopMessage[];
  currentGoal?: string;
  projectName?: string;
}): string {
  const transcript = input.messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.trim()}`)
    .filter((line) => line.length > 8)
    .join('\n\n');

  return [
    'You are a swarm goal coach. Your job is to interview the user and produce a pasteable swarm contract.',
    'The swarm orchestrator will treat that contract as the source of truth: in-scope, out-of-scope, and done-when.',
    'Do not implement the work. Do not invent extra product features. Ask short clarifying questions until you can write the contract.',
    input.projectName ? `Project: ${input.projectName}` : '',
    input.currentGoal?.trim()
      ? `The create form currently has this goal text (refine it, do not ignore it):\n${input.currentGoal.trim()}`
      : '',
    '',
    'When you have enough to write a good contract, reply with a brief confirmation AND a fenced block exactly like:',
    '```swarm-goal',
    '**Problem**',
    '…',
    '',
    '**Goal**',
    '…',
    '',
    '**In scope**',
    '1. …',
    '',
    '**Out of scope**',
    '- …',
    '',
    '**Done when**',
    '- …',
    '```',
    'If you still need information, ask 1–3 questions and do NOT emit a ```swarm-goal block.',
    'Keep the contract bounded: a swarm should finish in one harvest cycle of focused work, not an unbounded rewrite.',
    '',
    '## Conversation so far',
    transcript || '(user has not spoken yet — greet them and ask what they want the swarm to accomplish)',
    '',
    'Reply next as the Assistant.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export async function runGoalWorkshop(input: {
  projectId: string;
  provider?: string | null;
  model?: string | null;
  messages: GoalWorkshopMessage[];
  currentGoal?: string;
  signal?: AbortSignal | null;
}): Promise<GoalWorkshopResult> {
  const projectId = input.projectId.trim();
  if (!projectId) {
    throw new AppError('Select a project before drafting a swarm goal', {
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }
  const project = projectsDb.getProjectById(projectId);
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!project || !projectPath) {
    throw new AppError('Project not found', { code: 'NOT_FOUND', statusCode: 404 });
  }
  const messages = input.messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role, content: String(message.content ?? '').trim() }))
    .filter((message) => message.content.length > 0)
    .slice(-24);
  if (!messages.some((message) => message.role === 'user')) {
    throw new AppError('Send a message describing what you want the swarm to do', {
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  const provider = resolveSwarmProvider(input.provider);
  if (!runnerOverride && !getSwarmSpawnFn(provider)) {
    throw new AppError(`Provider "${provider}" is not available for the goal workshop`, {
      code: 'SWARM_RUNTIME_UNAVAILABLE',
      statusCode: 400,
    });
  }

  const capabilities = providerCapabilitiesService.getProviderCapabilities(provider);
  // Never use plan mode for this text-only turn. Claude plan mode implicitly
  // enables Task/ExitPlanMode/AskUserQuestion, which can leave a detached HTTP
  // request waiting on a tool approval and was the source of live 524s.
  const permissionMode = capabilities.permissionModes.includes('default')
    ? 'default'
    : capabilities.defaultPermissionMode;
  const prompt = buildGoalWorkshopPrompt({
    messages,
    currentGoal: input.currentGoal,
    projectName: project.custom_project_name || undefined,
  });

  const run = runService.create({
    source: 'swarm',
    projectId,
    parentRunId: null,
    rootRunId: null,
    workspaceId: null,
    provider,
    model: input.model ?? null,
    effort: null,
    permissionMode,
    title: 'Swarm goal workshop',
    trigger: `swarm-goal-workshop:${projectId}`,
    status: 'running',
    meta: { phase: 'goal-workshop' },
  });

  try {
    const outcome = runnerOverride
      ? await runnerOverride({
          projectId,
          projectPath,
          provider,
          model: input.model ?? null,
          prompt,
          runId: run.run_id,
          permissionMode,
          signal: input.signal,
        })
      : await runSwarmAgent({
          projectId,
          projectPath,
          provider,
          model: input.model ?? null,
          effort: null,
          permissionMode,
          prompt,
          runId: run.run_id,
          title: 'Swarm goal workshop',
          timeoutMs: WORKSHOP_TIMEOUT_MS,
          stallTimeoutMs: WORKSHOP_STALL_TIMEOUT_MS,
          signal: input.signal,
        });

    if (!outcome.success || !outcome.text.trim()) {
      throw new AppError(outcome.errorMessage || 'Goal workshop produced no reply', {
        code: 'SWARM_GOAL_WORKSHOP_FAILED',
        statusCode: 502,
      });
    }
    const parsed = parseGoalDraft(outcome.text);
    return {
      reply: outcome.text.trim(),
      draftGoal: parsed.draftGoal,
      ready: parsed.ready,
    };
  } catch (error) {
    try {
      const current = runService.get(run.run_id);
      if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
        const aborted = input.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
        runService.markTerminal(run.run_id, {
          status: aborted ? 'aborted' : 'failed',
          errorSummary: error instanceof Error ? error.message : String(error),
        });
      }
    } catch {
      /* the provider event stream may already have closed the run */
    }
    throw error;
  } finally {
    try {
      const current = runService.get(run.run_id);
      if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
        runService.markTerminal(run.run_id, { status: 'succeeded' });
      }
    } catch {
      /* optional */
    }
  }
}
