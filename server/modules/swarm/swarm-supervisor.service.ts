/**
 * Hybrid supervisor for Agent Swarm.
 *
 * The initial orchestrator plan still runs as a DAG. The first friction
 * (reviewer needs_changes, empty implementer diff, crash after the attempt
 * budget, validation red) switches the swarm into supervisor mode. From then
 * on the orchestrator stays on shift: policy picks the *legal* next role,
 * the LLM writes the brief and chooses the seat, and a hard SHA/fingerprint
 * invariant refuses another review of an unchanged tree.
 */
import { parseJsonFromAgentText } from '@/modules/mission-control/index.js';
import {
  looksLikeReviewApproval,
  stepRequiresSourceChanges,
  type ParsedMemberFindings,
} from '@/modules/swarm/swarm-agent.service.js';
import type {
  SwarmAgentKind,
  SwarmAgentSpec,
  SwarmConfig,
  SwarmCritiquePacket,
  SwarmCritiqueSeverity,
  SwarmGoalCard,
  SwarmGoalCardReview,
  SwarmPlanStep,
  SwarmSupervisorAction,
  SwarmSupervisorDecision,
  SwarmWorktreeFingerprint,
} from '@/modules/swarm/swarm.types.js';
import { runGit } from '@/modules/workspaces/index.js';

const DEFAULT_SUPERVISOR_TICKS = 8;
const SUPERVISOR_TICKS_HARD_CAP = 12;
const AUTONOMOUS_SUPERVISOR_TICKS_DEFAULT = 20;
const AUTONOMOUS_SUPERVISOR_TICKS_HARD_CAP = 30;

const FILE_PATH_RE =
  /(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.@-]+\.[A-Za-z]{1,8}/g;

export type SupervisorEventKind =
  | 'reviewer_needs_changes'
  | 'reviewer_approved'
  | 'reviewer_failed'
  | 'implementer_changed'
  | 'implementer_incomplete'
  | 'implementer_no_diff'
  | 'implementer_failed'
  | 'explorer_succeeded'
  | 'explorer_failed'
  | 'validation_red'
  | 'other_failed'
  | 'other_succeeded';

export type SupervisorEvent = {
  kind: SupervisorEventKind;
  stepKind: string;
  stepId: string;
  seatLabel: string;
  output: string | null;
  error: string | null;
  packets: SwarmCritiquePacket[];
  fingerprint: SwarmWorktreeFingerprint;
  failed: boolean;
  needsChanges: boolean;
};

export type SupervisorPolicy = {
  action: SwarmSupervisorAction;
  kind: SwarmAgentKind | null;
  requiresChanges: boolean;
  escalate: boolean;
  refuseReviewer: boolean;
  policy: string;
  reason: string;
};

export type SupervisorDecisionDraft = {
  action: SwarmSupervisorAction;
  kind: SwarmAgentKind | null;
  assignTo: string | null;
  profileId: string | null;
  title: string;
  prompt: string;
  difficulty: 'basic' | 'medium' | 'advanced' | null;
  scope: string[];
  acceptanceCriteria: string[];
  requiresChanges: boolean;
  reason: string;
};

const WORKER_KINDS = new Set<SwarmAgentKind>([
  'explorer',
  'implementer',
  'reviewer',
  'tester',
  'security',
  'docs',
  'custom',
]);

export function resolveSupervisorTickBudget(config: SwarmConfig | null): number {
  const autonomous = config?.autonomous === true;
  const hardCap = autonomous ? AUTONOMOUS_SUPERVISOR_TICKS_HARD_CAP : SUPERVISOR_TICKS_HARD_CAP;
  const fromConfig = config?.maxSupervisorTicks;
  const fromEnv = Number(process.env.CLOUDCLI_SWARM_MAX_SUPERVISOR_TICKS);
  const fallback = autonomous ? AUTONOMOUS_SUPERVISOR_TICKS_DEFAULT : DEFAULT_SUPERVISOR_TICKS;
  const raw =
    typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0
      ? fromConfig
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : fallback;
  return Math.min(hardCap, Math.max(1, Math.trunc(raw)));
}

export function emptyGoalCard(tickBudget: number): SwarmGoalCard {
  return {
    status: 'unknown',
    mode: 'plan',
    fingerprint: null,
    lastWriter: null,
    lastWriterKind: null,
    lastReview: null,
    lastEventKind: null,
    lastEventStepId: null,
    lastEventSeat: null,
    lastEventError: null,
    repeatBlockerCount: 0,
    ticksUsed: 0,
    tickBudget,
    decisions: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function captureWorktreeFingerprint(cwd: string): Promise<SwarmWorktreeFingerprint> {
  try {
    const [headResult, statusResult] = await Promise.all([
      runGit(cwd, ['rev-parse', 'HEAD']),
      runGit(cwd, ['status', '--porcelain']),
    ]);
    const head = (headResult.stdout || '').trim();
    const dirtyPaths = [...new Set(
      (statusResult.stdout || '')
        .split('\n')
        .map((line) => line.slice(3).trim().replace(/^"+|"+$/g, ''))
        .filter(Boolean),
    )].sort();
    const contentHashes = await Promise.all(
      dirtyPaths.slice(0, 40).map(async (relative) => {
        const hashed = await runGit(cwd, ['hash-object', '--', relative]);
        return `${relative}:${(hashed.stdout || '').trim().slice(0, 12)}`;
      }),
    );
    const safeHead = /^[0-9a-f]{7,40}$/i.test(head) ? head : null;
    return {
      head: safeHead,
      dirty: dirtyPaths.length > 0,
      signature: `${safeHead ?? 'nohead'}|${contentHashes.join(',')}`,
    };
  } catch {
    return { head: null, dirty: false, signature: 'unknown' };
  }
}

export function fingerprintsMatch(
  a: SwarmWorktreeFingerprint | string | null | undefined,
  b: SwarmWorktreeFingerprint | string | null | undefined,
): boolean {
  const left = typeof a === 'string' ? a : a?.signature;
  const right = typeof b === 'string' ? b : b?.signature;
  return Boolean(left && right && left === right);
}

function firstFilePath(text: string): string | null {
  const match = text.match(FILE_PATH_RE);
  return match?.[0] ?? null;
}

function normalizeAsk(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s./_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function blockerHash(blockers: SwarmCritiquePacket[]): string {
  return blockers
    .map((packet) => `${(packet.file ?? '').toLowerCase()}|${normalizeAsk(packet.ask)}`)
    .filter((entry) => entry !== '|')
    .sort()
    .join('||');
}

export function isVagueReview(packets: SwarmCritiquePacket[]): boolean {
  if (packets.length === 0) return true;
  return packets.every((packet) => !packet.file && !firstFilePath(`${packet.ask} ${packet.evidence}`));
}

function severityOf(value: unknown): SwarmCritiqueSeverity {
  if (value === 'critical' || value === 'warning' || value === 'info') return value;
  return 'warning';
}

export function extractCritiquePackets(
  parsed: ParsedMemberFindings,
  contractError?: string | null,
): SwarmCritiquePacket[] {
  const packets: SwarmCritiquePacket[] = [];
  const seen = new Set<string>();
  const push = (packet: SwarmCritiquePacket) => {
    const ask = packet.ask.trim();
    if (!ask) return;
    const key = `${(packet.file ?? '').toLowerCase()}|${normalizeAsk(ask)}`;
    if (seen.has(key)) return;
    seen.add(key);
    packets.push({
      file: packet.file,
      severity: packet.severity,
      ask: ask.slice(0, 400),
      evidence: packet.evidence.trim().slice(0, 400),
    });
  };

  for (const entry of parsed.acceptance) {
    if (entry.met) continue;
    const blob = `${entry.criterion} ${entry.evidence}`;
    push({
      file: firstFilePath(blob),
      severity: parsed.severity === 'critical' ? 'critical' : 'warning',
      ask: entry.criterion || entry.evidence,
      evidence: entry.evidence,
    });
  }
  for (const finding of parsed.findings) {
    push({
      file: firstFilePath(finding),
      severity: severityOf(parsed.severity),
      ask: finding,
      evidence: parsed.summary,
    });
  }
  for (const rec of parsed.recommendations) {
    push({
      file: firstFilePath(rec),
      severity: 'warning',
      ask: rec,
      evidence: parsed.summary,
    });
  }
  const unmet = contractError?.match(/Acceptance evidence missing or unmet:\s*(.+)$/i);
  if (unmet) {
    for (const part of unmet[1].split(/;|\n/)) {
      push({
        file: firstFilePath(part),
        severity: 'critical',
        ask: part.trim(),
        evidence: contractError ?? '',
      });
    }
  }
  return packets.slice(0, 16);
}

export function classifySupervisorEvent(input: {
  stepKind: string;
  stepId: string;
  seatLabel: string;
  output: string | null;
  error: string | null;
  failed: boolean;
  needsChanges: boolean;
  packets: SwarmCritiquePacket[];
  fingerprint: SwarmWorktreeFingerprint;
}): SupervisorEvent {
  const kind = input.stepKind;
  let eventKind: SupervisorEventKind = input.failed ? 'other_failed' : 'other_succeeded';
  if (kind === 'reviewer') {
    if (input.needsChanges) eventKind = 'reviewer_needs_changes';
    else if (!input.failed) eventKind = 'reviewer_approved';
    else if (
      looksLikeReviewApproval(input.output)
      && /unchanged|required source changes/i.test(input.error ?? '')
    ) {
      // Reviewer did their job (SHIP/LGTM) but a stale requiresChanges flag
      // graded the read-only pass as a missing diff. That is not a failure.
      eventKind = 'reviewer_approved';
    } else eventKind = 'reviewer_failed';
  } else if (kind === 'implementer' || kind === 'custom') {
    if (!input.failed) eventKind = 'implementer_changed';
    else if (/unchanged|required source changes/i.test(input.error ?? '')) eventKind = 'implementer_no_diff';
    else if (input.needsChanges) eventKind = 'implementer_incomplete';
    else eventKind = 'implementer_failed';
  } else if (kind === 'explorer') {
    eventKind = input.failed ? 'explorer_failed' : 'explorer_succeeded';
  }
  return {
    kind: eventKind,
    stepKind: kind,
    stepId: input.stepId,
    seatLabel: input.seatLabel,
    output: input.output,
    error: input.error,
    packets: input.packets,
    fingerprint: input.fingerprint,
    failed: input.failed,
    needsChanges: input.needsChanges,
  };
}

export function eventFromGoalCard(card: SwarmGoalCard): SupervisorEvent | null {
  const fingerprint = card.fingerprint ?? {
    head: card.lastReview?.shaReviewed ?? null,
    dirty: false,
    signature: card.lastReview?.fingerprint ?? `${card.lastReview?.shaReviewed ?? 'nohead'}|`,
  };
  if (card.lastEventKind) {
    const kind = card.lastEventKind as SupervisorEventKind;
    const stepKind = kind.startsWith('reviewer')
      ? 'reviewer'
      : kind.startsWith('explorer')
        ? 'explorer'
        : kind.startsWith('implementer')
          ? 'implementer'
          : 'custom';
    return {
      kind,
      stepKind,
      stepId: card.lastEventStepId ?? card.lastReview?.stepId ?? 'resume',
      seatLabel: card.lastEventSeat ?? card.lastReview?.seatLabel ?? 'worker',
      output: null,
      error: card.lastEventError ?? null,
      packets: card.lastReview?.blockers ?? [],
      fingerprint,
      failed: kind !== 'reviewer_approved' && kind !== 'implementer_changed' && kind !== 'explorer_succeeded',
      needsChanges: kind === 'reviewer_needs_changes' || kind === 'implementer_incomplete',
    };
  }
  const review = card.lastReview;
  if (!review) return null;
  return {
    kind:
      review.verdict === 'approved'
        ? 'reviewer_approved'
        : review.verdict === 'changes_requested'
          ? 'reviewer_needs_changes'
          : 'reviewer_failed',
    stepKind: 'reviewer',
    stepId: review.stepId ?? 'review',
    seatLabel: review.seatLabel ?? 'Reviewer',
    output: null,
    error: null,
    packets: review.blockers,
    fingerprint,
    failed: review.verdict !== 'approved',
    needsChanges: review.verdict === 'changes_requested',
  };
}

export function applySupervisorEvent(card: SwarmGoalCard, event: SupervisorEvent): SwarmGoalCard {
  const next: SwarmGoalCard = {
    ...card,
    fingerprint: event.fingerprint,
    lastEventKind: event.kind,
    lastEventStepId: event.stepId,
    lastEventSeat: event.seatLabel,
    lastEventError: event.error,
    updatedAt: new Date().toISOString(),
  };

  if (event.stepKind === 'implementer' || event.stepKind === 'custom') {
    next.lastWriter = event.seatLabel;
    next.lastWriterKind = event.stepKind;
  }

  if (event.kind === 'reviewer_needs_changes' || event.kind === 'reviewer_approved' || event.kind === 'reviewer_failed') {
    const hash = blockerHash(event.packets);
    const same = Boolean(card.lastReview?.blockerHash && hash && card.lastReview.blockerHash === hash);
    const review: SwarmGoalCardReview = {
      verdict:
        event.kind === 'reviewer_approved'
          ? 'approved'
          : event.kind === 'reviewer_needs_changes'
            ? 'changes_requested'
            : 'failed',
      blockers: event.packets,
      blockerHash: hash,
      shaReviewed: event.fingerprint.head,
      fingerprint: event.fingerprint.signature,
      seatLabel: event.seatLabel,
      stepId: event.stepId,
      vague: isVagueReview(event.packets),
    };
    next.lastReview = review;
    next.repeatBlockerCount = same ? card.repeatBlockerCount + 1 : event.kind === 'reviewer_needs_changes' ? 1 : 0;
  }

  if (event.kind === 'reviewer_approved') next.status = 'accepted';
  else if (event.kind === 'reviewer_needs_changes') next.status = 'in_review';
  else if (event.kind.startsWith('implementer')) next.status = 'implementing';
  else if (event.kind.startsWith('explorer')) next.status = 'exploring';
  else if (event.kind === 'validation_red') next.status = 'implementing';

  return next;
}

export function shouldRefuseReviewer(
  card: SwarmGoalCard | null,
  fingerprint: SwarmWorktreeFingerprint,
): boolean {
  if (!card?.lastReview) return false;
  if (card.lastReview.verdict !== 'changes_requested') return false;
  return fingerprintsMatch(card.lastReview.fingerprint, fingerprint);
}

export function routeSupervisorPolicy(card: SwarmGoalCard, event: SupervisorEvent): SupervisorPolicy {
  const refuseReviewer = shouldRefuseReviewer(card, event.fingerprint)
    || (event.kind === 'reviewer_needs_changes' && fingerprintsMatch(card.fingerprint, event.fingerprint));
  const vague = event.kind === 'reviewer_needs_changes' && isVagueReview(event.packets);
  const repeated = card.repeatBlockerCount >= 1 && event.kind === 'reviewer_needs_changes';

  if (event.kind === 'reviewer_approved') {
    return {
      action: 'done',
      kind: null,
      requiresChanges: false,
      escalate: false,
      refuseReviewer: false,
      policy: 'reviewer_approved',
      reason: 'Independent review approved the work. The goal is done.',
    };
  }

  if (event.kind === 'reviewer_needs_changes') {
    if (vague) {
      return {
        action: 'dispatch',
        kind: 'explorer',
        requiresChanges: false,
        escalate: false,
        refuseReviewer: true,
        policy: 'reviewer_vague',
        reason: 'Review asked for changes but named no files. Dispatch an explorer for evidence, then implement.',
      };
    }
    return {
      action: 'dispatch',
      kind: 'implementer',
      requiresChanges: true,
      escalate: repeated,
      refuseReviewer: true,
      policy: repeated ? 'repeat_blockers_escalate' : 'reviewer_needs_changes',
      reason: refuseReviewer
        ? 'Reviewer requested changes and the tree has not moved. Dispatch an implementer; do not re-review.'
        : 'Reviewer requested concrete changes. Dispatch an implementer with those asks as the brief.',
    };
  }

  if (event.kind === 'implementer_changed') {
    return {
      action: 'dispatch',
      kind: 'reviewer',
      requiresChanges: false,
      escalate: false,
      refuseReviewer: false,
      policy: 'implementer_landed',
      reason: 'A writer landed a real diff. Re-run review against the changed tree.',
    };
  }

  if (event.kind === 'implementer_no_diff') {
    return {
      action: 'dispatch',
      kind: 'implementer',
      requiresChanges: true,
      escalate: true,
      refuseReviewer: true,
      policy: 'implementer_no_diff',
      reason: 'Implementer left the tree unchanged. Retry a stronger writer; do not review a no-op.',
    };
  }

  if (event.kind === 'implementer_incomplete' || event.kind === 'implementer_failed') {
    return {
      action: 'dispatch',
      kind: 'implementer',
      requiresChanges: event.kind === 'implementer_incomplete',
      escalate: event.kind === 'implementer_failed',
      refuseReviewer: true,
      policy: event.kind,
      reason: 'Implementation is still open. Dispatch another implementer with the failure as ground truth.',
    };
  }

  if (event.kind === 'explorer_succeeded') {
    return {
      action: 'dispatch',
      kind: 'implementer',
      requiresChanges: Boolean(card.lastReview && card.lastReview.verdict === 'changes_requested'),
      escalate: false,
      refuseReviewer: true,
      policy: 'explorer_done',
      reason: 'Exploration finished. Dispatch an implementer with the new evidence.',
    };
  }

  if (event.kind === 'explorer_failed') {
    return {
      action: 'dispatch',
      kind: 'explorer',
      requiresChanges: false,
      escalate: true,
      refuseReviewer: true,
      policy: 'explorer_failed',
      reason: 'Explorer failed. Try a stronger explorer before writing code blindly.',
    };
  }

  if (event.kind === 'validation_red') {
    return {
      action: 'dispatch',
      kind: 'implementer',
      requiresChanges: true,
      escalate: true,
      refuseReviewer: true,
      policy: 'validation_red',
      reason: 'The pre-PR gate is red. Gate logs are the brief — dispatch an implementer, not a reviewer.',
    };
  }

  if (event.kind === 'reviewer_failed' || event.failed) {
    return {
      action: 'dispatch',
      kind: 'implementer',
      requiresChanges: true,
      escalate: true,
      refuseReviewer: true,
      policy: 'worker_failed',
      reason: 'A worker failed. Keep making progress with an implementer rather than looping a read-only seat.',
    };
  }

  return {
    action: 'done',
    kind: null,
    requiresChanges: false,
    escalate: false,
    refuseReviewer: false,
    policy: 'no_open_work',
    reason: 'No open blockers remain.',
  };
}

function asWorkerKind(value: unknown): SwarmAgentKind | null {
  return typeof value === 'string' && WORKER_KINDS.has(value as SwarmAgentKind)
    ? (value as SwarmAgentKind)
    : null;
}

export function parseSupervisorDecision(text: string): SupervisorDecisionDraft | null {
  try {
    const parsed = parseJsonFromAgentText(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const action: SwarmSupervisorAction =
      o.action === 'done' || o.action === 'blocked' || o.action === 'dispatch' ? o.action : 'dispatch';
    const kind = asWorkerKind(o.kind);
    const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : 'Supervisor dispatch';
    const reason = typeof o.reason === 'string' && o.reason.trim()
      ? o.reason.trim()
      : 'Orchestrator chose the next step.';
    if (action === 'dispatch' && !kind && !prompt) return null;
    return {
      action,
      kind,
      assignTo: typeof o.assignTo === 'string' ? o.assignTo : null,
      profileId: typeof o.profileId === 'string' ? o.profileId : null,
      title: title.slice(0, 160),
      prompt: prompt.slice(0, 8_000),
      difficulty:
        o.difficulty === 'basic' || o.difficulty === 'medium' || o.difficulty === 'advanced'
          ? o.difficulty
          : null,
      scope: Array.isArray(o.scope)
        ? o.scope.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          .map((entry) => entry.trim().slice(0, 300))
          .slice(0, 24)
        : [],
      acceptanceCriteria: Array.isArray(o.acceptanceCriteria)
        ? o.acceptanceCriteria
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .map((entry) => entry.trim().slice(0, 400))
            .slice(0, 8)
        : [],
      requiresChanges: o.requiresChanges === true,
      reason: reason.slice(0, 800),
    };
  } catch {
    return null;
  }
}

export function applySupervisorPolicy(
  policy: SupervisorPolicy,
  draft: SupervisorDecisionDraft | null,
): SupervisorDecisionDraft {
  const base: SupervisorDecisionDraft = draft ?? {
    action: policy.action,
    kind: policy.kind,
    assignTo: null,
    profileId: null,
    title: policy.action === 'dispatch' ? 'Supervisor dispatch' : policy.action,
    prompt: '',
    difficulty: policy.escalate ? 'advanced' : 'medium',
    scope: [],
    acceptanceCriteria: [],
    requiresChanges: policy.requiresChanges,
    reason: policy.reason,
  };

  let action = base.action;
  let kind = base.kind ?? policy.kind;
  let coerced = false;

  if (policy.action === 'dispatch' && action === 'done' && policy.kind) {
    action = 'dispatch';
    kind = policy.kind;
    coerced = true;
  }
  if (policy.refuseReviewer && (kind === 'reviewer' || kind === 'tester')) {
    action = 'dispatch';
    kind = policy.kind ?? 'implementer';
    coerced = true;
  }
  if (policy.kind === 'implementer' && kind === 'explorer' && policy.policy !== 'reviewer_vague') {
    kind = 'implementer';
    coerced = true;
  }
  if (action === 'dispatch' && !kind) {
    kind = policy.kind ?? 'implementer';
    coerced = true;
  }

  // A coerced writer must not keep a read-only seat label from the draft.
  let assignTo = base.assignTo;
  if (coerced && (kind === 'implementer' || kind === 'custom')) {
    assignTo = null;
  }

  return {
    ...base,
    action,
    kind,
    assignTo,
    requiresChanges: stepRequiresSourceChanges(
      kind,
      policy.requiresChanges || base.requiresChanges,
    ),
    difficulty: policy.escalate ? 'advanced' : base.difficulty,
    reason: coerced ? `${base.reason} (policy: ${policy.policy})` : base.reason,
  };
}

export function compileImplementerBrief(input: {
  packets: SwarmCritiquePacket[];
  orchestratorPrompt: string;
  lastError?: string | null;
}): string {
  const lines = [
    'Implement the changes requested by the reviewer. Do not merely audit or restate the findings; edit the worktree and verify the correction.',
    '',
  ];
  if (input.packets.length > 0) {
    lines.push('## Critique packets (ground truth — fix each one)');
    for (const packet of input.packets) {
      const where = packet.file ? `${packet.file} · ` : '';
      lines.push(`- [${packet.severity}] ${where}${packet.ask}${packet.evidence ? ` — ${packet.evidence}` : ''}`);
    }
    lines.push('');
  }
  if (input.lastError) {
    lines.push('## Previous error', input.lastError.slice(0, 1_200), '');
  }
  if (input.orchestratorPrompt.trim()) {
    lines.push('## Orchestrator brief', input.orchestratorPrompt.trim());
  }
  return lines.join('\n');
}

export function buildSupervisorPrompt(input: {
  goal: string;
  card: SwarmGoalCard;
  event: SupervisorEvent;
  policy: SupervisorPolicy;
  roster: SwarmAgentSpec[];
  planSummary?: string | null;
}): string {
  const rosterLines = input.roster
    .filter((seat) => seat.kind !== 'orchestrator')
    .map(
      (seat) =>
        `- "${seat.label}" (${seat.kind}, level ${seat.level ?? 'medium'}, ${seat.provider ?? 'default'}${seat.model ? `/${seat.model}` : ''})`,
    )
    .join('\n');
  const packets = input.event.packets.length
    ? input.event.packets
        .map((packet) => `- [${packet.severity}] ${packet.file ?? '(no file)'} — ${packet.ask}${packet.evidence ? ` (${packet.evidence})` : ''}`)
        .join('\n')
    : '(none parsed)';
  const lastDecisions = input.card.decisions
    .slice(-6)
    .map((decision) => `- tick ${decision.tick}: ${decision.action} ${decision.kind ?? ''} — ${decision.reason}`)
    .join('\n');

  return [
    'You are the Swarm Orchestrator, still on shift. SUPERVISOR TICK.',
    'The initial plan has yielded. You now choose the next worker the way a human operator would:',
    'read the last verdict, spawn the right agent, and keep going until the goal is actually done.',
    '',
    '## Goal',
    input.goal,
    '',
    input.planSummary ? `## Original plan\n${input.planSummary}\n` : '',
    '## Goal card',
    `- status: ${input.card.status}`,
    `- mode: ${input.card.mode}`,
    `- head: ${input.card.fingerprint?.head ?? 'unknown'}${input.card.fingerprint?.dirty ? ' (dirty)' : ''}`,
    `- last writer: ${input.card.lastWriter ?? 'none'}`,
    `- last review: ${input.card.lastReview?.verdict ?? 'none'} (repeat blockers: ${input.card.repeatBlockerCount})`,
    `- ticks: ${input.card.ticksUsed}/${input.card.tickBudget}`,
    '',
    '## Last event',
    `- ${input.event.kind} by "${input.event.seatLabel}" (${input.event.stepKind} ${input.event.stepId})`,
    input.event.error ? `- error: ${input.event.error.slice(0, 800)}` : '',
    '',
    '## Critique packets',
    packets,
    '',
    '## Policy (hard — your kind will be coerced if you violate it)',
    `- ${input.policy.policy}: ${input.policy.reason}`,
    input.policy.kind ? `- legal next role: ${input.policy.kind}` : '- legal action: done',
    input.policy.refuseReviewer ? '- you MUST NOT dispatch a reviewer or tester against this unchanged tree' : '',
    '',
    '## Seats',
    rosterLines || '(no worker seats — pick a kind and a profile will be provisioned)',
    '',
    lastDecisions ? `## Recent supervisor decisions\n${lastDecisions}\n` : '',
    '## Your job',
    'Return ONLY a JSON object (no markdown fences):',
    '{',
    '  "action": "dispatch" | "done" | "blocked",',
    '  "kind": "explorer" | "implementer" | "reviewer" | "tester" | "security" | "docs" | "custom",',
    '  "assignTo": "exact roster label or omit",',
    '  "title": "short title",',
    '  "prompt": "detailed brief for the worker",',
    '  "difficulty": "basic" | "medium" | "advanced",',
    '  "scope": ["files or areas"],',
    '  "acceptanceCriteria": ["observable result"],',
    '  "requiresChanges": true,',
    '  "reason": "one or two sentences the human will read"',
    '}',
    'Rules:',
    '- You choose the seat, the brief, and whether the goal is done. Policy will correct an illegal role.',
    '- Do not declare done while a reviewer still has open change requests.',
    '- After an implementer lands a diff, prefer the same reviewer (or a stronger one).',
    '- Prefer the cheapest seat that can actually do the work. Escalate only when the same blockers repeated.',
    '- Do NOT run terminal, git, or file tools. The goal card and last event are complete.',
    '- A denied tool aborts this entire supervisor tick.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function appendSupervisorDecision(
  card: SwarmGoalCard,
  decision: Omit<SwarmSupervisorDecision, 'tick' | 'at'> & { tick?: number },
): SwarmGoalCard {
  const tick = decision.tick ?? card.ticksUsed;
  const entry: SwarmSupervisorDecision = {
    tick,
    at: new Date().toISOString(),
    action: decision.action,
    kind: decision.kind,
    title: decision.title,
    reason: decision.reason,
    policy: decision.policy,
    coerced: decision.coerced,
    stepId: decision.stepId,
  };
  return {
    ...card,
    ticksUsed: Math.max(card.ticksUsed, tick),
    decisions: [...card.decisions, entry].slice(-40),
    updatedAt: new Date().toISOString(),
  };
}

export function buildSupervisorStep(input: {
  decision: SupervisorDecisionDraft;
  event: SupervisorEvent;
  packets: SwarmCritiquePacket[];
}): SwarmPlanStep {
  const writer = input.decision.kind === 'implementer' || input.decision.kind === 'custom';
  const prompt = writer
    ? compileImplementerBrief({
        packets: input.packets,
        orchestratorPrompt: input.decision.prompt,
        lastError: input.event.error,
      })
    : input.decision.prompt || `Continue the swarm goal after ${input.event.kind}.`;
  const acceptance = input.decision.acceptanceCriteria.length > 0
    ? input.decision.acceptanceCriteria
    : writer && input.decision.requiresChanges
      ? ['The requested changes are implemented and verified in the worktree']
      : undefined;
  return {
    id: `supervise-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    replacesStepId: input.event.stepId,
    title: input.decision.title || `Supervisor ${input.decision.kind ?? 'step'}`,
    kind: input.decision.kind ?? 'implementer',
    assignTo: input.decision.assignTo,
    profileId: input.decision.profileId,
    difficulty: input.decision.difficulty,
    scope: input.decision.scope,
    acceptanceCriteria: acceptance,
    requiresChanges: stepRequiresSourceChanges(input.decision.kind, input.decision.requiresChanges),
    wave: 0,
    dependsOn: [input.event.stepId],
    prompt,
    status: 'queued',
  };
}
