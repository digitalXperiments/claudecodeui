/**
 * Dynamic swarm dispatch — parse the orchestrator's "what next" decision.
 * Seed plans are suggestions; this contract is how the loop replans after harvest.
 */

import { parseJsonFromAgentText } from '@/modules/mission-control/index.js';
import type { SwarmAgentKind, SwarmAgentLevel, SwarmPlan, SwarmPlanStep } from '@/modules/swarm/swarm.types.js';

const WORKER_KINDS = new Set<string>([
  'explorer',
  'implementer',
  'reviewer',
  'tester',
  'security',
  'docs',
  'custom',
]);

export type DispatchTask = {
  title: string;
  kind: SwarmAgentKind;
  difficulty: SwarmAgentLevel;
  prompt: string;
  scope: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  dependsOn: string[];
};

export type DispatchDecision = {
  done: boolean;
  blocked: boolean;
  valid: boolean;
  reason: string;
  tasks: DispatchTask[];
};

const INVALID: DispatchDecision = {
  done: false,
  blocked: false,
  valid: false,
  reason: 'orchestrator returned no valid dispatch payload',
  tasks: [],
};

/** Seed DAG is suggestion-only unless this is a targeted step retry. */
export function usesDynamicDispatchLoop(
  dynamicEngine: boolean,
  retryStepId?: string | null,
): boolean {
  return dynamicEngine === true && !retryStepId;
}

/** First cycle with no worker evidence must not terminate — run seed wave 0. */
export function shouldUseSeedFirstWave(input: {
  done: boolean;
  taskCount: number;
  findingsCount: number;
  unusedSeedCount: number;
}): boolean {
  return (
    (input.done || input.taskCount === 0) &&
    input.findingsCount === 0 &&
    input.unusedSeedCount > 0
  );
}

export function parseDispatchDecision(text: string): DispatchDecision {
  let raw: unknown;
  try {
    raw = parseJsonFromAgentText(text);
  } catch {
    return INVALID;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return INVALID;
  const record = raw as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  const done = record.done === true || status === 'done';
  const blocked = record.blocked === true || status === 'blocked';
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  const list = Array.isArray(record.tasks) ? record.tasks : Array.isArray(record.batch) ? record.batch : [];
  const tasks: DispatchTask[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : title;
    if (!title && !prompt) continue;
    const kindRaw = typeof row.kind === 'string' ? row.kind.trim() : 'implementer';
    const kind = (WORKER_KINDS.has(kindRaw) ? kindRaw : 'custom') as SwarmAgentKind;
    const difficulty: SwarmAgentLevel =
      row.difficulty === 'advanced' || row.difficulty === 'basic' ? row.difficulty : 'medium';
    const scope = Array.isArray(row.scope)
      ? row.scope.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const acceptanceCriteria = Array.isArray(row.acceptanceCriteria)
      ? row.acceptanceCriteria.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const verificationCommands = Array.isArray(row.verificationCommands)
      ? row.verificationCommands.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        )
      : [];
    const dependsOn = Array.isArray(row.dependsOn)
      ? row.dependsOn.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    tasks.push({
      title: (title || prompt).slice(0, 200),
      kind,
      difficulty,
      prompt: prompt || title,
      scope,
      acceptanceCriteria,
      verificationCommands,
      dependsOn,
    });
  }
  if (done) {
    return {
      done: true,
      blocked: false,
      valid: true,
      reason: reason || 'orchestrator marked the goal complete',
      tasks: [],
    };
  }
  if (blocked) {
    return {
      done: false,
      blocked: true,
      valid: true,
      reason: reason || 'orchestrator cannot safely continue',
      tasks: [],
    };
  }
  if (tasks.length === 0) {
    return { ...INVALID, reason: reason || INVALID.reason };
  }
  return { done: false, blocked: false, valid: true, reason: reason || 'dispatch next batch', tasks };
}

export function planDigest(plan: SwarmPlan, maxSteps = 24): string {
  const lines = plan.steps.slice(-maxSteps).map((step) => {
    const status = step.status ?? 'queued';
    return `- ${step.id} [${status}] ${step.kind} ${step.title}`;
  });
  return lines.length ? lines.join('\n') : '(no steps yet)';
}

export function toPlanSteps(tasks: DispatchTask[], cycle: number, existing: SwarmPlanStep[]): SwarmPlanStep[] {
  const used = new Set(existing.map((step) => step.id));
  const wave = Math.max(0, ...existing.map((step) => step.wave ?? 0)) + 1;
  const steps: SwarmPlanStep[] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    let id = `d${cycle}-${index + 1}`;
    let n = 2;
    while (used.has(id)) {
      id = `d${cycle}-${index + 1}-${n}`;
      n += 1;
    }
    used.add(id);
    steps.push({
      id,
      title: task.title,
      kind: task.kind,
      difficulty: task.difficulty,
      prompt: task.prompt,
      scope: task.scope,
      acceptanceCriteria: task.acceptanceCriteria,
      verificationCommands: task.verificationCommands,
      dependsOn: task.dependsOn.filter((dep) => used.has(dep) || existing.some((step) => step.id === dep)),
      wave,
      status: 'queued',
      requiresChanges: task.kind === 'implementer' || task.kind === 'custom',
    });
  }
  return steps;
}

export function buildDispatchPrompt(input: {
  goal: string;
  planDigest: string;
  findings: string;
  registrySummary: string;
}): string {
  return [
    'You are the swarm orchestrator in a dynamic workflow.',
    'The seed plan is a SUGGESTION, not a contract. Queued seed steps are not owed work — drop, split, or replace them.',
    'After EVERY harvest you decide the NEXT batch from the live goal, not from leftover DAG waves.',
    'Do not redo finished work. Independent branches proceed while a failed subgraph remediates.',
    'Staffing: do NOT pick models or profile ids. The registry assigns worker models from enabled Model Profiles.',
    'Writers run in isolated git worktrees and MAY run in parallel when scopes are disjoint.',
    '',
    '## Goal',
    input.goal,
    '',
    '## Plan so far',
    input.planDigest,
    '',
    '## Latest findings (distilled)',
    input.findings || '(none)',
    '',
    '## Enabled model profiles (for your awareness; the router picks seats)',
    input.registrySummary,
    '',
    'Reply with JSON only:',
    '{ "status": "dispatch", "reason": "...", "tasks": [',
    '  { "title": "...", "kind": "explorer|implementer|reviewer|tester|docs", "difficulty": "basic|medium|advanced",',
    '    "prompt": "...", "scope": ["path-or-area"], "acceptanceCriteria": ["..."],',
    '    "verificationCommands": ["safe read-only test command"], "dependsOn": [] }',
    '] }',
    'Use status "done" ONLY when the GOAL itself is met. Use status "blocked" only when no safe task can make progress.',
    'If no worker has landed evidence yet, you MUST return tasks — never done.',
    'PARALLELISM IS THE TOP PRIORITY. Split the remaining goal into as many EXCLUSIVE tasks as possible',
    '(up to 6 per batch): each task owns a disjoint slice (different files/directories/concerns) and can',
    'run fully in parallel with its siblings. Only serialize when a task genuinely depends on another\'s output',
    '(then declare dependsOn). Do NOT bundle independent work into one big task — split it.',
    'SCOPE IS MANDATORY for every non-explorer task: list the concrete directories/files it will touch',
    '(e.g. ["server/modules/auth", "src/components/login"]). Tasks without scope CANNOT run in parallel,',
    'which serializes the whole batch and wastes fan-out. Disjoint scopes across tasks = parallel speed.',
  ].join('\n');
}
