import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename as pathBasename, extname as pathExtname, join as pathJoin } from 'node:path';

import spawn from 'cross-spawn';

import {
  agentRunProfilesDb,
  getConnection,
  projectsDb,
  systemNotificationsDb,
  type AgentRunProfile,
} from '@/modules/database/index.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { runService } from '@/modules/runs/index.js';
import {
  downgradeModelForSoftCap,
  evaluateSpend,
  raiseSpendCapInterrupt,
} from '@/modules/runs/spend-governor.service.js';
import { providerCapabilitiesService } from '@/modules/providers/index.js';
import {
  collectProjectGitContext,
  abortSwarmAgentSession,
  acceptanceEvidenceMatches,
  getSwarmSpawnFn,
  isSwarmProvider,
  looksLikeReviewApproval,
  mergeFindingsFallback,
  parseMemberFindings,
  parseOrchestratorPlan,
  parseSynthesis,
  resolveProjectPath,
  resolveSwarmProvider,
  runSwarmAgent,
  stepRequiresSourceChanges,
  type ParsedMemberFindings,
} from '@/modules/swarm/swarm-agent.service.js';
import { estimateCostUsd } from '@/modules/runs/model-pricing.js';
import { parseJsonFromAgentText } from '@/modules/mission-control/index.js';
import { swarmDb } from '@/modules/swarm/swarm.repository.js';
import {
  buildSwarmCostLedger,
  candidateValueScore,
  formatCostStats,
  type SwarmCostLedger,
} from '@/modules/swarm/swarm-cost-ledger.service.js';
import {
  runSwarmValidationGate,
  swarmReportDir,
  type SwarmValidationGateResult,
} from '@/modules/swarm/swarm-validation.service.js';
import {
  captureWorkspaceMutationSnapshot,
  workspaceMutationDetected,
} from '@/modules/swarm/swarm-workspace-changes.service.js';
import {
  applySupervisorEvent,
  applySupervisorPolicy,
  appendSupervisorDecision,
  buildSupervisorPrompt,
  buildSupervisorStep,
  captureWorktreeFingerprint,
  classifySupervisorEvent,
  emptyGoalCard,
  eventFromGoalCard,
  extractCritiquePackets,
  parseSupervisorDecision,
  resolveSupervisorTickBudget,
  routeSupervisorPolicy,
  shouldRefuseReviewer,
  type SupervisorEvent,
} from '@/modules/swarm/swarm-supervisor.service.js';
import type {
  StartSwarmInput,
  SwarmAgentLevel,
  SwarmAgentSpec,
  SwarmAttachment,
  SwarmConfig,
  SwarmFinding,
  SwarmGoalCard,
  SwarmHandoff,
  SwarmMessage,
  SwarmPlan,
  SwarmPlanStep,
  SwarmRoleConfig,
  SwarmRun,
  SwarmStepAttemptRecord,
  SwarmValidationAttemptRecord,
} from '@/modules/swarm/swarm.types.js';
import { filterImagesToUploadStore } from '@/modules/websocket/index.js';
import {
  runGit,
  remoteRepoSlug,
  workspaceService,
  type AgentWorkspace,
} from '@/modules/workspaces/index.js';
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

const MAX_GOAL_CHARS = 12_000;
const MAX_ROSTER_SIZE = 12;
const MAX_PLAN_STEPS = 12;
const MAX_LABEL_CHARS = 120;
const MAX_FOCUS_CHARS = 4_000;
const MAX_PROMPT_CHARS = 12_000;
const MAX_SKILLS = 32;
const MAX_SKILL_CHARS = 160;
// Hard wall-clock ceiling per agent run. Deliberately generous: real work on a
// large repo routinely runs past 15 minutes, and killing a busy agent on the
// clock throws away everything it had done. Stuck agents are caught by the
// stall budget (silence) instead, which is the accurate signal.
const DEFAULT_STEP_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_STEP_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_STEP_MAX_ATTEMPTS = 3;
const STEP_MAX_ATTEMPTS_HARD_CAP = 5;
// Autonomous (long-horizon, unattended) swarms only ever stop on a
// crashed/silent provider — a reviewer/tester finding real issues just
// triggers another attempt. These ceilings are still finite: a genuinely
// circular disagreement between agents must stop eventually rather than
// run unattended for good.
const AUTONOMOUS_STEP_MAX_ATTEMPTS_DEFAULT = 12;
const AUTONOMOUS_STEP_MAX_ATTEMPTS_HARD_CAP = 20;
const DEFAULT_MAX_REPLAN_ROUNDS = 1;
const MAX_REPLAN_ROUNDS_HARD_CAP = 1;
const AUTONOMOUS_MAX_REPLAN_ROUNDS_DEFAULT = 8;
const AUTONOMOUS_MAX_REPLAN_ROUNDS_HARD_CAP = 15;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const TERMINAL_SWARM_STATUSES = new Set(['succeeded', 'failed', 'aborted']);
const PIPELINE_LEASE_TTL_MS = 30_000;
const PIPELINE_OWNER = `swarm-worker:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

const KIND_INSTRUCTIONS: Record<string, string> = {
  orchestrator:
    'You are the Swarm Orchestrator. You plan work, assign it to specialist agents, and produce a final handoff. Prefer cheap models for exploration and expensive models only when quality requires it. Do not implement large code changes yourself unless no implementer is available.',
  explorer:
    'You are an Explorer agent. Map the repo, gather evidence (paths, APIs, tests), and report facts other agents need. Prefer read-only investigation unless a tiny probe is required.',
  implementer:
    'You are an Implementation agent. Make the planned changes in the codebase. Follow existing patterns, keep diffs focused, and report what you changed.',
  reviewer:
    'You are a Review agent. Inspect what explorers/implementers did, verify against the goal, call out bugs, missing tests, and risks. Prefer evidence over generic advice.',
  tester:
    'You are a Test agent. Design and run focused verification, reproduce failures, and report deterministic evidence without making unrelated product changes.',
  security:
    'You are a Security agent. Inspect trust boundaries, permissions, secrets, injection paths, and dependency risk; report concrete exploitable findings.',
  docs:
    'You are a Documentation agent. Update the scoped documentation with accurate examples and verify links/commands.',
  custom: 'You are a specialized swarm agent. Complete your assigned task with concrete evidence.',
};

const STEP_ENVELOPE = `Return a clear work report. Prefer a JSON object (no markdown fences) when possible:
{
  "summary": "what you did / found (2-8 sentences)",
  "findings": ["specific fact with paths"],
  "recommendations": ["next step for other agents"],
  "risks": ["risk if any"],
  "messagesForPeers": ["short note other agents should know"],
  "changedFiles": ["path/to/file"],
  "verification": ["command or evidence proving the result"],
  "acceptance": [{"criterion": "1", "met": true, "evidence": "specific evidence"}],
  "severity": "info" | "warning" | "critical"
}
Acceptance rules: report one "acceptance" entry per numbered acceptance criterion, in order. For "criterion", give the criterion's number exactly as listed (e.g. "1") — do not paraphrase. Never end your turn before emitting this report: it is how your work is graded.`;

const PLAN_ENVELOPE = `Return ONLY a JSON object (no markdown fences):
{
  "summary": "short plan overview",
  "strategy": "how you minimize wall-clock time and token cost while fully covering the goal",
  "costNotes": "which roster seats you use, which you skip, and why (cheap vs strong)",
  "steps": [
    {
      "id": "step-1",
      "title": "short title",
      "kind": "explorer" | "implementer" | "reviewer" | "tester" | "security" | "docs" | "custom",
      "difficulty": "basic" | "medium" | "advanced",
      "assignTo": "exact roster label",
      "scope": ["apps/web/src/cart/**", "the cart page only"],
      "acceptanceCriteria": ["specific observable result"],
      "verificationCommands": ["npm test -- cart"],
      "requiresChanges": true,
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
- Every step needs a "difficulty" and must go to an agent whose level is >= it (see the capability model above).
- Every step needs a "scope": the files, globs or areas that step exclusively owns. Two steps in the same wave MUST have disjoint scopes.
- Every step needs 1-5 concrete acceptanceCriteria. Add verificationCommands only for safe, read-only project checks.
- Set requiresChanges=true ONLY for implementer/docs/custom steps whose acceptance requires a diff. Reviewer, explorer, tester, and security steps MUST set requiresChanges=false — they inspect the tree; a no-op is success.
- Prefer cheaper/low-effort seats for broad exploration and mapping; stronger seats only for hard implementation or critical review.
- Sequence explore → implement → review when dependent.
- All work happens in a dedicated git worktree on a feature branch; after handoff the system will commit, push, and open a PR.
- Hard maximum 12 steps, but that is a ceiling, not a target — see the sizing rules above.`;

const HANDOFF_ENVELOPE = `Return ONLY a JSON object (no markdown fences):
{
  "summary": "final overview / conclusion for the human operator — what the swarm achieved, key evidence, and what they should know next",
  "completed": ["done item"],
  "remaining": ["still open"],
  "recommendations": ["follow-up advice (not backlog tickets)"],
  "risks": ["risk"],
  "verificationTargets": ["/route or screen affected by the change, e.g. /settings"]
}
Rules:
- This is a handoff message only. Do NOT invent Kanban tasks or ticket lists.
- Be concrete: paths, decisions, residual risks.
- verificationTargets: at most 8 app routes a human should look at to verify the change; the system smoke-tests and screenshots them before opening the PR. Use "/" when unsure.
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
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
      });
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
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, forcedError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, stdout, stderr: forcedError ? `${stderr}\n${forcedError}`.trim() : stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* optional */
      }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* optional */ }
        finish(null, `${command} exceeded ${timeoutMs}ms and was killed`);
      }, 5_000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < 1024 * 1024) stdout += String(chunk).slice(0, 1024 * 1024 - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 1024 * 1024) stderr += String(chunk).slice(0, 1024 * 1024 - stderr.length);
    });
    child.on('error', (error: Error) => {
      finish(null, error.message);
    });
    child.on('close', (code: number | null) => {
      finish(code);
    });
  });
}

const activePipelines = new Set<string>();
const swarmMergeLocks = new Map<string, Promise<void>>();

/** Serialize merges into the canonical swarm worktree while workers run apart. */
async function withSwarmMergeLock<T>(workPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = swarmMergeLocks.get(workPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  swarmMergeLocks.set(workPath, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (swarmMergeLocks.get(workPath) === current) swarmMergeLocks.delete(workPath);
  }
}

/** Swarms aborted by the operator mid-run; the pipeline bails between phases. */
const abortedPipelines = new Set<string>();
/** Live provider runs share one swarm cancellation signal. Durable cancellation remains in SQL. */
const pipelineAbortControllers = new Map<string, AbortController>();
let testExecutor: ((swarmId: string) => Promise<void>) | null = null;

function hasLivePipelineLease(swarm: SwarmRun): boolean {
  if (!swarm.lease_owner) return false;
  if (!swarm.lease_expires_at) return true;
  return new Date(swarm.lease_expires_at).getTime() > Date.now();
}

const SWARM_AGENT_KINDS = new Set([
  'orchestrator',
  'explorer',
  'implementer',
  'reviewer',
  'tester',
  'security',
  'docs',
  'custom',
]);

function isSwarmAgentKind(value: unknown): value is string {
  return typeof value === 'string' && SWARM_AGENT_KINDS.has(value);
}

function isReadOnlyKind(kind: string): boolean {
  return kind === 'explorer' || kind === 'reviewer' || kind === 'tester' || kind === 'security';
}

function readOnlyPermissionMode(provider: LLMProvider): string {
  return ['claude', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'pi'].includes(provider)
    ? 'plan'
    : 'default';
}

type SeatCapabilities = ReturnType<typeof providerCapabilitiesService.getProviderCapabilities>;

/** Most autonomous mode that still stops short of full bypass. */
function mostAutonomousNonBypassMode(capabilities: SeatCapabilities): string | null {
  for (const mode of ['auto', 'acceptEdits', 'default']) {
    if (capabilities.permissionModes.includes(mode)) return mode;
  }
  return null;
}

/**
 * Resolve the provider permission mode for one seat.
 *
 * - Read-only seats (explorer/reviewer/orchestrator phases) stay read-only BY
 *   POLICY: a restricting provider mode ('plan') is kept where one exists, and
 *   the permission broker guarantees any prompt is still answered, so a
 *   detached run can never hang on an interactive approval.
 * - Worker seats honor the user's/plan's requested mode verbatim when the
 *   provider supports it (including 'bypassPermissions'/'auto'). Without an
 *   explicit request, the most autonomous non-bypass mode wins
 *   ('auto' → 'acceptEdits' → 'default'), falling back to the provider default.
 *
 * Returns the mode plus a human-readable note when the request was adjusted,
 * so the change can be recorded on the blackboard.
 */
function resolveSeatPermissionMode(input: {
  kind: string;
  provider: LLMProvider;
  capabilities: SeatCapabilities;
  requested: string | null;
}): { mode: string; adjustment: string | null } {
  const { kind, provider, capabilities, requested } = input;
  if (isReadOnlyKind(kind)) {
    const preferred = readOnlyPermissionMode(provider);
    const mode = capabilities.permissionModes.includes(preferred)
      ? preferred
      : capabilities.defaultPermissionMode;
    const adjustment =
      requested && requested !== mode
        ? `requested permission mode "${requested}" overridden with "${mode}" — ${kind} seats are read-only by policy (the permission broker answers any prompt)`
        : null;
    return { mode, adjustment };
  }
  if (requested && capabilities.permissionModes.includes(requested)) {
    return { mode: requested, adjustment: null };
  }
  const mode = mostAutonomousNonBypassMode(capabilities) ?? capabilities.defaultPermissionMode;
  const adjustment = requested
    ? `requested permission mode "${requested}" is not supported by ${provider}; using "${mode}"`
    : null;
  return { mode, adjustment };
}

/**
 * Only pass/persist effort when the provider actually supports it; otherwise
 * the DB/UI would record an effort the runtime silently drops.
 */
function resolveSeatEffort(
  capabilities: SeatCapabilities,
  requested: string | null,
): { effort: string | null; droppedNote: string | null } {
  if (!requested) return { effort: null, droppedNote: null };
  if (capabilities.supportsEffort) return { effort: requested, droppedNote: null };
  return {
    effort: null,
    droppedNote: `effort "${requested}" dropped — provider ${capabilities.provider} does not support reasoning effort`,
  };
}

// A red gate is a work item, not a verdict: the orchestrator gets a real budget
// of remediation rounds before anyone calls the goal unreachable.
const VALIDATION_MAX_ATTEMPTS_DEFAULT = 4;
const VALIDATION_MAX_ATTEMPTS_HARD_CAP = 8;
const AUTONOMOUS_VALIDATION_MAX_ATTEMPTS_DEFAULT = 10;
const AUTONOMOUS_VALIDATION_MAX_ATTEMPTS_HARD_CAP = 20;
const MAX_REMEDIATION_STEPS_PER_ATTEMPT = 3;

/** Capability tiers, weakest → strongest. Mirrors agent-profile swarm_level. */
const LEVEL_RANK: Record<SwarmAgentLevel, number> = { basic: 1, medium: 2, advanced: 3 };
const DEFAULT_LEVEL: SwarmAgentLevel = 'medium';

function isSwarmAgentLevel(value: unknown): value is SwarmAgentLevel {
  return value === 'basic' || value === 'medium' || value === 'advanced';
}

function levelOf(value: unknown): SwarmAgentLevel {
  return isSwarmAgentLevel(value) ? value : DEFAULT_LEVEL;
}

/**
 * Per-step attempt budget: explicit swarm config wins, then the
 * CLOUDCLI_SWARM_STEP_MAX_ATTEMPTS env override, then the default (3);
 * clamped to 1..5.
 */
function resolveStepMaxAttempts(config: SwarmConfig | null): number {
  const autonomous = config?.autonomous === true;
  const hardCap = autonomous ? AUTONOMOUS_STEP_MAX_ATTEMPTS_HARD_CAP : STEP_MAX_ATTEMPTS_HARD_CAP;
  const fromConfig = config?.stepMaxAttempts;
  const fromEnv = Number(process.env.CLOUDCLI_SWARM_STEP_MAX_ATTEMPTS);
  const raw =
    typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0
      ? fromConfig
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : autonomous
          ? AUTONOMOUS_STEP_MAX_ATTEMPTS_DEFAULT
          : DEFAULT_STEP_MAX_ATTEMPTS;
  return Math.min(hardCap, Math.max(1, Math.trunc(raw)));
}

/**
 * Orchestrator replan rounds per wave: explicit swarm config wins, then the
 * CLOUDCLI_SWARM_MAX_REPLAN_ROUNDS env override, then the (autonomous-aware)
 * default; always clamped so replanning can never loop unbounded.
 */
function resolveMaxReplanRounds(config: SwarmConfig | null): number {
  const autonomous = config?.autonomous === true;
  const hardCap = autonomous ? AUTONOMOUS_MAX_REPLAN_ROUNDS_HARD_CAP : MAX_REPLAN_ROUNDS_HARD_CAP;
  const fromConfig = config?.maxReplanRounds;
  const fromEnv = Number(process.env.CLOUDCLI_SWARM_MAX_REPLAN_ROUNDS);
  const raw =
    typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0
      ? fromConfig
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : autonomous
          ? AUTONOMOUS_MAX_REPLAN_ROUNDS_DEFAULT
          : DEFAULT_MAX_REPLAN_ROUNDS;
  return Math.min(hardCap, Math.max(1, Math.trunc(raw)));
}

/**
 * Validation attempt budget: explicit swarm config wins, then the
 * CLOUDCLI_SWARM_VALIDATION_MAX_ATTEMPTS env override, then the default;
 * always clamped so remediation can never loop unbounded.
 */
/** Compact check names for blackboard narration ("lint, build, boot"). */
function shortCheckNames(labels: string[]): string {
  return (
    labels
      .map((label) =>
        label
          .replace(/^npm run /, '')
          .replace(/^Boot app.*$/i, 'boot')
          .replace(/^Visit /, 'visit '),
      )
      .join(', ') || 'unknown checks'
  );
}

function resolveValidationMaxAttempts(config: SwarmConfig | null): number {
  const autonomous = config?.autonomous === true;
  const hardCap = autonomous ? AUTONOMOUS_VALIDATION_MAX_ATTEMPTS_HARD_CAP : VALIDATION_MAX_ATTEMPTS_HARD_CAP;
  const fromConfig = config?.validationMaxAttempts;
  const fromEnv = Number(process.env.CLOUDCLI_SWARM_VALIDATION_MAX_ATTEMPTS);
  const raw =
    typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0
      ? fromConfig
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : autonomous
          ? AUTONOMOUS_VALIDATION_MAX_ATTEMPTS_DEFAULT
          : VALIDATION_MAX_ATTEMPTS_DEFAULT;
  return Math.min(hardCap, Math.max(1, Math.trunc(raw)));
}

/** Observability: record seat-policy adjustments on the blackboard. */
function appendPolicyNote(swarmId: string, seatLabel: string, note: string): void {
  try {
    swarmDb.appendMessage(swarmId, {
      id: newMsgId(),
      from: 'Swarm policy',
      kind: 'system',
      content: `[policy] ${seatLabel}: ${note}`,
      stepId: null,
      at: new Date().toISOString(),
    });
  } catch {
    /* observability only — never block execution */
  }
}

function validateBoundedText(name: string, value: unknown, max: number, required = false): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new CloudError('RUN_NOT_FOUND', `${name} is required`);
  if (text.length > max) {
    throw new CloudError('RUN_NOT_FOUND', `${name} exceeds the ${max} character limit`);
  }
  return text;
}

function validatePlan(plan: SwarmPlan, roster: SwarmAgentSpec[]): SwarmPlan {
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > MAX_PLAN_STEPS) {
    throw new Error(`Swarm plan must contain between 1 and ${MAX_PLAN_STEPS} steps`);
  }
  const ids = new Set<string>();
  const rosterLabels = new Set(roster.filter((a) => a.kind !== 'orchestrator').flatMap((a) => [a.id, a.label.toLowerCase()].filter(Boolean) as string[]));
  for (const step of plan.steps) {
    step.requiresChanges = stepRequiresSourceChanges(step.kind, step.requiresChanges);
    validateBoundedText('plan step id', step.id, 80, true);
    validateBoundedText('plan step title', step.title, 240, true);
    validateBoundedText('plan step prompt', step.prompt, MAX_PROMPT_CHARS, true);
    if (!isSwarmAgentKind(step.kind) || step.kind === 'orchestrator') {
      throw new Error(`Invalid worker kind for step ${step.id}: ${step.kind}`);
    }
    if (step.provider && !isSwarmProvider(step.provider)) {
      throw new Error(`Unknown provider for step ${step.id}: ${step.provider}`);
    }
    if (ids.has(step.id)) throw new Error(`Duplicate swarm plan step id: ${step.id}`);
    ids.add(step.id);
    if (step.assignTo && !rosterLabels.has(step.assignTo) && !rosterLabels.has(step.assignTo.toLowerCase())) {
      throw new Error(`Step ${step.id} assigns unknown roster seat: ${step.assignTo}`);
    }
    if (step.dependsOn && (!Array.isArray(step.dependsOn) || step.dependsOn.length > MAX_PLAN_STEPS)) {
      throw new Error(`Invalid dependencies for step ${step.id}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Swarm plan dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) throw new Error(`Step ${id} depends on unknown step ${dep}`);
      if (dep === id) throw new Error(`Step ${id} cannot depend on itself`);
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return plan;
}

function cancellationRequested(swarmId: string): boolean {
  const swarm = swarmDb.get(swarmId);
  return abortedPipelines.has(swarmId) || Boolean(swarm?.cancel_requested_at) || swarm?.status === 'aborted';
}

function assertNotCancelled(swarmId: string): void {
  if (!cancellationRequested(swarmId)) return;
  const error = new Error('Swarm cancelled');
  error.name = 'AbortError';
  throw error;
}

function persistPlanStepStatus(swarmId: string, stepId: string, status: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = swarmDb.get(swarmId);
    if (!current?.plan || TERMINAL_SWARM_STATUSES.has(current.status)) return;
    const index = current.plan.steps.findIndex((step) => step.id === stepId);
    if (index < 0 || current.plan.steps[index]?.status === status) return;
    const plan: SwarmPlan = {
      ...current.plan,
      steps: current.plan.steps.map((step, i) => i === index ? { ...step, status } : step),
    };
    if (swarmDb.update(swarmId, { plan }, {
      expectedStatuses: [current.status],
      expectedVersion: current.version,
    })) return;
  }
}

function persistGoalCard(swarmId: string, goalCard: SwarmGoalCard): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = swarmDb.get(swarmId);
    if (!current || TERMINAL_SWARM_STATUSES.has(current.status)) return;
    if (swarmDb.update(swarmId, { goalCard }, {
      expectedStatuses: [current.status],
      expectedVersion: current.version,
    })) return;
  }
}

function setOrchestratorMemberStatus(
  swarmId: string,
  status: string,
  findingsSummary?: string | null,
): void {
  const orch = swarmDb
    .listMembers(swarmId)
    .find((member) => member.kind === 'orchestrator' || member.role === 'orchestrator');
  if (!orch) return;
  swarmDb.updateMember(orch.member_id, {
    status,
    findingsSummary: findingsSummary ?? orch.findings_summary,
    finished: false,
  });
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
    (role === 'planner' ? 'orchestrator' : role);
  const label =
    (raw.label && String(raw.label).trim()) ||
    kind.charAt(0).toUpperCase() + kind.slice(1);
  validateBoundedText('agent label', label, MAX_LABEL_CHARS, true);
  if (raw.focus != null) validateBoundedText('agent focus', raw.focus, MAX_FOCUS_CHARS);
  if (Array.isArray(raw.skills) && raw.skills.length > MAX_SKILLS) {
    throw new CloudError('RUN_NOT_FOUND', `An agent may use at most ${MAX_SKILLS} skills`);
  }
  // Orchestrator seats default to bypassPermissions — they drive the whole
  // swarm unattended and must never stall on a permission prompt. This is
  // the *last* resort in the chain: an explicit per-seat permissionMode, or
  // an explicit swarm-level default (`fallback.permissionMode`, e.g. a
  // caller-supplied `input.permissionMode`), both still win. This must never
  // be hardcoded onto the DEFAULT_ROSTER template itself — doing so would
  // make it act like an explicit per-seat value and wrongly outrank a
  // caller's swarm-level override whenever no custom agents are supplied.
  const permissionMode =
    raw.permissionMode ?? fallback.permissionMode ?? (kind === 'orchestrator' ? 'bypassPermissions' : null);
  return {
    id: raw.id || `${kind}-${label}`.toLowerCase().replace(/\s+/g, '-'),
    kind,
    label,
    provider: raw.provider ?? fallback.provider ?? null,
    model: raw.model ?? fallback.model ?? null,
    effort: raw.effort ?? fallback.effort ?? null,
    permissionMode,
    skills: Array.isArray(raw.skills)
      ? raw.skills.map((skill) => validateBoundedText('skill', skill, MAX_SKILL_CHARS, true))
      : [],
    focus: raw.focus,
    level: 'level' in raw && isSwarmAgentLevel(raw.level) ? raw.level : DEFAULT_LEVEL,
    profileId: 'profileId' in raw && typeof raw.profileId === 'string' ? raw.profileId : null,
  };
}

export function resolveRoster(input: StartSwarmInput): {
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

  // Auto-roster: the orchestrator selects worker seats from swarm-tagged
  // agent profiles at plan time. Enabled explicitly (autoRoster: true) or
  // implied when the user supplied ONLY orchestrator seat(s) — either as an
  // explicit agents/roles list without workers, or via the `orchestrator`
  // field with no agents at all. A goal-only start (no seats at all) keeps
  // today's DEFAULT_ROSTER behavior; a full manual roster is untouched.
  const explicitSeatList =
    (Array.isArray(input.agents) && input.agents.length > 0) ||
    (Array.isArray(input.roles) && input.roles.length > 0);
  const autoRoster =
    input.autoRoster !== false &&
    (input.autoRoster === true ||
      (explicitSeatList && roster.every((a) => a.kind === 'orchestrator')) ||
      (!explicitSeatList && Boolean(input.orchestrator)));

  // Ensure orchestrator sits first for readability. Under auto-roster the
  // worker seats are provisioned after the orchestrator's plan selects them.
  const workers = autoRoster ? [] : roster.filter((a) => a.kind !== 'orchestrator');
  roster = [orchestrator, ...workers];

  if (roster.length > MAX_ROSTER_SIZE) {
    throw new CloudError('RUN_NOT_FOUND', `Swarm roster may contain at most ${MAX_ROSTER_SIZE} agents`);
  }
  const ids = new Set<string>();
  for (const seat of roster) {
    const id = validateBoundedText('agent id', seat.id, 120, true);
    if (ids.has(id)) throw new CloudError('RUN_NOT_FOUND', `Duplicate swarm agent id: ${id}`);
    ids.add(id);
    const seatProvider = seat.provider;
    if (seatProvider && !isSwarmProvider(seatProvider)) {
      throw new CloudError('RUN_NOT_FOUND', `Unknown provider for agent "${seat.label}": ${seatProvider}`);
    }
    if (seatProvider && isSwarmProvider(seatProvider) && seat.permissionMode) {
      const capabilities = providerCapabilitiesService.getProviderCapabilities(seatProvider);
      if (!capabilities.permissionModes.includes(seat.permissionMode)) {
        throw new CloudError('RUN_NOT_FOUND', `Permission mode "${seat.permissionMode}" is not supported by ${seatProvider}`);
      }
    }
  }
  if (input.provider && !isSwarmProvider(input.provider)) {
    throw new CloudError('RUN_NOT_FOUND', `Unknown swarm provider: ${input.provider}`);
  }
  if ((input.skills?.length ?? 0) > MAX_SKILLS) {
    throw new CloudError('RUN_NOT_FOUND', `Swarm may use at most ${MAX_SKILLS} skills`);
  }

  const autonomous = input.autonomous === true;
  const stepAttemptsHardCap = autonomous ? AUTONOMOUS_STEP_MAX_ATTEMPTS_HARD_CAP : STEP_MAX_ATTEMPTS_HARD_CAP;
  const validationAttemptsHardCap = autonomous
    ? AUTONOMOUS_VALIDATION_MAX_ATTEMPTS_HARD_CAP
    : VALIDATION_MAX_ATTEMPTS_HARD_CAP;
  const replanRoundsHardCap = autonomous ? AUTONOMOUS_MAX_REPLAN_ROUNDS_HARD_CAP : MAX_REPLAN_ROUNDS_HARD_CAP;
  const config: SwarmConfig = {
    // Approval was historically used to gate Kanban task creation; Agent Swarm
    // now ends on orchestrator handoff only (no task side effects).
    requireApproval: Boolean(input.requireApproval),
    requirePlanApproval: Boolean(input.requirePlanApproval),
    stepTimeoutMs:
      typeof input.stepTimeoutMs === 'number' && Number.isFinite(input.stepTimeoutMs)
        ? Math.min(MAX_STEP_TIMEOUT_MS, Math.max(1_000, Math.trunc(input.stepTimeoutMs)))
        : DEFAULT_STEP_TIMEOUT_MS,
    stallTimeoutMs:
      typeof input.stallTimeoutMs === 'number' &&
      Number.isFinite(input.stallTimeoutMs) &&
      input.stallTimeoutMs > 0
        ? Math.min(MAX_STEP_TIMEOUT_MS, Math.max(30_000, Math.trunc(input.stallTimeoutMs)))
        : null,
    stepMaxAttempts:
      typeof input.stepMaxAttempts === 'number' &&
      Number.isFinite(input.stepMaxAttempts) &&
      input.stepMaxAttempts > 0
        ? Math.min(stepAttemptsHardCap, Math.trunc(input.stepMaxAttempts))
        : null,
    maxConcurrency:
      typeof input.maxConcurrency === 'number' && Number.isFinite(input.maxConcurrency)
        ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.trunc(input.maxConcurrency)))
        : DEFAULT_MAX_CONCURRENCY,
    parallelWriters: input.parallelWriters === true,
    autoRoster,
    validateBeforePr: input.validateBeforePr !== false,
    validationMaxAttempts:
      typeof input.validationMaxAttempts === 'number' &&
      Number.isFinite(input.validationMaxAttempts) &&
      input.validationMaxAttempts > 0
        ? Math.min(validationAttemptsHardCap, Math.trunc(input.validationMaxAttempts))
        : null,
    prOnRedValidation: input.prOnRedValidation !== false,
    autonomous,
    maxReplanRounds:
      typeof input.maxReplanRounds === 'number' &&
      Number.isFinite(input.maxReplanRounds) &&
      input.maxReplanRounds > 0
        ? Math.min(replanRoundsHardCap, Math.trunc(input.maxReplanRounds))
        : null,
    maxSupervisorTicks:
      typeof input.maxSupervisorTicks === 'number' &&
      Number.isFinite(input.maxSupervisorTicks) &&
      input.maxSupervisorTicks > 0
        ? Math.trunc(input.maxSupervisorTicks)
        : null,
    orchestrator,
    agents: workers,
    skills: Array.isArray(input.skills)
      ? [...new Set(input.skills.filter(Boolean).map((skill) => validateBoundedText('skill', skill, MAX_SKILL_CHARS, true)))]
      : [],
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
  // The newest findings and policy decisions are the most useful context for
  // a takeover. Preserve the tail rather than silently feeding agents only
  // the oldest messages after a long swarm.
  return text.length > maxChars ? `…(older messages truncated)\n${text.slice(-maxChars)}` : text;
}

function formatRoster(roster: SwarmAgentSpec[]): string {
  return roster
    .map((a) => {
      const level = levelOf(a.level);
      const bits = [
        `- **${a.label}** (${a.kind})`,
        `level=${level} (${LEVEL_RANK[level]}/3)`,
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

function formatCandidateProfiles(pool: AgentRunProfile[], ledger?: SwarmCostLedger | null): string {
  // Strongest first so the strength ordering is visible without arithmetic.
  return [...pool]
    .sort((a, b) => LEVEL_RANK[levelOf(b.swarm_level)] - LEVEL_RANK[levelOf(a.swarm_level)])
    .map((profile) => {
      const level = levelOf(profile.swarm_level);
      const head = [
        `- profileId=${profile.profile_id}`,
        `name="${profile.name}"`,
        `roles=[${profile.swarm_roles.join(', ')}]`,
        `level=${level} (${LEVEL_RANK[level]}/3)`,
        `provider=${profile.provider}`,
        profile.model ? `model=${profile.model}` : null,
        profile.effort ? `effort=${profile.effort}` : null,
        `permissions=${profile.permission_mode}`,
        profile.description ? `— ${profile.description.slice(0, 160)}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      // Measured history, where any exists: what this profile has actually cost
      // in each role. Absent line = no track record yet, not "free".
      const observed = (profile.swarm_roles as string[])
        .map((role) => {
          const line = formatCostStats(ledger?.get(profile.profile_id, role) ?? null);
          return line ? `    observed as ${role}: ${line}` : null;
        })
        .filter(Boolean);
      return [head, ...observed].join('\n');
    })
    .join('\n');
}

/**
 * How dispatch ACTUALLY executes, stated plainly. Without this the orchestrator
 * assumes ordinary "more agents = faster" parallelism and fans out — which used
 * to cost N full context loads and save nothing, because writers serialize on
 * the single shared worktree. Right-sizing has to be argued from the real cost
 * model, not asserted as "don't over-split".
 */
const SIZING_RULES = `## Execution model and plan sizing (read before choosing how many agents)

How your plan really runs:
- Steps in the same wave with the same kind run **in parallel ONLY if they are read-only** (explorer / reviewer). There is one shared git worktree, so **implementer steps always run one after another**, no matter what wave you put them in.
- So splitting implementation across N agents does **not** make it faster. It costs N full context loads (each agent re-reads the repo and the blackboard from scratch) and runs just as long.
- Serialized implementers cannot see each other's uncommitted work — only each other's short blackboard summaries. Splitting ONE coherent change across two agents therefore produces **worse** code, not just more expensive code.

How to size the plan:
- Start from the smallest plan that fully covers the goal, then add a step only when you can justify it. For a small, single-area change the correct plan is **1-2 steps**. Do not pad it.
- Add a second agent of the same kind ONLY when you can name the **disjoint file set** each one owns, in "scope". If you cannot describe the split in terms of files or directories that do not overlap, it is not a real split — use one agent.
- Parallel exploration is genuinely cheap and genuinely concurrent: use 2-3 explorers when the codebase is large or unfamiliar and the questions are independent. Use ONE explorer (or none) when the area is small or already described in the blackboard.
- One strong agent beats two weak ones on a single coherent change. Reach for the capability LEVEL before reaching for more seats.
- Review is a checking pass, not a vote. One reviewer is normally right; add a second only for a genuinely different lens (e.g. visual/UX vs build/lint correctness) on a large change. Never plan three sequential reviewers — that is slower than a single agent and does not improve the ship decision.
- A step whose only content is "verify what the previous step did" is usually waste — fold it into the previous step's acceptance criteria, or into the review step.
- Prefer wall-clock speed: one implementer who lands the whole change beats a relay of review→fail→re-implement cycles. If a reviewer ships (SHIP / LGTM / approved), stop.

State your seat count and why in "costNotes": how many agents, what disjoint slice each owns, and which available seats you deliberately skipped.`;

/**
 * Two orthogonal signals the orchestrator must reason over instead of guessing
 * from seat names: ROLE (what the agent is for) and LEVEL (how capable it is).
 */
const CAPABILITY_RULES = `## Agent capability model (two signals — use both)
Every candidate carries a ROLE and a LEVEL. Do not infer capability from names.
- ROLE — what the agent is built for: "explorer" (read-only investigation and mapping), "implementer" (writes code), "reviewer" (verifies work). Never staff a step with an agent whose roles do not include that step's kind.
- LEVEL — quantitative capability: basic (1/3) = mechanical, well-specified, low-ambiguity work; medium (2/3) = ordinary feature work with some judgement; advanced (3/3) = architecture, cross-cutting design, subtle debugging, high-stakes review.
Rate each step's "difficulty" ("basic" | "medium" | "advanced") from the work it demands, then staff it with an agent whose LEVEL is >= that difficulty. Never put a basic agent on an advanced step. Do not waste an advanced agent on basic work when a cheaper capable seat exists — but correctness outranks cost: if in doubt, staff up.`;

const AUTO_ROSTER_PLAN_RULES = `- AUTO ROSTER: the roster has only you. Staff every step by setting "profileId" to one of the candidate agent profiles above, choosing a profile whose roles include the step kind AND whose level is >= the step's difficulty. Do NOT invent profile ids and do NOT set assignTo — the system creates the seats from your picks.`;

/** Max goal-context files accepted on swarm start. */
const MAX_SWARM_ATTACHMENTS = 10;

/**
 * Trust-boundary filter for client-supplied attachment descriptors. Only files
 * inside the global upload store (`~/.cloudcli/assets`) are kept.
 */
function normalizeSwarmAttachments(raw: unknown): SwarmAttachment[] {
  const filtered = filterImagesToUploadStore(raw);
  return filtered.slice(0, MAX_SWARM_ATTACHMENTS).map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      path: String(record.path ?? ''),
      name: typeof record.name === 'string' ? record.name : undefined,
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
      size: typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined,
      workspacePath:
        typeof record.workspacePath === 'string' ? record.workspacePath : null,
    };
  }).filter((entry) => entry.path.length > 0);
}

/** Shape passed through to provider runtimes as `options.images`. */
function providerImagesFromAttachments(
  attachments: SwarmAttachment[] | null | undefined,
): Array<{ path: string; name?: string; mimeType?: string }> {
  if (!attachments?.length) return [];
  return attachments.map((attachment) => ({
    path: attachment.path,
    name: attachment.name,
    mimeType: attachment.mimeType,
  }));
}

function safeAttachmentFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-()+ ]+/g, '_').replace(/\s+/g, ' ').trim();
  const base = cleaned.slice(0, 120) || 'attachment';
  // Avoid hidden/traversal-looking names.
  return base.replace(/^\.+/, '') || 'attachment';
}

/**
 * Copy goal attachments into the swarm workspace so agents can open them with
 * ordinary file tools without leaving the worktree. Returns updated descriptors
 * with `workspacePath` set when the copy succeeds.
 */
async function materializeSwarmAttachments(
  workPath: string,
  attachments: SwarmAttachment[],
): Promise<SwarmAttachment[]> {
  if (!attachments.length) return attachments;
  const destDir = pathJoin(workPath, 'tmp', 'cloudcli', 'swarm-attachments');
  await mkdir(destDir, { recursive: true });
  const usedNames = new Set<string>();
  const out: SwarmAttachment[] = [];

  for (const attachment of attachments) {
    if (attachment.workspacePath) {
      // Already materialized (pipeline resume).
      out.push(attachment);
      continue;
    }
    const originalName = attachment.name || pathBasename(attachment.path) || 'attachment';
    let fileName = safeAttachmentFileName(originalName);
    const ext = pathExtname(fileName);
    const stem = ext ? fileName.slice(0, -ext.length) : fileName;
    let counter = 2;
    while (usedNames.has(fileName.toLowerCase())) {
      fileName = `${stem}-${counter}${ext}`;
      counter += 1;
    }
    usedNames.add(fileName.toLowerCase());
    const destAbs = pathJoin(destDir, fileName);
    try {
      await copyFile(attachment.path, destAbs);
      out.push({
        ...attachment,
        workspacePath: `tmp/cloudcli/swarm-attachments/${fileName}`,
      });
    } catch (error) {
      console.warn(
        '[Swarm] Failed to copy attachment into workspace',
        attachment.path,
        error instanceof Error ? error.message : error,
      );
      out.push(attachment);
    }
  }
  return out;
}

/** Prompt section so agents know about PRDs/screenshots attached to the goal. */
function formatAttachmentsForPrompt(attachments: SwarmAttachment[] | null | undefined): string {
  if (!attachments?.length) return '';
  const lines = attachments.map((attachment, index) => {
    const label = attachment.name || pathBasename(attachment.path) || `file-${index + 1}`;
    const workspace = attachment.workspacePath
      ? ` — workspace path: \`${attachment.workspacePath}\``
      : '';
    const store = ` — store path: \`${attachment.path}\``;
    const mime = attachment.mimeType ? ` (${attachment.mimeType})` : '';
    return `${index + 1}. **${label}**${mime}${workspace}${store}`;
  });
  return [
    '## Goal attachments (source of truth — read these)',
    'The operator uploaded these files with the goal (PRD, screenshots, design docs, …).',
    'Prefer the workspace path when present; otherwise open the store path.',
    'Treat attachment content as authoritative requirements for the goal.',
    ...lines,
  ].join('\n');
}

function buildPlanPrompt(input: {
  goal: string;
  roster: SwarmAgentSpec[];
  skills: string[];
  gitContext: string;
  attachments?: SwarmAttachment[] | null;
  /** Auto-roster: swarm-tagged agent profiles the orchestrator must staff from. */
  candidateProfiles?: AgentRunProfile[] | null;
  /** Measured per-profile cost/performance history, when any exists. */
  costLedger?: SwarmCostLedger | null;
}): string {
  const autoRoster = Boolean(input.candidateProfiles && input.candidateProfiles.length > 0);
  const attachmentsBlock = formatAttachmentsForPrompt(input.attachments);
  return [
    KIND_INSTRUCTIONS.orchestrator,
    '',
    '## Goal',
    input.goal,
    attachmentsBlock ? `\n${attachmentsBlock}` : '',
    '',
    autoRoster
      ? [
          '## Roster',
          'Only the orchestrator seat exists so far — you select the worker seats.',
          formatRoster(input.roster),
          '',
          '## Candidate agent profiles (staff steps ONLY from these, by profileId)',
          formatCandidateProfiles(input.candidateProfiles!, input.costLedger ?? null),
        ].join('\n')
      : ['## Available agents (assign work only to these)', formatRoster(input.roster)].join('\n'),
    '',
    CAPABILITY_RULES,
    '',
    SIZING_RULES,
    input.skills.length ? `\n## Skills available\n${input.skills.map((s) => `- ${s}`).join('\n')}` : '',
    '',
    '## Project snapshot',
    input.gitContext,
    '',
    '## Your job',
    'Create the SMALLEST plan that fully covers the goal with top-quality output.',
    'Use the fewest agents that can do it well — every extra agent must own a disjoint slice',
    'you can name. Skip seats that are not useful; an unused seat costs nothing, a redundant',
    'one costs a full context load. Agents share a blackboard and will see prior step results.',
    'All agents work inside a dedicated git worktree (not the primary checkout).',
    'Do not execute the work yourself in this step — only plan. There is no Kanban board;',
    'your later handoff is the conclusion, then the system opens a PR from the worktree.',
    'Do NOT run terminal, git, or file tools. The Project snapshot already includes',
    'workspace path, branch, status, and worktrees. A denied tool aborts this entire turn.',
    '',
    autoRoster ? `${PLAN_ENVELOPE}\n${AUTO_ROSTER_PLAN_RULES}` : PLAN_ENVELOPE,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Auto-roster: map the orchestrator's per-step profile picks onto real roster
 * seats, validating strictly against the candidate pool.
 *
 * - unknown profileId / role mismatch → deterministic fallback: the first
 *   listed candidate tagged for that role whose provider runtime is available;
 * - no tagged candidates for a role at all → the DEFAULT_ROSTER seat of that
 *   kind (default provider);
 * - every fallback is recorded on the blackboard for observability.
 *
 * Returns the worker seats plus the plan with assignTo bound to seat labels.
 */
function resolveAutoRosterFromPlan(input: {
  swarmId: string;
  plan: SwarmPlan;
  pool: AgentRunProfile[];
  defaultProvider: LLMProvider | string;
  defaultModel: string | null;
  /** Measured history; absent/empty falls back to weakest-sufficient by level. */
  costLedger?: SwarmCostLedger | null;
}): { workers: SwarmAgentSpec[]; plan: SwarmPlan } {
  const seats = new Map<string, SwarmAgentSpec>();
  const usedLabels = new Set<string>();

  const uniqueLabel = (base: string, kind: string): string => {
    let label = base.slice(0, MAX_LABEL_CHARS);
    if (usedLabels.has(label.toLowerCase())) {
      label = `${base} (${kind})`.slice(0, MAX_LABEL_CHARS);
    }
    let counter = 2;
    while (usedLabels.has(label.toLowerCase())) {
      label = `${base} ${counter}`.slice(0, MAX_LABEL_CHARS);
      counter += 1;
    }
    usedLabels.add(label.toLowerCase());
    return label;
  };

  const seatForProfile = (profile: AgentRunProfile, kind: string): SwarmAgentSpec => {
    const key = `profile:${profile.profile_id}:${kind}`;
    const existing = seats.get(key);
    if (existing) return existing;
    const seat: SwarmAgentSpec = {
      id: `auto-${profile.profile_id}-${kind}`.toLowerCase(),
      kind,
      label: uniqueLabel(profile.name, kind),
      provider: profile.provider,
      model: profile.model ?? null,
      effort: profile.effort ?? null,
      permissionMode: profile.permission_mode ?? null,
      skills: [],
      focus: profile.description || undefined,
      level: levelOf(profile.swarm_level),
      profileId: profile.profile_id,
    };
    seats.set(key, seat);
    return seat;
  };

  const fallbackSeatForKind = (kind: string): SwarmAgentSpec => {
    const key = `default:${kind}`;
    const existing = seats.get(key);
    if (existing) return existing;
    const template = DEFAULT_ROSTER.find((seat) => seat.kind === kind);
    const seat: SwarmAgentSpec = {
      id: `auto-default-${kind}`,
      kind,
      label: uniqueLabel(template?.label ?? `${kind[0]?.toUpperCase()}${kind.slice(1)}`, kind),
      provider: input.defaultProvider,
      model: input.defaultModel,
      effort: null,
      permissionMode: null,
      skills: [],
      focus: template?.focus,
      level: DEFAULT_LEVEL,
      profileId: null,
    };
    seats.set(key, seat);
    return seat;
  };

  const steps = input.plan.steps.map((step) => {
    if (step.kind === 'orchestrator') return step;
    const runtimeReady = (profile: AgentRunProfile): boolean => {
      const provider = resolveSwarmProvider(profile.provider);
      return isSwarmProvider(provider) && Boolean(getSwarmSpawnFn(provider));
    };
    const candidates = input.pool.filter(
      (profile) => (profile.swarm_roles as string[]).includes(step.kind) && runtimeReady(profile),
    );
    const difficulty = levelOf(step.difficulty);
    const required = LEVEL_RANK[difficulty];
    // Weakest-sufficient first: honour the difficulty floor without burning the
    // strongest seat on work that does not need it.
    const rankedCandidates = [...candidates].sort(
      (a, b) => LEVEL_RANK[levelOf(a.swarm_level)] - LEVEL_RANK[levelOf(b.swarm_level)],
    );
    const capable = rankedCandidates.filter(
      (candidate) => LEVEL_RANK[levelOf(candidate.swarm_level)] >= required,
    );
    /**
     * Among candidates that clear the difficulty bar, prefer the one with the
     * best MEASURED record (reliability first, then cost per successful step).
     * With no history every score is equal and this degrades to the previous
     * weakest-sufficient ordering.
     */
    const bestByValue = (candidates: AgentRunProfile[]): AgentRunProfile | null => {
      if (candidates.length === 0) return null;
      if (!input.costLedger || input.costLedger.isEmpty) return candidates[0];
      return [...candidates].sort((a, b) => {
        const scoreDelta =
          candidateValueScore(input.costLedger!.get(a.profile_id, step.kind, difficulty)) -
          candidateValueScore(input.costLedger!.get(b.profile_id, step.kind, difficulty));
        if (Math.abs(scoreDelta) > 0.01) return scoreDelta;
        // Equal record: keep the cheaper (weaker-but-sufficient) seat.
        return LEVEL_RANK[levelOf(a.swarm_level)] - LEVEL_RANK[levelOf(b.swarm_level)];
      })[0];
    };

    let profile: AgentRunProfile | null = null;
    if (step.profileId) {
      const picked = candidates.find((candidate) => candidate.profile_id === step.profileId) ?? null;
      if (!picked) {
        appendPolicyNote(
          input.swarmId,
          'Auto-roster',
          `step ${step.id}: orchestrator picked profile "${step.profileId}" which is unknown, not tagged for role "${step.kind}", or has no available runtime — falling back to the weakest sufficient candidate`,
        );
      } else if (LEVEL_RANK[levelOf(picked.swarm_level)] < required) {
        // The plan under-staffed a hard step. The difficulty rating is the
        // orchestrator's own judgement, so honour it over its seat pick.
        appendPolicyNote(
          input.swarmId,
          'Auto-roster',
          `step ${step.id}: "${picked.name}" is level ${levelOf(picked.swarm_level)} but the step is rated ${difficulty} — promoting to a capable seat`,
        );
      } else {
        profile = picked;
      }
    } else {
      appendPolicyNote(
        input.swarmId,
        'Auto-roster',
        `step ${step.id}: plan omitted profileId for role "${step.kind}" — using the weakest candidate at level >= ${difficulty}`,
      );
    }
    if (!profile) {
      profile = bestByValue(capable);
      if (profile && input.costLedger && !input.costLedger.isEmpty) {
        const stats = input.costLedger.get(profile.profile_id, step.kind, difficulty);
        if (stats) {
          appendPolicyNote(
            input.swarmId,
            'Auto-roster',
            `step ${step.id}: picked "${profile.name}" on observed record — ${formatCostStats(stats)}`,
          );
        }
      }
    }
    if (!profile && rankedCandidates.length > 0) {
      // Nothing meets the bar: take the strongest available and say so.
      profile = rankedCandidates[rankedCandidates.length - 1];
      appendPolicyNote(
        input.swarmId,
        'Auto-roster',
        `step ${step.id}: no "${step.kind}" profile reaches level ${difficulty} — using the strongest available ("${profile.name}", level ${levelOf(profile.swarm_level)})`,
      );
    }

    if (!profile) {
      const seat = fallbackSeatForKind(step.kind);
      appendPolicyNote(
        input.swarmId,
        'Auto-roster',
        `no swarm-tagged agent profiles available for role "${step.kind}" — using default ${seat.label} seat (${seat.provider})`,
      );
      return { ...step, profileId: null, difficulty, assignTo: seat.label };
    }
    const seat = seatForProfile(profile, step.kind);
    return { ...step, profileId: profile.profile_id, difficulty, assignTo: seat.label };
  });

  return {
    workers: [...seats.values()],
    plan: { ...input.plan, steps },
  };
}

function buildStepPrompt(input: {
  agent: SwarmAgentSpec;
  step: SwarmPlanStep;
  goal: string;
  skills: string[];
  gitContext: string;
  blackboard: SwarmMessage[];
  attachments?: SwarmAttachment[] | null;
}): string {
  const kindBlurb = KIND_INSTRUCTIONS[input.agent.kind] || KIND_INSTRUCTIONS.custom;
  const attachmentsBlock = formatAttachmentsForPrompt(input.attachments);
  return [
    kindBlurb,
    input.agent.focus ? `\n## Role focus\n${input.agent.focus}` : '',
    '',
    '## Swarm goal',
    input.goal,
    attachmentsBlock ? `\n${attachmentsBlock}` : '',
    '',
    '## Your assigned step',
    `**${input.step.title}** (\`${input.step.id}\`, kind=${input.step.kind})`,
    input.step.prompt,
    input.step.acceptanceCriteria?.length
      ? [
          '',
          '## Acceptance criteria (report evidence for each)',
          ...input.step.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
        ].join('\n')
      : '',
    input.step.verificationCommands?.length
      ? [
          '',
          '## Suggested verification commands (read-only checks)',
          ...input.step.verificationCommands.map((command) => `- ${command}`),
        ].join('\n')
      : '',
    input.step.requiresChanges ? '\nThis is an implementation step: a non-empty diff is required for success.' : '',
    // Exclusive ownership: peers may be working other slices of the same goal,
    // so staying inside the scope is what keeps their work from being clobbered.
    input.step.scope?.length
      ? [
          '',
          '## Your exclusive scope',
          'You own these files/areas for this step. Other agents own the rest — do NOT edit outside this list:',
          ...input.step.scope.map((entry) => `- ${entry}`),
          'If the step cannot be completed without touching something outside your scope, say so in your report instead of editing it.',
        ].join('\n')
      : '',
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
  attachments?: SwarmAttachment[] | null;
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

  const attachmentsBlock = formatAttachmentsForPrompt(input.attachments);
  return [
    KIND_INSTRUCTIONS.orchestrator,
    '',
    '## Goal',
    input.goal,
    attachmentsBlock ? `\n${attachmentsBlock}` : '',
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
    'Do NOT run terminal, git, or file tools. Use the blackboard and findings only.',
    'A denied tool aborts this entire turn.',
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
  if (parsed.changedFiles.length) {
    bits.push(`Changed files: ${parsed.changedFiles.slice(0, 20).join(', ')}`);
  }
  if (parsed.verification.length) {
    bits.push(`Verification: ${parsed.verification.slice(0, 8).join(' · ')}`);
  }
  if (parsed.acceptance.length) {
    bits.push(
      'Acceptance evidence:\n' +
        parsed.acceptance
          .slice(0, 8)
          .map((entry) => `• [${entry.met ? 'met' : 'unmet'}] ${entry.criterion}${entry.evidence ? ` — ${entry.evidence}` : ''}`)
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

/** Mutable roster handle: seats provisioned mid-run are visible to later steps. */
type RosterRef = { current: SwarmAgentSpec[] };

/**
 * Pick a DIFFERENT seat to take over a step that just failed or stalled.
 *
 * Reassignment is capability-aware: the replacement must be at least as strong
 * as the seat that failed (a weaker agent will not succeed where a stronger one
 * did not), and at least as strong as the step's own difficulty rating. Roster
 * seats are preferred; under auto-roster a fresh seat is provisioned from the
 * profile pool when the roster has no untried capable seat. Returns null when
 * no alternative exists — the caller then retries the same seat with feedback.
 */
/**
 * Identity of the *agent* behind a seat, not the seat row. Two differently-named
 * profiles on the same provider + model + effort are the same agent for retry
 * purposes: handing a failed step to one after the other is a re-run, not a
 * second opinion.
 */
function agentSignature(input: {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
}): string {
  return [
    (input.provider ?? '').toLowerCase(),
    (input.model ?? '').toLowerCase(),
    (input.effort ?? '').toLowerCase(),
  ].join('|');
}

/**
 * Is this candidate a meaningfully different attempt from everything already
 * tried? Either a different agent, or the same agent at a strictly higher
 * capability tier — escalating level is a real change, so "Claude medium failed,
 * try Claude advanced" must be allowed even though the provider matches.
 */
function isDistinctRetryCandidate(
  candidate: { signature: string; levelRank: number },
  tried: { signatures: Set<string>; maxLevelRank: number },
): boolean {
  return !tried.signatures.has(candidate.signature) || candidate.levelRank > tried.maxLevelRank;
}

function pickReassignmentSeat(input: {
  swarmId: string;
  step: SwarmPlanStep;
  rosterRef: RosterRef;
  /** Seat ids already tried for this step. */
  triedSeatIds: Set<string>;
  /** provider|model|effort signatures already tried for this step. */
  triedSignatures: Set<string>;
  /** Highest capability tier already tried, so escalation is still allowed. */
  maxTriedLevelRank: number;
  /** Measured history used to rank substitutes; optional. */
  costLedger?: SwarmCostLedger | null;
  autoRoster: boolean;
  defaultProvider: LLMProvider | string;
  defaultModel: string | null;
  failedSeat: SwarmAgentSpec;
}): { seat: SwarmAgentSpec; note: string } | null {
  const kind = input.step.kind;
  const difficultyLabel = levelOf(input.step.difficulty);
  // At least as capable as the seat that just failed, and at least as capable as
  // the step itself demands. A weaker agent will not succeed where a stronger
  // one did not.
  const floor = Math.max(
    LEVEL_RANK[levelOf(input.failedSeat.level)],
    LEVEL_RANK[levelOf(input.step.difficulty)],
  );
  const eligibleKind = (seat: SwarmAgentSpec): boolean =>
    seat.kind === kind || (kind === 'implementer' && seat.kind === 'custom');

  const rosterCandidates = input.rosterRef.current
    .filter(
      (seat) =>
        eligibleKind(seat) &&
        !input.triedSeatIds.has(seat.id ?? seat.label) &&
        LEVEL_RANK[levelOf(seat.level)] >= floor,
    )
    // Weakest sufficient first, so escalation is gradual across attempts.
    .sort((a, b) => LEVEL_RANK[levelOf(a.level)] - LEVEL_RANK[levelOf(b.level)]);
  const tried = { signatures: input.triedSignatures, maxLevelRank: input.maxTriedLevelRank };
  // A genuinely different agent (or a strictly stronger one) beats a clone.
  const freshRosterSeat =
    rosterCandidates.find((seat) =>
      isDistinctRetryCandidate(
        { signature: agentSignature(seat), levelRank: LEVEL_RANK[levelOf(seat.level)] },
        tried,
      ),
    ) ?? null;
  if (freshRosterSeat) {
    return {
      seat: freshRosterSeat,
      note: `reassigned to roster seat "${freshRosterSeat.label}" (level ${levelOf(freshRosterSeat.level)}, ${freshRosterSeat.provider ?? 'default provider'})`,
    };
  }

  // No untried roster seat of the right capability. Draw an equally-or-more
  // capable agent from the profile pool instead. This applies to MANUAL rosters
  // too: a lean roster is now the norm, so "one implementer failed" must not
  // mean "retry the same agent forever" — the goal has to be met. Bringing in a
  // seat the operator did not list is recorded on the blackboard.
  let pool: AgentRunProfile[];
  try {
    pool = agentRunProfilesDb.list({
      swarmRole: kind === 'custom' ? 'implementer' : (kind as 'explorer' | 'implementer' | 'reviewer'),
      enabledOnly: true,
    });
  } catch {
    pool = [];
  }
  const triedProfileIds = new Set(
    input.rosterRef.current
      .filter((seat) => input.triedSeatIds.has(seat.id ?? seat.label))
      .map((seat) => seat.profileId)
      .filter((id): id is string => Boolean(id)),
  );
  const rosterProfileIds = new Set(
    input.rosterRef.current.map((seat) => seat.profileId).filter((id): id is string => Boolean(id)),
  );
  const capable = pool
    .filter((profile) => {
      const provider = resolveSwarmProvider(profile.provider);
      return isSwarmProvider(provider) && Boolean(getSwarmSpawnFn(provider));
    })
    .filter((profile) => !triedProfileIds.has(profile.profile_id))
    .filter((profile) => LEVEL_RANK[levelOf(profile.swarm_level)] >= floor)
    .sort((a, b) => LEVEL_RANK[levelOf(a.swarm_level)] - LEVEL_RANK[levelOf(b.swarm_level)]);

  // Prefer a different agent (provider+model) that is also not already seated;
  // then any different agent; only then fall back to a clone of one already tried.
  const differentAgent = capable.filter((profile) =>
    isDistinctRetryCandidate(
      {
        signature: agentSignature({
          provider: profile.provider,
          model: profile.model,
          effort: profile.effort,
        }),
        levelRank: LEVEL_RANK[levelOf(profile.swarm_level)],
      },
      tried,
    ),
  );
  // Among valid substitutes, prefer the best MEASURED record at this difficulty
  // (reliability first, then cost per success); no history keeps the previous
  // weakest-sufficient order. A substitute is a second chance — spending it on
  // an agent with a known-bad record at this difficulty wastes the attempt.
  const ranked =
    input.costLedger && !input.costLedger.isEmpty
      ? [...differentAgent].sort(
          (a, b) =>
            candidateValueScore(input.costLedger!.get(a.profile_id, kind, difficultyLabel)) -
            candidateValueScore(input.costLedger!.get(b.profile_id, kind, difficultyLabel)),
        )
      : differentAgent;
  const profile =
    ranked.find((candidate) => !rosterProfileIds.has(candidate.profile_id)) ?? ranked[0] ?? null;

  if (!profile) {
    // Nothing new to offer. The caller retries the same seat with feedback,
    // which is still worth one more attempt (the failure text is new information).
    return null;
  }

  const usedLabels = new Set(input.rosterRef.current.map((seat) => seat.label.toLowerCase()));
  let label = profile.name.slice(0, MAX_LABEL_CHARS);
  let counter = 2;
  while (usedLabels.has(label.toLowerCase())) {
    label = `${profile.name} ${counter}`.slice(0, MAX_LABEL_CHARS);
    counter += 1;
  }
  const seat: SwarmAgentSpec = {
    id: `takeover-${profile.profile_id}-${input.step.id}`.toLowerCase().slice(0, 120),
    kind,
    label,
    provider: profile.provider,
    model: profile.model ?? null,
    effort: profile.effort ?? null,
    permissionMode: profile.permission_mode ?? null,
    skills: [],
    focus: profile.description || undefined,
    level: levelOf(profile.swarm_level),
    profileId: profile.profile_id,
  };
  input.rosterRef.current = [...input.rosterRef.current, seat];
  try {
    swarmDb.update(input.swarmId, { roles: input.rosterRef.current });
  } catch {
    /* roster persistence is observability only; the run continues */
  }
  if (!input.autoRoster) {
    appendPolicyNote(
      input.swarmId,
      'Swarm policy',
      `step ${input.step.id}: no untried ${kind} seat at level ${Object.keys(LEVEL_RANK).find((key) => LEVEL_RANK[key as SwarmAgentLevel] === floor) ?? 'required'}+ in the manual roster — brought in "${seat.label}" (profile "${profile.name}") to take the step over`,
    );
  }
  return {
    seat,
    note: `handed off to a newly provisioned seat "${seat.label}" (level ${levelOf(seat.level)}, profile "${profile.name}", ${seat.provider ?? 'default provider'})`,
  };
}

/** Test seam: the seat-selection rule is pure and worth asserting directly. */
export const pickReassignmentSeatForTest = pickReassignmentSeat;

/** Feedback block prepended to a retried step so the next agent starts informed. */
function buildRetryFeedback(
  history: SwarmStepAttemptRecord[],
  partialOutput: string | null,
  reassigned: boolean,
): string {
  const lines = [
    '## PREVIOUS ATTEMPTS AT THIS EXACT STEP FAILED — READ BEFORE STARTING',
    'These attempts are ground truth. Do not repeat what already failed.',
    '',
    ...history.map(
      (entry) =>
        `- Attempt ${entry.attempt} by "${entry.seatLabel}" — ${entry.outcome}${entry.error ? `: ${entry.error.slice(0, 600)}` : ''}`,
    ),
  ];
  if (partialOutput && partialOutput.trim()) {
    lines.push(
      '',
      'Partial output from the last attempt (it may have completed real work — verify before redoing it):',
      '```',
      partialOutput.trim().slice(-2_500),
      '```',
    );
  }
  const last = history[history.length - 1];
  if (last && (last.outcome === 'stalled' || last.outcome === 'timed_out')) {
    lines.push(
      '',
      'That attempt was killed for running too long without producing output. Work in smaller verifiable increments, prefer targeted commands over repo-wide scans, and report progress as you go.',
    );
  }
  if (reassigned) {
    lines.push(
      '',
      'You are a DIFFERENT agent taking this step over. Re-verify the current state of the worktree yourself rather than trusting the previous attempt.',
    );
  }
  lines.push('', '## The step (unchanged)');
  return lines.join('\n');
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
function unresolvedPlanSteps(plan: SwarmPlan | null): SwarmPlanStep[] {
  if (!plan) return [];
  const recovered = new Set(
    plan.steps
      .filter((step) => step.status === 'recovered' && step.replacesStepId)
      .map((step) => step.replacesStepId as string),
  );
  return plan.steps.filter(
    (step) => (step.status === 'failed' || step.status === 'needs_changes') && !recovered.has(step.id),
  );
}

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

/**
 * Normalize a declared scope entry for comparison: lowercase, strip a leading
 * `./`, drop glob tails so `src/cart/**` and `src/cart/page.tsx` compare as the
 * same area, and collapse whitespace in prose scopes ("the cart page only").
 */
function normalizeScopeEntry(entry: string): string {
  return entry
    .trim()
    .toLowerCase()
    .replace(/^\.\//, '')
    .replace(/\/?\*+.*$/, '')
    .replace(/\/+$/, '')
    .replace(/\s+/g, ' ');
}

/** True when two scope entries name the same area or one contains the other. */
function scopeEntriesOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Path containment: "src/cart" vs "src/cart/page.tsx".
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The overlapping scope entries between two steps (empty when disjoint). */
function overlappingScopes(a: SwarmPlanStep, b: SwarmPlanStep): string[] {
  const left = (a.scope ?? []).map(normalizeScopeEntry).filter(Boolean);
  const right = (b.scope ?? []).map(normalizeScopeEntry).filter(Boolean);
  const hits = new Set<string>();
  for (const entry of left) {
    for (const other of right) {
      if (scopeEntriesOverlap(entry, other)) hits.add(entry === other ? entry : `${entry} ~ ${other}`);
    }
  }
  return [...hits];
}

/**
 * Split a wave so that no two steps of the same kind run together unless their
 * declared scopes are disjoint. This is the "several agents on one thing" guard:
 * a step with no declared scope is treated as owning everything of its kind, so
 * an unscoped fan-out serializes too.
 *
 * Nothing is dropped or merged — over-splitting only costs the wall-clock it was
 * never going to save, and the caller records what happened on the blackboard.
 */
export function splitWaveByScope(wave: SwarmPlanStep[]): {
  groups: SwarmPlanStep[][];
  conflicts: Array<{ step: string; against: string; kind: string; overlap: string[] }>;
} {
  const groups: SwarmPlanStep[][] = [];
  const conflicts: Array<{ step: string; against: string; kind: string; overlap: string[] }> = [];

  for (const step of wave) {
    const target = groups.find((group) =>
      group.every((member) => {
        if (member.kind !== step.kind) return true;
        const memberScope = (member.scope ?? []).filter(Boolean);
        const stepScope = (step.scope ?? []).filter(Boolean);
        // Undeclared scope = assume it owns everything of its kind.
        if (memberScope.length === 0 || stepScope.length === 0) return false;
        return overlappingScopes(member, step).length === 0;
      }),
    );
    if (target) {
      target.push(step);
      continue;
    }
    // Record why this step could not join an existing group.
    const blocker = groups
      .flat()
      .find((member) => member.kind === step.kind);
    if (blocker) {
      const overlap = overlappingScopes(blocker, step);
      conflicts.push({
        step: step.id,
        against: blocker.id,
        kind: step.kind,
        overlap:
          overlap.length > 0
            ? overlap
            : [(blocker.scope ?? []).length === 0 || (step.scope ?? []).length === 0 ? 'no declared scope' : 'same area'],
      });
    }
    groups.push([step]);
  }

  return { groups, conflicts };
}

export const swarmService = {
  start(input: StartSwarmInput): SwarmRun {
    if (!input.projectId?.trim())
      throw new CloudError('RUN_NOT_FOUND', 'projectId is required');
    if (!projectsDb.getProjectById(input.projectId))
      throw new CloudError('RUN_NOT_FOUND', `Project not found: ${input.projectId}`);
    const goal = validateBoundedText('goal', input.goal, MAX_GOAL_CHARS, true);
    const attachments = normalizeSwarmAttachments(input.attachments ?? []);
    const idempotencyKey = input.idempotencyKey
      ? validateBoundedText('idempotency key', input.idempotencyKey, 200, true)
      : null;
    if (idempotencyKey) {
      const existing = swarmDb.getByIdempotency(input.projectId, idempotencyKey);
      if (existing) return this.withUsage(existing);
    }

    const budget = runService.getBudget(input.projectId);
    const stats = runService.projectStats(input.projectId);
    if (
      (budget.monthly_token_budget != null && stats.tokensMonth >= budget.monthly_token_budget) ||
      (budget.monthly_cost_usd_budget != null && stats.costMonth >= budget.monthly_cost_usd_budget)
    ) {
      throw new CloudError('PACK_BUDGET_EXCEEDED', 'Project run budget is exhausted; increase it before starting a swarm');
    }

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

    const created = getConnection().transaction(() => {
      if (idempotencyKey) {
        const existing = swarmDb.getByIdempotency(input.projectId, idempotencyKey);
        if (existing) return { swarm: existing, created: false };
      }
      const parent = runService.create({
        source: 'swarm',
        projectId: input.projectId,
        title: `Agent Swarm: ${goal.slice(0, 120)}`,
        trigger: 'swarm.start',
        status: 'running',
        provider: defaultProvider,
        model: orchestrator.model ?? input.model ?? null,
        meta: {
          goal,
          roster,
          requireApproval: config.requireApproval,
          skills: config.skills,
          attachments,
        },
      });
      const fresh = swarmDb.create({
        projectId: input.projectId,
        goal,
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
        attachments,
        idempotencyKey,
      });
      // Roster rows are seats, not attempts. Child runs are created only when a
      // seat is actually dispatched, avoiding orphan queued runs.
      for (const seat of roster) {
        const provider = resolveSwarmProvider(seat.provider || defaultProvider);
        swarmDb.createMember({
          swarmId: fresh.swarm_id,
          role: seat.kind,
          kind: seat.kind,
          label: seat.label,
          provider,
          model: seat.model ?? null,
          effort: seat.effort ?? null,
          permissionMode: seat.permissionMode ?? null,
          skills: seat.skills ?? config.skills,
          runId: null,
          status: 'queued',
        });
      }
      return { swarm: swarmDb.get(fresh.swarm_id)!, created: true };
    }).immediate();
    const swarm = created.swarm;
    if (!created.created) return this.withUsage(swarm);
    const parentRunId = swarm.parent_run_id;

    swarmDb.appendMessage(swarm.swarm_id, {
      id: newMsgId(),
      from: 'system',
      kind: 'system',
      content: attachments.length
        ? `Agent Swarm started for goal: ${goal} (${attachments.length} attachment${attachments.length === 1 ? '' : 's'})`
        : `Agent Swarm started for goal: ${goal}`,
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
      try {
        const current = swarmDb.get(swarm.swarm_id);
        if (current?.status === 'aborted') return;
        console.error('[Swarm] pipeline failed', swarm.swarm_id, error);
        if (current && !TERMINAL_SWARM_STATUSES.has(current.status)) {
          swarmDb.update(swarm.swarm_id, {
            status: 'failed',
            finished: true,
            lastError: error instanceof Error ? error.message : String(error),
          }, { expectedStatuses: [current.status], expectedVersion: current.version });
          reconcileTerminalMembers(
            swarm.swarm_id,
            'failed',
            error instanceof Error ? error.message : String(error),
          );
        }
        if (current && current.status !== 'aborted' && parentRunId) {
          runService.markTerminal(parentRunId, {
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
            return {
              workspace: workspaceService.get(existing.workspace_id)!,
              workPath: workspaceService.resolveCwd(existing.workspace_id),
            };
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

    return { workspace, workPath: workspaceService.resolveCwd(workspace.workspace_id) };
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
    assertNotCancelled(swarmId);

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

    const cwd = workspaceService.resolveCwd(workspace.workspace_id);
    const branch = workspace.feature_branch;

    // Stage + commit any remaining agent changes.
    try {
      const status = await runGit(cwd, ['status', '--porcelain']);
      assertNotCancelled(swarmId);
      if (status.code === 0 && status.stdout.trim()) {
        await runGit(cwd, ['add', '-A']);
        assertNotCancelled(swarmId);
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
        assertNotCancelled(swarmId);
        if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
          // Retry without custom author if config forbids it.
          await runGit(cwd, ['commit', '-m', commitMsg]);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ...base, prError: `Could not commit swarm changes: ${msg}` };
    }

    // Fail fast if the branch has nothing to offer main: pushing it anyway
    // only produces a much later, confusing "No commits between" GraphQL
    // error from `gh pr create`, after a needless push. This is the case
    // where every plan step ended up read-only/no-op — see
    // validatePlan's implementer-step requirement, which now catches this
    // earlier for new plans, but resumed/manual-roster runs can still land
    // here.
    const baseBranchForDiff = workspace.base_branch || 'main';
    assertNotCancelled(swarmId);
    const aheadCount = await runGit(cwd, ['rev-list', '--count', `${baseBranchForDiff}..HEAD`]);
    if (aheadCount.code === 0 && aheadCount.stdout.trim() === '0') {
      return {
        ...base,
        pushed: false,
        prError:
          `No changes to submit: branch ${branch} has no commits ahead of ${baseBranchForDiff}. ` +
          'The swarm never produced a diff (likely every plan step was read-only/no-op) — skipped push and PR.',
      };
    }

    // Push feature branch.
    assertNotCancelled(swarmId);
    const push = await runGit(cwd, ['push', '-u', 'origin', branch]);
    assertNotCancelled(swarmId);
    if (push.code !== 0) {
      const detail = (push.stderr || push.stdout).trim().slice(0, 800);
      return {
        ...base,
        pushed: false,
        prError: `Could not push branch ${branch}: ${detail || 'git push failed'}`,
      };
    }

    const pushedBase: SwarmHandoff = { ...base, pushed: true };

    // Open a real (ready-for-review) PR via GitHub CLI — deliberately not a
    // draft. The swarm's job ends here: a human reviews the worktree, then
    // merges the PR on GitHub. Nothing downstream merges to the base branch.
    // A red gate still ships a PR (the branch and its PDF report are the input
    // to a follow-up swarm), but it must be impossible to mistake for green.
    const validationRed = handoff.validation ? handoff.validation.passed === false : false;
    const prTitle = `${validationRed ? '[VALIDATION RED] ' : ''}Agent Swarm: ${swarm.goal.slice(0, 100)}`;
    const failedCheckLabels = (handoff.validation?.checks ?? [])
      .filter((check) => check.status === 'failed')
      .map((check) => check.label);
    const prBody = [
      validationRed
        ? [
            '> [!CAUTION]',
            `> **Do not merge as-is — the pre-PR validation gate is still red after ${handoff.validation?.attempts?.length ?? 1} attempt(s).**`,
            failedCheckLabels.length ? `> Failing checks: ${failedCheckLabels.join(', ')}` : '',
            '> The branch and the attached validation report are published so the remaining work can be picked up (e.g. by a follow-up swarm on this branch).',
            '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
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
      handoff.validation
        ? [
            '### Pre-PR validation',
            handoff.validation.summary,
            handoff.validation.attempts?.length
              ? `Attempt history:\n${handoff.validation.attempts
                  .map(
                    (entry) =>
                      `- attempt ${entry.attempt}: ${entry.passed ? 'passed' : `failed (${entry.failedChecks.join(', ') || 'see report'})`}${
                        entry.remediationSteps?.length
                          ? ` — remediation: ${entry.remediationSteps.join('; ')}`
                          : ''
                      }`,
                  )
                  .join('\n')}`
              : '',
            handoff.validation.checks.length
              ? handoff.validation.checks.map((check) => `- ${check.label}: ${check.status}`).join('\n')
              : '',
            handoff.validation.reportPdfPath || handoff.validation.reportHtmlPath
              ? `Report: \`${handoff.validation.reportPdfPath ?? handoff.validation.reportHtmlPath}\``
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
      '',
      `---`,
      `_Opened automatically by CloudCLI Agent Swarm \`${swarmId}\` from worktree \`${workspace.workspace_id}\`._`,
    ]
      .filter(Boolean)
      .join('\n');

    const baseBranch = workspace.base_branch || 'main';
    // Pin the target repo to the remote we pushed to; see remoteRepoSlug.
    const repoSlug = await remoteRepoSlug(cwd);
    const repoArgs = repoSlug ? ['--repo', repoSlug] : [];
    const created = await runCli(
      'gh',
      [
        'pr',
        'create',
        ...repoArgs,
        '--head',
        branch,
        '--base',
        baseBranch,
        '--title',
        prTitle,
        '--body',
        prBody,
      ],
      cwd,
    );
    assertNotCancelled(swarmId);
    const output = `${created.stdout}\n${created.stderr}`.trim();
    if (created.code !== 0) {
      // Already-open PR is success-ish — try to recover URL.
      const existing = await runCli(
        'gh',
        [
          'pr',
          'view',
          branch,
          ...repoArgs,
          '--json',
          'url,number',
          '--jq',
          '.url + " " + (.number|tostring)',
        ],
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
        return { ...pushedBase, prUrl: existingUrl, prNumber: number, prError: null };
      }
      const target = `${repoSlug ?? '(unresolved repo)'} ${branch} → ${baseBranch}`;
      return {
        ...pushedBase,
        prError: `Could not create PR [${target}]: ${
          output.slice(-1000) || 'gh pr create failed'
        }`,
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

    return { ...pushedBase, prUrl: url, prNumber: number, prError: url ? null : 'PR created but no URL returned' };
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
      /** Manual retry may target one step without hiding other failures. */
      retryStepId?: string | null;
      /** Resume every unresolved checkpoint while preserving completed work. */
      resumeFromFailure?: boolean;
    } = {},
  ): Promise<SwarmRun> {
    if (activePipelines.has(swarmId)) {
      const current = swarmDb.get(swarmId);
      if (current) return current;
      throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    }
    if (!swarmDb.tryAcquireLease(swarmId, PIPELINE_OWNER, PIPELINE_LEASE_TTL_MS)) {
      const current = swarmDb.get(swarmId);
      if (current) return current;
      throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    }
    activePipelines.add(swarmId);
    const abortController = new AbortController();
    pipelineAbortControllers.set(swarmId, abortController);
    const leaseHeartbeat = setInterval(() => {
      if (!swarmDb.renewLease(swarmId, PIPELINE_OWNER, PIPELINE_LEASE_TTL_MS)) {
        abortController.abort();
      }
    }, PIPELINE_LEASE_TTL_MS / 3);
    leaseHeartbeat.unref?.();

    try {
      if (testExecutor) {
        await testExecutor(swarmId);
        return swarmDb.get(swarmId)!;
      }

      const swarm = swarmDb.get(swarmId);
      if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
      if (TERMINAL_SWARM_STATUSES.has(swarm.status)) return swarm;
      if (swarm.status === 'awaiting_plan_approval') return swarm;
      assertNotCancelled(swarmId);
      for (const stale of swarmDb.listAttempts(swarmId).filter((attempt) => attempt.status === 'running')) {
        swarmDb.updateAttempt(stale.attempt_id, {
          status: 'failed',
          error: 'recovered after execution lease expired',
        });
        if (stale.member_id) {
          const member = swarmDb.getMember(stale.member_id);
          if (member?.status === 'running') {
            swarmDb.updateMember(stale.member_id, {
              status: 'failed',
              error: 'recovered after execution lease expired',
              finished: true,
            });
          }
        }
        if (stale.run_id) {
          try {
            const run = runService.get(stale.run_id);
            if (run && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(run.status)) {
              runService.markTerminal(stale.run_id, {
                status: 'failed',
                errorSummary: 'recovered after execution lease expired',
              });
            }
          } catch { /* optional */ }
        }
      }

      const primaryProjectPath = resolveProjectPath(swarm.project_id);

      // ——— Phase 0: dedicated worktree / sandbox ———
      const { workPath, workspace } = await this.ensureSwarmWorkspace(swarmId, {
        projectId: swarm.project_id,
        projectPath: primaryProjectPath,
        goal: swarm.goal,
        parentRunId: swarm.parent_run_id,
        existingWorkspaceId: swarm.workspace_id,
      });
      assertNotCancelled(swarmId);

      // Copy goal attachments (PRDs, images, docs) into the worktree so agents
      // can open them with file tools without leaving the workspace sandbox.
      let swarmAttachments = swarm.attachments ?? [];
      if (swarmAttachments.length > 0) {
        const needsMaterialize = swarmAttachments.some((a) => !a.workspacePath);
        if (needsMaterialize) {
          swarmAttachments = await materializeSwarmAttachments(workPath, swarmAttachments);
          swarmDb.update(swarmId, { attachments: swarmAttachments });
          const names = swarmAttachments
            .map((a) => a.name || pathBasename(a.path))
            .filter(Boolean)
            .slice(0, 8);
          swarmDb.appendMessage(swarmId, {
            id: newMsgId(),
            from: 'system',
            kind: 'system',
            content: `Goal attachments ready under tmp/cloudcli/swarm-attachments/: ${names.join(', ')}${
              swarmAttachments.length > names.length ? ` (+${swarmAttachments.length - names.length} more)` : ''
            }`,
            at: new Date().toISOString(),
          });
        }
      }

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
        swarmAttachments.length
          ? `- goal_attachments: ${swarmAttachments.length} file(s) in tmp/cloudcli/swarm-attachments/`
          : '',
        'Work only inside this workspace path. A PR will be opened after handoff.',
      ]
        .filter(Boolean)
        .join('\n');

      let roster = swarm.roles.length ? swarm.roles : DEFAULT_ROSTER;
      const orchestratorSpec =
        swarm.config?.orchestrator ||
        roster.find((a) => a.kind === 'orchestrator') ||
        roster[0];
      const defaultProvider = resolveSwarmProvider(
        opts.defaultProvider || orchestratorSpec.provider || null,
      );
      const skills = swarm.skills?.length ? swarm.skills : swarm.config?.skills ?? [];

      // ——— Phase 1: Orchestrator plan (or persisted restart continuation) ———
      let plan = swarm.plan;
      const resumingPersistedPlan = Boolean(
        plan && ['running', 'handing_off'].includes(swarm.status),
      );
      // Auto-roster: only the orchestrator seat exists — the plan staffs the
      // worker seats from swarm-tagged agent profiles. Resumed pipelines that
      // already selected seats (persisted roles) skip re-selection.
      const autoRosterPending =
        swarm.config?.autoRoster === true &&
        !resumingPersistedPlan &&
        roster.filter((seat) => seat.kind !== 'orchestrator').length === 0;
      let candidateProfiles: AgentRunProfile[] | null = null;
      if (autoRosterPending) {
        try {
          // Disabled profiles stay usable for explicit assignment but are
          // never offered to the orchestrator for automatic seating.
          candidateProfiles = agentRunProfilesDb
            .list({ enabledOnly: true })
            .filter((profile) => profile.swarm_roles.length > 0);
        } catch {
          candidateProfiles = [];
        }
      }
      // Measured cost/performance of every profile, built once per pass. Cold
      // start returns an empty ledger and every decision falls back to level.
      const costLedger = buildSwarmCostLedger();
      if (!resumingPersistedPlan) {
        const planning = swarmDb.transition(
          swarmId,
          ['queued', 'planning', 'running'],
          { status: 'planning' },
        );
        if (!planning) {
          assertNotCancelled(swarmId);
          throw new Error('Swarm planning transition was rejected');
        }
        plan = await this.runOrchestratorPlan(swarmId, {
          goal: swarm.goal,
          projectPath: workPath,
          parentRunId: swarm.parent_run_id,
          orchestrator: orchestratorSpec,
          roster,
          skills,
          gitContext,
          defaultProvider,
          defaultModel: opts.defaultModel ?? null,
          candidateProfiles,
          costLedger,
          signal: abortController.signal,
        });
        assertNotCancelled(swarmId);
        if (autoRosterPending) {
          const resolved = resolveAutoRosterFromPlan({
            swarmId,
            plan,
            pool: candidateProfiles ?? [],
            defaultProvider,
            defaultModel: opts.defaultModel ?? null,
            costLedger,
          });
          plan = resolved.plan;
          if (resolved.workers.length > 0) {
            roster = [orchestratorSpec, ...resolved.workers];
            swarmDb.update(swarmId, { roles: roster });
            // Persist the seats so the UI roster renders and executeStep can
            // bind steps to members exactly like a manual roster.
            for (const seat of resolved.workers) {
              swarmDb.createMember({
                swarmId,
                role: seat.kind,
                kind: seat.kind,
                label: seat.label,
                provider: resolveSwarmProvider(seat.provider || defaultProvider),
                model: seat.model ?? null,
                effort: seat.effort ?? null,
                permissionMode: seat.permissionMode ?? null,
                skills: seat.skills ?? [],
                runId: null,
                status: 'queued',
              });
            }
            swarmDb.appendMessage(swarmId, {
              id: newMsgId(),
              from: 'Auto-roster',
              kind: 'system',
              content: `Auto-selected ${resolved.workers.length} seat(s) from agent profiles:\n${resolved.workers
                .map(
                  (seat) =>
                    `- ${seat.label} (${seat.kind}, ${seat.provider}${seat.model ? `, ${seat.model}` : ''}${seat.permissionMode ? `, permissions=${seat.permissionMode}` : ''})`,
                )
                .join('\n')}`,
              at: new Date().toISOString(),
            });
          }
        }
        plan = validatePlan(plan, roster);
        const running = swarmDb.transition(swarmId, ['planning'], {
          status: 'running',
          plan,
        });
        if (!running) {
          assertNotCancelled(swarmId);
          throw new Error('Swarm plan checkpoint was rejected');
        }
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: orchestratorSpec.label || 'Orchestrator',
          kind: 'plan',
          content: `${plan.summary}\n\nStrategy: ${plan.strategy}${
            plan.costNotes ? `\nCost: ${plan.costNotes}` : ''
          }\n\nSteps:\n${plan.steps
            .map(
              (s) =>
                `- ${s.id} [wave ${s.wave ?? '?'}${s.difficulty ? `, ${s.difficulty}` : ''}] ${s.title} → ${s.assignTo || s.kind}${
                  s.scope?.length ? ` · owns: ${s.scope.slice(0, 4).join(', ')}` : ' · no declared scope'
                }`,
            )
            .join('\n')}`,
          at: new Date().toISOString(),
        });
        // Sizing is a cost decision the operator should be able to audit at a
        // glance, without reading the whole plan.
        appendPolicyNote(
          swarmId,
          'Plan sizing',
          `${plan.steps.length} step(s) across ${new Set(plan.steps.map((step) => step.assignTo || step.kind)).size} worker seat(s) — ` +
            `${plan.steps.filter((step) => step.kind === 'explorer').length} explorer, ` +
            `${plan.steps.filter((step) => step.kind === 'implementer' || step.kind === 'custom').length} implementer, ` +
            `${plan.steps.filter((step) => step.kind === 'reviewer').length} reviewer` +
            (plan.steps.some((step) => !step.scope?.length)
              ? `; ${plan.steps.filter((step) => !step.scope?.length).length} step(s) declared no scope`
              : ''),
        );
      } else {
        plan = validatePlan(plan!, roster);
      }

      // Reconcile the JSON checkpoint with immutable attempts. This covers a
      // crash after an attempt terminalized but before a wave-level plan write.
      const latestAttemptByStep = new Map<string, ReturnType<typeof swarmDb.listAttempts>[number]>();
      for (const attempt of swarmDb.listAttempts(swarmId)) {
        const prior = latestAttemptByStep.get(attempt.step_id);
        if (!prior || attempt.attempt_no >= prior.attempt_no) latestAttemptByStep.set(attempt.step_id, attempt);
      }
      plan = {
        ...plan!,
        steps: plan!.steps.map((step) =>
          latestAttemptByStep.get(step.id)?.status === 'succeeded'
            ? { ...step, status: 'succeeded' }
            : step,
        ),
      };
      const checkpointed = swarmDb.update(swarmId, { plan });
      if (!checkpointed) {
        assertNotCancelled(swarmId);
        throw new Error('Swarm attempt checkpoint was rejected');
      }

      // ——— Phase 1b: optional plan-approval gate ———
      // Let the operator review the cost-aware plan BEFORE any worker burns tokens.
      const requirePlanApproval =
        opts.requirePlanApproval === true || swarm.approval_status === 'plan_pending';
      const planAlreadyApproved = swarm.approval_status === 'approved';
      if (requirePlanApproval && !planAlreadyApproved) {
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
        const awaitingApproval = swarmDb.transition(swarmId, ['running'], {
          status: 'awaiting_plan_approval',
          approvalStatus: 'plan_pending',
          interruptId: interrupt.interrupt_id,
          plan,
        });
        if (!awaitingApproval) {
          try { interruptsService.act(interrupt.interrupt_id, { key: 'dismiss' }); } catch { /* raced */ }
          assertNotCancelled(swarmId);
          throw new Error('Swarm plan approval transition was rejected');
        }
        if (swarm.parent_run_id) {
          try {
            runService.updateStatus(swarm.parent_run_id, 'waiting_permission');
          } catch {
            /* optional */
          }
        }

        // Durable pause: no in-memory resolver is required. approvePlan starts
        // executePipeline again using the persisted validated plan/workspace.
        return swarmDb.get(swarmId)!;
      }

      // ——— Phase 2: Execute plan waves (all in worktree) ———
      assertNotCancelled(swarmId);
      const recoveredFailureIds = new Set(
        plan!.steps
          .filter((step) => step.status === 'recovered' && step.replacesStepId)
          .map((step) => step.replacesStepId as string),
      );
      const pendingSteps = swarm.status === 'handing_off'
        ? []
        : opts.retryStepId
          ? plan!.steps.filter((step) => step.id === opts.retryStepId && !['succeeded', 'recovered'].includes(step.status ?? ''))
          : opts.resumeFromFailure
            ? plan!.steps.filter((step) =>
                !['succeeded', 'recovered'].includes(step.status ?? '')
                && !recoveredFailureIds.has(step.id),
              )
          : plan!.steps.filter((step) => !['succeeded', 'recovered'].includes(step.status ?? ''));
      const waves = orderWaves(pendingSteps);
      const findings: SwarmFinding[] = [...(swarmDb.get(swarmId)?.findings ?? [])];
      let livePlan: SwarmPlan = { ...plan!, steps: plan!.steps.map((s) => ({ ...s })) };
      const stepTimeoutMs = opts.stepTimeoutMs ?? swarm.config?.stepTimeoutMs ?? null;
      const stallTimeoutMs = swarm.config?.stallTimeoutMs ?? undefined;
      const stepMaxAttempts = resolveStepMaxAttempts(swarm.config ?? null);
      const maxConcurrency = opts.maxConcurrency ?? swarm.config?.maxConcurrency ?? null;
      const autoRoster = swarm.config?.autoRoster === true;
      // Shared handle so takeover seats provisioned mid-step are visible to
      // every later step (and get persisted onto the swarm row).
      const rosterRef: RosterRef = { current: roster };
      const tickBudget = Math.max(
        resolveSupervisorTickBudget(swarm.config ?? null),
        resolveMaxReplanRounds(swarm.config ?? null) * 2,
      );
      let goalCard: SwarmGoalCard = swarm.goalCard
        ? { ...swarm.goalCard, tickBudget }
        : emptyGoalCard(tickBudget);
      persistGoalCard(swarmId, goalCard);
      let supervisorMode = goalCard.mode === 'supervisor';
      let lastSupervisorEvent: SupervisorEvent | null = supervisorMode
        ? eventFromGoalCard(goalCard)
        : null;

      for (const plannedWave of waves) {
        if (supervisorMode) break;
        assertNotCancelled(swarmId);
        // Same-kind steps only share a wave when their declared scopes are
        // disjoint. Overlapping (or unscoped) fan-out is the "several agents on
        // one thing" smell: it is split into consecutive groups and reported,
        // never dropped.
        const { groups, conflicts } = splitWaveByScope(plannedWave);
        for (const conflict of conflicts) {
          swarmDb.appendMessage(swarmId, {
            id: newMsgId(),
            from: 'Swarm policy',
            kind: 'system',
            content: `[plan] steps ${conflict.step} and ${conflict.against} are both "${conflict.kind}" over the same scope (${conflict.overlap.join(', ')}) — running them one after another instead of together. Two agents on one area costs a full context load each and cannot see each other's uncommitted work.`,
            stepId: conflict.step,
            at: new Date().toISOString(),
          });
        }

        const results: Array<Awaited<ReturnType<typeof swarmService.runStepWithFeedbackRetries>>> = [];
        for (const wave of groups) {
          assertNotCancelled(swarmId);
          const fingerprint = await captureWorktreeFingerprint(workPath);
          const skipped = wave.filter(
            (step) => step.kind === 'reviewer' && shouldRefuseReviewer(goalCard, fingerprint),
          );
          const runnable = wave.filter(
            (step) => !(step.kind === 'reviewer' && shouldRefuseReviewer(goalCard, fingerprint)),
          );
          if (skipped.length > 0) {
            supervisorMode = true;
            lastSupervisorEvent = lastSupervisorEvent ?? eventFromGoalCard(goalCard);
            swarmDb.appendMessage(swarmId, {
              id: newMsgId(),
              from: 'Swarm policy',
              kind: 'system',
              content: `[supervisor] refused ${skipped.length} reviewer step(s) — worktree fingerprint is unchanged since the last changes-requested verdict`,
              at: new Date().toISOString(),
            });
          }
          if (runnable.length === 0) continue;
          // One shared writable worktree, so writers serialize. Read-only steps
          // cannot conflict (the broker denies every mutation from an
          // explorer/reviewer seat), so they genuinely run concurrently — which
          // is what makes a parallel exploration wave worth planning at all.
          // A mixed group stays at 1: a writer in it invalidates what readers see.
          const allReadOnly = runnable.every((step) => isReadOnlyKind(step.kind));
          const allWriters = runnable.every((step) => step.kind === 'implementer' || step.kind === 'custom');
          const parallelWriters = swarm.config?.parallelWriters === true && allWriters && runnable.length > 1;
          const waveConcurrency = allReadOnly || parallelWriters
            ? Math.min(runnable.length, Math.max(1, maxConcurrency ?? DEFAULT_MAX_CONCURRENCY))
            : 1;
          const groupResults = await this.runWaveWithConcurrency(
            runnable,
            (step) =>
              this.runStepWithFeedbackRetries(swarmId, {
                step,
                goal: swarm.goal,
                projectPath: workPath,
                parentRunId: swarm.parent_run_id,
                rosterRef,
                skills,
                gitContext,
                defaultProvider,
                defaultModel: opts.defaultModel ?? null,
                timeoutMs: stepTimeoutMs,
                stallTimeoutMs,
                signal: abortController.signal,
                maxAttempts: stepMaxAttempts,
                autoRoster,
                costLedger,
                parallelWriterWorkspaces: parallelWriters,
              }),
            waveConcurrency,
          );
          results.push(...groupResults);
          roster = rosterRef.current;
        }
        assertNotCancelled(swarmId);

        for (const r of results) {
          findings.push(r.finding);
          const idx = livePlan.steps.findIndex((s) => s.id === r.step.id);
          if (idx >= 0) {
            livePlan.steps[idx] = {
              ...livePlan.steps[idx],
              status: r.needsChanges ? 'needs_changes' : r.failed ? 'failed' : 'succeeded',
            };
          }
          const fingerprint = await captureWorktreeFingerprint(workPath);
          const parsed = parseMemberFindings(r.output ?? r.finding.summary ?? '');
          const event = classifySupervisorEvent({
            stepKind: r.step.kind,
            stepId: r.step.id,
            seatLabel: r.seat?.label ?? r.finding.role,
            output: r.output ?? null,
            error: r.error ?? r.finding.summary,
            failed: Boolean(r.failed),
            needsChanges: Boolean(r.needsChanges),
            packets: extractCritiquePackets(parsed, r.error ?? r.finding.summary),
            fingerprint,
          });
          goalCard = applySupervisorEvent(goalCard, event);
          if (r.failed || r.needsChanges) {
            supervisorMode = true;
            lastSupervisorEvent = event;
          }
        }
        if (supervisorMode) {
          goalCard = { ...goalCard, mode: 'supervisor' };
        }
        persistGoalCard(swarmId, goalCard);
        swarmDb.update(swarmId, { findings: [...findings], plan: livePlan });
        if (supervisorMode) break;
      }

      if (supervisorMode) {
        if (!lastSupervisorEvent) {
          lastSupervisorEvent = eventFromGoalCard(goalCard);
        }
        if (lastSupervisorEvent) {
          setOrchestratorMemberStatus(swarmId, 'supervising', 'Supervising live swarm — choosing the next agent');
          const supervised = await this.runSupervisorLoop(swarmId, {
            event: lastSupervisorEvent,
            goalCard,
            livePlan,
            findings,
            goal: swarm.goal,
            projectPath: workPath,
            parentRunId: swarm.parent_run_id,
            orchestrator: orchestratorSpec,
            rosterRef,
            skills,
            gitContext,
            defaultProvider,
            defaultModel: opts.defaultModel ?? null,
            timeoutMs: stepTimeoutMs,
            stallTimeoutMs,
            signal: abortController.signal,
            maxAttempts: stepMaxAttempts,
            autoRoster,
            costLedger,
          });
          goalCard = supervised.goalCard;
          livePlan = supervised.plan;
          findings.splice(0, findings.length, ...supervised.findings);
          roster = rosterRef.current;
          setOrchestratorMemberStatus(
            swarmId,
            'queued',
            goalCard.decisions.at(-1)?.reason ?? 'Supervisor finished',
          );
        }
      }

      const unresolvedSteps = unresolvedPlanSteps(livePlan);
      const executionFailureReason = unresolvedSteps.length > 0
        ? `Required swarm step(s) remained unresolved: ${unresolvedSteps.map((step) => step.title).join(', ')}`
        : null;
      if (executionFailureReason) {
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: 'Swarm policy',
          kind: 'system',
          content: `[execution] ${executionFailureReason}. The handoff and PR will preserve the evidence, but the swarm cannot be reported as succeeded.`,
          at: new Date().toISOString(),
        });
      }

      // ——— Phase 3: Orchestrator handoff ———
      assertNotCancelled(swarmId);
      const handingOff = swarmDb.transition(
        swarmId,
        ['running', 'handing_off'],
        { status: 'handing_off' },
      );
      if (!handingOff) {
        assertNotCancelled(swarmId);
        throw new Error('Swarm handoff transition lost its execution lease');
      }
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
        signal: abortController.signal,
      });
      assertNotCancelled(swarmId);

      // ——— Phase 3.5: pre-PR stability gate with bounded remediation loop ———
      // Gate failure is orchestrator feedback, not an immediate stop: failed
      // checks trigger a remediation replan + implementer wave, then the gate
      // re-runs — up to the attempt budget. Exhaustion keeps the original
      // "block on red" semantics (failed swarm + ci_failed interrupt + report).
      // Set when the gate stayed red through every attempt. The PR is still
      // opened (see below); these carry the red verdict into the final
      // transition so the swarm is honestly marked failed with its report.
      let validationFailureReason: string | null = null;
      let validationInterruptId: string | null = null;

      const validateBeforePr = swarm.config?.validateBeforePr !== false;
      if (validateBeforePr) {
        const maxAttempts = resolveValidationMaxAttempts(swarm.config ?? null);
        // Boot recovery: persisted validation attempts count against the
        // budget so a restarted pipeline resumes numbering instead of
        // re-running completed attempts from scratch.
        const priorAttempts = swarmDb
          .listAttempts(swarmId)
          .filter(
            (row) => row.phase === 'validate' && ['succeeded', 'failed'].includes(row.status),
          );
        const attemptHistory: SwarmValidationAttemptRecord[] = priorAttempts.map((row, index) => ({
          attempt: index + 1,
          passed: row.status === 'succeeded',
          failedChecks: row.status === 'succeeded' || !row.error ? [] : [row.error.slice(0, 200)],
        }));
        let attempt = attemptHistory.length;
        let gate: SwarmValidationGateResult | null = null;
        let terminalReason: string | null = null;

        for (;;) {
          if (attempt >= maxAttempts) {
            // Budget already consumed (possible after boot recovery). A
            // previously-passed final attempt proceeds; otherwise terminal.
            if (attemptHistory[attemptHistory.length - 1]?.passed) break;
            terminalReason = `validation attempt budget exhausted (${maxAttempts} attempt(s))`;
            break;
          }
          attempt += 1;
          assertNotCancelled(swarmId);
          const attemptRow = swarmDb.createAttempt({
            swarmId,
            stepId: `validation-attempt-${attempt}`,
            phase: 'validate',
            status: 'running',
            workspaceId: swarm.workspace_id,
          });
          try {
            const latest = swarmDb.get(swarmId)!;
            gate = await runSwarmValidationGate({
              swarmId,
              goal: swarm.goal,
              roster,
              workspaceRoot: workPath,
              primaryProjectPath,
              blackboard: latest.blackboard ?? [],
              verificationTargets: handoff.verificationTargets ?? null,
              smokeEligible: workspace.mode === 'git_worktree',
              attempt,
              attemptHistory,
            });
          } catch (error) {
            // Gate infrastructure crashing is a validation failure, not a bypass.
            const msg = error instanceof Error ? error.message : String(error);
            gate = {
              passed: false,
              degraded: true,
              checks: [
                {
                  id: 'gate:internal',
                  kind: 'report',
                  label: 'Validation gate',
                  status: 'failed',
                  reason: msg,
                  output: '',
                  durationMs: 0,
                },
              ],
              screenshots: [],
              reportDir: swarmReportDir(primaryProjectPath, swarmId),
              htmlPath: null,
              pdfPath: null,
              summary: `Validation gate crashed: ${msg}`,
              generatedAt: new Date().toISOString(),
            };
          }
          assertNotCancelled(swarmId);

          const failedLabels = gate.checks
            .filter((check) => check.status === 'failed')
            .map((check) => check.label);
          attemptHistory.push({ attempt, passed: gate.passed, failedChecks: failedLabels });
          swarmDb.updateAttempt(attemptRow.attempt_id, {
            status: gate.passed ? 'succeeded' : 'failed',
            error: gate.passed ? null : (failedLabels.join(', ') || gate.summary).slice(0, 500),
          });

          if (gate.passed) {
            if (attempt > 1) {
              swarmDb.appendMessage(swarmId, {
                id: newMsgId(),
                from: 'Validation gate',
                kind: 'system',
                content: `[validation] attempt ${attempt} passed`,
                at: new Date().toISOString(),
              });
            }
            break;
          }

          const failedShort = shortCheckNames(failedLabels);
          if (attempt >= maxAttempts) {
            swarmDb.appendMessage(swarmId, {
              id: newMsgId(),
              from: 'Validation gate',
              kind: 'system',
              content: `[validation] attempt ${attempt} failed: ${failedShort} — attempt budget exhausted (${maxAttempts})`,
              at: new Date().toISOString(),
            });
            terminalReason = `validation failed after ${attempt} attempt(s): ${failedLabels.join(', ') || gate.summary.slice(0, 300)}`;
            break;
          }
          swarmDb.appendMessage(swarmId, {
            id: newMsgId(),
            from: 'Validation gate',
            kind: 'system',
            content: `[validation] attempt ${attempt} failed: ${failedShort} — replanning remediation`,
            at: new Date().toISOString(),
          });

          // Remediation steps count against the existing plan step budget.
          const planNow = swarmDb.get(swarmId)?.plan ?? null;
          const stepBudget = Math.min(
            MAX_REMEDIATION_STEPS_PER_ATTEMPT,
            MAX_PLAN_STEPS - (planNow?.steps.length ?? 0),
          );
          if (stepBudget <= 0) {
            terminalReason = `validation remediation halted: plan step budget (${MAX_PLAN_STEPS}) exhausted`;
            break;
          }

          let remediation: { steps: SwarmPlanStep[] } | null = null;
          try {
            remediation = await this.replanValidationRemediation(swarmId, {
              goal: swarm.goal,
              projectPath: workPath,
              parentRunId: swarm.parent_run_id,
              orchestrator: orchestratorSpec,
              roster,
              skills,
              gitContext,
              defaultProvider,
              defaultModel: opts.defaultModel ?? null,
              plan: planNow,
              gate,
              attempt,
              maxAttempts,
              maxSteps: stepBudget,
              signal: abortController.signal,
            });
          } catch {
            remediation = null;
          }
          assertNotCancelled(swarmId);
          if (!remediation || remediation.steps.length === 0) {
            swarmDb.appendMessage(swarmId, {
              id: newMsgId(),
              from: 'Validation gate',
              kind: 'system',
              content: `[validation] remediation attempt ${attempt}: orchestrator produced no viable implementer steps — failing`,
              at: new Date().toISOString(),
            });
            terminalReason = `validation remediation replan produced no viable implementer steps (attempt ${attempt})`;
            break;
          }
          const remediationSteps = remediation.steps;

          // Ensure an implementer-capable seat exists (auto-roster swarms may
          // have staffed no implementer in the original plan). Prefer a fresh
          // implementer profile pick, else the default seat.
          if (!rosterRef.current.some((seat) => seat.kind === 'implementer' || seat.kind === 'custom')) {
            let seat: SwarmAgentSpec | null = null;
            if (swarm.config?.autoRoster === true) {
              try {
                const pool = agentRunProfilesDb
                  .list({ swarmRole: 'implementer' })
                  .filter((profile) => {
                    const provider = resolveSwarmProvider(profile.provider);
                    return isSwarmProvider(provider) && Boolean(getSwarmSpawnFn(provider));
                  });
                // Remediation is by definition the hard part of the run: take
                // the strongest implementer profile available.
                const profile =
                  [...pool].sort(
                    (a, b) => LEVEL_RANK[levelOf(b.swarm_level)] - LEVEL_RANK[levelOf(a.swarm_level)],
                  )[0] ?? null;
                if (profile) {
                  seat = {
                    id: `auto-${profile.profile_id}-implementer`.toLowerCase(),
                    kind: 'implementer',
                    label: profile.name,
                    provider: profile.provider,
                    model: profile.model ?? null,
                    effort: profile.effort ?? null,
                    permissionMode: profile.permission_mode ?? null,
                    skills: [],
                    level: levelOf(profile.swarm_level),
                    profileId: profile.profile_id,
                  };
                }
              } catch {
                seat = null;
              }
            }
            if (!seat) {
              seat = {
                id: 'auto-remediation-implementer',
                kind: 'implementer',
                label: 'Implementer',
                provider: defaultProvider,
                model: opts.defaultModel ?? null,
                skills: [],
                level: DEFAULT_LEVEL,
                profileId: null,
              };
            }
            rosterRef.current = [...rosterRef.current, seat];
            roster = rosterRef.current;
            swarmDb.update(swarmId, { roles: roster });
            swarmDb.createMember({
              swarmId,
              role: 'implementer',
              kind: 'implementer',
              label: seat.label,
              provider: resolveSwarmProvider(seat.provider || defaultProvider),
              model: seat.model ?? null,
              effort: seat.effort ?? null,
              permissionMode: seat.permissionMode ?? null,
              skills: [],
              runId: null,
              status: 'queued',
            });
            appendPolicyNote(swarmId, 'Validation gate', `provisioned implementer seat "${seat.label}" for remediation`);
          }

          // Persist the remediation steps into the plan so the UI, status
          // tracking (persistPlanStepStatus) and boot recovery treat them as
          // first-class steps.
          const planForRun = swarmDb.get(swarmId)?.plan;
          if (planForRun) {
            swarmDb.update(swarmId, {
              plan: {
                ...planForRun,
                steps: [
                  ...planForRun.steps,
                  ...remediationSteps.map((step) => ({ ...step, status: 'queued' })),
                ],
              },
            });
          }
          swarmDb.appendMessage(swarmId, {
            id: newMsgId(),
            from: 'Validation gate',
            kind: 'system',
            content: `[validation] remediation attempt ${attempt}: ${remediationSteps.length} step(s) dispatched`,
            at: new Date().toISOString(),
          });
          attemptHistory[attemptHistory.length - 1].remediationSteps = remediationSteps.map(
            (step) => step.title,
          );

          // Execute through the normal step path (broker, members, blackboard)
          // in the SAME worktree. A failed remediation step is not terminal by
          // itself — the re-run gate is the ground truth.
          const remediationResults = await this.runWaveWithConcurrency(
            remediationSteps,
            (step) =>
              this.runStepWithFeedbackRetries(swarmId, {
                step,
                goal: swarm.goal,
                projectPath: workPath,
                parentRunId: swarm.parent_run_id,
                rosterRef,
                skills,
                gitContext,
                defaultProvider,
                defaultModel: opts.defaultModel ?? null,
                timeoutMs: stepTimeoutMs,
                stallTimeoutMs,
                signal: abortController.signal,
                maxAttempts: stepMaxAttempts,
                autoRoster,
                costLedger,
              }),
            // Remediation steps are generated from the same failing checks and
            // intentionally serialize to avoid competing fixes in one area.
            1,
          );
          assertNotCancelled(swarmId);
          roster = rosterRef.current;
          for (const result of remediationResults) findings.push(result.finding);
          swarmDb.update(swarmId, { findings: [...findings] });
        }

        const validationPassed = terminalReason == null && (gate?.passed ?? attemptHistory[attemptHistory.length - 1]?.passed === true);
        handoff = {
          ...handoff,
          validation: {
            passed: Boolean(validationPassed),
            degraded: gate?.degraded ?? false,
            summary:
              gate?.summary ??
              (terminalReason ?? 'validated in a previous attempt (recovered pipeline)'),
            checks: (gate?.checks ?? []).map(({ id, label, status }) => ({ id, label, status })),
            // Persist artifact names, not local absolute paths. The authenticated
            // report endpoint resolves these files server-side.
            reportPdfPath: gate?.pdfPath ? 'report.pdf' : null,
            reportHtmlPath: gate?.htmlPath ? 'report.html' : null,
            generatedAt: gate?.generatedAt ?? new Date().toISOString(),
            attempts: attemptHistory,
          },
        };
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: 'Validation gate',
          kind: 'system',
          content: `${(gate?.summary ?? terminalReason ?? 'validation summary unavailable').slice(0, 2000)}\nReport: ${gate?.pdfPath ?? gate?.htmlPath ?? swarmReportDir(primaryProjectPath, swarmId)}`,
          at: new Date().toISOString(),
        });

        if (!validationPassed) {
          const reason = `Pre-PR validation failed: ${(terminalReason ?? gate?.summary ?? 'validation failed').slice(0, 600)}`;
          const interrupt = interruptsService.create({
            projectId: swarm.project_id,
            kind: 'ci_failed',
            severity: 'error',
            title: `Swarm validation failed: ${swarm.goal.slice(0, 80)}`,
            body: [
              (terminalReason ?? gate?.summary ?? '').slice(0, 800),
              `Attempts: ${attemptHistory.map((entry) => `#${entry.attempt} ${entry.passed ? 'passed' : `failed (${shortCheckNames(entry.failedChecks)})`}`).join('; ')}`,
              `Report: ${gate?.pdfPath ?? gate?.htmlPath ?? swarmReportDir(primaryProjectPath, swarmId)}`,
            ]
              .filter(Boolean)
              .join('\n'),
            runId: swarm.parent_run_id,
            href: `/api/swarm/${swarmId}/report`,
            actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
            meta: {
              swarmId,
              reportDir: gate?.reportDir ?? swarmReportDir(primaryProjectPath, swarmId),
              pdfPath: gate?.pdfPath ?? null,
              htmlPath: gate?.htmlPath ?? null,
              attempts: attemptHistory,
            },
            dedupeKey: `swarm-validation:${swarmId}`,
          });
          validationInterruptId = interrupt.interrupt_id;
          validationFailureReason = reason;

          if (swarm.config?.prOnRedValidation === false) {
            // Opt-in strict mode: no PR while the gate is red.
            const failedTransition = swarmDb.transition(swarmId, ['handing_off'], {
              status: 'failed',
              finished: true,
              synthesis: handoff,
              findings,
              interruptId: interrupt.interrupt_id,
              lastError: reason,
            });
            if (!failedTransition) {
              assertNotCancelled(swarmId);
              throw new Error(reason);
            }
            reconcileTerminalMembers(swarmId, 'failed', reason);
            if (swarm.parent_run_id) {
              try {
                runService.markTerminal(swarm.parent_run_id, { status: 'failed', errorSummary: reason });
              } catch {
                /* optional */
              }
            }
            return swarmDb.get(swarmId)!;
          }

          // Default: the work and its evidence are never thrown away. Open the
          // PR anyway, clearly flagged red, so the branch + PDF report become
          // the starting point for a follow-up swarm instead of a dead end.
          swarmDb.appendMessage(swarmId, {
            id: newMsgId(),
            from: 'Validation gate',
            kind: 'system',
            content: `[validation] gate still red after ${attemptHistory.length} attempt(s) — opening the PR anyway with the report attached so the remaining work can be picked up`,
            at: new Date().toISOString(),
          });
        }
      }

      if (executionFailureReason && !validationFailureReason) {
        const interrupt = interruptsService.create({
          projectId: swarm.project_id,
          kind: 'ci_failed',
          severity: 'error',
          title: `Swarm steps unresolved: ${swarm.goal.slice(0, 80)}`,
          body: executionFailureReason,
          runId: swarm.parent_run_id,
          actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
          meta: { swarmId, unresolvedSteps: unresolvedSteps.map((step) => step.id) },
          dedupeKey: `swarm-execution:${swarmId}`,
        });
        validationInterruptId = interrupt.interrupt_id;
        validationFailureReason = executionFailureReason;
      }

      // ——— Phase 4: Commit, push, open PR from worktree ———
      handoff = await this.finalizeSwarmPullRequest(swarmId, handoff);
      assertNotCancelled(swarmId);

      const requireApproval =
        opts.requireApproval === true || swarm.approval_status === 'pending';

      if (requireApproval && !validationFailureReason) {
        // Optional human gate: acknowledge a green handoff only. Failed
        // execution/validation is terminal and cannot be approved into success.
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
        const awaitingApproval = swarmDb.transition(swarmId, ['handing_off'], {
          status: 'awaiting_approval',
          approvalStatus: 'pending',
          interruptId: interrupt.interrupt_id,
          synthesis: handoff,
          findings,
          prUrl: handoff.prUrl ?? null,
        });
        if (!awaitingApproval) {
          try { interruptsService.act(interrupt.interrupt_id, { key: 'dismiss' }); } catch { /* raced */ }
          assertNotCancelled(swarmId);
          throw new Error('Swarm approval transition was rejected');
        }
        if (swarm.parent_run_id) {
          try {
            runService.updateStatus(swarm.parent_run_id, 'waiting_permission');
          } catch {
            /* optional */
          }
        }
      } else if (validationFailureReason) {
        // PR opened, gate red: the artifacts exist but the goal is not met, so
        // the swarm is marked failed with the PR + report attached rather than
        // reported as a success.
        const completed = swarmDb.transition(swarmId, ['handing_off'], {
          status: 'failed',
          approvalStatus: null,
          synthesis: handoff,
          findings,
          prUrl: handoff.prUrl ?? null,
          interruptId: validationInterruptId,
          lastError: validationFailureReason,
          finished: true,
        });
        if (!completed) {
          assertNotCancelled(swarmId);
          throw new Error(validationFailureReason);
        }
        reconcileTerminalMembers(swarmId, 'failed', validationFailureReason);
        if (swarm.parent_run_id) {
          try {
            runService.markTerminal(swarm.parent_run_id, {
              status: 'failed',
              errorSummary: validationFailureReason,
            });
          } catch {
            /* optional */
          }
        }
      } else {
        const completed = swarmDb.transition(swarmId, ['handing_off'], {
          status: 'succeeded',
          approvalStatus: null,
          synthesis: handoff,
          findings,
          prUrl: handoff.prUrl ?? null,
          finished: true,
        });
        if (!completed) {
          assertNotCancelled(swarmId);
          throw new Error('Swarm completion transition was rejected');
        }
        reconcileTerminalMembers(swarmId, 'succeeded', 'swarm completed');
        const notifiedHandoff = this.notifyHandoffComplete(swarmId, handoff);
        swarmDb.update(swarmId, { synthesis: notifiedHandoff });
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
      clearInterval(leaseHeartbeat);
      try {
        swarmDb.releaseLease(swarmId, PIPELINE_OWNER);
      } catch {
        // Database may have been closed/replaced during test or shutdown.
      }
      activePipelines.delete(swarmId);
      if (pipelineAbortControllers.get(swarmId) === abortController) {
        pipelineAbortControllers.delete(swarmId);
      }
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
      /** Auto-roster: candidate profiles the plan must staff steps from. */
      candidateProfiles?: AgentRunProfile[] | null;
      /** Measured per-profile cost/performance history, when any exists. */
      costLedger?: SwarmCostLedger | null;
      signal?: AbortSignal | null;
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

    const currentSwarm = swarmDb.get(swarmId);
    const orchestratorEffort = resolveSeatEffort(
      providerCapabilitiesService.getProviderCapabilities(provider),
      input.orchestrator.effort ?? null,
    ).effort;
    const orchestratorPermissionMode = readOnlyPermissionMode(provider);

    const child = runService.create({
        source: 'swarm',
        projectId: currentSwarm?.project_id ?? null,
        parentRunId: input.parentRunId,
        rootRunId: input.parentRunId,
        workspaceId: currentSwarm?.workspace_id ?? null,
        provider,
        model,
        effort: orchestratorEffort,
        permissionMode: orchestratorPermissionMode,
        title: `Swarm plan: ${input.goal.slice(0, 80)}`,
        trigger: `swarm-plan:${swarmId}`,
        status: 'running',
        meta: { swarmId, role: 'orchestrator', phase: 'plan' },
      });
    const runId = child.run_id;
    if (orchMember) swarmDb.updateMember(orchMember.member_id, { runId, status: 'running' });
    const attempt = swarmDb.createAttempt({
      swarmId,
      stepId: 'plan',
      memberId: orchMember?.member_id,
      runId,
      phase: 'plan',
      status: 'running',
      workspaceId: swarmDb.get(swarmId)?.workspace_id,
    });

    try {
      const planAttachments = swarmDb.get(swarmId)?.attachments ?? [];
      const outcome = await runSwarmAgent({
        projectId: swarmDb.get(swarmId)?.project_id ?? '',
        projectPath: input.projectPath,
        provider,
        model,
        effort: orchestratorEffort,
        permissionMode: orchestratorPermissionMode,
        prompt: buildPlanPrompt({
          goal: input.goal,
          roster: input.roster,
          skills: input.skills,
          gitContext: input.gitContext,
          attachments: planAttachments,
          candidateProfiles: input.candidateProfiles ?? null,
          costLedger: input.costLedger ?? null,
        }),
        images: providerImagesFromAttachments(planAttachments),
        runId,
        title: 'Swarm orchestrator plan',
        signal: input.signal,
        permission: {
          swarmId,
          memberId: orchMember?.member_id ?? null,
          seatKind: 'orchestrator',
          seatLabel: input.orchestrator.label || 'Orchestrator',
          workspaceRoot: input.projectPath,
        },
      });
      assertNotCancelled(swarmId);

      if (!outcome.success || !outcome.text.trim()) {
        const message = outcome.errorMessage
          || (outcome.success
            ? `Orchestrator "${input.orchestrator.label || provider}" emitted no plan`
            : `Orchestrator "${input.orchestrator.label || provider}" failed while planning`);
        throw new Error(message);
      }

      const parsed = parseOrchestratorPlan(
        outcome.text,
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
      swarmDb.updateAttempt(attempt.attempt_id, { status: 'succeeded' });

      return plan;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (cancellationRequested(swarmId)) {
        swarmDb.updateAttempt(attempt.attempt_id, { status: 'aborted', error: msg });
        throw error;
      }
      swarmDb.updateAttempt(attempt.attempt_id, { status: 'failed', error: msg });
      try {
        const current = runService.get(runId);
        if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
          runService.markTerminal(runId, { status: 'failed', errorSummary: msg });
        }
      } catch {
        /* optional */
      }
      if (orchMember) {
        swarmDb.updateMember(orchMember.member_id, {
          status: 'failed',
          error: msg,
        });
      }
      throw error;
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
      /** Silence budget; omitted uses the service default, null disables. */
      stallTimeoutMs?: number | null;
      signal?: AbortSignal | null;
      /** Retry loop: run this exact seat instead of resolving from the plan. */
      seatOverride?: SwarmAgentSpec | null;
      /** Retry loop: 1-based attempt number, for member/run titles. */
      attemptNo?: number;
      /** Retry loop: prior-failure context prepended to the step prompt. */
      feedback?: string | null;
      /** Isolated child workspace used for a parallel writer attempt. */
      workspaceIdOverride?: string | null;
    },
  ): Promise<{
    step: SwarmPlanStep;
    finding: SwarmFinding;
    failed: boolean;
    /** True when `failed` is a reviewer/agent verdict (unmet acceptance
     * criteria) rather than an execution failure (crash/timeout/no diff). */
    needsChanges?: boolean;
    /** Seat that actually ran (may be an override or an auto-scaled sibling). */
    seat: SwarmAgentSpec;
    timedOut: boolean;
    stalled: boolean;
    error: string | null;
    /** Whatever the agent produced, including on a killed run. */
    output: string | null;
  }> {
    const agent = input.seatOverride ?? pickAgentForStep(input.step, input.roster);
    // A retry/takeover is an execution-time reassignment. Its seat must own the
    // provider/model choice even when the original plan pinned those fields;
    // otherwise a Grok failure reassigned to OpenCode still launches Grok.
    const providerCandidate = input.seatOverride
      ? input.seatOverride.provider || input.defaultProvider
      : input.step.provider || agent.provider || input.defaultProvider;
    const modelCandidate = input.seatOverride
      ? input.seatOverride.model ?? input.defaultModel ?? null
      : input.step.model || agent.model || input.defaultModel || null;
    const provider = resolveSwarmProvider(
      providerCandidate,
    );
    const spendSwarm = swarmDb.get(swarmId);
    const spendUsage = spendSwarm ? this.withUsage(spendSwarm) : null;
    const spendVerdict = evaluateSpend(spendUsage?.usage?.totalCostUsd ?? 0);
    if (spendVerdict.hard) {
      raiseSpendCapInterrupt({
        projectId: spendSwarm?.project_id,
        title: `Spend cap: swarm paused at $${spendVerdict.spentUsd.toFixed(2)}`,
        body: `Hard cap is $${spendVerdict.hardUsd?.toFixed(2) ?? 'off'}. Raise it in Settings → Appearance, then resume the swarm.`,
        runId: spendSwarm?.parent_run_id,
        href: `/`,
        spentUsd: spendVerdict.spentUsd,
        hardUsd: spendVerdict.hardUsd,
      });
      throw new CloudError(
        'SWARM_SPEND_CAP',
        `Live spend $${spendVerdict.spentUsd.toFixed(2)} hit the hard cap of $${spendVerdict.hardUsd?.toFixed(2)}. Swarm paused.`,
      );
    }
    const model = spendVerdict.soft
      ? downgradeModelForSoftCap(modelCandidate)
      : modelCandidate;
    const capabilities = providerCapabilitiesService.getProviderCapabilities(provider);
    const requestedPermissionMode = input.step.permissionMode || agent.permissionMode || null;
    const modeResolution = resolveSeatPermissionMode({
      kind: agent.kind,
      provider,
      capabilities,
      requested: requestedPermissionMode,
    });
    const permissionMode = modeResolution.mode;
    if (!permissionMode || !capabilities.permissionModes.includes(permissionMode)) {
      throw new Error(
        `Provider "${provider}" requires an explicit supported permission mode for ${agent.kind}; refusing to escalate permissions`,
      );
    }
    if (modeResolution.adjustment) {
      appendPolicyNote(swarmId, agent.label, modeResolution.adjustment);
    }
    if (permissionMode === 'bypassPermissions' && !isReadOnlyKind(agent.kind)) {
      appendPolicyNote(
        swarmId,
        agent.label,
        'provider-native bypassPermissions is enabled; the broker may not observe every tool call, so workspace isolation is the containment boundary',
      );
    }
    const effortResolution = resolveSeatEffort(capabilities, input.step.effort || agent.effort || null);
    const effort = effortResolution.effort;
    if (effortResolution.droppedNote) {
      appendPolicyNote(swarmId, agent.label, effortResolution.droppedNote);
    }
    const skills = [...(agent.skills ?? []), ...input.skills];

    const attemptNo = input.attemptNo && input.attemptNo > 0 ? input.attemptNo : 1;
    const isRetryAttempt = attemptNo > 1;

    const members = swarmDb.listMembers(swarmId);
    let member = isRetryAttempt
      ? // Each retry gets its own member row so the UI shows every attempt (and
        // which seat ran it) instead of overwriting the failed one.
        null
      : members.find(
          (m) =>
            (m.label && m.label.toLowerCase() === agent.label.toLowerCase()) ||
            // An explicit seat is matched by label only: falling back to "any
            // member of this kind" would hijack another seat's row.
            (!input.seatOverride && m.role === agent.kind),
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

    assertNotCancelled(swarmId);
    const swarm = swarmDb.get(swarmId)!;
    const blackboard = swarm.blackboard ?? [];

    const child = runService.create({
      source: 'swarm',
      projectId: swarm.project_id,
      parentRunId: input.parentRunId,
      rootRunId: input.parentRunId,
      workspaceId: input.workspaceIdOverride ?? swarm.workspace_id,
      provider,
      model,
      effort,
      permissionMode,
      title: `Swarm ${agent.label}${isRetryAttempt ? ` (attempt ${attemptNo})` : ''}: ${input.step.title.slice(0, 80)}`,
      trigger: `swarm:${swarmId}:${input.step.id}`,
      status: 'running',
      // profileId + difficulty are what make this run attributable in the cost
      // ledger; without them the spend cannot be traced back to an agent profile.
      profileId: agent.profileId ?? null,
      meta: {
        swarmId,
        role: agent.kind,
        stepId: input.step.id,
        effort,
        permissionMode,
        attempt: attemptNo,
        level: levelOf(agent.level),
        difficulty: levelOf(input.step.difficulty),
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
          // Persist what actually reaches the runtime (validated mode,
          // capability-checked effort) instead of the raw seat request.
          effort,
          permissionMode,
        });
      }
    } else {
      member = swarmDb.createMember({
        swarmId,
        role: agent.kind,
        kind: agent.kind,
        label: isRetryAttempt ? `${agent.label} · attempt ${attemptNo}` : agent.label,
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
    const attempt = swarmDb.createAttempt({
      swarmId,
      stepId: input.step.id,
      memberId: member.member_id,
      runId: child.run_id,
      phase: 'execute',
      status: 'running',
      workspaceId: input.workspaceIdOverride ?? swarm.workspace_id,
    });

    try {
      assertNotCancelled(swarmId);
      if (!isSwarmProvider(provider) || !getSwarmSpawnFn(provider)) {
        throw new Error(
          `Provider "${provider}" is not available. Authenticate it in Settings and retry.`,
        );
      }

      const stepAttachments = swarm.attachments ?? [];
      const prompt = buildStepPrompt({
        agent,
        step: input.feedback
          ? { ...input.step, prompt: `${input.feedback}\n${input.step.prompt}` }
          : input.step,
        goal: input.goal,
        skills,
        gitContext: input.gitContext,
        blackboard,
        attachments: stepAttachments,
      });

      // Capture immediately before dispatch. `git status` cannot validate a
      // sandbox_copy at all and cannot tell whether this step changed a git
      // worktree that an earlier step already left dirty.
      const requiresDiff = stepRequiresSourceChanges(input.step.kind, input.step.requiresChanges);
      const mutationBaseline = requiresDiff
        ? await captureWorkspaceMutationSnapshot(input.projectPath)
        : null;

      const outcome = await runSwarmAgent({
        projectId: swarm.project_id,
        projectPath: input.projectPath,
        provider,
        model,
        effort,
        permissionMode,
        prompt,
        images: providerImagesFromAttachments(stepAttachments),
        runId: child.run_id,
        title: `Swarm ${agent.label}`,
        timeoutMs: input.timeoutMs ?? null,
        stallTimeoutMs: input.stallTimeoutMs,
        signal: input.signal,
        permission: {
          swarmId,
          memberId: member.member_id,
          seatKind: agent.kind,
          seatLabel: agent.label,
          workspaceRoot: input.projectPath,
        },
      });
      assertNotCancelled(swarmId);
      const mutationAfter = mutationBaseline
        ? await captureWorkspaceMutationSnapshot(input.projectPath)
        : null;
      const requiredDiffMissing = Boolean(
        requiresDiff
          && mutationBaseline
          && mutationAfter
          && !workspaceMutationDetected(mutationBaseline, mutationAfter),
      );
      const parsed = parseMemberFindings(outcome.text);
      // A run that exits clean with an empty transcript is a plumbing failure
      // (provider events never reached the run), not an agent that ignored its
      // contract — blaming acceptance there sends the retry loop after work the
      // agent may well have done. Say what actually happened instead.
      const emptyOutput = outcome.success && !parsed.rawText.trim();
      const reviewerShipped =
        input.step.kind === 'reviewer'
        && looksLikeReviewApproval(outcome.text)
        && parsed.severity !== 'critical';
      const unmetCriteria = emptyOutput || reviewerShipped
        ? []
        : (input.step.acceptanceCriteria ?? []).filter(
            (criterion, index) =>
              !parsed.acceptance.some((evidence) => acceptanceEvidenceMatches(criterion, index, evidence)),
          );
      const contractError = emptyOutput
        ? `Agent "${agent.label}" (${provider}${model ? `/${model}` : ''}) finished successfully but emitted no output. `
          + 'No assistant text was captured for this run, so its findings could not be read.'
        : unmetCriteria.length > 0
          ? `Acceptance evidence missing or unmet: ${unmetCriteria.join('; ')}`
          : null;

      if (!outcome.success || requiredDiffMissing || contractError) {
        // `errorMessage` is only the real cause when the run itself failed;
        // on a clean exit it is whatever the provider wrote to stderr, which
        // for several CLIs is routine warning noise ("permission requested …;
        // auto-rejecting"). Letting that outrank the contract failure hides
        // why the step was actually rejected.
        const err = !outcome.success
          ? (outcome.errorMessage || 'Agent run failed')
          : contractError
            || (requiredDiffMissing
              ? 'Step required source changes but the agent left the workspace source tree unchanged'
              : outcome.errorMessage || 'Agent run failed');
        // A run/tool that never completed is a real failure. An agent that ran
        // fine and honestly reported unmet acceptance criteria (a reviewer
        // finding real defects, for example) is not the same thing — it is a
        // verdict, not a crash. Recording both as `failed` makes a correctly
        // working reviewer look identical to a provider that died mid-run, so
        // give the verdict case its own status.
        const isVerdictOnly = outcome.success
          && !requiredDiffMissing
          && !emptyOutput
          && unmetCriteria.length > 0;
        const stepStatus = isVerdictOnly ? 'needs_changes' : 'failed';
        swarmDb.updateMember(member.member_id, {
          status: stepStatus,
          error: err,
          findingsSummary: findingsSummaryLine(parsed).slice(0, 1500) || null,
          finished: true,
        });
        persistPlanStepStatus(swarmId, input.step.id, stepStatus);
        swarmDb.updateAttempt(attempt.attempt_id, {
          status: outcome.timedOut ? 'timed_out' : stepStatus,
          error: err,
        });
        const content = outcome.text || err;
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: agent.label,
          kind: 'result',
          content: `${isVerdictOnly ? 'NEEDS CHANGES' : 'FAILED'} step ${input.step.id}: ${content.slice(0, 2000)}`,
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
          needsChanges: isVerdictOnly,
          seat: agent,
          timedOut: Boolean(outcome.timedOut),
          stalled: Boolean(outcome.stalled),
          error: err,
          output: outcome.text || null,
        };
      }

      const summary = findingsSummaryLine(parsed);
      if (parsed.changedFiles.length > 0) {
        swarmDb.createArtifact({
          swarmId,
          stepId: input.step.id,
          attemptId: attempt.attempt_id,
          kind: 'changed_files',
          label: `${input.step.title} changed files`,
          content: JSON.stringify(parsed.changedFiles),
        });
      }
      if (parsed.verification.length > 0) {
        swarmDb.createArtifact({
          swarmId,
          stepId: input.step.id,
          attemptId: attempt.attempt_id,
          kind: 'verification',
          label: `${input.step.title} verification`,
          content: JSON.stringify(parsed.verification),
        });
      }
      if (parsed.acceptance.length > 0) {
        swarmDb.createArtifact({
          swarmId,
          stepId: input.step.id,
          attemptId: attempt.attempt_id,
          kind: 'acceptance',
          label: `${input.step.title} acceptance evidence`,
          content: JSON.stringify(parsed.acceptance),
        });
      }
      swarmDb.updateMember(member.member_id, {
        status: 'succeeded',
        findingsSummary: summary,
        error: null,
        finished: true,
      });
      persistPlanStepStatus(swarmId, input.step.id, 'succeeded');
      swarmDb.updateAttempt(attempt.attempt_id, { status: 'succeeded' });
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
        seat: agent,
        timedOut: false,
        stalled: false,
        error: null,
        output: outcome.text || null,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (cancellationRequested(swarmId)) {
        swarmDb.updateAttempt(attempt.attempt_id, { status: 'aborted', error: msg });
        throw error;
      }
      persistPlanStepStatus(swarmId, input.step.id, 'failed');
      swarmDb.updateAttempt(attempt.attempt_id, { status: 'failed', error: msg });
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
        seat: agent,
        timedOut: false,
        stalled: false,
        error: msg,
        output: null,
      };
    }
  },

  /**
   * Run ONE plan step to success, with a bounded attempt budget.
   *
   * Each failed attempt feeds its own error (and any partial output) back into
   * the next attempt, and the step is handed to a DIFFERENT, equal-or-stronger
   * seat whenever one is available — a stalled or failing agent rarely
   * succeeds by simply being asked again. Only after the budget is spent does
   * the step surface as failed, which is what triggers an orchestrator replan.
   */
  async runStepWithFeedbackRetries(
    swarmId: string,
    input: {
      step: SwarmPlanStep;
      goal: string;
      projectPath: string;
      parentRunId: string | null;
      rosterRef: RosterRef;
      skills: string[];
      gitContext: string;
      defaultProvider: LLMProvider | string;
      defaultModel?: string | null;
      timeoutMs?: number | null;
      stallTimeoutMs?: number | null;
      signal?: AbortSignal | null;
      maxAttempts: number;
      autoRoster: boolean;
      costLedger?: SwarmCostLedger | null;
      parallelWriterWorkspaces?: boolean;
    },
  ): Promise<{
    step: SwarmPlanStep;
    finding: SwarmFinding;
    failed: boolean;
    needsChanges?: boolean;
    attempts: SwarmStepAttemptRecord[];
    output?: string | null;
    seat?: SwarmAgentSpec;
    error?: string | null;
  }> {
    const history: SwarmStepAttemptRecord[] = [];
    const priorAttempts = swarmDb
      .listAttempts(swarmId, input.step.id)
      .filter((attempt) => attempt.phase === 'execute');
    const attemptOffset = priorAttempts.length;
    const triedSeatIds = new Set<string>();
    // provider|model|effort of every agent already tried, so a retry never lands
    // on a differently-labelled clone of the seat that just failed.
    const triedSignatures = new Set<string>();
    let maxTriedLevelRank = 0;
    let seatOverride: SwarmAgentSpec | null = null;
    let feedback: string | null = priorAttempts.length > 0
      ? [
          '## CONTINUING FROM A PREVIOUS FAILED SWARM CHECKPOINT',
          'The existing worktree and completed work were preserved. Re-check the current state before editing.',
          ...priorAttempts.slice(-3).map((attempt) =>
            `- Prior attempt ${attempt.attempt_no}: ${attempt.status}${attempt.error ? ` — ${attempt.error.slice(0, 600)}` : ''}`,
          ),
          '',
          '## The step (unchanged)',
        ].join('\n')
      : null;
    let lastResult: Awaited<ReturnType<typeof swarmService.executeStep>> | null = null;

    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      assertNotCancelled(swarmId);
      let attemptWorkspace: AgentWorkspace | null = null;
      let attemptProjectPath = input.projectPath;
      if (input.parallelWriterWorkspaces && (input.step.kind === 'implementer' || input.step.kind === 'custom')) {
        const swarm = swarmDb.get(swarmId);
        const parentWorkspace = swarm?.workspace_id ? workspaceService.get(swarm.workspace_id) : null;
        if (!swarm || !parentWorkspace || parentWorkspace.mode !== 'git_worktree' || !parentWorkspace.feature_branch) {
          throw new Error('Parallel writer execution requires a git-backed swarm worktree');
        }
        attemptWorkspace = await workspaceService.create({
          projectId: swarm.project_id,
          projectPath: input.projectPath,
          baseBranch: parentWorkspace.feature_branch,
          branchName: `swarm/${swarmId.replace(/^swarm_/, '').slice(0, 10)}/${slugifyGoal(input.step.id)}-${attempt}-${Date.now().toString(36)}`,
          runId: input.parentRunId ?? undefined,
        });
        attemptProjectPath = workspaceService.resolveCwd(attemptWorkspace.workspace_id);
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: 'Swarm policy',
          kind: 'system',
          content: `[workspace] step ${input.step.id} attempt ${attempt} isolated in ${attemptWorkspace.workspace_id}`,
          stepId: input.step.id,
          at: new Date().toISOString(),
        });
      }
      let result = await swarmService.executeStep(swarmId, {
        step: input.step,
        goal: input.goal,
        projectPath: attemptProjectPath,
        parentRunId: input.parentRunId,
        roster: input.rosterRef.current,
        skills: input.skills,
        gitContext: input.gitContext,
        defaultProvider: input.defaultProvider,
        defaultModel: input.defaultModel ?? null,
        timeoutMs: input.timeoutMs ?? null,
        stallTimeoutMs: input.stallTimeoutMs,
        signal: input.signal,
        seatOverride,
        attemptNo: attemptOffset + attempt,
        feedback,
        workspaceIdOverride: attemptWorkspace?.workspace_id ?? null,
      });

      if (attemptWorkspace && !result.failed) {
        const status = await runGit(attemptProjectPath, ['status', '--porcelain']);
        if (status.code === 0 && status.stdout.trim()) {
          await runGit(attemptProjectPath, ['add', '-A']);
          const commit = await runGit(attemptProjectPath, [
            'commit',
            '-m',
            `swarm: ${input.step.title.slice(0, 72)}`,
            '--author',
            'CloudCLI Swarm <swarm@cloudcli.local>',
          ]);
          if (commit.code !== 0 && !/nothing to commit/i.test(`${commit.stdout} ${commit.stderr}`)) {
            result = {
              ...result,
              failed: true,
              error: `Could not commit isolated step workspace: ${commit.stderr || commit.stdout}`.slice(0, 1000),
            };
          }
        }
        if (!result.failed) {
          const mergeError = await withSwarmMergeLock(input.projectPath, async () => {
            const merge = await runGit(input.projectPath, [
              'merge',
              '--no-ff',
              '--no-edit',
              attemptWorkspace!.feature_branch!,
            ]);
            if (merge.code !== 0) {
              await runGit(input.projectPath, ['merge', '--abort']);
              return `Parallel step merge conflict for ${input.step.id}: ${merge.stderr || merge.stdout}`.slice(0, 1000);
            }
            await workspaceService.discard(attemptWorkspace!.workspace_id, { deleteBranch: true });
            return null;
          });
          if (mergeError) {
            result = {
              ...result,
              failed: true,
              error: mergeError,
            };
            swarmDb.appendMessage(swarmId, {
              id: newMsgId(),
              from: 'Swarm policy',
              kind: 'system',
              content: `[workspace] merge conflict for step ${input.step.id}; isolated workspace ${attemptWorkspace.workspace_id} was kept for diagnosis`,
              stepId: input.step.id,
              at: new Date().toISOString(),
            });
          }
        }
      }
      if (attemptWorkspace && result.failed) {
        persistPlanStepStatus(swarmId, input.step.id, 'failed');
        const latestAttempt = swarmDb.listAttempts(swarmId, input.step.id).at(-1);
        if (latestAttempt) {
          swarmDb.updateAttempt(latestAttempt.attempt_id, { status: 'failed', error: result.error });
        }
        swarmDb.updateMember(result.finding.memberId, {
          status: 'failed',
          error: result.error,
          finished: true,
        });
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: 'Swarm policy',
          kind: 'system',
          content: `[workspace] isolated workspace ${attemptWorkspace.workspace_id} retained after failed step ${input.step.id}`,
          stepId: input.step.id,
          at: new Date().toISOString(),
        });
      }
      lastResult = result;
      triedSeatIds.add(result.seat.id ?? result.seat.label);
      triedSignatures.add(agentSignature(result.seat));
      maxTriedLevelRank = Math.max(maxTriedLevelRank, LEVEL_RANK[levelOf(result.seat.level)]);

      if (!result.failed) {
        if (attempt > 1) {
          swarmDb.appendMessage(swarmId, {
            id: newMsgId(),
            from: 'Swarm policy',
            kind: 'system',
          content: `[retry] step ${input.step.id} succeeded on attempt ${attemptOffset + attempt} with "${result.seat.label}"`,
            stepId: input.step.id,
            at: new Date().toISOString(),
          });
        }
        history.push({ attempt: attemptOffset + attempt, seatLabel: result.seat.label, outcome: 'succeeded' });
        return {
          step: result.step,
          finding: result.finding,
          failed: false,
          attempts: history,
          output: result.output ?? null,
          seat: result.seat,
          error: result.error ?? null,
        };
      }

      // A reviewer asking for changes is a successful review verdict, not a
      // request to run the reviewer again against the same unchanged tree.
      // Return it immediately so the orchestrator can dispatch an implementer;
      // the pipeline schedules a fresh review after that correction lands.
      if (result.needsChanges && input.step.kind === 'reviewer') {
        history.push({
          attempt: attemptOffset + attempt,
          seatLabel: result.seat.label,
          outcome: 'needs_changes',
          error: result.error?.slice(0, 1_000) ?? null,
        });
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: 'Swarm policy',
          kind: 'system',
          content: `[review] step ${input.step.id} requested changes — dispatching implementation remediation before re-review`,
          stepId: input.step.id,
          at: new Date().toISOString(),
        });
        return {
          step: result.step,
          finding: result.finding,
          failed: true,
          needsChanges: true,
          attempts: history,
          output: result.output ?? null,
          seat: result.seat,
          error: result.error ?? null,
        };
      }

      const outcome: SwarmStepAttemptRecord['outcome'] = result.stalled
        ? 'stalled'
        : result.timedOut
          ? 'timed_out'
          : 'failed';
      const record: SwarmStepAttemptRecord = {
        attempt: attemptOffset + attempt,
        seatLabel: result.seat.label,
        outcome,
        error: result.error?.slice(0, 1_000) ?? null,
      };
      history.push(record);

      if (attempt >= input.maxAttempts) {
        swarmDb.appendMessage(swarmId, {
          id: newMsgId(),
          from: 'Swarm policy',
          kind: 'system',
          content: `[retry] step ${input.step.id} exhausted its ${input.maxAttempts} attempt(s) — escalating to the orchestrator for a replan`,
          stepId: input.step.id,
          at: new Date().toISOString(),
        });
        break;
      }

      // Hand the step to a different, equal-or-stronger seat when one exists.
      const takeover = pickReassignmentSeat({
        swarmId,
        step: input.step,
        rosterRef: input.rosterRef,
        triedSeatIds,
        triedSignatures,
        maxTriedLevelRank,
        autoRoster: input.autoRoster,
        costLedger: input.costLedger ?? null,
        defaultProvider: input.defaultProvider,
        defaultModel: input.defaultModel ?? null,
        failedSeat: result.seat,
      });
      seatOverride = takeover?.seat ?? null;
      record.reassigned = Boolean(takeover);
      feedback = buildRetryFeedback(history, result.output, Boolean(takeover));

      swarmDb.appendMessage(swarmId, {
        id: newMsgId(),
        from: 'Swarm policy',
        kind: 'system',
        content: `[retry] step ${input.step.id} attempt ${attempt} ${outcome} on "${result.seat.label}" — ${
          takeover ? takeover.note : `retrying with the same seat and failure feedback (no stronger untried seat available)`
        } (attempt ${attempt + 1}/${input.maxAttempts})`,
        stepId: input.step.id,
        at: new Date().toISOString(),
      });
    }

    return {
      step: lastResult?.step ?? input.step,
      finding:
        lastResult?.finding ??
        {
          memberId: '',
          role: input.step.assignTo || input.step.kind,
          summary: `Step ${input.step.id} produced no attempts`,
          at: new Date().toISOString(),
          stepId: input.step.id,
        },
      failed: true,
      needsChanges: lastResult?.needsChanges ?? false,
      attempts: history,
      output: lastResult?.output ?? null,
      seat: lastResult?.seat,
      error: lastResult?.error ?? null,
    };
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
   * After the initial plan hits friction, the orchestrator stays on shift.
   * Policy chooses the legal next role; the LLM writes the brief and picks
   * the seat. Bounded by the supervisor tick budget.
   */
  async runSupervisorLoop(
    swarmId: string,
    input: {
      event: SupervisorEvent;
      goalCard: SwarmGoalCard;
      livePlan: SwarmPlan;
      findings: SwarmFinding[];
      goal: string;
      projectPath: string;
      parentRunId: string | null;
      orchestrator: SwarmAgentSpec;
      rosterRef: RosterRef;
      skills: string[];
      gitContext: string;
      defaultProvider: LLMProvider | string;
      defaultModel?: string | null;
      timeoutMs?: number | null;
      stallTimeoutMs?: number | null;
      signal?: AbortSignal | null;
      maxAttempts: number;
      autoRoster: boolean;
      costLedger?: SwarmCostLedger | null;
    },
  ): Promise<{ goalCard: SwarmGoalCard; plan: SwarmPlan; findings: SwarmFinding[] }> {
    let card: SwarmGoalCard = { ...input.goalCard, mode: 'supervisor' };
    let event = input.event;
    const plan: SwarmPlan = { ...input.livePlan, steps: [...input.livePlan.steps] };
    const findings = [...input.findings];
    persistGoalCard(swarmId, card);

    const hasKind = (kind: string) =>
      input.rosterRef.current.some((seat) => seat.kind === kind);

    const finish = (status: SwarmGoalCard['status'], reason: string) => {
      if (status === 'accepted') {
        for (let idx = 0; idx < plan.steps.length; idx += 1) {
          const step = plan.steps[idx];
          if (step.status === 'failed' || step.status === 'needs_changes') {
            plan.steps[idx] = { ...step, status: 'recovered' };
          }
        }
      }
      card = { ...card, status, updatedAt: new Date().toISOString() };
      persistGoalCard(swarmId, card);
      swarmDb.update(swarmId, { plan, findings });
      swarmDb.appendMessage(swarmId, {
        id: newMsgId(),
        from: 'Swarm orchestrator',
        kind: 'system',
        content: `[supervisor] ${reason}`,
        at: new Date().toISOString(),
      });
      return { goalCard: card, plan, findings };
    };

    for (;;) {
      assertNotCancelled(swarmId);
      card = applySupervisorEvent(card, event);
      persistGoalCard(swarmId, card);
      const policy = routeSupervisorPolicy(card, event);

      const noReviewerNeeded =
        policy.kind === 'reviewer' && !hasKind('reviewer') && event.kind === 'implementer_changed';
      if (policy.action === 'done' || noReviewerNeeded) {
        return finish('accepted', policy.reason);
      }

      if (card.ticksUsed >= card.tickBudget) {
        return finish(
          'blocked',
          `Supervisor tick budget exhausted (${card.tickBudget}). Last event: ${event.kind}.`,
        );
      }

      const tick = card.ticksUsed + 1;
      card = { ...card, ticksUsed: tick };
      persistGoalCard(swarmId, card);
      setOrchestratorMemberStatus(
        swarmId,
        'supervising',
        `Tick ${tick}/${card.tickBudget}: ${policy.reason}`,
      );

      const draft = await this.consultSupervisor(swarmId, {
        goal: input.goal,
        projectPath: input.projectPath,
        parentRunId: input.parentRunId,
        orchestrator: input.orchestrator,
        defaultProvider: input.defaultProvider,
        defaultModel: input.defaultModel ?? null,
        card,
        event,
        policy,
        roster: input.rosterRef.current,
        planSummary: input.livePlan.summary,
        signal: input.signal,
      });
      const applied = applySupervisorPolicy(policy, draft);
      const coerced = Boolean(
        draft && (draft.kind !== applied.kind || draft.action !== applied.action),
      );

      if (applied.action === 'done') {
        card = appendSupervisorDecision(card, {
          tick,
          action: 'done',
          kind: null,
          title: applied.title,
          reason: applied.reason,
          policy: policy.policy,
          coerced,
          stepId: null,
        });
        return finish('accepted', applied.reason);
      }
      if (applied.action === 'blocked') {
        card = appendSupervisorDecision(card, {
          tick,
          action: 'blocked',
          kind: null,
          title: applied.title,
          reason: applied.reason,
          policy: policy.policy,
          coerced,
          stepId: null,
        });
        return finish('blocked', applied.reason);
      }

      if (applied.kind === 'reviewer' && !hasKind('reviewer') && event.kind === 'implementer_changed') {
        card = appendSupervisorDecision(card, {
          tick,
          action: 'done',
          kind: null,
          title: applied.title,
          reason: 'No reviewer seat; implementation succeeded so the goal is treated as done.',
          policy: policy.policy,
          coerced: true,
          stepId: null,
        });
        return finish('accepted', 'Implementation succeeded and no reviewer is on the roster.');
      }

      if (applied.kind === 'reviewer') {
        const fingerprint = await captureWorktreeFingerprint(input.projectPath);
        if (shouldRefuseReviewer(card, fingerprint)) {
          applied.kind = 'implementer';
          applied.requiresChanges = true;
          applied.reason = `${applied.reason} (policy: tree unchanged — implementer required)`;
        }
      }

      if (policy.escalate && (applied.kind === 'implementer' || applied.kind === 'custom')) {
        const writers = input.rosterRef.current
          .filter((seat) => seat.kind === 'implementer' || seat.kind === 'custom')
          .sort((a, b) => LEVEL_RANK[levelOf(b.level)] - LEVEL_RANK[levelOf(a.level)]);
        if (writers[0] && !applied.assignTo) applied.assignTo = writers[0].label;
      }

      const step = buildSupervisorStep({
        decision: applied,
        event,
        packets: event.packets.length ? event.packets : (card.lastReview?.blockers ?? []),
      });
      if (step.kind === 'reviewer') {
        const priorReview = plan.steps.find((entry) => entry.id === card.lastReview?.stepId)
          ?? plan.steps.find((entry) => entry.kind === 'reviewer' && entry.prompt);
        if (priorReview?.prompt && !step.prompt.includes(priorReview.prompt.slice(0, 80))) {
          step.prompt = [
            step.prompt,
            `Re-review the current worktree after implementation. Do not approve based only on the implementer's report.`,
            priorReview.prompt,
          ].filter(Boolean).join('\n\n');
        }
      }
      plan.steps.push({ ...step, status: 'queued' });
      swarmDb.update(swarmId, { plan });
      card = appendSupervisorDecision(card, {
        tick,
        action: 'dispatch',
        kind: applied.kind,
        title: step.title,
        reason: applied.reason,
        policy: policy.policy,
        coerced,
        stepId: step.id,
      });
      persistGoalCard(swarmId, card);
      swarmDb.appendMessage(swarmId, {
        id: newMsgId(),
        from: 'Swarm orchestrator',
        kind: 'system',
        content: `[supervisor] tick ${tick}/${card.tickBudget}: ${applied.action} ${applied.kind ?? ''} — ${applied.reason}`,
        stepId: step.id,
        at: new Date().toISOString(),
      });

      const result = await this.runStepWithFeedbackRetries(swarmId, {
        step,
        goal: input.goal,
        projectPath: input.projectPath,
        parentRunId: input.parentRunId,
        rosterRef: input.rosterRef,
        skills: input.skills,
        gitContext: input.gitContext,
        defaultProvider: input.defaultProvider,
        defaultModel: input.defaultModel ?? null,
        timeoutMs: input.timeoutMs,
        stallTimeoutMs: input.stallTimeoutMs,
        signal: input.signal,
        maxAttempts: input.maxAttempts,
        autoRoster: input.autoRoster,
        costLedger: input.costLedger,
      });
      assertNotCancelled(swarmId);
      findings.push(result.finding);
      const stepStatus = result.needsChanges ? 'needs_changes' : result.failed ? 'failed' : 'succeeded';
      const stepIndex = plan.steps.findIndex((entry) => entry.id === step.id);
      if (stepIndex >= 0) plan.steps[stepIndex] = { ...plan.steps[stepIndex], status: stepStatus };

      if (!result.failed && step.replacesStepId && step.kind !== 'reviewer') {
        const replaced = plan.steps.findIndex((entry) => entry.id === step.replacesStepId);
        if (replaced >= 0 && plan.steps[replaced].kind !== 'reviewer') {
          plan.steps[replaced] = { ...plan.steps[replaced], status: 'recovered' };
        }
      }
      if (!result.failed && step.kind === 'reviewer' && step.replacesStepId) {
        const replaced = plan.steps.findIndex((entry) => entry.id === step.replacesStepId);
        if (replaced >= 0) {
          plan.steps[replaced] = { ...plan.steps[replaced], status: 'recovered' };
        }
        // A passing re-review also closes the original review that requested changes.
        const originalReview = card.lastReview?.stepId;
        if (originalReview) {
          const originalIndex = plan.steps.findIndex((entry) => entry.id === originalReview);
          if (originalIndex >= 0 && plan.steps[originalIndex].status === 'needs_changes') {
            plan.steps[originalIndex] = { ...plan.steps[originalIndex], status: 'recovered' };
          }
        }
      }

      const fingerprint = await captureWorktreeFingerprint(input.projectPath);
      const parsed = parseMemberFindings(result.output ?? result.finding.summary ?? '');
      event = classifySupervisorEvent({
        stepKind: step.kind,
        stepId: step.id,
        seatLabel: result.seat?.label ?? result.finding.role,
        output: result.output ?? null,
        error: result.error ?? result.finding.summary,
        failed: Boolean(result.failed),
        needsChanges: Boolean(result.needsChanges),
        packets: extractCritiquePackets(parsed, result.error ?? result.finding.summary),
        fingerprint,
      });
      swarmDb.update(swarmId, { findings, plan });
    }
  },

  async consultSupervisor(
    swarmId: string,
    input: {
      goal: string;
      projectPath: string;
      parentRunId: string | null;
      orchestrator: SwarmAgentSpec;
      defaultProvider: LLMProvider | string;
      defaultModel?: string | null;
      card: SwarmGoalCard;
      event: SupervisorEvent;
      policy: ReturnType<typeof routeSupervisorPolicy>;
      roster: SwarmAgentSpec[];
      planSummary?: string | null;
      signal?: AbortSignal | null;
    },
  ) {
    const provider = resolveSwarmProvider(input.orchestrator.provider || input.defaultProvider);
    if (!isSwarmProvider(provider) || !getSwarmSpawnFn(provider)) return null;
    const currentSwarm = swarmDb.get(swarmId);
    if (!currentSwarm) return null;
    const model = input.orchestrator.model || input.defaultModel || null;
    const effort = resolveSeatEffort(
      providerCapabilitiesService.getProviderCapabilities(provider),
      input.orchestrator.effort ?? null,
    ).effort;
    const permissionMode = readOnlyPermissionMode(provider);
    const orchestratorMember = swarmDb
      .listMembers(swarmId)
      .find((member) => member.kind === 'orchestrator' || member.role === 'orchestrator');
    const run = runService.create({
      source: 'swarm',
      projectId: currentSwarm.project_id,
      parentRunId: input.parentRunId,
      rootRunId: input.parentRunId,
      workspaceId: currentSwarm.workspace_id,
      provider,
      model,
      effort,
      permissionMode,
      title: `Swarm supervise tick ${input.card.ticksUsed}`,
      trigger: `swarm-supervise:${swarmId}`,
      status: 'running',
      meta: { swarmId, role: 'orchestrator', phase: 'supervise' },
    });
    const attempt = swarmDb.createAttempt({
      swarmId,
      stepId: `supervise-${input.card.ticksUsed}`,
      memberId: orchestratorMember?.member_id ?? null,
      runId: run.run_id,
      phase: 'supervise',
      status: 'running',
      workspaceId: currentSwarm.workspace_id,
    });
    if (orchestratorMember) {
      swarmDb.updateMember(orchestratorMember.member_id, {
        status: 'supervising',
        runId: run.run_id,
        finished: false,
      });
    }
    try {
      const outcome = await runSwarmAgent({
        projectId: currentSwarm.project_id,
        projectPath: input.projectPath,
        provider,
        model,
        effort,
        permissionMode,
        prompt: buildSupervisorPrompt({
          goal: input.goal,
          card: input.card,
          event: input.event,
          policy: input.policy,
          roster: input.roster,
          planSummary: input.planSummary,
        }),
        images: providerImagesFromAttachments(currentSwarm.attachments),
        runId: run.run_id,
        title: `Swarm supervisor tick ${input.card.ticksUsed}`,
        timeoutMs: 4 * 60 * 1000,
        signal: input.signal,
        permission: {
          swarmId,
          seatKind: 'orchestrator',
          seatLabel: input.orchestrator.label || 'Orchestrator',
          workspaceRoot: input.projectPath,
        },
      });
      if (!outcome.success) {
        swarmDb.updateAttempt(attempt.attempt_id, {
          status: 'failed',
          error: outcome.errorMessage || 'supervisor consult failed',
        });
        return null;
      }
      swarmDb.updateAttempt(attempt.attempt_id, { status: 'succeeded' });
      try {
        const current = runService.get(run.run_id);
        if (current && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(current.status)) {
          runService.markTerminal(run.run_id, { status: 'succeeded' });
        }
      } catch { /* optional */ }
      return parseSupervisorDecision(outcome.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      swarmDb.updateAttempt(attempt.attempt_id, {
        status: cancellationRequested(swarmId) ? 'aborted' : 'failed',
        error: message,
      });
      return null;
    }
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
      signal?: AbortSignal | null;
      /** Per-step attempt history, so the replan avoids seats that already failed. */
      attemptsByStep?: Record<string, SwarmStepAttemptRecord[]>;
    },
  ): Promise<{ steps: SwarmPlanStep[] } | null> {
    const failed = input.failedSteps;
    const provider = resolveSwarmProvider(
      input.orchestrator.provider || input.defaultProvider,
    );
    if (!isSwarmProvider(provider) || !getSwarmSpawnFn(provider)) return null;

    // Who already failed, on what, and why. Without this the orchestrator
    // reassigns the replacement straight back to the seat that just burned its
    // whole attempt budget on the same work.
    const failedSummary = failed
      .map((step) => {
        const attempts = input.attemptsByStep?.[step.id] ?? [];
        const head = `- ${step.id} [wave ${step.wave ?? '?'} ${step.kind}${step.difficulty ? `, ${step.difficulty}` : ''}] ${step.title}${step.assignTo ? ` → ${step.assignTo}` : ''}`;
        if (attempts.length === 0) return head;
        const lines = attempts.map(
          (attempt) =>
            `    · attempt ${attempt.attempt} by "${attempt.seatLabel}" — ${attempt.outcome}${attempt.error ? `: ${attempt.error.slice(0, 300)}` : ''}`,
        );
        return [head, ...lines].join('\n');
      })
      .join('\n');

    const exhaustedSeats = [
      ...new Set(
        failed.flatMap((step) =>
          (input.attemptsByStep?.[step.id] ?? []).map((attempt) => attempt.seatLabel),
        ),
      ),
    ];
    const seatMenu = input.roster
      .filter((seat) => seat.kind !== 'orchestrator')
      .map(
        (seat) =>
          `- "${seat.label}" (${seat.kind}, level ${levelOf(seat.level)}, ${seat.provider ?? 'default provider'})${
            exhaustedSeats.includes(seat.label) ? ' — ALREADY FAILED this work' : ''
          }`,
      )
      .join('\n');

    const currentSwarm = swarmDb.get(swarmId)!;
    const replanAttachments = currentSwarm.attachments ?? [];
    const prompt = buildStepPrompt({
      agent: input.orchestrator,
      step: {
        id: 'replan',
        title: 'Replan failed steps',
        kind: 'orchestrator',
        wave: 0,
        prompt: [
          `The following steps of your swarm plan failed and need recovery.`,
          `Each one already used its full per-step attempt budget, with automatic`,
          `feedback and hand-offs between seats — so a plain re-run of the same`,
          `work by the same agent will fail again.`,
          ``,
          failedSummary,
          ``,
          `## Seats available`,
          seatMenu || '(no worker seats listed)',
          ``,
          `## Rules for the replacement step(s)`,
          `- Produce at most ${failed.length} replacement step(s). Recover what you can, skip what is unrecoverable, and never invent steps beyond the failures.`,
          `- Change something real: assign it to a DIFFERENT seat, or a more capable one (higher level), or narrow the step so it is achievable. Re-issuing identical work to a seat marked "ALREADY FAILED this work" is not acceptable.`,
          `- A reviewer whose verdict is needs_changes has completed its job. Its replacement MUST be an implementer/custom correction step that changes the worktree; never dispatch another explorer or reviewer until the correction has landed. The pipeline will automatically re-run review afterward.`,
          exhaustedSeats.length
            ? `- These seats already exhausted their attempts on this work: ${exhaustedSeats.join(', ')}.`
            : '',
          `- Quote the specific error from the attempt history in the new step's prompt, and set "difficulty" and "scope" as usual.`,
          `- If a failure is genuinely unrecoverable (missing credentials, impossible requirement), omit it rather than looping.`,
        ]
          .filter(Boolean)
          .join('\n'),
        dependsOn: [],
      },
      goal: input.goal,
      skills: input.skills,
      gitContext: input.gitContext + '\n\n' + input.blackboard.slice(-5).map((b) => `- ${b.from}: ${b.content.slice(0, 300)}`).join('\n'),
      blackboard: input.blackboard,
      attachments: replanAttachments,
    });
    const model = input.orchestrator.model || input.defaultModel || null;
    const effort = resolveSeatEffort(
      providerCapabilitiesService.getProviderCapabilities(provider),
      input.orchestrator.effort ?? null,
    ).effort;
    const permissionMode = readOnlyPermissionMode(provider);
    const orchestratorMember = swarmDb
      .listMembers(swarmId)
      .find((member) => member.kind === 'orchestrator' || member.role === 'orchestrator');
    const replanRun = runService.create({
      source: 'swarm',
      projectId: currentSwarm.project_id,
      parentRunId: input.parentRunId,
      rootRunId: input.parentRunId,
      workspaceId: currentSwarm.workspace_id,
      provider,
      model,
      effort,
      permissionMode,
      title: `Swarm replan: ${failed.length} failed step(s)`,
      trigger: `swarm-replan:${swarmId}`,
      status: 'running',
      meta: { swarmId, role: 'orchestrator', phase: 'replan' },
    });
    const replanAttempt = swarmDb.createAttempt({
      swarmId,
      stepId: 'replan-failed-steps',
      memberId: orchestratorMember?.member_id ?? null,
      runId: replanRun.run_id,
      phase: 'replan',
      status: 'running',
      workspaceId: currentSwarm.workspace_id,
    });

    let outcome;
    try {
      outcome = await runSwarmAgent({
        projectId: swarmDb.get(swarmId)!.project_id,
        projectPath: input.projectPath,
        provider,
        model,
        effort,
        permissionMode,
        prompt,
        images: providerImagesFromAttachments(currentSwarm.attachments),
        runId: replanRun.run_id,
        title: `Swarm Replan (${failed.length} failed)`,
        timeoutMs: 4 * 60 * 1000,
        signal: input.signal,
        permission: {
          swarmId,
          seatKind: 'orchestrator',
          seatLabel: input.orchestrator.label || 'Orchestrator',
          workspaceRoot: input.projectPath,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      swarmDb.updateAttempt(replanAttempt.attempt_id, {
        status: cancellationRequested(swarmId) ? 'aborted' : 'failed',
        error: message,
      });
      try {
        const run = runService.get(replanRun.run_id);
        if (run && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(run.status)) {
          runService.markTerminal(replanRun.run_id, {
            status: cancellationRequested(swarmId) ? 'aborted' : 'failed',
            errorSummary: message,
          });
        }
      } catch { /* optional */ }
      return null;
    }

    if (!outcome.success) {
      swarmDb.updateAttempt(replanAttempt.attempt_id, {
        status: 'failed',
        error: outcome.errorMessage || 'orchestrator replan failed',
      });
      return null;
    }

    // Replacement steps come from JSON { steps: [{ id, title, kind, prompt, ... }] }.
    let replaced: SwarmPlanStep[] | null = null;
    try {
      const parsed = parseJsonFromAgentText(outcome.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        if (Array.isArray(o.steps)) {
          const writerSeats = input.roster
            .filter((seat) => seat.kind === 'implementer' || seat.kind === 'custom')
            .sort((a, b) => LEVEL_RANK[levelOf(b.level)] - LEVEL_RANK[levelOf(a.level)]);
          const cleaned = (o.steps as Array<Record<string, unknown>>)
            .filter((s) => typeof s?.title === 'string' && s.title.trim())
            .slice(0, failed.length)
            .map((s, i) => {
              const source = failed[i];
              const reviewerVerdict = source?.kind === 'reviewer'
                && (input.attemptsByStep?.[source.id] ?? []).some((attempt) => attempt.outcome === 'needs_changes');
              const correctionSeat = reviewerVerdict ? writerSeats[0] ?? null : null;
              return {
                // A plain positional fallback (e.g. `replan-1`) collides across
                // replan rounds — round 2's step could get the exact id round 1's
                // step already used, so it points `replacesStepId` at itself and
                // its own "succeeded" write gets clobbered by the "recovered"
                // write meant for a *different* step. Must be unique per call.
                id: typeof s.id === 'string' ? s.id : `replan-${i + 1}-${newMsgId()}`,
                replacesStepId: source?.id ?? null,
                title: (s.title as string).trim(),
                kind: reviewerVerdict
                  ? 'implementer'
                  : (isSwarmAgentKind(s.kind) ? s.kind : 'implementer') as SwarmPlanStep['kind'],
                wave: 0,
                assignTo: correctionSeat?.label ?? (typeof s.assignTo === 'string' ? s.assignTo : undefined),
                // Carry the sizing signals through so the recovery step is staffed
                // and scoped by the same rules as an original step.
                difficulty: isSwarmAgentLevel(s.difficulty) ? s.difficulty : null,
                scope: Array.isArray(s.scope)
                  ? (s.scope as unknown[])
                      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
                      .map((entry) => entry.trim().slice(0, 300))
                      .slice(0, 24)
                  : [],
                prompt: [
                  reviewerVerdict
                    ? `Implement the changes requested by reviewer step "${source.title}". Do not merely audit or restate the findings; edit the worktree and verify the correction.`
                    : '',
                  typeof s.prompt === 'string' ? s.prompt : `Recover failed step ${s.title}`,
                ].filter(Boolean).join('\n\n'),
                dependsOn: Array.isArray(s.dependsOn) ? (s.dependsOn as string[]) : [],
                // Recovery must clear the same bar the original step did — a
                // replacement that quietly drops requiresChanges/acceptance
                // criteria could report "succeeded" without ever proving it
                // fixed what actually failed.
                requiresChanges: stepRequiresSourceChanges(
                  reviewerVerdict
                    ? 'implementer'
                    : (isSwarmAgentKind(s.kind) ? s.kind : 'implementer'),
                  reviewerVerdict ? true : source?.requiresChanges,
                ),
                acceptanceCriteria: source?.acceptanceCriteria,
                verificationCommands: source?.verificationCommands,
              };
            });
          replaced = cleaned;
        }
      }
    } catch {
      replaced = null;
    }
    if (!replaced || replaced.length === 0) {
      swarmDb.updateAttempt(replanAttempt.attempt_id, {
        status: 'failed',
        error: 'orchestrator returned no valid replacement steps',
      });
      return null;
    }
    swarmDb.updateAttempt(replanAttempt.attempt_id, { status: 'succeeded' });
    return { steps: replaced };
  },

  /**
   * Validation remediation replan: the pre-PR gate failed, so ask the
   * orchestrator for a SMALL implementer plan (1..maxSteps steps) that makes
   * the failing checks pass. The gate evidence in the prompt is declared
   * ground truth over any prior agent/reviewer report, and reviewer-only
   * remediation is explicitly rejected (non-implementer kinds are coerced).
   * Returns null when no viable implementer steps came back — callers treat
   * that as attempt exhaustion.
   */
  async replanValidationRemediation(
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
      plan: SwarmPlan | null;
      gate: SwarmValidationGateResult;
      attempt: number;
      maxAttempts: number;
      maxSteps: number;
      signal?: AbortSignal | null;
    },
  ): Promise<{ steps: SwarmPlanStep[] } | null> {
    const provider = resolveSwarmProvider(
      input.orchestrator.provider || input.defaultProvider,
    );
    if (!isSwarmProvider(provider) || !getSwarmSpawnFn(provider)) return null;

    const implementerSeats = input.roster.filter(
      (seat) => seat.kind === 'implementer' || seat.kind === 'custom',
    );
    const seatLabels = implementerSeats.map((seat) => seat.label);

    // Per-check evidence: status + reason + trimmed output tail (errors live
    // at the end of lint/build/boot logs).
    const evidence = input.gate.checks
      .map((check) => {
        const head = `- ${check.label} [${check.status}]${check.reason ? ` — ${check.reason}` : ''}`;
        if (check.status !== 'failed' || !check.output) return head;
        return `${head}\n\`\`\`\n${check.output.slice(-1200)}\n\`\`\``;
      })
      .join('\n');

    const prompt = [
      KIND_INSTRUCTIONS.orchestrator,
      '',
      'The pre-PR VALIDATION GATE FAILED after your agents reported completion.',
      'The gate evidence below is ground truth — it overrides every agent and reviewer report.',
      'A reviewer approving code that does not lint/build/boot was wrong; do not repeat that.',
      '',
      '## Goal',
      input.goal,
      '',
      '## Original plan',
      input.plan
        ? `${input.plan.summary}\nSteps:\n${input.plan.steps
            .map((step) => `- ${step.id} [${step.status ?? 'queued'}] ${step.title}`)
            .join('\n')}`
        : '(no plan available)',
      '',
      `## Validation gate evidence (attempt ${input.attempt} of ${input.maxAttempts})`,
      evidence,
      '',
      '## Your job',
      `Produce a SMALL remediation plan (1-${input.maxSteps} step(s)) that makes the failing checks pass inside the SAME worktree.`,
      'Rules:',
      '- Every step must be concrete implementer work that FIXES the reported failures (edit code/config, then re-run the failing command to confirm).',
      '- A reviewer-only step is NOT acceptable. At least one implementer step is required; reviewer/explorer steps will be coerced to implementer or dropped.',
      seatLabels.length
        ? `- assignTo must be one of the existing implementer seats: ${seatLabels.join(', ')}.`
        : '- assignTo may be omitted; the system binds each step to an implementer seat.',
      '- Quote the specific errors from the evidence in each step prompt so the implementer knows exactly what to fix.',
      '',
      'Return ONLY a JSON object (no markdown fences):',
      '{"steps": [{"id": "fix-1", "title": "short title", "kind": "implementer", "assignTo": "seat label", "prompt": "detailed fix instructions quoting the errors"}]}',
    ]
      .filter((line) => line !== '')
      .join('\n');

    const currentSwarm = swarmDb.get(swarmId)!;
    const model = input.orchestrator.model || input.defaultModel || null;
    const effort = resolveSeatEffort(
      providerCapabilitiesService.getProviderCapabilities(provider),
      input.orchestrator.effort ?? null,
    ).effort;
    const permissionMode = readOnlyPermissionMode(provider);
    const orchestratorMember = swarmDb
      .listMembers(swarmId)
      .find((member) => member.kind === 'orchestrator' || member.role === 'orchestrator');
    const replanRun = runService.create({
      source: 'swarm',
      projectId: currentSwarm.project_id,
      parentRunId: input.parentRunId,
      rootRunId: input.parentRunId,
      workspaceId: currentSwarm.workspace_id,
      provider,
      model,
      effort,
      permissionMode,
      title: `Swarm validation remediation replan (attempt ${input.attempt})`,
      trigger: `swarm-validation-replan:${swarmId}:${input.attempt}`,
      status: 'running',
      meta: { swarmId, role: 'orchestrator', phase: 'validation-replan', attempt: input.attempt },
    });
    const replanAttempt = swarmDb.createAttempt({
      swarmId,
      stepId: `validation-remediation-${input.attempt}`,
      memberId: orchestratorMember?.member_id ?? null,
      runId: replanRun.run_id,
      phase: 'validation-replan',
      status: 'running',
      workspaceId: currentSwarm.workspace_id,
    });

    let outcome;
    try {
      outcome = await runSwarmAgent({
        projectId: swarmDb.get(swarmId)!.project_id,
        projectPath: input.projectPath,
        provider,
        model,
        effort,
        permissionMode,
        prompt,
        images: providerImagesFromAttachments(currentSwarm.attachments),
        runId: replanRun.run_id,
        title: `Swarm validation remediation replan (attempt ${input.attempt})`,
        timeoutMs: 4 * 60 * 1000,
        signal: input.signal,
        permission: {
          swarmId,
          seatKind: 'orchestrator',
          seatLabel: input.orchestrator.label || 'Orchestrator',
          workspaceRoot: input.projectPath,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      swarmDb.updateAttempt(replanAttempt.attempt_id, {
        status: cancellationRequested(swarmId) ? 'aborted' : 'failed',
        error: message,
      });
      try {
        const run = runService.get(replanRun.run_id);
        if (run && !['succeeded', 'failed', 'aborted', 'timed_out'].includes(run.status)) {
          runService.markTerminal(replanRun.run_id, {
            status: cancellationRequested(swarmId) ? 'aborted' : 'failed',
            errorSummary: message,
          });
        }
      } catch { /* optional */ }
      return null;
    }
    if (!outcome.success) {
      swarmDb.updateAttempt(replanAttempt.attempt_id, {
        status: 'failed',
        error: outcome.errorMessage || 'validation remediation replan failed',
      });
      return null;
    }

    try {
      const parsed = parseJsonFromAgentText(outcome.text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        swarmDb.updateAttempt(replanAttempt.attempt_id, {
          status: 'failed',
          error: 'orchestrator returned invalid remediation JSON',
        });
        return null;
      }
      const rawSteps = (parsed as Record<string, unknown>).steps;
      if (!Array.isArray(rawSteps)) {
        swarmDb.updateAttempt(replanAttempt.attempt_id, {
          status: 'failed',
          error: 'orchestrator remediation response omitted steps',
        });
        return null;
      }
      const seatKeys = new Set(
        implementerSeats.flatMap((seat) =>
          [seat.label.toLowerCase(), seat.id ?? ''].filter(Boolean),
        ),
      );
      const steps: SwarmPlanStep[] = [];
      for (const [index, raw] of rawSteps.entries()) {
        if (steps.length >= input.maxSteps) break;
        if (!raw || typeof raw !== 'object') continue;
        const e = raw as Record<string, unknown>;
        const title =
          typeof e.title === 'string' && e.title.trim() ? e.title.trim().slice(0, 200) : '';
        const promptText =
          typeof e.prompt === 'string' && e.prompt.trim()
            ? e.prompt.trim().slice(0, MAX_PROMPT_CHARS)
            : title;
        if (!title || !promptText) continue;
        // Reviewer-only remediation is not acceptable: coerce to implementer.
        const kind = e.kind === 'custom' ? 'custom' : 'implementer';
        const requestedAssign = typeof e.assignTo === 'string' ? e.assignTo.trim() : '';
        const assignTo =
          requestedAssign &&
          (seatKeys.has(requestedAssign.toLowerCase()) || seatKeys.has(requestedAssign))
            ? requestedAssign
            : null;
        const profileId =
          typeof e.profileId === 'string' && e.profileId.trim() ? e.profileId.trim() : null;
        steps.push({
          id: `remediate-${input.attempt}-${index + 1}`,
          title,
          kind,
          assignTo,
          profileId,
          prompt: promptText,
          dependsOn: [],
          wave: 0,
        });
      }
      if (steps.length === 0) {
        swarmDb.updateAttempt(replanAttempt.attempt_id, {
          status: 'failed',
          error: 'orchestrator returned no valid remediation steps',
        });
        return null;
      }
      swarmDb.updateAttempt(replanAttempt.attempt_id, { status: 'succeeded' });
      return { steps };
    } catch (error) {
      swarmDb.updateAttempt(replanAttempt.attempt_id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
      signal?: AbortSignal | null;
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
        .filter((s) => ['succeeded', 'recovered'].includes(s.status ?? ''))
        .map((s) => s.title) ?? [],
      remaining: input.plan?.steps
        .filter((s) => !['succeeded', 'recovered'].includes(s.status ?? ''))
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

    const currentSwarm = swarmDb.get(swarmId);
    const orchestratorMember = swarmDb
      .listMembers(swarmId)
      .find((member) => member.kind === 'orchestrator' || member.role === 'orchestrator');
    const orchestratorEffort = resolveSeatEffort(
      providerCapabilitiesService.getProviderCapabilities(provider),
      input.orchestrator.effort ?? null,
    ).effort;
    const orchestratorPermissionMode = readOnlyPermissionMode(provider);

    const handoffRun = runService.create({
      source: 'swarm',
      projectId: currentSwarm?.project_id ?? null,
      parentRunId: input.parentRunId,
      rootRunId: input.parentRunId,
      workspaceId: currentSwarm?.workspace_id ?? null,
      provider,
      model,
      effort: orchestratorEffort,
      permissionMode: orchestratorPermissionMode,
      title: `Swarm handoff: ${input.goal.slice(0, 80)}`,
      trigger: `swarm-handoff:${swarmId}`,
      status: 'running',
      meta: { swarmId, role: 'orchestrator', phase: 'handoff' },
    });
    if (orchestratorMember) {
      swarmDb.updateMember(orchestratorMember.member_id, {
        runId: handoffRun.run_id,
        status: 'running',
      });
    }
    const attempt = swarmDb.createAttempt({
      swarmId,
      stepId: 'handoff',
      memberId: orchestratorMember?.member_id ?? null,
      runId: handoffRun.run_id,
      phase: 'handoff',
      status: 'running',
      workspaceId: swarmDb.get(swarmId)?.workspace_id,
    });

    try {
      const handoffAttachments = swarmDb.get(swarmId)?.attachments ?? [];
      const outcome = await runSwarmAgent({
        projectId: swarmDb.get(swarmId)?.project_id ?? '',
        projectPath: input.projectPath,
        provider,
        model,
        effort: orchestratorEffort,
        permissionMode: orchestratorPermissionMode,
        prompt: buildHandoffPrompt({
          goal: input.goal,
          plan: input.plan,
          blackboard: input.blackboard,
          findings: input.findings,
          attachments: handoffAttachments,
        }),
        images: providerImagesFromAttachments(handoffAttachments),
        runId: handoffRun.run_id,
        title: `Swarm handoff: ${input.goal.slice(0, 80)}`,
        signal: input.signal,
        permission: {
          swarmId,
          seatKind: 'orchestrator',
          seatLabel: input.orchestrator.label || 'Orchestrator',
          workspaceRoot: input.projectPath,
        },
      });
      assertNotCancelled(swarmId);

      if (!outcome.success || !outcome.text.trim()) {
        try {
          runService.markTerminal(handoffRun.run_id, {
            status: 'failed',
            errorSummary: outcome.errorMessage || 'empty handoff',
          });
        } catch {
          /* optional */
        }
        swarmDb.updateAttempt(attempt.attempt_id, {
          status: 'failed',
          error: outcome.errorMessage || 'empty handoff',
        });
        if (orchestratorMember) {
          swarmDb.updateMember(orchestratorMember.member_id, {
            status: 'failed',
            error: outcome.errorMessage || 'empty handoff',
            finished: true,
          });
        }
        return baseHandoff();
      }

      const parsed = parseSynthesis(
        outcome.text,
        input.findings.map((f) => parseMemberFindings(f.summary)),
      );

      // Extract completed/remaining/verificationTargets if present.
      let completed = baseHandoff().completed;
      let remaining = baseHandoff().remaining;
      let verificationTargets: string[] = [];
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
        const targets = o.verificationTargets ?? o.verification_targets;
        if (Array.isArray(targets)) {
          verificationTargets = targets
            .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
            .slice(0, 8);
        }
      } catch {
        /* optional */
      }
      swarmDb.updateAttempt(attempt.attempt_id, { status: 'succeeded' });

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
        verificationTargets,
      };

      if (orchestratorMember) {
        swarmDb.updateMember(orchestratorMember.member_id, {
          status: 'succeeded',
          findingsSummary: `Handoff: ${handoff.summary}`,
          error: null,
          finished: true,
        });
      }

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
      swarmDb.updateAttempt(attempt.attempt_id, {
        status: cancellationRequested(swarmId) ? 'aborted' : 'failed',
        error: msg,
      });
      try {
        runService.markTerminal(handoffRun.run_id, { status: 'failed', errorSummary: msg });
      } catch {
        /* optional */
      }
      if (orchestratorMember) {
        swarmDb.updateMember(orchestratorMember.member_id, {
          status: cancellationRequested(swarmId) ? 'aborted' : 'failed',
          error: msg,
          finished: true,
        });
      }
      if (cancellationRequested(swarmId)) throw error;
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
    if (swarm.status !== 'running') {
      throw new CloudError('SWARM_STILL_RUNNING', `Member completion is not allowed while swarm status is ${swarm.status}`);
    }
    if (activePipelines.has(swarmId) || hasLivePipelineLease(swarm)) {
      throw new CloudError(
        'SWARM_STILL_RUNNING',
        'Member completion is owned by the active swarm executor',
      );
    }
    const member = swarmDb.getMember(memberId);
    if (!member || member.swarm_id !== swarmId)
      throw new CloudError('RUN_NOT_FOUND', `Member not found: ${memberId}`);
    if (!['queued', 'running'].includes(member.status)) {
      throw new CloudError('RUN_ALREADY_TERMINAL', `Member is already terminal (status: ${member.status})`);
    }

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
    if (!['running', 'handing_off'].includes(swarm.status)) {
      throw new CloudError('RUN_ALREADY_TERMINAL', `Synthesis is not allowed while swarm status is ${swarm.status}`);
    }
    if (activePipelines.has(swarmId) || hasLivePipelineLease(swarm)) {
      throw new CloudError(
        'SWARM_STILL_RUNNING',
        'Synthesis is owned by the active swarm executor',
      );
    }
    const members = swarmDb.listMembers(swarmId);
    const workspace = swarm.workspace_id ? workspaceService.get(swarm.workspace_id) : null;
    if (!workspace || !['active', 'error'].includes(workspace.status)) {
      throw new CloudError('WORKSPACE_NOT_FOUND', 'Swarm workspace is unavailable for synthesis');
    }
    if (swarm.interrupt_id) {
      try { interruptsService.act(swarm.interrupt_id, { key: 'dismiss' }); } catch { /* already resolved */ }
    }
    const projectPath = workspaceService.resolveCwd(workspace.workspace_id);
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
    if (!swarm.plan) {
      throw new CloudError('SWARM_NOT_AWAITING_PLAN_APPROVAL', 'Swarm has no persisted plan to resume');
    }
    validatePlan(swarm.plan, swarm.roles);
    const resumed = swarmDb.transition(swarmId, ['awaiting_plan_approval'], {
      status: 'running',
      approvalStatus: 'approved',
      interruptId: null,
    });
    if (!resumed) throw new CloudError('SWARM_NOT_AWAITING_PLAN_APPROVAL', 'Plan approval raced another action');
    if (swarm.interrupt_id) {
      try {
        interruptsService.act(swarm.interrupt_id, { key: 'dismiss' });
      } catch {
        /* may already be resolved */
      }
    }
    void this.executePipeline(swarmId, {
      requireApproval: resumed.config?.requireApproval,
      requirePlanApproval: true,
      stepTimeoutMs: resumed.config?.stepTimeoutMs,
      maxConcurrency: resumed.config?.maxConcurrency,
      defaultProvider: resumed.config?.orchestrator.provider,
      defaultModel: resumed.config?.orchestrator.model,
    }).catch((error) => {
      const current = swarmDb.get(swarmId);
      if (current && !TERMINAL_SWARM_STATUSES.has(current.status)) {
        swarmDb.transition(swarmId, [current.status], {
          status: 'failed',
          finished: true,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return resumed;
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
    const rejected = swarmDb.transition(swarmId, ['awaiting_plan_approval'], {
      status: 'failed',
      approvalStatus: 'rejected',
      finished: true,
    });
    if (!rejected) throw new CloudError('SWARM_NOT_AWAITING_PLAN_APPROVAL', 'Plan rejection raced another action');
    reconcileTerminalMembers(swarmId, 'failed', 'swarm plan rejected');
    if (swarm.interrupt_id) {
      try {
        interruptsService.act(swarm.interrupt_id, { key: 'dismiss' });
      } catch {
        /* may already be resolved */
      }
    }
    if (swarm.parent_run_id) {
      try {
        runService.markTerminal(swarm.parent_run_id, { status: 'failed', errorSummary: 'Swarm plan rejected' });
      } catch { /* optional */ }
    }
    return rejected;
  },

  /** Abort a live swarm; running agent sessions are force-killed best-effort. */
  async abort(swarmId: string): Promise<SwarmRun> {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    const abortable = ['queued', 'planning', 'awaiting_plan_approval', 'running', 'handing_off', 'awaiting_approval'];
    if (!abortable.includes(swarm.status)) {
      return swarm;
    }

    abortedPipelines.add(swarmId);
    const requestedAt = new Date().toISOString();
    const requested = swarmDb.transition(swarmId, [swarm.status], {
      cancelRequestedAt: requestedAt,
      lastError: 'swarm aborted',
    });
    if (!requested) return swarmDb.get(swarmId)!;
    const liveController = pipelineAbortControllers.get(swarmId);
    liveController?.abort();

    // Best-effort kill running member sessions.
    const members = swarmDb.listMembers(swarmId);
    const abortedRunIds = new Set<string>();
    for (const member of members) {
      if (member.run_id && ['running', 'queued'].includes(member.status)) {
        abortedRunIds.add(member.run_id);
        const child = runService.get(member.run_id);
        if (!liveController && child?.app_session_id && isSwarmProvider(member.provider)) {
          await abortSwarmAgentSession(child.app_session_id, member.provider);
        }
        try {
          runService.markTerminal(member.run_id, { status: 'aborted', errorSummary: 'swarm aborted' });
        } catch {
          /* optional */
        }
        swarmDb.updateMember(member.member_id, {
          status: 'aborted',
          error: 'swarm aborted',
          finished: true,
        });
      }
    }

    for (const attempt of swarmDb.listAttempts(swarmId)) {
      if (attempt.status === 'running' || attempt.status === 'queued') {
        if (attempt.run_id && !abortedRunIds.has(attempt.run_id)) {
          const run = runService.get(attempt.run_id);
          if (!liveController && run?.app_session_id && isSwarmProvider(run.provider)) {
            await abortSwarmAgentSession(run.app_session_id, run.provider);
          }
          try {
            if (attempt.run_id) runService.markTerminal(attempt.run_id, {
              status: 'aborted',
              errorSummary: 'swarm aborted',
            });
          } catch { /* optional */ }
        }
        swarmDb.updateAttempt(attempt.attempt_id, { status: 'aborted', error: 'swarm aborted' });
      }
    }
    const aborted = swarmDb.transition(swarmId, [requested.status], {
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
    return aborted ?? swarmDb.get(swarmId)!;
  },

  /**
   * Requeue a failed step through the canonical pipeline. This deliberately
   * reuses normal retries, handoff, validation, publication, and terminal
   * semantics instead of maintaining a second abbreviated execution path.
   */
  async retryStep(swarmId: string, stepId: string): Promise<SwarmRun> {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (!['failed', 'awaiting_approval'].includes(swarm.status)) {
      throw new CloudError('SWARM_STILL_RUNNING', `Retry is only allowed for failed or awaiting-approval swarms (status: ${swarm.status})`);
    }
    if (activePipelines.has(swarmId)) {
      throw new CloudError('SWARM_STILL_RUNNING', 'Swarm already has an active executor');
    }
    if (!swarm.plan?.steps.some((step) => step.id === stepId)) {
      throw new CloudError('SWARM_STEP_NOT_FOUND', `Step not found: ${stepId}`);
    }
    const workspace = swarm.workspace_id ? workspaceService.get(swarm.workspace_id) : null;
    if (!workspace || !['active', 'error'].includes(workspace.status)) {
      throw new CloudError('WORKSPACE_NOT_FOUND', 'The original swarm workspace is unavailable; retry will not use the primary checkout');
    }
    const plan = {
      ...swarm.plan,
      steps: swarm.plan.steps.map((step) =>
        step.id === stepId ? { ...step, status: 'queued' } : step,
      ),
    };
    const resumed = swarmDb.transition(
      swarmId,
      [swarm.status],
      {
        status: 'running',
        finished: false,
        cancelRequestedAt: null,
        lastError: null,
        approvalStatus: null,
        interruptId: null,
        plan,
      },
      { allowTerminalTransition: swarm.status === 'failed' },
    );
    if (!resumed) throw new CloudError('SWARM_STILL_RUNNING', 'Retry raced another swarm action');
    if (swarm.interrupt_id) {
      try { interruptsService.act(swarm.interrupt_id, { key: 'dismiss' }); } catch { /* already resolved */ }
    }
    if (resumed.parent_run_id) {
      try {
        runService.updateStatus(
          resumed.parent_run_id,
          'running',
          {},
          { allowTerminalTransition: swarm.status === 'failed' },
        );
      } catch { /* optional */ }
    }
    void this.executePipeline(swarmId, {
      requireApproval: resumed.config?.requireApproval,
      requirePlanApproval: false,
      stepTimeoutMs: resumed.config?.stepTimeoutMs,
      maxConcurrency: resumed.config?.maxConcurrency,
      defaultProvider: resumed.config?.orchestrator.provider,
      defaultModel: resumed.config?.orchestrator.model,
      retryStepId: stepId,
    }).catch((error) => {
      const current = swarmDb.get(swarmId);
      if (current && !TERMINAL_SWARM_STATUSES.has(current.status)) {
        swarmDb.transition(swarmId, [current.status], {
          status: 'failed',
          finished: true,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return resumed;
  },

  /**
   * Continue a failed swarm from its durable checkpoint in the SAME workspace.
   * Completed/recovered steps remain immutable; unresolved and interrupted
   * steps are requeued. If execution had completed and validation/handoff was
   * the failure point, the pipeline skips workers and resumes that later phase.
   */
  async resumeFromFailure(swarmId: string): Promise<SwarmRun> {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (swarm.status !== 'failed') {
      throw new CloudError(
        'SWARM_STILL_RUNNING',
        `Resume from failure is only allowed for failed swarms (status: ${swarm.status})`,
      );
    }
    if (swarm.archived_at) {
      throw new CloudError('RUN_ALREADY_TERMINAL', 'Restore the swarm from the archive before resuming it');
    }
    if (activePipelines.has(swarmId)) {
      throw new CloudError('SWARM_STILL_RUNNING', 'Swarm already has an active executor');
    }
    if (!swarm.plan) {
      throw new CloudError('SWARM_STEP_NOT_FOUND', 'The failed swarm has no persisted plan checkpoint to resume');
    }
    validatePlan(swarm.plan, swarm.roles);
    const workspace = swarm.workspace_id ? workspaceService.get(swarm.workspace_id) : null;
    if (!workspace || !['active', 'error'].includes(workspace.status)) {
      throw new CloudError(
        'WORKSPACE_NOT_FOUND',
        'The original swarm workspace is unavailable; resume will not fall back to the primary checkout',
      );
    }

    const recoveredFailureIds = new Set(
      swarm.plan.steps
        .filter((step) => step.status === 'recovered' && step.replacesStepId)
        .map((step) => step.replacesStepId as string),
    );
    const resumableIds = swarm.plan.steps
      .filter((step) =>
        !['succeeded', 'recovered'].includes(step.status ?? '')
        && !recoveredFailureIds.has(step.id),
      )
      .map((step) => step.id);
    const resumableSet = new Set(resumableIds);
    const plan: SwarmPlan = {
      ...swarm.plan,
      steps: swarm.plan.steps.map((step) =>
        resumableSet.has(step.id) ? { ...step, status: 'queued' } : step,
      ),
    };

    const resumed = swarmDb.transition(
      swarmId,
      ['failed'],
      {
        status: 'running',
        finished: false,
        cancelRequestedAt: null,
        lastError: null,
        approvalStatus: null,
        interruptId: null,
        plan,
      },
      { allowTerminalTransition: true },
    );
    if (!resumed) throw new CloudError('SWARM_STILL_RUNNING', 'Resume raced another swarm action');

    swarmDb.appendMessage(swarmId, {
      id: newMsgId(),
      from: 'Swarm policy',
      kind: 'system',
      content: resumableIds.length > 0
        ? `[resume] continuing from the last failure checkpoint in the existing workspace; requeued ${resumableIds.length} unresolved step(s): ${resumableIds.join(', ')}`
        : '[resume] worker steps were already complete; continuing from handoff/validation in the existing workspace',
      at: new Date().toISOString(),
    });
    if (swarm.interrupt_id) {
      try { interruptsService.act(swarm.interrupt_id, { key: 'dismiss' }); } catch { /* already resolved */ }
    }
    if (resumed.parent_run_id) {
      try {
        runService.updateStatus(
          resumed.parent_run_id,
          'running',
          {},
          { allowTerminalTransition: true },
        );
      } catch { /* optional */ }
    }

    void this.executePipeline(swarmId, {
      requireApproval: resumed.config?.requireApproval,
      requirePlanApproval: false,
      stepTimeoutMs: resumed.config?.stepTimeoutMs,
      maxConcurrency: resumed.config?.maxConcurrency,
      defaultProvider: resumed.config?.orchestrator.provider,
      defaultModel: resumed.config?.orchestrator.model,
      resumeFromFailure: true,
    }).catch((error) => {
      const current = swarmDb.get(swarmId);
      if (current && !TERMINAL_SWARM_STATUSES.has(current.status)) {
        swarmDb.transition(swarmId, [current.status], {
          status: 'failed',
          finished: true,
          lastError: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return resumed;
  },

  /**
   * Legacy synchronous retry implementation retained temporarily for old
   * callers compiled against the previous service shape. New routes use the
   * canonical retryStep above.
   */
  async retryStepLegacy(swarmId: string, stepId: string): Promise<SwarmRun> {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (!['failed', 'awaiting_approval'].includes(swarm.status)) {
      throw new CloudError('SWARM_STILL_RUNNING', `Retry is only allowed for failed or awaiting-approval swarms (status: ${swarm.status})`);
    }
    if (activePipelines.has(swarmId)) {
      throw new CloudError('SWARM_STILL_RUNNING', 'Swarm already has an active executor');
    }
    const step = swarm.plan?.steps.find((s) => s.id === stepId);
    if (!step) throw new CloudError('SWARM_STEP_NOT_FOUND', `Step not found: ${stepId}`);
    const workspace = swarm.workspace_id ? workspaceService.get(swarm.workspace_id) : null;
    if (!workspace || !['active', 'error'].includes(workspace.status)) {
      throw new CloudError('WORKSPACE_NOT_FOUND', 'The original swarm workspace is unavailable; retry will not use the primary checkout');
    }
    const findings = [...(swarm.findings ?? [])];
    const running = swarmDb.transitionWithLease(
      swarmId,
      [swarm.status],
      {
        status: 'running',
        finished: false,
        cancelRequestedAt: null,
        lastError: null,
        approvalStatus: null,
        interruptId: null,
      },
      PIPELINE_OWNER,
      PIPELINE_LEASE_TTL_MS,
      { allowTerminalTransition: swarm.status === 'failed' },
    );
    if (!running) throw new CloudError('SWARM_STILL_RUNNING', 'Retry raced another swarm action');
    if (swarm.interrupt_id) {
      try { interruptsService.act(swarm.interrupt_id, { key: 'dismiss' }); } catch { /* already resolved */ }
    }
    activePipelines.add(swarmId);
    const controller = new AbortController();
    pipelineAbortControllers.set(swarmId, controller);
    const leaseHeartbeat = setInterval(() => {
      if (!swarmDb.renewLease(swarmId, PIPELINE_OWNER, PIPELINE_LEASE_TTL_MS)) controller.abort();
    }, PIPELINE_LEASE_TTL_MS / 3);
    leaseHeartbeat.unref?.();
    const releaseRetryOwnership = () => {
      clearInterval(leaseHeartbeat);
      try { swarmDb.releaseLease(swarmId, PIPELINE_OWNER); } catch { /* shutdown */ }
      activePipelines.delete(swarmId);
      if (pipelineAbortControllers.get(swarmId) === controller) pipelineAbortControllers.delete(swarmId);
    };
    if (swarm.parent_run_id) {
      try {
        runService.updateStatus(
          swarm.parent_run_id,
          'running',
          {},
          { allowTerminalTransition: swarm.status === 'failed' },
        );
      } catch { /* optional */ }
    }
    let resultFailed = true;
    try {
      const projectPath = workspaceService.resolveCwd(workspace.workspace_id);
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
        signal: controller.signal,
      });
      assertNotCancelled(swarmId);
      resultFailed = result.failed;
      findings.push(result.finding);
      const livePlan = swarm.plan ? { ...swarm.plan, steps: swarm.plan.steps.map((s) => ({ ...s })) } : null;
      if (livePlan) {
        const idx = livePlan.steps.findIndex((s) => s.id === stepId);
        if (idx >= 0) {
          livePlan.steps[idx] = {
            ...livePlan.steps[idx],
            status: result.needsChanges ? 'needs_changes' : result.failed ? 'failed' : 'succeeded',
          };
        }
      }
      swarmDb.update(swarmId, { findings: [...findings], plan: livePlan });
    } catch (error) {
      if (cancellationRequested(swarmId)) {
        releaseRetryOwnership();
        return swarmDb.get(swarmId)!;
      }
      const msg = error instanceof Error ? error.message : String(error);
      findings.push({ memberId: 'retry', role: 'implementer', summary: msg, at: new Date().toISOString(), stepId });
      swarmDb.update(swarmId, { findings: [...findings], lastError: msg });
      resultFailed = true;
    }

    if (resultFailed) {
      const failed = swarmDb.transition(swarmId, ['running'], { status: 'failed', finished: true });
      if (failed && swarm.parent_run_id) {
        try { runService.markTerminal(swarm.parent_run_id, { status: 'failed', errorSummary: 'Retried swarm step failed' }); } catch { /* optional */ }
      }
      releaseRetryOwnership();
      return swarmDb.get(swarmId)!;
    }

    const refreshed = swarmDb.get(swarmId)!;
    const orchestrator = refreshed.config?.orchestrator || refreshed.roles.find((a) => a.kind === 'orchestrator') || refreshed.roles[0];
    let handoff: SwarmHandoff;
    try {
      handoff = await this.runOrchestratorHandoff(swarmId, {
        goal: refreshed.goal,
        projectPath: workspaceService.resolveCwd(workspace.workspace_id),
        parentRunId: refreshed.parent_run_id,
        orchestrator,
        plan: refreshed.plan,
        blackboard: refreshed.blackboard,
        findings: refreshed.findings,
        defaultProvider: resolveSwarmProvider(orchestrator.provider),
        defaultModel: orchestrator.model,
        signal: controller.signal,
      });
      assertNotCancelled(swarmId);
      handoff = await this.finalizeSwarmPullRequest(swarmId, handoff);
      assertNotCancelled(swarmId);
    } catch (error) {
      releaseRetryOwnership();
      if (cancellationRequested(swarmId)) return swarmDb.get(swarmId)!;
      const message = error instanceof Error ? error.message : String(error);
      swarmDb.transition(swarmId, ['running'], { status: 'failed', finished: true, lastError: message });
      throw error;
    }
    try {
      if (refreshed.config?.requireApproval) {
        const interrupt = interruptsService.create({
          projectId: refreshed.project_id,
          kind: 'approval_pending',
          severity: handoff.risks?.length ? 'warning' : 'info',
          title: `Agent Swarm retry ready: ${refreshed.goal.slice(0, 80)}`,
          body: [handoff.summary.slice(0, 400), handoff.prUrl ? `PR: ${handoff.prUrl}` : handoff.prError || ''].filter(Boolean).join('\n'),
          runId: refreshed.parent_run_id,
          actions: [
            { id: 'approve_swarm', label: 'Acknowledge handoff', style: 'primary' },
            { id: 'reject_swarm', label: 'Reject', style: 'destructive' },
          ],
          meta: { swarmId, retryStepId: stepId, prUrl: handoff.prUrl ?? null },
          dedupeKey: `swarm-approval:${swarmId}:retry:${swarmDb.listAttempts(swarmId, stepId).length}`,
        });
        const awaitingApproval = swarmDb.transition(swarmId, ['running'], {
          status: 'awaiting_approval',
          approvalStatus: 'pending',
          interruptId: interrupt.interrupt_id,
          synthesis: handoff,
          prUrl: handoff.prUrl ?? null,
        });
        if (!awaitingApproval) {
          try { interruptsService.act(interrupt.interrupt_id, { key: 'dismiss' }); } catch { /* raced */ }
          assertNotCancelled(swarmId);
          throw new Error('Retried swarm approval transition was rejected');
        }
        if (refreshed.parent_run_id) {
          try { runService.updateStatus(refreshed.parent_run_id, 'waiting_permission'); } catch { /* optional */ }
        }
      } else {
        const completed = swarmDb.transition(swarmId, ['running'], {
          status: 'succeeded',
          synthesis: handoff,
          prUrl: handoff.prUrl ?? null,
          finished: true,
        });
        if (!completed) {
          assertNotCancelled(swarmId);
          throw new Error('Retried swarm completion transition was rejected');
        }
        const notifiedHandoff = this.notifyHandoffComplete(swarmId, handoff);
        swarmDb.update(swarmId, { synthesis: notifiedHandoff });
        if (refreshed.parent_run_id) {
          try { runService.markTerminal(refreshed.parent_run_id, { status: 'succeeded' }); } catch { /* optional */ }
        }
      }
    } catch (error) {
      releaseRetryOwnership();
      throw error;
    }
    releaseRetryOwnership();
    return swarmDb.get(swarmId)!;
  },

  approve(swarmId: string): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (swarm.status !== 'awaiting_approval' || swarm.approval_status !== 'pending') {
      throw new CloudError('RUN_ALREADY_TERMINAL', `Swarm is not awaiting handoff approval (status: ${swarm.status})`);
    }
    if (swarm.synthesis?.validation?.passed === false || swarm.synthesis?.prError) {
      throw new CloudError(
        'RUN_ALREADY_TERMINAL',
        'A failed validation or publication error cannot be approved into a successful swarm',
      );
    }
    const handoff = this.notifyHandoffComplete(swarmId, swarm.synthesis);
    const approved = swarmDb.transition(swarmId, ['awaiting_approval'], {
      status: 'succeeded',
      approvalStatus: 'approved',
      synthesis: handoff,
      finished: true,
    });
    if (!approved) throw new CloudError('RUN_ALREADY_TERMINAL', 'Approval raced another action');
    reconcileTerminalMembers(swarmId, 'succeeded', 'swarm handoff approved');
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
    return approved;
  },

  reject(swarmId: string): SwarmRun {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) throw new CloudError('RUN_NOT_FOUND', `Swarm not found: ${swarmId}`);
    if (swarm.status !== 'awaiting_approval' || swarm.approval_status !== 'pending') {
      throw new CloudError('RUN_ALREADY_TERMINAL', `Swarm is not awaiting handoff approval (status: ${swarm.status})`);
    }
    const rejected = swarmDb.transition(swarmId, ['awaiting_approval'], {
      status: 'failed',
      approvalStatus: 'rejected',
      finished: true,
    });
    if (!rejected) throw new CloudError('RUN_ALREADY_TERMINAL', 'Rejection raced another action');
    reconcileTerminalMembers(swarmId, 'failed', 'agent swarm rejected');
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
    return rejected;
  },

  /** Compute the cost/usage rollup from member child runs (computed on read). */
  withUsage(swarm: SwarmRun): SwarmRun {
    const members = swarmDb.listMembers(swarm.swarm_id);
    let totalTokens = 0;
    let totalCostUsd = 0;
    let billedDurationMs = 0;
    let hasBilledDuration = false;
    const memberRuns: NonNullable<SwarmRun['usage']>['memberRuns'] = [];
    for (const m of members) {
      let tokens = 0;
      let costUsd = 0;
      let durationMs: number | null = null;
      let runId: string | null = m.run_id;
      if (m.run_id) {
        const child = runService.get(m.run_id);
        if (child) {
          const inputTokens = child.token_input ?? 0;
          const outputTokens = child.token_output ?? 0;
          tokens = (child.token_total ?? 0) || inputTokens + outputTokens;
          costUsd = child.cost_usd_estimate ?? 0;
          if (!(costUsd > 0) && tokens > 0) {
            const priced = estimateCostUsd(
              child.provider ?? m.provider,
              child.model ?? m.model,
              inputTokens || tokens,
              outputTokens,
              child.started_at ?? child.created_at,
              child.token_cache_read,
              child.token_cache_write,
            );
            if (priced != null && priced > 0) costUsd = priced;
          }
          const started = child.started_at ?? child.created_at;
          const finished = child.finished_at ?? (child.status === 'running' ? new Date().toISOString() : null);
          if (started && finished) {
            durationMs = Math.max(0, new Date(finished).getTime() - new Date(started).getTime());
          }
        } else {
          runId = null;
        }
      }
      if (durationMs == null && m.created_at && m.finished_at) {
        durationMs = Math.max(
          0,
          new Date(m.finished_at).getTime() - new Date(m.created_at).getTime(),
        );
      }
      totalTokens += tokens;
      totalCostUsd += costUsd;
      if (durationMs != null) {
        billedDurationMs += durationMs;
        hasBilledDuration = true;
      }
      memberRuns.push({
        memberId: m.member_id,
        runId,
        stepId: m.step_id ?? null,
        label: m.label,
        tokens,
        costUsd,
        durationMs,
      });
    }
    const startMs = swarm.created_at ? new Date(swarm.created_at).getTime() : NaN;
    const endMs = swarm.finished_at
      ? new Date(swarm.finished_at).getTime()
      : Date.now();
    const totalDurationMs = Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : null;
    return {
      ...swarm,
      usage: {
        totalTokens,
        totalCostUsd,
        totalDurationMs,
        billedDurationMs: hasBilledDuration ? billedDurationMs : null,
        memberRuns,
      },
    };
  },

  get(swarmId: string): SwarmRun | null {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) return null;
    return this.withUsage(swarm);
  },

  /**
   * Locate a swarm's validation-report artifacts (written by the pre-PR gate
   * under the PRIMARY project's tmp/cloudcli/swarm-reports/<swarmId>/).
   */
  validationReport(swarmId: string): {
    dir: string;
    pdfPath: string | null;
    htmlPath: string | null;
    summaryPath: string | null;
  } | null {
    const swarm = swarmDb.get(swarmId);
    if (!swarm) return null;
    let projectPath: string;
    try {
      projectPath = resolveProjectPath(swarm.project_id);
    } catch {
      return null;
    }
    const dir = swarmReportDir(projectPath, swarmId);
    const resolveIfExists = (name: string): string | null => {
      const candidate = pathJoin(dir, name);
      return existsSync(candidate) ? candidate : null;
    };
    return {
      dir,
      pdfPath: resolveIfExists('report.pdf'),
      htmlPath: resolveIfExists('report.html'),
      summaryPath: resolveIfExists('summary.json'),
    };
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
    const live = ['queued', 'planning', 'awaiting_plan_approval', 'running', 'handing_off', 'awaiting_approval'].includes(swarm.status);
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
    const live = ['queued', 'planning', 'awaiting_plan_approval', 'running', 'handing_off', 'awaiting_approval'].includes(swarm.status);
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

function persistRecoveryFailure(swarmId: string, error: unknown): void {
  const current = swarmDb.get(swarmId);
  if (!current || TERMINAL_SWARM_STATUSES.has(current.status)) return;
  const message = error instanceof Error ? error.message : String(error);
  const failed = swarmDb.transition(swarmId, [current.status], {
    status: 'failed',
    lastError: `restart recovery failed: ${message}`,
    finished: true,
  });
  if (failed) {
    reconcileTerminalMembers(swarmId, 'failed', `restart recovery failed: ${message}`);
  }
  if (failed?.parent_run_id) {
    try {
      runService.markTerminal(failed.parent_run_id, {
        status: 'failed',
        errorSummary: `Swarm restart recovery failed: ${message}`,
      });
    } catch { /* already terminal */ }
  }
}

/** Close roster rows that cannot make further progress once the swarm is terminal. */
function reconcileTerminalMembers(
  swarmId: string,
  terminalStatus: 'succeeded' | 'failed' | 'aborted',
  reason: string,
): void {
  for (const member of swarmDb.listMembers(swarmId)) {
    if (member.status === 'queued') {
      const completedOrchestratorWork =
        (member.kind === 'orchestrator' || member.role === 'orchestrator') &&
        Boolean(member.findings_summary);
      swarmDb.updateMember(member.member_id, {
        status: completedOrchestratorWork ? 'succeeded' : 'skipped',
        findingsSummary: completedOrchestratorWork
          ? member.findings_summary
          : member.findings_summary || `Not dispatched before swarm ${terminalStatus}.`,
        finished: true,
      });
      continue;
    }
    if (member.status === 'running') {
      swarmDb.updateMember(member.member_id, {
        status: terminalStatus === 'aborted' ? 'aborted' : 'failed',
        error: reason,
        finished: true,
      });
    }
  }
}

/** Resume durable in-flight swarms after a server restart. Approval-paused rows stay paused. */
export async function recoverActiveSwarms(): Promise<void> {
  const recoverable = swarmDb
    .listAll(500, { includeArchived: false })
    .filter((swarm) => ['queued', 'planning', 'running', 'handing_off'].includes(swarm.status));
  // Bounded sequential admission avoids a restart stampede. Each pipeline may
  // fan out internally according to its own safe concurrency limit.
  for (const swarm of recoverable) {
    try {
      if (swarm.cancel_requested_at) {
        await swarmService.abort(swarm.swarm_id);
        continue;
      }
      const leaseExpiry = swarm.lease_expires_at ? new Date(swarm.lease_expires_at).getTime() : 0;
      if (swarm.lease_owner && swarm.lease_owner !== PIPELINE_OWNER && leaseExpiry > Date.now()) {
        const retryDelay = Math.min(PIPELINE_LEASE_TTL_MS + 250, Math.max(50, leaseExpiry - Date.now() + 50));
        const timer = setTimeout(() => {
          void swarmService.executePipeline(swarm.swarm_id, {
            requireApproval: swarm.config?.requireApproval,
            requirePlanApproval: swarm.config?.requirePlanApproval,
            stepTimeoutMs: swarm.config?.stepTimeoutMs,
            maxConcurrency: swarm.config?.maxConcurrency,
            defaultProvider: swarm.config?.orchestrator.provider,
            defaultModel: swarm.config?.orchestrator.model,
          }).catch((error) => {
            console.error('[Swarm] deferred recovery failed', swarm.swarm_id, error);
            persistRecoveryFailure(swarm.swarm_id, error);
          });
        }, retryDelay);
        timer.unref?.();
        continue;
      }
      await swarmService.executePipeline(swarm.swarm_id, {
        requireApproval: swarm.config?.requireApproval,
        requirePlanApproval: swarm.config?.requirePlanApproval,
        stepTimeoutMs: swarm.config?.stepTimeoutMs,
        maxConcurrency: swarm.config?.maxConcurrency,
        defaultProvider: swarm.config?.orchestrator.provider,
        defaultModel: swarm.config?.orchestrator.model,
      });
    } catch (error) {
      console.error('[Swarm] recovery failed', swarm.swarm_id, error);
      persistRecoveryFailure(swarm.swarm_id, error);
    }
  }
}
