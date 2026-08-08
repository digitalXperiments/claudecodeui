import spawn from 'cross-spawn';

import { systemNotificationsDb } from '@/modules/database/index.js';
import { projectsDb } from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { runService } from '@/modules/runs/index.js';
import {
  collectProjectGitContext,
  getSwarmAbortFn,
  getSwarmSpawnFn,
  isSwarmProvider,
  mergeFindingsFallback,
  parseMemberFindings,
  parseOrchestratorPlan,
  parseSynthesis,
  resolveProjectPath,
  resolveSwarmProvider,
  runSwarmAgent,
  type ParsedMemberFindings,
} from '@/modules/swarm/swarm-agent.service.js';
import { parseJsonFromAgentText } from '@/modules/mission-control/index.js';
import { swarmDb } from '@/modules/swarm/swarm.repository.js';
import type {
  StartSwarmInput,
  SwarmAgentSpec,
  SwarmConfig,
  SwarmFinding,
  SwarmHandoff,
  SwarmMember,
  SwarmMessage,
  SwarmPlan,
  SwarmPlanStep,
  SwarmRoleConfig,
  SwarmRun,
} from '@/modules/swarm/swarm.types.js';
import { runGit } from '@/modules/workspaces/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import type { AgentWorkspace } from '@/modules/workspaces/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { CloudError } from '@/shared/run-events.js';

const DEFAULT_ROSTER: SwarmAgentSpec[] = [
  {
    id: 'orchestrator',
    kind: 'orchestrator',
    label: 'Orchestrator',
    focus: 'Plan the goal, assign work to the cheapest capable agents, synthesize handoff.',
  },
  {
    id: 'explorer',
    kind: 'explorer',
    label: 'Explorer',
    focus: 'Map the codebase, gather facts, locate files and patterns relevant to the goal.',
  },
  {
    id: 'implementer',
    kind: 'implementer',
    label: 'Implementer',
    focus: 'Implement concrete changes required by the plan.',
  },
  {
    id: 'reviewer',
    kind: 'reviewer',
    label: 'Reviewer',
    focus: 'Review work done so far for correctness, risks, and missing tests.',
  },
];

const KIND_INSTRUCTIONS: Record<string, string> = {
  orchestrator:
    'You are the Swarm Orchestrator. You plan work, assign it to specialist agents, and produce a final handoff. Prefer cheap models for exploration and expensive models only when quality requires it. Do not implement large code changes yourself unless no implementer is available.',
  explorer:
    'You are an Explorer agent. Map the repo, gather evidence (paths, APIs, tests), and report facts other agents need. Prefer read-only investigation unless a tiny probe is required.',
  implementer:
    'You are an Implementation agent. Make the planned changes in the codebase. Follow existing patterns, keep diffs focused, and report what you changed.',
  reviewer:
    'You are a Review agent. Inspect what explorers/implementers did, verify against the goal, call out bugs, missing tests, and risks. Prefer evidence over generic advice.',
  custom: 'You are a specialized swarm agent. Complete your assigned task with concrete evidence.',
};

const STEP_ENVELOPE = `Return a clear work report. Prefer a JSON object (no markdown fences) when possible:
{
  "summary": "what you did / found (2-8 sentences)",
  "findings": ["specific fact with paths"],
  "recommendations": ["next step for other agents"],
  "risks": ["risk if any"],
  "messagesForPeers": ["short note other agents should know"],
  "severity": "info" | "warning" | "critical"
}`;

const PLAN_ENVELOPE = `Return ONLY a JSON object (no markdown fences):
{
  "summary": "short plan overview",
  "strategy": "how you minimize wall-clock time and token cost while fully covering the goal",
  "costNotes": "which roster seats you use, which you skip, and why (cheap vs strong)",
  "steps": [
    {
      "id": "step-1",
      "title": "short title",
      "kind": "explorer" | "implementer" | "reviewer" | "custom",
      "assignTo": "exact roster label",
      "wave": 1,
      "dependsOn": [],
      "prompt": "detailed task for that agent including acceptance criteria",
      "provider": "optional override",
      "model": "optional override",
      "effort": "optional low|medium|high|…",
      "permissionMode": "optional"
    }
  ]
}
Rules:
- You are the ONLY orchestrator. Do not assign work to yourself as implementer/explorer.
- Use only roster labels in assignTo. You may assign multiple steps to different agents of the same kind when the roster has multiple explorers/implementers/reviewers.
- Dispatch efficiently: maximize parallelism (same wave when independent); skip unused seats when not needed; do not over-split trivial work.
- Prefer cheaper/low-effort seats for broad exploration and mapping; stronger seats only for hard implementation or critical review.
- Sequence explore → implement → review when dependent; otherwise fan out in parallel waves.
- All work happens in a dedicated git worktree on a feature branch; after handoff the system will commit, push, and open a PR.
- Max 12 steps. Prefer fewer high-leverage steps over many tiny ones.`;

const HANDOFF_ENVELOPE = `Return ONLY a JSON object (no markdown fences):
{
  "summary": "final overview / conclusion for the human operator — what the swarm achieved, key evidence, and what they should know next",
  "completed": ["done item"],
  "remaining": ["still open"],
  "recommendations": ["follow-up advice (not backlog tickets)"],
  "risks": ["risk"]
}
Rules:
- This is a handoff message only. Do NOT invent Kanban tasks or ticket lists.
- Be concrete: paths, decisions, residual risks.
- A pull request will be opened automatically from the swarm worktree after this handoff.`;

function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 36) || 'goal';
}

function defaultSwarmBranch(swarmId: string, goal: string): string {
  const shortId = swarmId.replace(/^swarm_/, '').slice(0, 8);
  return `swarm/${slugifyGoal(goal)}-${shortId}`;
}

function runCli(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: process.env });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* optional */
      }
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const activePipelines = new Set<string>();
/** Swarms aborted by the operator mid-run; the pipeline bails between phases. */
const abortedPipelines = new Set<string>();
/** Pending plan-approval gates: swarmId → resolver so approve/reject can resume. */
const planApprovalGates = new Map<string, (approved: boolean) => void>();
let testExecutor: ((swarmId: string) => Promise<void>) | null = null;

const SWARM_AGENT_KINDS = new Set([
  'orchestrator',
  'explorer',
  'implementer',
  'reviewer',
  'custom',
]);

function isSwarmAgentKind(value: unknown): value is string {
  return typeof value === 'string' && SWARM_AGENT_KINDS.has(value);
}

export function setSwarmTestExecutor(fn: ((swarmId: string) => Promise<void>) | null): void {
  testExecutor = fn;
}

function newMsgId(): string {
  return `smsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAgentSpec(
  raw: SwarmAgentSpec | SwarmRoleConfig,
  fallback: { provider?: string | null; model?: string | null; effort?: string | null; permissionMode?: string | null },
): SwarmAgentSpec {
  const role =
    'role' in raw && raw.role
      ? String(raw.role)
      : 'kind' in raw && raw.kind
        ? String(raw.kind)
        : 'custom';
  const kind =
    ('kind' in raw && raw.kind ? String(raw.kind) : null) ||
    (role === 'planner' ? 'orchestrator' : role === 'tester' || role === 'security' || role === 'docs' ? 'reviewer' : role);
  const label =
    (raw.label && String(raw.label).trim()) ||
    kind.charAt(0).toUpperCase() + kind.slice(1);
  return {
    id: raw.id || `${kind}-${label}`.toLowerCase().replace(/\s+/g, '-'),
    kind,
    label,
    provider: raw.provider ?? fallback.provider ?? null,
    model: raw.model ?? fallback.model ?? null,
    effort: raw.effort ?? fallback.effort ?? null,
    permissionMode: raw.permissionMode ?? fallback.permissionMode ?? null,
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    focus: raw.focus,
  };
}

function resolveRoster(input: StartSwarmInput): {
  roster: SwarmAgentSpec[];
  orchestrator: SwarmAgentSpec;
  config: SwarmConfig;
} {
  const fallback = {
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
  };

  let roster: SwarmAgentSpec[] = [];

  if (Array.isArray(input.agents) && input.agents.length > 0) {
    roster = input.agents.map((a) => normalizeAgentSpec(a, fallback));
  } else if (Array.isArray(input.roles) && input.roles.length > 0) {
    roster = input.roles.map((a) => normalizeAgentSpec(a, fallback));
  } else {
    roster = DEFAULT_ROSTER.map((a) => normalizeAgentSpec(a, fallback));
  }

  // Explicit orchestrator input wins and demotes any other orchestrator seats.
  if (input.orchestrator) {
    const orch = normalizeAgentSpec(
      { ...input.orchestrator, kind: 'orchestrator' },
      fallback,
    );
    roster = [
      orch,
      ...roster
        .filter((a) => a.kind !== 'orchestrator' && a.id !== orch.id)
        .map((a) =>
          a.kind === 'orchestrator' ? { ...a, kind: 'custom' as const } : a,
        ),
    ];
  }

  // Exactly one orchestrator is compulsory.
  const orchestrators = roster.filter((a) => a.kind === 'orchestrator');
  if (orchestrators.length === 0) {
    roster = [
      normalizeAgentSpec(
        {
          kind: 'orchestrator',
          label: 'Orchestrator',
          provider: fallback.provider,
          model: fallback.model,
          effort: fallback.effort ?? 'medium',
          permissionMode: fallback.permissionMode,
        },
        fallback,
      ),
      ...roster,
    ];
  } else if (orchestrators.length > 1) {
    // Keep the first orchestrator; demote extras to custom so roster size is preserved.
    let kept = false;
    roster = roster.map((a) => {
      if (a.kind !== 'orchestrator') return a;
      if (!kept) {
        kept = true;
        return a;
      }
      return { ...a, kind: 'custom', label: a.label || 'Custom' };
    });
  }

  const orchestrator =
    roster.find((a) => a.kind === 'orchestrator') ||
    normalizeAgentSpec(DEFAULT_ROSTER[0], fallback);

  // Ensure orchestrator sits first for readability.
  const workers = roster.filter((a) => a.kind !== 'orchestrator');
  roster = [orchestrator, ...workers];

  const config: SwarmConfig = {
    // Approval was historically used to gate Kanban task creation; Agent Swarm
    // now ends on orchestrator handoff only (no task side effects).
    requireApproval: Boolean(input.requireApproval),
    requirePlanApproval: Boolean(input.requirePlanApproval),
    stepTimeoutMs: typeof input.stepTimeoutMs === 'number' && input.stepTimeoutMs > 0 ? input.stepTimeoutMs : null,
    maxConcurrency: typeof input.maxConcurrency === 'number' && input.maxConcurrency > 0 ? input.maxConcurrency : null,
    orchestrator,
    agents: workers,
    skills: Array.isArray(input.skills) ? input.skills.filter(Boolean) : [],
  };

  return { roster, orchestrator, config };
}

function formatBlackboard(messages: SwarmMessage[], maxChars = 10_000): string {
  if (!messages.length) return '(no prior messages — you are early in the swarm)';
  const lines = messages.map((m) => {
    const to = m.to ? ` → ${m.to}` : '';
    const step = m.stepId ? ` [${m.stepId}]` : '';
    return `### ${m.from}${to}${step} (${m.kind}) @ ${m.at}\n${m.content}`;
  });
  const text = lines.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

function formatRoster(roster: SwarmAgentSpec[]): string {
  return roster
    .map((a) => {
      const bits = [
        `- **${a.label}** (${a.kind})`,
        a.provider ? `provider=${a.provider}` : null,
        a.model ? `model=${a.model}` : null,
        a.effort ? `effort=${a.effort}` : null,
        a.permissionMode ? `permissions=${a.permissionMode}` : null,
        a.skills?.length ? `skills=${a.skills.join(',')}` : null,
        a.focus ? `focus: ${a.focus}` : null,
      ].filter(Boolean);
      return bits.join(' · ');
    })
    .join('\n');
}

function buildPlanPrompt(input: {
  goal: string;
  roster: SwarmAgentSpec[];
  skills: string[];
  gitContext: string;
}): string {
  return [
    KIND_INSTRUCTIONS.orchestrator,
    '',
    '## Goal',
    input.goal,
    '',
    '## Available agents (assign work only to these)',
    formatRoster(input.roster),
    input.skills.length ? `\n## Skills available\n${input.skills.map((s) => `- ${s}`).join('\n')}` : '',
    '',
    '## Project snapshot',
    input.gitContext,
    '',
    '## Your job',
    'Create a cost- and time-aware execution plan that fully covers the goal.',
    'Dispatch as many roster agents as needed in parallel waves when independent;',
    'skip seats that are not useful. Agents share a blackboard and will see prior step results.',
    'All agents work inside a dedicated git worktree (not the primary checkout).',
    'Do not execute the work yourself in this step — only plan. There is no Kanban board;',
    'your later handoff is the conclusion, then the system opens a PR from the worktree.',
    '',
    PLAN_ENVELOPE,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function buildStepPrompt(input: {
  agent: SwarmAgentSpec;
  step: SwarmPlanStep;
  goal: string;
  skills: string[];
  gitContext: string;
  blackboard: SwarmMessage[];
}): string {
  const kindBlurb = KIND_INSTRUCTIONS[input.agent.kind] || KIND_INSTRUCTIONS.custom;
  return [
    kindBlurb,
    input.agent.focus ? `\n## Role focus\n${input.agent.focus}` : '',
    '',
    '## Swarm goal',
    input.goal,
    '',
    '## Your assigned step',
    `**${input.step.title}** (\`${input.step.id}\`, kind=${input.step.kind})`,
    input.step.prompt,
    input.skills.length
      ? `\n## Skills to prefer\n${input.skills.map((s) => `- ${s}`).join('\n')}`
      : '',
    '',
    '## Shared blackboard (messages from other agents)',
    formatBlackboard(input.blackboard),
    '',
    '## Project snapshot (isolated swarm worktree)',
    input.gitContext,
    '',
    '## Your job',
    '1. Read the blackboard — build on what peers already found or changed.',
    '2. Complete this step only inside the swarm workspace path; stay in character for your kind.',
    '3. Leave clear notes for peers (they will read your report next).',
    '4. Prefer evidence (paths, commands, diffs) over generic advice.',
    '5. Commit-ready changes: keep the tree in a state the orchestrator can PR.',
    '',
    STEP_ENVELOPE,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function buildHandoffPrompt(input: {
  goal: string;
  plan: SwarmPlan | null;
  blackboard: SwarmMessage[];
  findings: SwarmFinding[];
}): string {
  const planBlock = input.plan
    ? [
        `Summary: ${input.plan.summary}`,
        `Strategy: ${input.plan.strategy}`,
        input.plan.costNotes ? `Cost notes: ${input.plan.costNotes}` : '',
        'Steps:',
        ...input.plan.steps.map(
          (s) => `- [${s.status || 'pending'}] ${s.id}: ${s.title} → ${s.assignTo || s.kind}`,
        ),
      ]
        .filter(Boolean)
        .join('\n')
    : '(no plan stored)';

  return [
    KIND_INSTRUCTIONS.orchestrator,
    '',
    '## Goal',
    input.goal,
    '',
    '## Plan',
    planBlock,
    '',
    '## Agent findings (compact)',
    input.findings.map((f) => `- **${f.role}**: ${f.summary.slice(0, 400)}`).join('\n') ||
      '(none)',
    '',
    '## Full blackboard',
    formatBlackboard(input.blackboard, 14_000),
    '',
    '## Your job',
    'Produce the final overview and handoff message for the human operator.',
    'This is the swarm conclusion — no tickets or Kanban tasks will be created.',
    'A pull request will be opened from the swarm worktree after this handoff.',
    'Call out what is done, what remains, risks, and practical recommendations.',
    '',
    HANDOFF_ENVELOPE,
  ].join('\n');
}

function findingsSummaryLine(parsed: ParsedMemberFindings): string {
  const bits = [parsed.summary];
  if (parsed.findings.length) {
    bits.push(
      parsed.findings
        .slice(0, 5)
        .map((f) => `• ${f}`)
        .join('\n'),
    );
  }
  if (parsed.recommendations.length) {
    bits.push(
      'Recommendations:\n' +
        parsed.recommendations
          .slice(0, 5)
          .map((r) => `• ${r}`)
          .join('\n'),
    );
  }
  return bits.filter(Boolean).join('\n\n');
}

function pickAgentForStep(
  step: SwarmPlanStep,
  roster: SwarmAgentSpec[],
): SwarmAgentSpec {
  const workers = roster.filter((a) => a.kind !== 'orchestrator');
  if (step.assignTo) {
    const byLabel = roster.find(
      (a) => a.label.toLowerCase() === step.assignTo!.toLowerCase(),
    );
    if (byLabel) return byLabel;
    const byId = roster.find((a) => a.id === step.assignTo);
    if (byId) return byId;
  }
  const byKind = workers.find((a) => a.kind === step.kind);
  if (byKind) return byKind;
  return workers[0] || roster[0];
}

/** Group steps into parallel waves respecting dependsOn. */
function orderWaves(steps: SwarmPlanStep[]): SwarmPlanStep[][] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const waves: SwarmPlanStep[][] = [];
  let remaining = [...steps];

  while (remaining.length > 0) {
    const ready = remaining.filter((s) =>
      (s.dependsOn ?? []).every((d) => done.has(d) || !byId.has(d)),
    );
    // If orchestrator gave explicit wave numbers, prefer those among ready steps.
    if (ready.length === 0) {
      // Cycle / bad deps — force next remaining as its own wave.
      const forced = remaining[0];
      waves.push([forced]);
      done.add(forced.id);
      remaining = remaining.filter((s) => s.id !== forced.id);
      continue;
    }
    const minWave = Math.min(...ready.map((s) => s.wave ?? 999));
    const waveSteps = ready.filter((s) => (s.wave ?? minWave) === minWave);
    const batch = waveSteps.length ? waveSteps : ready;
    waves.push(batch);
    for (const s of batch) done.add(s.id);
    remaining = remaining.filter((s) => !done.has(s.id));
  }
  return waves;
}

export const swarmService = {
  start(input: StartSwarmInput): SwarmRun {
    if (!input.projectId?.trim())
      throw new CloudError('RUN_NOT_FOUND', 'projectId is required');
    if (!projectsDb.getProjectById(input.projectId))
      throw new CloudError('RUN_NOT_FOUND', `Project not found: ${input.projectId}`);
    if (!input.goal?.trim()) throw new CloudError('RUN_NOT_FOUND', 'goal is required');

    const { roster, orchestrator, config } = resolveRoster(input);
    const defaultProvider = resolveSwarmProvider(
      orchestrator.provider || input.provider || null,
    );

    if (!testExecutor && !getSwarmSpawnFn(defaultProvider)) {
      throw new CloudError(
        'RUN_NOT_FOUND',
        `Provider "${defaultProvider}" runtime is not available. Pick a configured agent (claude, codex, cursor, grok, …).`,
      );
    }

    // Validate each roster seat that has an explicit provider.
    if (!testExecutor) {
      for (const seat of roster) {
        const p = resolveSwarmProvider(seat.provider || defaultProvider);
        if (!getSwarmSpawnFn(p)) {
          throw new CloudError(
            'RUN_NOT_FOUND',
            `Provider "${p}" for agent "${seat.label}" is not available.`,
          );
        }
      }
    }

    const parent = runService.create({
      source: 'swarm',
      projectId: input.projectId,
      title: `Agent Swarm: ${input.goal.trim().slice(0, 120)}`,
      trigger: 'swarm.start',
      status: 'running',
      provider: defaultProvider,
      model: orchestrator.model ?? input.model ?? null,
      meta: {
        goal: input.goal.trim(),
        roster,
        requireApproval: config.requireApproval,
        skills: config.skills,
      },
    });

    const swarm = swarmDb.create({
      projectId: input.projectId,
      goal: input.goal.trim(),
      parentRunId: parent.run_id,
      roles: roster.map((r) => ({
        ...r,
        provider: r.provider || defaultProvider,
        model: r.model ?? input.model ?? null,
      })),
      status: 'planning',
      approvalStatus: config.requireApproval
        ? 'pending'
        : config.requirePlanApproval
          ? 'plan_pending'
          : null,
      skills: config.skills,
      config,
    });

    // Create roster members (queued until assigned a plan step).
    for (const seat of roster) {
      const provider = resolveSwarmProvider(seat.provider || defaultProvider);
      const child = runService.create({
        source: 'swarm',
        projectId: input.projectId,
        parentRunId: parent.run_id,
        rootRunId: parent.run_id,
        provider,
        model: seat.model ?? null,
        title: `Swarm ${seat.label}: ${input.goal.trim().slice(0, 80)}`,
        trigger: `swarm:${swarm.swarm_id}`,
        status: 'queued',
        meta: {
          swarmId: swarm.swarm_id,
          role: seat.kind,
          kind: seat.kind,
          label: seat.label,
          effort: seat.effort ?? null,
          permissionMode: seat.permissionMode ?? null,
        },
      });
      swarmDb.createMember({
        swarmId: swarm.swarm_id,
        role: seat.kind,
        kind: seat.kind,
        label: seat.label,
        provider,
        model: seat.model ?? null,
        effort: seat.effort ?? null,
        permissionMode: seat.permissionMode ?? null,
        skills: seat.skills ?? config.skills,
        runId: child.run_id,
        status: 'queued',
      });
    }

    swarmDb.appendMessage(swarm.swarm_id, {
      id: newMsgId(),
      from: 'system',
      kind: 'system',
      content: `Agent Swarm started for goal: ${input.goal.trim()}`,
      at: new Date().toISOString(),
    });

    void this.executePipeline(swarm.swarm_id, {
      requireApproval: config.requireApproval,
      requirePlanApproval: config.requirePlanApproval,
      stepTimeoutMs: config.stepTimeoutMs ?? null,
      maxConcurrency: config.maxConcurrency ?? null,
      defaultProvider,
      defaultModel: orchestrator.model ?? input.model ?? null,
    }).catch((error) => {
      console.error('[Swarm] pipeline failed', swarm.swarm_id, error);
      try {
        swarmDb.update(swarm.swarm_id, {
          status: 'failed',
          finished: true,
        });
        if (swarm.parent_run_id) {
          runService.markTerminal(swarm.parent_run_id, {
            status: 'failed',
            errorSummary: error instanceof Error ? error.message : String(error),
          });
        }
      } catch {
        /* best effort */
      }
    });

    return swarmDb.get(swarm.swarm_id)!;
  },

  /**
   * Create (or reuse) a dedicated workspace so the entire swarm stays off the
   * primary checkout. Prefer git_worktree + feature branch.
   */
  async ensureSwarmWorkspace(
    swarmId: string,
    input: {
      projectId: string;
      projectPath: string;
      goal: string;
      parentRunId: string | null;
      existingWorkspaceId?: string | null;
    },
  ): Promise<{ workspace: AgentWorkspace; workPath: string }> {
    if (input.existingWorkspaceId) {
      const existing = workspaceService.get(input.existingWorkspaceId);
      if (existing && (existing.status === 'active' || existing.status === 'error')) {
        try {
          const refreshed = await workspaceService.refreshStatus(existing.workspace_id);
          if (refreshed.status === 'active' || refreshed.status === 'error') {
            if (input.parentRunId) {
              workspaceService.bindRun(existing.workspace_id, input.parentRunId);
            }
            return { workspace: existing, workPath: existing.root_path };
          }
        } catch {
          /* fall through to create */
        }
      }
    }

    const branchName = defaultSwarmBranch(swarmId, input.goal);
    const workspace = await workspaceService.create({
      projectId: input.projectId,
      projectPath: input.projectPath,
      runId: input.parentRunId ?? undefined,
      branchName,
    });

    swarmDb.update(swarmId, {
      workspaceId: workspace.workspace_id,
      featureBranch: workspace.feature_branch || branchName,
    });

    if (input.parentRunId) {
      try {
        runService.linkWorkspace(input.parentRunId, workspace.workspace_id);
      } catch {
        /* optional */
      }
    }

    swarmDb.appendMessage(swarmId, {
      id: newMsgId(),
      from: 'system',
      kind: 'system',
      content: `Isolated workspace ready: ${workspace.root_path}${
        workspace.feature_branch ? ` (branch ${workspace.feature_branch})` : ''
      } · mode=${workspace.mode}`,
      at: new Date().toISOString(),
    });

    return { workspace, workPath: workspace.root_path };
  },

  /**
   * Commit dirty worktree changes, push the feature branch, open a PR.
   * Best-effort: never fails the swarm solely because PR tooling is missing;
   * records prError on the handoff instead.
   */
  async finalizeSwarmPullRequest(
    swarmId: string,
    handoff: SwarmHandoff,
  ): Promise<SwarmHandoff> {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) return handoff;

    const workspaceId = swarm.workspace_id;
    if (!workspaceId) {
      return {
        ...handoff,
        workspaceId: null,
        prError: 'No swarm workspace was allocated; skipped PR creation.',
      };
    }

    const workspace = workspaceService.get(workspaceId);
    if (!workspace) {
      return {
        ...handoff,
        workspaceId,
        prError: `Workspace ${workspaceId} not found; skipped PR creation.`,
      };
    }

    const base: SwarmHandoff = {
      ...handoff,
      workspaceId: workspace.workspace_id,
      featureBranch: workspace.feature_branch || swarm.feature_branch || null,
    };

    if (workspace.mode !== 'git_worktree' || !workspace.feature_branch) {
      return {
        ...base,
        prError:
          'Swarm workspace is not a git worktree with a feature branch (sandbox or non-git project); skipped PR.',
      };
    }

    const cwd = workspace.root_path;
    const branch = workspace.feature_branch;

    // Stage + commit any remaining agent changes.
    try {
      const status = await runGit(cwd, ['status', '--porcelain']);
      if (status.code === 0 && status.stdout.trim()) {
        await runGit(cwd, ['add', '-A']);
        const commitMsg = [
          `swarm: ${swarm.goal.slice(0, 72)}`,
          '',
          'Automated commit from Agent Swarm.',
          '',
          handoff.summary.slice(0, 1500),
        ].join('\n');
        const commit = await runGit(cwd, [
          'commit',
          '-m',
          commitMsg,
          '--author',
          'CloudCLI Swarm <swarm@cloudcli.local>',
        ]);
        if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
          // Retry without custom author if config forbids it.
          await runGit(cwd, ['commit', '-m', commitMsg]);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ...base, prError: `Could not commit swarm changes: ${msg}` };
    }

    // Push feature branch.
    const push = await runGit(cwd, ['push', '-u', 'origin', branch]);
    if (push.code !== 0) {
      const detail = (push.stderr || push.stdout).trim().slice(0, 800);
      return {
        ...base,
        prError: `Could not push branch ${branch}: ${detail || 'git push failed'}`,
      };
    }

    // Open PR via GitHub CLI (draft by default).
    const prTitle = `Agent Swarm: ${swarm.goal.slice(0, 100)}`;
    const prBody = [
      '## Agent Swarm handoff',
      '',
      handoff.summary,
      '',
      handoff.completed?.length
        ? `### Completed\n${handoff.completed.map((c) => `- ${c}`).join('\n')}`
        : '',
      handoff.remaining?.length
        ? `### Remaining\n${handoff.remaining.map((c) => `- ${c}`).join('\n')}`
        : '',
      handoff.risks?.length
        ? `### Risks\n${handoff.risks.map((c) => `- ${c}`).join('\n')}`
        : '',
      handoff.recommendations?.length
        ? `### Recommendations\n${handoff.recommendations.map((c) => `- ${c}`).join('\n')}`
        : '',
      '',
      `---`,
      `_Opened automatically by CloudCLI Agent Swarm \`${swarmId}\` from worktree \`${workspace.workspace_id}\`._`,
    ]
      .filter(Boolean)
      .join('\n');

    const baseBranch = workspace.base_branch || 'main';
    const created = await runCli(
      'gh',
      [
        'pr',
        'create',
        '--head',
        branch,
        '--base',
        baseBranch,
        '--title',
        prTitle,
        '--body',
        prBody,
        '--draft',
      ],
      cwd,
    );
    const output = `${created.stdout}\n${created.stderr}`.trim();
    if (created.code !== 0) {
      // Already-open PR is success-ish — try to recover URL.
      const existing = await runCli(
        'gh',
        ['pr', 'view', branch, '--json', 'url,number', '--jq', '.url + " " + (.number|tostring)'],
        cwd,
      );
      const existingUrl = existing.stdout.trim().split(/\s+/)[0];
      if (existing.code === 0 && existingUrl?.startsWith('http')) {
        const number = Number(existing.stdout.trim().split(/\s+/)[1]) || null;
        swarmDb.update(swarmId, { prUrl: existingUrl });
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: 'system',
          kind: 'system',
          content: `Pull request already open: ${existingUrl}`,
          at: new Date().toISOString(),
        });
        return { ...base, prUrl: existingUrl, prNumber: number, prError: null };
      }
      return {
        ...base,
        prError: `Could not create PR: ${output.slice(-1000) || 'gh pr create failed'}`,
      };
    }

    const url = output.match(/https?:\/\/[^\s)]+/)?.[0] ?? null;
    const number = url
      ? Number(url.match(/(?:pull|merge_requests)\/(\d+)/)?.[1] ?? '') || null
      : null;

    if (url) {
      swarmDb.update(swarmId, { prUrl: url });
      swarmDb.appendMessage(swarmId, {
        id: newMsgId(),
        from: 'system',
        kind: 'system',
        content: `Pull request opened: ${url}`,
        at: new Date().toISOString(),
      });
    }

    return { ...base, prUrl: url, prNumber: number, prError: url ? null : 'PR created but no URL returned' };
  },

  /**
   * Orchestrator plans → waves of agents (shared blackboard) → handoff → PR.
   * All agent cwd is the dedicated swarm worktree.
   */
  async executePipeline(
    swarmId: string,
    opts: {
      requireApproval?: boolean;
      requirePlanApproval?: boolean;
      stepTimeoutMs?: number | null;
      maxConcurrency?: number | null;
      defaultProvider?: LLMProvider | string | null;
      defaultModel?: string | null;
    } = {},
  ): Promise<SwarmRun> {
    if (activePipelines.has(swarmId)) {
      const current = swarmDb.get(swarmId);
      if (current) return current;
      throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    }
    activePipelines.add(swarmId);

    try {
      if (testExecutor) {
        await testExecutor(swarmId);
        return swarmDb.get(swarmId)!;
      }

      const swarm = swarmDb.get(swarmId);
      if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);

      const primaryProjectPath = resolveProjectPath(swarm.project_id);

      // ——— Phase 0: dedicated worktree / sandbox ———
      const { workPath, workspace } = await this.ensureSwarmWorkspace(swarmId, {
        projectId: swarm.project_id,
        projectPath: primaryProjectPath,
        goal: swarm.goal,
        parentRunId: swarm.parent_run_id,
        existingWorkspaceId: swarm.workspace_id,
      });

      // Git context from the isolated workspace (agents never touch primary).
      const gitContext = [
        collectProjectGitContext(workPath),
        '',
        `## Swarm workspace`,
        `- workspace_id: ${workspace.workspace_id}`,
        `- mode: ${workspace.mode}`,
        `- path: ${workPath}`,
        workspace.feature_branch
          ? `- feature_branch: ${workspace.feature_branch}`
          : '- feature_branch: (none — sandbox)',
        workspace.base_branch ? `- base_branch: ${workspace.base_branch}` : '',
        'Work only inside this workspace path. A PR will be opened after handoff.',
      ]
        .filter(Boolean)
        .join('\n');

      const roster = swarm.roles.length ? swarm.roles : DEFAULT_ROSTER;
      const orchestratorSpec =
        swarm.config?.orchestrator ||
        roster.find((a) => a.kind === 'orchestrator') ||
        roster[0];
      const defaultProvider = resolveSwarmProvider(
        opts.defaultProvider || orchestratorSpec.provider || null,
      );
      const skills = swarm.skills?.length ? swarm.skills : swarm.config?.skills ?? [];

      // ——— Phase 1: Orchestrator plan ———
      swarmDb.update(swarmId, { status: 'planning' });
      const plan = await this.runOrchestratorPlan(swarmId, {
        goal: swarm.goal,
        projectPath: workPath,
        parentRunId: swarm.parent_run_id,
        orchestrator: orchestratorSpec,
        roster,
        skills,
        gitContext,
        defaultProvider,
        defaultModel: opts.defaultModel ?? null,
      });

      swarmDb.update(swarmId, { status: 'running', plan });
      swarmDb.appendMessage(swarmId, {
        id: newMsgId(),
        from: orchestratorSpec.label || 'Orchestrator',
        kind: 'plan',
        content: `${plan.summary}\n\nStrategy: ${plan.strategy}${
          plan.costNotes ? `\nCost: ${plan.costNotes}` : ''
        }\n\nSteps:\n${plan.steps
          .map((s) => `- ${s.id} [wave ${s.wave ?? '?'}] ${s.title} → ${s.assignTo || s.kind}`)
          .join('\n')}`,
        at: new Date().toISOString(),
      });

      // ——— Phase 1b: optional plan-approval gate ———
      // Let the operator review the cost-aware plan BEFORE any worker burns tokens.
      const requirePlanApproval =
        opts.requirePlanApproval === true || swarm.approval_status === 'plan_pending';
      if (requirePlanApproval && !abortedPipelines.has(swarmId)) {
        const gateTitle = `Agent Swarm plan ready: ${swarm.goal.slice(0, 80)}`;
        const interrupt = interruptsService.create({
          projectId: swarm.project_id,
          kind: 'approval_pending',
          severity: plan.costNotes ? 'warning' : 'info',
          title: gateTitle,
          body: [
            plan.summary.slice(0, 300),
            plan.costNotes ? `Cost: ${plan.costNotes}` : '',
            `Planned steps: ${plan.steps.length} (${plan.steps.filter((s) => s.kind === 'explorer').length} explorer, ${plan.steps.filter((s) => s.kind === 'implementer').length} implementer, ${plan.steps.filter((s) => s.kind === 'reviewer').length} reviewer)`,
          ]
            .filter(Boolean)
            .join('\n'),
          runId: swarm.parent_run_id,
          actions: [
            { id: 'approve_swarm_plan', label: 'Approve plan', style: 'primary' },
            { id: 'reject_swarm_plan', label: 'Reject', style: 'destructive' },
          ],
          meta: { swarmId, phase: 'plan' },
          dedupeKey: `swarm-plan-approval:${swarmId}`,
        });
        swarmDb.update(swarmId, {
          status: 'awaiting_plan_approval',
          approvalStatus: 'plan_pending',
          interruptId: interrupt.interrupt_id,
          plan,
        });
        if (swarm.parent_run_id) {
          try {
            runService.updateStatus(swarm.parent_run_id, 'waiting_permission');
          } catch {
            /* optional */
          }
        }

        const gate = new Promise<boolean>((resolve) => {
          planApprovalGates.set(swarmId, resolve);
        });
        const approved = await gate;
        planApprovalGates.delete(swarmId);

        if (!approved || abortedPipelines.has(swarmId)) {
          this.notifyHandoffComplete(swarmId, {
            summary: 'The orchestrator plan was rejected. No worker agents were dispatched and no PR was opened.',
            completed: [],
            remaining: [],
            recommendations: [],
            risks: [],
            memberCount: 0,
            generatedAt: new Date().toISOString(),
          });
          swarmDb.update(swarmId, {
            status: 'failed',
            approvalStatus: 'rejected',
            finished: true,
            plan,
          });
          if (swarm.parent_run_id) {
            try {
              runService.markTerminal(swarm.parent_run_id, {
                status: 'failed',
                errorSummary: 'Swarm plan rejected',
              });
            } catch {
              /* optional */
            }
          }
          return swarmDb.get(swarmId)!;
        }
      }

      // ——— Phase 2: Execute plan waves (all in worktree) ———
      const waves = orderWaves(plan.steps);
      const findings: SwarmFinding[] = [];
      const livePlan: SwarmPlan = { ...plan, steps: plan.steps.map((s) => ({ ...s })) };
      const stepTimeoutMs = opts.stepTimeoutMs ?? swarm.config?.stepTimeoutMs ?? null;
      const maxConcurrency = opts.maxConcurrency ?? swarm.config?.maxConcurrency ?? null;

      for (const wave of waves) {
        if (abortedPipelines.has(swarmId)) break;
        const results = await this.runWaveWithConcurrency(
          wave,
          (step) =>
            this.executeStep(swarmId, {
              step,
              goal: swarm.goal,
              projectPath: workPath,
              parentRunId: swarm.parent_run_id,
              roster,
              skills,
              gitContext,
              defaultProvider,
              defaultModel: opts.defaultModel ?? null,
              timeoutMs: stepTimeoutMs,
            }),
          maxConcurrency,
        );

        for (const r of results) {
          findings.push(r.finding);
          const idx = livePlan.steps.findIndex((s) => s.id === r.step.id);
          if (idx >= 0) {
            livePlan.steps[idx] = {
              ...livePlan.steps[idx],
              status: r.failed ? 'failed' : 'succeeded',
            };
          }
        }
        swarmDb.update(swarmId, { findings: [...findings], plan: livePlan });

        // Re-plan the failed steps through the orchestrator (bounded, never loops forever).
        const failedSteps = results.filter((r) => r.failed).map((r) => r.step);
        if (failedSteps.length > 0 && !abortedPipelines.has(swarmId)) {
          const replanned = await this.replanFailedSteps(swarmId, {
            failedSteps,
            goal: swarm.goal,
            projectPath: workPath,
            parentRunId: swarm.parent_run_id,
            orchestrator: orchestratorSpec,
            roster,
            skills,
            gitContext,
            defaultProvider,
            defaultModel: opts.defaultModel ?? null,
            plan: livePlan,
            blackboard: (swarmDb.get(swarmId)?.blackboard ?? []),
          });
          if (replanned && replanned.steps.length > 0) {
            for (const newStep of replanned.steps) {
              const result = await this.executeStep(swarmId, {
                step: newStep,
                goal: swarm.goal,
                projectPath: workPath,
                parentRunId: swarm.parent_run_id,
                roster,
                skills,
                gitContext,
                defaultProvider,
                defaultModel: opts.defaultModel ?? null,
                timeoutMs: stepTimeoutMs,
              });
              findings.push(result.finding);
              livePlan.steps.push({ ...newStep, status: result.failed ? 'failed' : 'succeeded' });
            }
            swarmDb.update(swarmId, { findings: [...findings], plan: livePlan });
          }
        }
      }

      // ——— Phase 3: Orchestrator handoff ———
      swarmDb.update(swarmId, { status: 'handing_off' });
      const refreshed = swarmDb.get(swarmId)!;
      let handoff = await this.runOrchestratorHandoff(swarmId, {
        goal: swarm.goal,
        projectPath: workPath,
        parentRunId: swarm.parent_run_id,
        orchestrator: orchestratorSpec,
        plan: refreshed.plan,
        blackboard: refreshed.blackboard,
        findings: refreshed.findings,
        defaultProvider,
        defaultModel: opts.defaultModel ?? null,
      });

      // ——— Phase 4: Commit, push, open PR from worktree ———
      handoff = await this.finalizeSwarmPullRequest(swarmId, handoff);

      const requireApproval =
        opts.requireApproval === true || swarm.approval_status === 'pending';

      if (requireApproval) {
        // Optional human gate: acknowledge handoff only (no Kanban side effects).
        const interrupt = interruptsService.create({
          projectId: swarm.project_id,
          kind: 'approval_pending',
          severity: handoff.risks?.length ? 'warning' : 'info',
          title: `Agent Swarm ready: ${swarm.goal.slice(0, 80)}`,
          body: [
            handoff.summary.slice(0, 400),
            handoff.prUrl ? `PR: ${handoff.prUrl}` : handoff.prError || '',
          ]
            .filter(Boolean)
            .join('\n'),
          runId: swarm.parent_run_id,
          actions: [
            { id: 'approve_swarm', label: 'Acknowledge handoff', style: 'primary' },
            { id: 'reject_swarm', label: 'Reject', style: 'destructive' },
          ],
          meta: { swarmId, prUrl: handoff.prUrl ?? null },
          dedupeKey: `swarm-approval:${swarmId}`,
        });
        swarmDb.update(swarmId, {
          status: 'awaiting_approval',
          approvalStatus: 'pending',
          interruptId: interrupt.interrupt_id,
          synthesis: handoff,
          findings,
          prUrl: handoff.prUrl ?? null,
        });
        if (swarm.parent_run_id) {
          try {
            runService.updateStatus(swarm.parent_run_id, 'waiting_permission');
          } catch {
            /* optional */
          }
        }
      } else {
        this.notifyHandoffComplete(swarmId, handoff);
        swarmDb.update(swarmId, {
          status: 'succeeded',
          approvalStatus: null,
          synthesis: handoff,
          findings,
          prUrl: handoff.prUrl ?? null,
          finished: true,
        });
        if (swarm.parent_run_id) {
          try {
            runService.markTerminal(swarm.parent_run_id, { status: 'succeeded' });
          } catch {
            /* optional */
          }
        }
      }

      return swarmDb.get(swarmId)!;
    } finally {
      activePipelines.delete(swarmId);
      abortedPipelines.delete(swarmId);
      planApprovalGates.delete(swarmId);
    }
  },

  async runOrchestratorPlan(
    swarmId: string,
    input: {
      goal: string;
      projectPath: string;
      parentRunId: string | null;
      orchestrator: SwarmAgentSpec;
      roster: SwarmAgentSpec[];
      skills: string[];
      gitContext: string;
      defaultProvider: LLMProvider | string;
      defaultModel?: string | null;
    },
  ): Promise<SwarmPlan> {
    const provider = resolveSwarmProvider(
      input.orchestrator.provider || input.defaultProvider,
    );
    const model = input.orchestrator.model ?? input.defaultModel ?? null;
    const members = swarmDb.listMembers(swarmId);
    const orchMember =
      members.find((m) => m.kind === 'orchestrator' || m.role === 'orchestrator') ||
      members[0];

    const fallbackAgents = input.roster.map((a) => ({
      kind: a.kind,
      label: a.label,
    }));

    if (!getSwarmSpawnFn(provider)) {
      const parsed = parseOrchestratorPlan('', fallbackAgents);
      return {
        summary: parsed.summary,
        strategy: parsed.strategy,
        costNotes: parsed.costNotes,
        steps: parsed.steps,
        generatedAt: new Date().toISOString(),
      };
    }

    let runId = orchMember?.run_id;
    if (!runId) {
      const child = runService.create({
        source: 'swarm',
        projectId: swarmDb.get(swarmId)?.project_id ?? null,
        parentRunId: input.parentRunId,
        rootRunId: input.parentRunId,
        provider,
        model,
        title: `Swarm plan: ${input.goal.slice(0, 80)}`,
        trigger: `swarm-plan:${swarmId}`,
        status: 'running',
        meta: { swarmId, role: 'orchestrator', phase: 'plan' },
      });
      runId = child.run_id;
      if (orchMember) {
        swarmDb.updateMember(orchMember.member_id, { runId, status: 'running' });
      }
    } else {
      if (orchMember) swarmDb.updateMember(orchMember.member_id, { status: 'running' });
      try {
        runService.updateStatus(runId, 'running');
      } catch {
        /* optional */
      }
    }

    try {
      const outcome = await runSwarmAgent({
        projectId: swarmDb.get(swarmId)?.project_id ?? '',
        projectPath: input.projectPath,
        provider,
        model,
        effort: input.orchestrator.effort,
        permissionMode: input.orchestrator.permissionMode,
        prompt: buildPlanPrompt({
          goal: input.goal,
          roster: input.roster,
          skills: input.skills,
          gitContext: input.gitContext,
        }),
        runId,
        title: 'Swarm orchestrator plan',
      });

      const parsed = parseOrchestratorPlan(
        outcome.success ? outcome.text : '',
        fallbackAgents,
      );
      const plan: SwarmPlan = {
        summary: parsed.summary,
        strategy: parsed.strategy,
        costNotes: parsed.costNotes,
        steps: parsed.steps.map((s) => ({ ...s, status: 'queued' })),
        generatedAt: new Date().toISOString(),
      };

      if (orchMember) {
        swarmDb.updateMember(orchMember.member_id, {
          status: 'succeeded',
          findingsSummary: `Plan: ${plan.summary}`,
          // keep member reusable for handoff — don't finish permanently for plan-only
          finished: false,
        });
        // Reset status to queued so handoff can reuse seat visually
        swarmDb.updateMember(orchMember.member_id, { status: 'queued' });
      }

      // Create a fresh run for handoff later; mark this plan run terminal.
      try {
        const current = runService.get(runId);
        if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
          runService.markTerminal(runId, { status: 'succeeded' });
        }
      } catch {
        /* optional */
      }

      return plan;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (orchMember) {
        swarmDb.updateMember(orchMember.member_id, {
          status: 'failed',
          error: msg,
        });
      }
      const parsed = parseOrchestratorPlan(msg, fallbackAgents);
      return {
        summary: parsed.summary,
        strategy: parsed.strategy,
        costNotes: parsed.costNotes,
        steps: parsed.steps.map((s) => ({ ...s, status: 'queued' })),
        generatedAt: new Date().toISOString(),
      };
    }
  },

  async executeStep(
    swarmId: string,
    input: {
      step: SwarmPlanStep;
      goal: string;
      projectPath: string;
      parentRunId: string | null;
      roster: SwarmAgentSpec[];
      skills: string[];
      gitContext: string;
      defaultProvider: LLMProvider | string;
      defaultModel?: string | null;
      timeoutMs?: number | null;
    },
  ): Promise<{ step: SwarmPlanStep; finding: SwarmFinding; failed: boolean }> {
    const agent = pickAgentForStep(input.step, input.roster);
    const provider = resolveSwarmProvider(
      input.step.provider || agent.provider || input.defaultProvider,
    );
    const model = input.step.model || agent.model || input.defaultModel || null;
    const effort = input.step.effort || agent.effort || null;
    const permissionMode =
      input.step.permissionMode || agent.permissionMode || 'bypassPermissions';
    const skills = [...(agent.skills ?? []), ...input.skills];

    const members = swarmDb.listMembers(swarmId);
    let member =
      members.find(
        (m) =>
          (m.label && m.label.toLowerCase() === agent.label.toLowerCase()) ||
          m.role === agent.kind,
      ) || null;

    // If the primary seat is FINISHED (succeeded/failed/timed_out), reuse a queued
    // sibling of the same kind if one exists.
    if (
      member &&
      ['succeeded', 'failed', 'timed_out'].includes(member.status) &&
      member.finished_at
    ) {
      const alt = members.find(
        (m) =>
          m.member_id !== member!.member_id &&
          (m.kind === agent.kind || m.role === agent.kind) &&
          m.status === 'queued',
      );
      if (alt) member = alt;
    }

    // Auto-scale: if the primary seat is busy running another step, provision a
    // fresh seat ("Implementer", "Implementer 2", ...) so concurrent same-kind
    // steps dispatch in parallel instead of queueing behind one agent.
    let scaledMember = false;
    if (member && member.status === 'running' && member.run_id) {
      const existingCount = members.filter(
        (m) => m.kind === agent.kind || m.role === agent.kind,
      ).length;
      const baseLabel = agent.label || `${agent.kind[0].toUpperCase()}${agent.kind.slice(1)}`;
      const scaledLabel = `${baseLabel} ${existingCount + 1}`;
      member = { ...member, label: scaledLabel, status: 'running' as const };
      scaledMember = true;
    }

    const swarm = swarmDb.get(swarmId)!;
    const blackboard = swarm.blackboard ?? [];

    const child = runService.create({
      source: 'swarm',
      projectId: swarm.project_id,
      parentRunId: input.parentRunId,
      rootRunId: input.parentRunId,
      provider,
      model,
      title: `Swarm ${agent.label}: ${input.step.title.slice(0, 80)}`,
      trigger: `swarm:${swarmId}:${input.step.id}`,
      status: 'running',
      meta: {
        swarmId,
        role: agent.kind,
        stepId: input.step.id,
        effort,
        permissionMode,
      },
    });

    if (member) {
      if (scaledMember) {
        member = swarmDb.createMember({
          swarmId,
          role: agent.kind,
          kind: agent.kind,
          label: member.label,
          provider,
          model,
          effort,
          permissionMode,
          skills,
          stepId: input.step.id,
          runId: child.run_id,
          status: 'running',
        });
      } else {
        swarmDb.updateMember(member.member_id, {
          status: 'running',
          runId: child.run_id,
          stepId: input.step.id,
        });
      }
    } else {
      member = swarmDb.createMember({
        swarmId,
        role: agent.kind,
        kind: agent.kind,
        label: agent.label,
        provider,
        model,
        effort,
        permissionMode,
        skills,
        stepId: input.step.id,
        runId: child.run_id,
        status: 'running',
      });
    }

    try {
      if (!isSwarmProvider(provider) || !getSwarmSpawnFn(provider)) {
        throw new Error(
          `Provider "${provider}" is not available. Authenticate it in Settings and retry.`,
        );
      }

      const prompt = buildStepPrompt({
        agent,
        step: input.step,
        goal: input.goal,
        skills,
        gitContext: input.gitContext,
        blackboard,
      });

      const outcome = await runSwarmAgent({
        projectId: swarm.project_id,
        projectPath: input.projectPath,
        provider,
        model,
        effort,
        permissionMode,
        prompt,
        runId: child.run_id,
        title: `Swarm ${agent.label}`,
        timeoutMs: input.timeoutMs ?? null,
      });

      if (!outcome.success) {
        const err = outcome.errorMessage || 'Agent run failed';
        swarmDb.updateMember(member.member_id, {
          status: 'failed',
          error: err,
          findingsSummary: outcome.text?.slice(0, 1500) || null,
          finished: true,
        });
        const content = outcome.text || err;
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: agent.label,
          kind: 'result',
          content: `FAILED step ${input.step.id}: ${content.slice(0, 2000)}`,
          stepId: input.step.id,
          at: new Date().toISOString(),
        });
        return {
          step: input.step,
          finding: {
            memberId: member.member_id,
            role: agent.label,
            summary: err,
            at: new Date().toISOString(),
            stepId: input.step.id,
          },
          failed: true,
        };
      }

      const parsed = parseMemberFindings(outcome.text);
      const summary = findingsSummaryLine(parsed);
      swarmDb.updateMember(member.member_id, {
        status: 'succeeded',
        findingsSummary: summary,
        error: null,
        finished: true,
      });
      try {
        const current = runService.get(child.run_id);
        if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
          runService.markTerminal(child.run_id, { status: 'succeeded' });
        }
      } catch {
        /* optional */
      }

      // Peer notes on the blackboard.
      const peerNotes =
        (() => {
          try {
            const j = JSON.parse(
              // best-effort extract messagesForPeers from raw
              '',
            );
            return j;
          } catch {
            return null;
          }
        })() || null;
      void peerNotes;

      swarmDb.appendMessage(swarmId, {
        id: newMsgId(),
        from: agent.label,
        kind: 'result',
        content: summary.slice(0, 4000),
        stepId: input.step.id,
        at: new Date().toISOString(),
      });

      // Extract peer messages if present in structured findings.
      try {
        const raw = parsed.rawText;
        const m = raw.match(/"messagesForPeers"\s*:\s*\[([\s\S]*?)\]/);
        if (m) {
          const arr = JSON.parse(`[${m[1]}]`) as unknown;
          if (Array.isArray(arr)) {
            for (const note of arr) {
              if (typeof note === 'string' && note.trim()) {
                swarmDb.appendMessage(swarmId, {
                  id: newMsgId(),
                  from: agent.label,
                  kind: 'note',
                  content: note.trim(),
                  stepId: input.step.id,
                  at: new Date().toISOString(),
                });
              }
            }
          }
        }
      } catch {
        /* optional */
      }

      return {
        step: input.step,
        finding: {
          memberId: member.member_id,
          role: agent.label,
          summary,
          at: new Date().toISOString(),
          stepId: input.step.id,
        },
        failed: false,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      swarmDb.updateMember(member.member_id, {
        status: 'failed',
        error: msg,
        finished: true,
      });
      try {
        const current = runService.get(child.run_id);
        if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
          runService.markTerminal(child.run_id, { status: 'failed', errorSummary: msg });
        }
      } catch {
        /* optional */
      }
      swarmDb.appendMessage(swarmId, {
        id: newMsgId(),
        from: agent.label,
        kind: 'result',
        content: `FAILED step ${input.step.id}: ${msg}`,
        stepId: input.step.id,
        at: new Date().toISOString(),
      });
      return {
        step: input.step,
        finding: {
          memberId: member.member_id,
          role: agent.label,
          summary: msg,
          at: new Date().toISOString(),
          stepId: input.step.id,
        },
        failed: true,
      };
    }
  },

  /** Run a wave of steps, respecting an optional max concurrency cap. */
  async runWaveWithConcurrency<T, R>(
    steps: T[],
    executor: (step: T) => Promise<R>,
    maxConcurrency: number | null,
  ): Promise<R[]> {
    if (!maxConcurrency || maxConcurrency < 1 || steps.length <= 1) {
      return Promise.all(steps.map(executor));
    }
    const results: R[] = new Array<R>(steps.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxConcurrency, steps.length) }, async () => {
      while (cursor < steps.length) {
        const idx = cursor;
        cursor += 1;
        results[idx] = await executor(steps[idx]);
      }
    });
    await Promise.all(workers);
    return results;
  },

  /**
   * When a wave has failed steps, ask the orchestrator for a bounded replan so
   * the swarm can recover without human triage. Returns replacement steps or null.
   * Callers must NOT loop on this (the bounding is on the caller side).
   */
  async replanFailedSteps(
    swarmId: string,
    input: {
      failedSteps: SwarmPlanStep[];
      goal: string;
      projectPath: string;
      parentRunId: string | null;
      orchestrator: SwarmAgentSpec;
      roster: SwarmAgentSpec[];
      skills: string[];
      gitContext: string;
      defaultProvider: LLMProvider | string;
      defaultModel?: string | null;
      plan: SwarmPlan;
      blackboard: SwarmMessage[];
    },
  ): Promise<{ steps: SwarmPlanStep[] } | null> {
    const failed = input.failedSteps;
    const provider = resolveSwarmProvider(
      input.orchestrator.provider || input.defaultProvider,
    );
    if (!isSwarmProvider(provider) || !getSwarmSpawnFn(provider)) return null;

    const failedSummary = failed
      .map((s) => `- ${s.id} [wave ${s.wave ?? '?'} ${s.kind}] ${s.title}${s.assignTo ? ` → ${s.assignTo}` : ''}`)
      .join('\n');

    const prompt = buildStepPrompt({
      agent: input.orchestrator,
      step: {
        id: 'replan',
        title: 'Replan failed steps',
        kind: 'orchestrator',
        wave: 0,
        prompt: [
          `The following steps of your swarm plan failed and need recovery.`,
          ``,
          failedSummary,
          ``,
          `Produce at most ${failed.length} replacement step(s) — recover what you can, skip what is unrecoverable, and never invent steps beyond the failures.`,
        ].join('\n'),
        dependsOn: [],
      },
      goal: input.goal,
      skills: input.skills,
      gitContext: input.gitContext + '\n\n' + input.blackboard.slice(-5).map((b) => `- ${b.from}: ${b.content.slice(0, 300)}`).join('\n'),
      blackboard: input.blackboard,
    });

    let outcome;
    try {
      outcome = await runSwarmAgent({
        projectId: swarmDb.get(swarmId)!.project_id,
        projectPath: input.projectPath,
        provider,
        model: input.orchestrator.model || input.defaultModel || null,
        effort: input.orchestrator.effort || null,
        permissionMode: input.orchestrator.permissionMode || 'bypassPermissions',
        prompt,
        runId: 'replan-failed-steps',
        title: `Swarm Replan (${failed.length} failed)`,
        timeoutMs: 4 * 60 * 1000,
      });
    } catch {
      return null;
    }

    if (!outcome.success) return null;

    // Replacement steps come from JSON { steps: [{ id, title, kind, prompt, ... }] }.
    let replaced: SwarmPlanStep[] | null = null;
    try {
      const parsed = parseJsonFromAgentText(outcome.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        if (Array.isArray(o.steps)) {
        const cleaned = (o.steps as Array<Record<string, unknown>>)
          .filter((s) => typeof s?.title === 'string' && s.title.trim())
          .slice(0, failed.length)
          .map((s, i) => ({
            id: typeof s.id === 'string' ? s.id : `replan-${i + 1}`,
            title: (s.title as string).trim(),
            kind: (isSwarmAgentKind(s.kind) ? s.kind : 'implementer') as SwarmPlanStep['kind'],
            wave: 0,
            assignTo: typeof s.assignTo === 'string' ? s.assignTo : undefined,
            prompt: typeof s.prompt === 'string' ? s.prompt : `Recover failed step ${s.title}`,
            dependsOn: Array.isArray(s.dependsOn) ? (s.dependsOn as string[]) : [],
          }));
          replaced = cleaned;
        }
      }
    } catch {
      replaced = null;
    }
    if (!replaced || replaced.length === 0) return null;
    return { steps: replaced };
  },

  async runOrchestratorHandoff(
    swarmId: string,
    input: {
      goal: string;
      projectPath: string;
      parentRunId: string | null;
      orchestrator: SwarmAgentSpec;
      plan: SwarmPlan | null;
      blackboard: SwarmMessage[];
      findings: SwarmFinding[];
      defaultProvider: LLMProvider | string;
      defaultModel?: string | null;
    },
  ): Promise<SwarmHandoff> {
    const provider = resolveSwarmProvider(
      input.orchestrator.provider || input.defaultProvider,
    );
    const model = input.orchestrator.model ?? input.defaultModel ?? null;
    const fallback = mergeFindingsFallback(
      input.goal,
      input.findings.map((f) => ({
        role: f.role,
        label: f.role,
        findings: parseMemberFindings(f.summary),
      })),
    );

    const baseHandoff = (): SwarmHandoff => ({
      summary: fallback.summary,
      completed: input.plan?.steps
        .filter((s) => s.status === 'succeeded')
        .map((s) => s.title) ?? [],
      remaining: input.plan?.steps
        .filter((s) => s.status !== 'succeeded')
        .map((s) => s.title) ?? [],
      recommendations: fallback.recommendations,
      risks: fallback.risks,
      memberCount: input.findings.length,
      generatedAt: new Date().toISOString(),
      actionItems: fallback.actionItems,
    });

    if (!getSwarmSpawnFn(provider)) {
      return baseHandoff();
    }

    const handoffRun = runService.create({
      source: 'swarm',
      projectId: swarmDb.get(swarmId)?.project_id ?? null,
      parentRunId: input.parentRunId,
      rootRunId: input.parentRunId,
      provider,
      model,
      title: `Swarm handoff: ${input.goal.slice(0, 80)}`,
      trigger: `swarm-handoff:${swarmId}`,
      status: 'running',
      meta: { swarmId, role: 'orchestrator', phase: 'handoff' },
    });

    try {
      const outcome = await runSwarmAgent({
        projectId: swarmDb.get(swarmId)?.project_id ?? '',
        projectPath: input.projectPath,
        provider,
        model,
        effort: input.orchestrator.effort,
        permissionMode: input.orchestrator.permissionMode,
        prompt: buildHandoffPrompt({
          goal: input.goal,
          plan: input.plan,
          blackboard: input.blackboard,
          findings: input.findings,
        }),
        runId: handoffRun.run_id,
      });

      if (!outcome.success || !outcome.text.trim()) {
        try {
          runService.markTerminal(handoffRun.run_id, {
            status: 'failed',
            errorSummary: outcome.errorMessage || 'empty handoff',
          });
        } catch {
          /* optional */
        }
        return baseHandoff();
      }

      const parsed = parseSynthesis(
        outcome.text,
        input.findings.map((f) => parseMemberFindings(f.summary)),
      );

      // Extract completed/remaining if present.
      let completed = baseHandoff().completed;
      let remaining = baseHandoff().remaining;
      try {
        const o = JSON.parse(
          outcome.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
        ) as Record<string, unknown>;
        if (Array.isArray(o.completed)) {
          completed = o.completed.filter((x): x is string => typeof x === 'string');
        }
        if (Array.isArray(o.remaining)) {
          remaining = o.remaining.filter((x): x is string => typeof x === 'string');
        }
      } catch {
        /* optional */
      }

      try {
        const current = runService.get(handoffRun.run_id);
        if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
          runService.markTerminal(handoffRun.run_id, { status: 'succeeded' });
        }
      } catch {
        /* optional */
      }

      const handoff: SwarmHandoff = {
        summary: parsed.summary,
        completed,
        remaining,
        recommendations: parsed.recommendations,
        risks: parsed.risks,
        memberCount: input.findings.length,
        generatedAt: new Date().toISOString(),
        actionItems: parsed.actionItems,
      };

      swarmDb.appendMessage(swarmId, {
        id: newMsgId(),
        from: input.orchestrator.label || 'Orchestrator',
        kind: 'handoff',
        content: handoff.summary.slice(0, 4000),
        at: new Date().toISOString(),
      });

      return handoff;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      try {
        runService.markTerminal(handoffRun.run_id, { status: 'failed', errorSummary: msg });
      } catch {
        /* optional */
      }
      return baseHandoff();
    }
  },

  /** @deprecated Synthesis is now orchestrator handoff; kept for manual re-run. */
  async runSynthesis(
    swarmId: string,
    input: {
      goal: string;
      projectPath: string;
      parentRunId: string | null;
      provider: LLMProvider | string;
      model?: string | null;
      memberResults: Array<{
        role: string;
        label?: string | null;
        findings: ParsedMemberFindings;
      }>;
    },
  ): Promise<SwarmHandoff> {
    const swarm = swarmDb.get(swarmId);
    return this.runOrchestratorHandoff(swarmId, {
      goal: input.goal,
      projectPath: input.projectPath,
      parentRunId: input.parentRunId,
      orchestrator: {
        kind: 'orchestrator',
        label: 'Orchestrator',
        provider: input.provider,
        model: input.model,
      },
      plan: swarm?.plan ?? null,
      blackboard: swarm?.blackboard ?? [],
      findings: (swarm?.findings ?? []).length
        ? swarm!.findings
        : input.memberResults.map((m, i) => ({
            memberId: `legacy-${i}`,
            role: m.label || m.role,
            summary: findingsSummaryLine(m.findings),
            at: new Date().toISOString(),
          })),
      defaultProvider: input.provider,
      defaultModel: input.model,
    });
  },

  /**
   * Notify that the swarm finished with an orchestrator handoff.
   * Agent Swarm does not create Kanban tasks — the handoff message is the conclusion.
   */
  notifyHandoffComplete(swarmId: string, synthesis: SwarmHandoff | null): SwarmHandoff {
    const swarm = swarmDb.get(swarmId);
    const base: SwarmHandoff = synthesis ??
      swarm?.synthesis ?? {
        summary: '',
        completed: [],
        remaining: [],
        recommendations: [],
        risks: [],
        memberCount: 0,
        generatedAt: new Date().toISOString(),
      };

    if (!swarm) return base;

    try {
      systemNotificationsDb.create({
        kind: 'system',
        severity: base.risks?.length ? 'warning' : 'info',
        title: base.prUrl
          ? `Agent Swarm complete + PR: ${swarm.goal.slice(0, 60)}`
          : `Agent Swarm complete: ${swarm.goal.slice(0, 80)}`,
        body: [
          (base.summary || 'Orchestrator handoff ready.').slice(0, 280),
          base.prUrl ? `PR: ${base.prUrl}` : base.prError || null,
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 400),
        source: 'swarm',
        href: base.prUrl ?? null,
        meta: {
          swarmId,
          workspaceId: base.workspaceId ?? swarm.workspace_id,
          prUrl: base.prUrl ?? null,
        },
        dedupeKey: `swarm-complete:${swarmId}`,
      });
    } catch (error) {
      console.warn('[Swarm] failed to create handoff notification', error);
    }

    if (swarm.parent_run_id) {
      try {
        runService.appendEvent(swarm.parent_run_id, {
          run_id: swarm.parent_run_id,
          ts: new Date().toISOString(),
          source: 'swarm',
          type: 'swarm.handoff',
          payload: {
            decision: 'complete',
            summary: base.summary?.slice(0, 500) ?? '',
            pr_url: base.prUrl ?? null,
            workspace_id: base.workspaceId ?? swarm.workspace_id,
            feature_branch: base.featureBranch ?? swarm.feature_branch,
          },
        });
      } catch {
        /* optional */
      }
    }

    // Strip any legacy task-creation fields so clients never show fake task counts.
    return {
      ...base,
      actionItems: undefined,
      createdTaskIds: [],
      tasksCreated: 0,
    };
  },

  /** @deprecated Prefer notifyHandoffComplete — kept for older callers; no Kanban tasks. */
  applyApprovalSideEffects(swarmId: string, synthesis: SwarmHandoff | null): SwarmHandoff {
    return this.notifyHandoffComplete(swarmId, synthesis);
  },

  completeMember(
    swarmId: string,
    memberId: string,
    findingsSummary: string,
  ): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    const member = swarmDb.getMember(memberId);
    if (!member || member.swarm_id !== swarmId)
      throw new CloudError('RUN_NOT_FOUND', `Member not found: ${memberId}`);

    swarmDb.updateMember(memberId, {
      status: 'succeeded',
      findingsSummary,
      finished: true,
    });
    if (member.run_id) {
      try {
        runService.markTerminal(member.run_id, { status: 'succeeded' });
      } catch {
        /* optional */
      }
    }

    swarmDb.appendMessage(swarmId, {
      id: newMsgId(),
      from: member.label || member.role,
      kind: 'result',
      content: findingsSummary,
      at: new Date().toISOString(),
    });

    const findings: SwarmFinding[] = [
      ...swarm.findings.filter((f) => f.memberId !== memberId),
      {
        memberId,
        role: member.label || member.role,
        summary: findingsSummary,
        at: new Date().toISOString(),
      },
    ];
    swarmDb.update(swarmId, { findings });
    return swarmDb.get(swarmId)!;
  },

  async synthesize(swarmId: string, requireApproval?: boolean): Promise<SwarmRun> {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    const members = swarmDb.listMembers(swarmId);
    const projectPath = resolveProjectPath(swarm.project_id);
    const memberResults = members.map((m) => ({
      role: m.role,
      label: m.label,
      findings: parseMemberFindings(m.findings_summary || ''),
    }));

    const synthesis = await this.runSynthesis(swarmId, {
      goal: swarm.goal,
      projectPath,
      parentRunId: swarm.parent_run_id,
      provider: resolveSwarmProvider(
        swarm.config?.orchestrator?.provider || members[0]?.provider,
      ),
      memberResults,
    });

    const needsApproval =
      requireApproval === true ||
      swarm.approval_status === 'pending' ||
      swarm.status === 'awaiting_approval';

    if (needsApproval) {
      const interrupt = interruptsService.create({
        projectId: swarm.project_id,
        kind: 'approval_pending',
        severity: 'warning',
        title: `Agent Swarm ready: ${swarm.goal.slice(0, 80)}`,
        body: synthesis.summary.slice(0, 500),
        runId: swarm.parent_run_id,
        actions: [
          { id: 'approve_swarm', label: 'Acknowledge handoff', style: 'primary' },
          { id: 'reject_swarm', label: 'Reject', style: 'destructive' },
        ],
        meta: { swarmId },
        dedupeKey: `swarm-approval:${swarmId}`,
      });
      swarmDb.update(swarmId, {
        status: 'awaiting_approval',
        approvalStatus: 'pending',
        interruptId: interrupt.interrupt_id,
        synthesis,
      });
    } else {
      const handoff = this.notifyHandoffComplete(swarmId, synthesis);
      swarmDb.update(swarmId, {
        status: 'succeeded',
        synthesis: handoff,
        finished: true,
      });
      if (swarm.parent_run_id) {
        try {
          runService.markTerminal(swarm.parent_run_id, { status: 'succeeded' });
        } catch {
          /* optional */
        }
      }
    }
    return swarmDb.get(swarmId)!;
  },

  /** Resume a swarm paused at the plan-approval gate. */
  approvePlan(swarmId: string): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (swarm.status !== 'awaiting_plan_approval') {
      throw new CloudError(
        'SWARM_NOT_AWAITING_PLAN_APPROVAL',
        `Swarm is not awaiting plan approval (status: ${swarm.status})`,
      );
    }
    const resume = planApprovalGates.get(swarmId);
    swarmDb.update(swarmId, {
      status: 'running',
      approvalStatus: 'approved',
      interruptId: null,
    });
    if (swarm.interrupt_id) {
      try {
        interruptsService.act(swarm.interrupt_id, { key: 'dismiss' });
      } catch {
        /* may already be resolved */
      }
    }
    if (resume) resume(true);
    return swarmDb.get(swarmId)!;
  },

  /** Reject the orchestrator plan; the pipeline ends without dispatching workers. */
  rejectPlan(swarmId: string): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (swarm.status !== 'awaiting_plan_approval') {
      throw new CloudError(
        'SWARM_NOT_AWAITING_PLAN_APPROVAL',
        `Swarm is not awaiting plan approval (status: ${swarm.status})`,
      );
    }
    const resume = planApprovalGates.get(swarmId);
    swarmDb.update(swarmId, {
      status: 'failed',
      approvalStatus: 'rejected',
      finished: true,
    });
    if (swarm.interrupt_id) {
      try {
        interruptsService.act(swarm.interrupt_id, { key: 'dismiss' });
      } catch {
        /* may already be resolved */
      }
    }
    if (resume) resume(false);
    return swarmDb.get(swarmId)!;
  },

  /** Abort a live swarm; running agent sessions are force-killed best-effort. */
  async abort(swarmId: string): Promise<SwarmRun> {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (!['queued', 'planning', 'awaiting_plan_approval', 'running', 'handing_off'].includes(swarm.status)) {
      return swarm;
    }

    abortedPipelines.add(swarmId);
    // Wake any pending plan-approval gate so the pipeline unwinds.
    const resume = planApprovalGates.get(swarmId);
    if (resume) resume(false);

    // Best-effort kill running member sessions.
    const members = swarmDb.listMembers(swarmId);
    for (const member of members) {
      if (member.run_id && ['running', 'queued'].includes(member.status)) {
        const child = runService.get(member.run_id);
        const sessionId = child?.app_session_id;
        if (sessionId) {
          const providerSessionId = (child as { provider_session_id?: string | null }).provider_session_id ?? null;
          const abortFn = providerSessionId ? getSwarmAbortFn(member.provider as LLMProvider) : undefined;
          if (abortFn && providerSessionId) {
            try {
              await abortFn(providerSessionId);
            } catch {
              /* best-effort */
            }
          }
        }
        try {
          runService.markTerminal(member.run_id, { status: 'aborted', errorSummary: 'swarm aborted' });
        } catch {
          /* optional */
        }
        swarmDb.updateMember(member.member_id, {
          status: 'failed',
          error: 'swarm aborted',
          finished: true,
        });
      }
    }

    swarmDb.update(swarmId, {
      status: 'aborted',
      approvalStatus: swarm.status === 'awaiting_plan_approval' ? 'rejected' : null,
      finished: true,
    });
    if (swarm.parent_run_id) {
      try {
        runService.markTerminal(swarm.parent_run_id, {
          status: 'aborted',
          errorSummary: 'swarm aborted',
        });
      } catch {
        /* optional */
      }
    }
    if (swarm.interrupt_id) {
      try {
        interruptsService.act(swarm.interrupt_id, { key: 'dismiss' });
      } catch {
        /* may already be resolved */
      }
    }
    return swarmDb.get(swarmId)!;
  },

  /**
   * Retry a single failed step, reusing its original member seat if one exists.
   * Appends a fresh child run and marks the step succeeded/failed on completion.
   */
  async retryStep(swarmId: string, stepId: string): Promise<SwarmRun> {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (!['succeeded', 'failed', 'aborted'].includes(swarm.status) && swarm.status !== 'awaiting_approval') {
      throw new CloudError('SWARM_STILL_RUNNING', 'Swarm is still running; wait for it to finish');
    }
    const step = swarm.plan?.steps.find((s) => s.id === stepId);
    if (!step) throw new CloudError('SWARM_STEP_NOT_FOUND', `Step not found: ${stepId}`);
    const findings = swarm.findings ?? [];

    swarmDb.update(swarmId, { status: 'running', finished: false });
    try {
      const projectPath = resolveProjectPath(swarm.project_id);
      const result = await this.executeStep(swarmId, {
        step: { ...step, status: undefined },
        goal: swarm.goal,
        projectPath,
        parentRunId: swarm.parent_run_id,
        roster: swarm.roles.length ? swarm.roles : DEFAULT_ROSTER,
        skills: swarm.skills ?? [],
        gitContext: collectProjectGitContext(projectPath),
        defaultProvider: resolveSwarmProvider(swarm.config?.orchestrator?.provider),
        defaultModel: swarm.config?.orchestrator?.model ?? null,
        timeoutMs: swarm.config?.stepTimeoutMs ?? null,
      });
      findings.push(result.finding);
      const livePlan = swarm.plan ? { ...swarm.plan, steps: swarm.plan.steps.map((s) => ({ ...s })) } : null;
      if (livePlan) {
        const idx = livePlan.steps.findIndex((s) => s.id === stepId);
        if (idx >= 0) livePlan.steps[idx] = { ...livePlan.steps[idx], status: result.failed ? 'failed' : 'succeeded' };
      }
      swarmDb.update(swarmId, { findings: [...findings], plan: livePlan });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      findings.push({ memberId: 'retry', role: 'implementer', summary: msg, at: new Date().toISOString(), stepId });
      swarmDb.update(swarmId, { findings: [...findings] });
    }
    swarmDb.update(swarmId, { status: 'failed', finished: true });
    return swarmDb.get(swarmId)!;
  },

  approve(swarmId: string): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    const handoff = this.notifyHandoffComplete(swarmId, swarm.synthesis);
    swarmDb.update(swarmId, {
      status: 'succeeded',
      approvalStatus: 'approved',
      synthesis: handoff,
      finished: true,
    });
    if (swarm.parent_run_id) {
      try {
        runService.markTerminal(swarm.parent_run_id, { status: 'succeeded' });
      } catch {
        /* optional */
      }
    }
    if (swarm.interrupt_id) {
      try {
        interruptsService.act(swarm.interrupt_id, { key: 'dismiss' });
      } catch {
        /* may already be resolved */
      }
    }
    return swarmDb.get(swarmId)!;
  },

  reject(swarmId: string): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    swarmDb.update(swarmId, {
      status: 'failed',
      approvalStatus: 'rejected',
      finished: true,
    });
    if (swarm.parent_run_id) {
      try {
        runService.markTerminal(swarm.parent_run_id, {
          status: 'failed',
          errorSummary: 'Agent swarm rejected',
        });
      } catch {
        /* optional */
      }
    }
    if (swarm.interrupt_id) {
      try {
        interruptsService.act(swarm.interrupt_id, { key: 'dismiss' });
      } catch {
        /* may already be resolved */
      }
    }
    try {
      systemNotificationsDb.create({
        kind: 'system',
        severity: 'warning',
        title: `Agent Swarm rejected: ${swarm.goal.slice(0, 80)}`,
        body: 'The agent swarm was rejected; handoff was discarded.',
        source: 'swarm',
        href: null,
        meta: { swarmId },
        dedupeKey: `swarm-rejected:${swarmId}`,
      });
    } catch {
      /* optional */
    }
    return swarmDb.get(swarmId)!;
  },

  /** Compute the cost/usage rollup from member child runs (computed on read). */
  withUsage(swarm: SwarmRun): SwarmRun {
    const members = swarmDb.listMembers(swarm.swarm_id);
    let totalTokens = 0;
    let totalCostUsd = 0;
    const memberRuns: NonNullable<SwarmRun['usage']>['memberRuns'] = [];
    for (const m of members) {
      let tokens = 0;
      let costUsd = 0;
      let durationMs: number | null = null;
      let runId: string | null = m.run_id;
      if (m.run_id) {
        const child = runService.get(m.run_id);
        if (child) {
          tokens =
            (child.token_total ?? 0) ||
            (child.token_input ?? 0) + (child.token_output ?? 0);
          costUsd = child.cost_usd_estimate ?? 0;
          if (child.started_at && child.finished_at) {
            durationMs = Math.max(
              0,
              new Date(child.finished_at).getTime() - new Date(child.started_at).getTime(),
            );
          }
        } else {
          runId = null;
        }
      }
      totalTokens += tokens;
      totalCostUsd += costUsd;
      memberRuns.push({
        memberId: m.member_id,
        runId,
        label: m.label,
        tokens,
        costUsd,
        durationMs,
      });
    }
    return { ...swarm, usage: { totalTokens, totalCostUsd, memberRuns } };
  },

  get(swarmId: string): SwarmRun | null {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) return null;
    return this.withUsage(swarm);
  },

  list(
    projectId?: string | null,
    limit = 50,
    options: { includeArchived?: boolean; archivedOnly?: boolean } = {},
  ): SwarmRun[] {
    let rows: SwarmRun[];
    if (projectId?.trim()) rows = swarmDb.list(projectId, limit, options);
    else rows = swarmDb.listAll(limit, options);
    return rows.map((row) => this.withUsage(row));
  },

  archive(swarmId: string): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) {
      throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    }
    if (swarm.archived_at) return swarm;
    const live = ['queued', 'planning', 'awaiting_plan_approval', 'running', 'handing_off'].includes(swarm.status);
    if (live) {
      throw new CloudError(
        'RUN_ALREADY_TERMINAL',
        'Cannot archive a live swarm — wait for it to finish first',
      );
    }
    return swarmDb.archive(swarmId)!;
  },

  unarchive(swarmId: string): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) {
      throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    }
    if (!swarm.archived_at) return swarm;
    return swarmDb.unarchive(swarmId)!;
  },

  delete(swarmId: string): void {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) {
      throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    }
    const live = ['queued', 'planning', 'awaiting_plan_approval', 'running', 'handing_off'].includes(swarm.status);
    if (live) {
      throw new CloudError(
        'RUN_ALREADY_TERMINAL',
        'Cannot delete a live swarm — wait for it to finish first',
      );
    }
    activePipelines.delete(swarmId);
    swarmDb.delete(swarmId);
  },

  defaultRoles(): SwarmAgentSpec[] {
    return DEFAULT_ROSTER.map((r) => ({ ...r }));
  },

  defaultRoster(): SwarmAgentSpec[] {
    return DEFAULT_ROSTER.map((r) => ({ ...r }));
  },
};
