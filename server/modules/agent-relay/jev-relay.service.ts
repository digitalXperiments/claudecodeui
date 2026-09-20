/**
 * Agent Relay's Jev questions and guardrails.
 *
 * The generic plumbing (credential, settings, HTTP, answer parsing) lives in
 * the `decisioning` module. What lives here is everything Relay-specific: the
 * enumerated answers, the redacted state, and the rules that decide whether an
 * answer may be acted on at all.
 */

import {
  askJev,
  capabilityMode,
  readJevSettings,
  type JevDecision,
  type JevSettings,
} from '@/modules/decisioning/index.js';

/** Redaction caps. Jev gets a summary, never a transcript or file contents. */
const MAX_COMMAND_CHARS = 600;
const MAX_TASK_CHARS = 1_200;
const MAX_SUMMARY_CHARS = 1_500;
const MAX_LIST_ITEMS = 12;
const MAX_LIST_ITEM_CHARS = 200;

function clip(value: string | null | undefined, max: number): string {
  const text = (value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function clipList(values: readonly string[] | null | undefined): string[] {
  return (values ?? []).slice(0, MAX_LIST_ITEMS).map((entry) => clip(entry, MAX_LIST_ITEM_CHARS));
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type JevPermissionVerdict = 'approve' | 'deny' | 'escalate';
export type JevPermissionAdvice = JevDecision<JevPermissionVerdict>;

export type JevPermissionInput = {
  mode: string;
  approvalPolicy: string;
  provider: string;
  envelopeRoot: string;
  /** Why the deterministic classifier could not settle this itself. */
  classifierReason: string;
  toolName: string | null;
  command: string | null;
  paths: string[];
  cwd: string | null;
  /** The assignment the worker is supposed to be doing. */
  task?: string | null;
  /** Upper bound for this call, so it cannot eat the lead's answering window. */
  maxTimeoutMs?: number;
};

/**
 * Asks Jev about one escalation-tier permission request. Returns `null`
 * whenever Jev must not or cannot be consulted.
 */
export async function adjudicatePermission(
  settings: JevSettings,
  input: JevPermissionInput,
): Promise<JevPermissionAdvice | null> {
  return askJev(settings, {
    capability: 'relay_permissions',
    fallbackVerdict: 'escalate',
    verdicts: ['approve', 'deny', 'escalate'] as const,
    maxTimeoutMs: input.maxTimeoutMs,
    verdictInstructions:
      'A delegated coding worker asked to run an action that CloudCLI could not settle deterministically. '
      + 'Choose what should happen to this one request.',
    verdictCriteria: {
      approve:
        "Routine for the stated assignment, confined to the worker's own isolated worktree, and easily reversible.",
      deny:
        'Destructive, irreversible, outside the declared envelope, reaching for credentials or secrets, '
        + 'or unrelated to the stated assignment.',
      escalate: 'Genuinely ambiguous, or high enough stakes that a human lead should decide.',
    },
    signals: {
      destructive:
        'Running this request could destroy data, publish or exfiltrate data, or change state outside the '
        + "worker's own isolated worktree.",
    },
    state: {
      request: {
        tool: input.toolName,
        command: clip(input.command, MAX_COMMAND_CHARS),
        paths: clipList(input.paths),
        cwd: input.cwd,
      },
      worker: {
        provider: input.provider,
        mode: input.mode,
        approvalPolicy: input.approvalPolicy,
        writableRoot: input.envelopeRoot,
        assignment: clip(input.task, MAX_TASK_CHARS),
      },
      hostPolicy: {
        classifierOutcome: 'escalate',
        classifierReason: clip(input.classifierReason, MAX_LIST_ITEM_CHARS * 2),
        note:
          'The host already denied everything it considered unsafe and approved everything it considered '
          + 'routine. Only this residual case is in question.',
      },
    },
  });
}

/**
 * Turns advice into an action, applying every guardrail in one place so the
 * broker cannot accidentally skip one.
 *
 * - Shadow mode never settles anything.
 * - A likely-destructive request can never be approved, whatever the verdict.
 * - Approving at all requires the separate `relayMayApprovePermissions` switch.
 * - Denying is allowed under `enforcing` alone: it only ever restricts.
 */
export function applyPermissionAdvice(
  settings: JevSettings | null | undefined,
  advice: JevPermissionAdvice | null,
): { settle: 'approve' | 'deny' | null; reason: string | null } {
  const none = { settle: null, reason: null } as const;
  if (!settings || !advice || advice.error) return none;
  if (capabilityMode(settings, 'relay_permissions') !== 'enforcing') return none;
  if (advice.confidence < settings.confidenceThreshold) return none;

  if (advice.verdict === 'deny') {
    return {
      settle: 'deny',
      reason: `Jev classified this request as unsafe (confidence ${advice.confidence.toFixed(2)})`,
    };
  }
  if (advice.verdict !== 'approve') return none;
  if (!settings.relayMayApprovePermissions) return none;
  // The destructive signal is an independent veto on the approve path only: it
  // may withhold an approval, never manufacture one.
  if ((advice.signals.destructive ?? 1) >= 0.5) return none;

  return {
    settle: 'approve',
    reason: `Jev settled this escalation as routine for the assignment (confidence ${advice.confidence.toFixed(2)})`,
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type JevResultVerdict = 'accept' | 'repair' | 'retry' | 'reassign' | 'escalate';
export type JevResultAdvice = JevDecision<JevResultVerdict>;

export type JevResultInput = {
  provider: string;
  model: string | null;
  mode: string;
  task: string;
  status: string;
  summary: string;
  evidence: string[];
  filesTouched: string[];
  testsRun: string[];
  openQuestions: string[];
  outputValidation: { valid: boolean; errors: string[] } | null;
  attempt: number;
  retryCount: number;
};

/**
 * Assesses a finished worker result. Advisory in every rollout stage: callers
 * record it and surface it, and it must never requeue, repair, retry, or
 * re-dispatch anything by itself.
 */
export async function adjudicateResult(
  settings: JevSettings,
  input: JevResultInput,
): Promise<JevResultAdvice | null> {
  return askJev(settings, {
    capability: 'relay_results',
    fallbackVerdict: 'escalate',
    verdicts: ['accept', 'repair', 'retry', 'reassign', 'escalate'] as const,
    verdictInstructions:
      'A delegated coding worker finished and returned the structured report below. Its schema already '
      + 'validated locally. Choose what the lead should do with it.',
    verdictCriteria: {
      accept: 'The assignment is satisfied and the evidence supports that claim.',
      repair: 'Substantially done, but the report itself is incomplete or inconsistent and needs one fix-up turn.',
      retry: 'The attempt failed for a transient reason and the same worker deserves another attempt.',
      reassign: 'The worker was not capable enough for this assignment; a stronger model should take it.',
      escalate: 'A human lead should look at this before anything else happens.',
    },
    signals: {
      satisfied: 'The worker actually completed the assignment it was given.',
      evidence: 'The evidence, files touched, and tests listed are sufficient to believe the claimed outcome.',
    },
    state: {
      assignment: clip(input.task, MAX_TASK_CHARS),
      worker: {
        provider: input.provider,
        model: input.model,
        mode: input.mode,
        attempt: input.attempt,
        retries: input.retryCount,
      },
      report: {
        status: input.status,
        summary: clip(input.summary, MAX_SUMMARY_CHARS),
        evidence: clipList(input.evidence),
        filesTouched: clipList(input.filesTouched),
        testsRun: clipList(input.testsRun),
        openQuestions: clipList(input.openQuestions),
      },
      localValidation: input.outputValidation
        ? { valid: input.outputValidation.valid, errors: clipList(input.outputValidation.errors) }
        : null,
    },
  });
}

/** Convenience for call sites that have no settings snapshot to hand. */
export { readJevSettings };
