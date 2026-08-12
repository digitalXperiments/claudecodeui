import { execFileSync } from 'node:child_process';

import { projectsDb } from '@/modules/database/index.js';
import {
  extractRunOutcome,
  parseJsonFromAgentText,
} from '@/modules/mission-control/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/index.js';
import { swarmPermissionBroker } from '@/modules/swarm/swarm-permission-broker.service.js';
import {
  chatRunRegistry,
  DETACHED_CONNECTION,
  startProviderRun,
  type ProviderSpawnFn,
} from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { resolveProviderAuthFailure } from '@/shared/provider-auth-failure.js';
import { AppError } from '@/shared/utils.js';

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};
let runtimeAbortFns: Partial<Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>> = {};

export function configureSwarmRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

/** Provider abort fns (same map the interactive chat uses) so timed-out/aborted swarm runs are force-killed. */
export function configureSwarmAbortFns(
  abortFns: Partial<Record<LLMProvider, (providerSessionId: string) => boolean | Promise<boolean>>>,
): void {
  runtimeAbortFns = abortFns;
}

export function getSwarmAbortFn(provider: LLMProvider): ((providerSessionId: string) => boolean | Promise<boolean>) | undefined {
  return runtimeAbortFns[provider];
}

/** Abort the live provider process addressed by the stable app-session id. */
export async function abortSwarmAgentSession(
  appSessionId: string,
  provider: LLMProvider,
): Promise<boolean> {
  const live = chatRunRegistry.getRun(appSessionId);
  if (!live || live.status !== 'running') return false;
  let aborted = false;
  const abortFn = live.providerSessionId ? getSwarmAbortFn(provider) : undefined;
  if (abortFn && live.providerSessionId) {
    try {
      aborted = Boolean(await abortFn(live.providerSessionId));
    } catch {
      aborted = false;
    }
  }
  // Always close the registry run. Some providers do not announce a native id
  // until late, but cancellation must still unblock the orchestration promise.
  chatRunRegistry.completeRun(appSessionId, { exitCode: 1, aborted: true });
  return aborted;
}

export function getSwarmSpawnFn(provider: LLMProvider): ProviderSpawnFn | undefined {
  return runtimeSpawnFns[provider];
}

const SWARM_PROVIDERS: LLMProvider[] = [
  'claude',
  'codex',
  'cursor',
  'opencode',
  'grok',
  'kimi',
  'pi',
];

export function isSwarmProvider(value: unknown): value is LLMProvider {
  return typeof value === 'string' && (SWARM_PROVIDERS as string[]).includes(value);
}

export function resolveSwarmProvider(preferred?: string | null): LLMProvider {
  if (preferred && isSwarmProvider(preferred)) return preferred;
  // Prefer a runtime that is actually wired; fall back to claude.
  for (const p of SWARM_PROVIDERS) {
    if (runtimeSpawnFns[p]) return p;
  }
  return 'claude';
}

function buildHeadlessOptions(
  provider: LLMProvider,
  opts?: {
    model?: string | null;
    effort?: string | null;
    permissionMode?: string | null;
    sessionSummary?: string | null;
  },
): AnyRecord {
  // Default to bypass so unattended swarm agents do not hang on permission UI.
  const permissionMode = opts?.permissionMode?.trim() || 'bypassPermissions';
  const options: AnyRecord = { permissionMode, unattended: true };
  if (opts?.model) options.model = opts.model;
  if (opts?.effort && opts.effort !== 'default') options.effort = opts.effort;
  if (opts?.sessionSummary) options.sessionSummary = opts.sessionSummary;

  switch (provider) {
    case 'claude':
    case 'cursor':
      options.toolsSettings = {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: permissionMode === 'bypassPermissions',
      };
      break;
    case 'grok':
      options.toolsSettings = {
        allowedCommands: [],
        disallowedCommands: [],
      };
      break;
    default:
      break;
  }
  return options;
}

/** Snapshot of git state for the role prompt (best-effort, never throws). */
export function collectProjectGitContext(projectPath: string, maxChars = 6000): string {
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd: projectPath,
        encoding: 'utf8',
        timeout: 8_000,
        maxBuffer: 512 * 1024,
      }).trim();
    } catch {
      return '';
    }
  };

  const status = run(['status', '--short', '--branch']);
  const diffStat = run(['diff', '--stat', 'HEAD']);
  const stagedStat = run(['diff', '--cached', '--stat']);
  const log = run(['log', '-5', '--oneline']);

  const parts = [
    status ? `## git status\n${status}` : '',
    diffStat ? `## unstaged diff --stat\n${diffStat}` : '',
    stagedStat ? `## staged diff --stat\n${stagedStat}` : '',
    log ? `## recent commits\n${log}` : '',
  ].filter(Boolean);

  if (parts.length === 0) {
    return '## git context\n(No git metadata available — inspect the working tree with tools.)';
  }
  const text = parts.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

export type SwarmMemberAgentResult = {
  appSessionId: string;
  runId: string;
  text: string;
  success: boolean;
  errorMessage: string | null;
  /** True when the run hit the stall or hard-ceiling budget and was force-aborted. */
  timedOut?: boolean;
  /**
   * True when the run was killed for going SILENT (no provider events for the
   * stall budget) rather than for exceeding the hard wall-clock ceiling. A
   * stalled agent is a stuck agent; a ceiling hit may just be slow work.
   */
  stalled?: boolean;
};

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Silence budget: how long a swarm agent may emit NO events before it is
 * treated as stuck. Wall-clock alone kills agents that are legitimately busy,
 * which is why the hard ceiling is generous and this is the primary signal.
 */
export function swarmStallTimeoutMs(): number {
  const raw = Number(process.env.CLOUDCLI_SWARM_STALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_TIMEOUT_MS;
}

export type RunSwarmAgentParams = {
  projectId: string;
  projectPath: string;
  provider: LLMProvider;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  prompt: string;
  /** Existing spine run id to attach events to (member/parent). */
  runId: string;
  title?: string;
  /** Hard wall-clock ceiling in ms (0/null disables). Generous by design. */
  timeoutMs?: number | null;
  /**
   * Silence budget in ms: abort when the provider emits no event for this long
   * (0/null disables; omitted uses `swarmStallTimeoutMs()`). This is the signal
   * that actually distinguishes a stuck agent from a slow one.
   */
  stallTimeoutMs?: number | null;
  /** Swarm-wide cancellation signal. */
  signal?: AbortSignal | null;
  /**
   * Swarm permission-broker registration. When present, the run is registered
   * for the lifetime of the provider process and every normalized
   * `permission_request` event is answered by the broker's seat policy
   * (approve / deny / orchestrator adjudication) instead of hanging on an
   * interactive prompt no operator will ever see.
   */
  permission?: {
    swarmId: string;
    memberId?: string | null;
    seatKind: string;
    seatLabel?: string | null;
    workspaceRoot: string;
    /** Set false for adjudication runs (recursion guard). */
    allowEscalation?: boolean;
  } | null;
};

/**
 * One headless provider run for a swarm member (or synthesizer).
 * Creates a fresh app session, records events on the given run spine row,
 * awaits completion, returns assistant text. An optional per-run timeout
 * force-aborts the provider session and marks the run `timed_out`.
 *
 * Registers the run with the swarm permission broker (when a `permission`
 * context is supplied) so unattended permission prompts are always answered.
 */
export async function runSwarmAgent(params: RunSwarmAgentParams): Promise<SwarmMemberAgentResult> {
  if (params.permission) {
    swarmPermissionBroker.register(params.runId, {
      swarmId: params.permission.swarmId,
      memberId: params.permission.memberId ?? null,
      seatKind: params.permission.seatKind,
      seatLabel: params.permission.seatLabel ?? null,
      workspaceRoot: params.permission.workspaceRoot,
      permissionMode: params.permissionMode ?? null,
      provider: params.provider,
      allowEscalation: params.permission.allowEscalation,
    });
  }
  try {
    return await runSwarmAgentInner(params);
  } finally {
    if (params.permission) swarmPermissionBroker.deregister(params.runId);
  }
}

async function runSwarmAgentInner(params: RunSwarmAgentParams): Promise<SwarmMemberAgentResult> {
  const { provider, projectPath, prompt, runId } = params;
  const spawnFn = runtimeSpawnFns[provider];
  if (!spawnFn) {
    throw new AppError(`Provider "${provider}" runtime is not available for agent swarm`, {
      code: 'SWARM_RUNTIME_UNAVAILABLE',
      statusCode: 400,
    });
  }
  if (params.signal?.aborted) {
    const error = new Error('Swarm agent cancelled');
    error.name = 'AbortError';
    throw error;
  }

  const created = sessionsService.createAppSession(provider, projectPath);
  const appSessionId = created.sessionId;
  const title = params.title?.trim() || null;
  if (title) {
    sessionsService.renameSessionById(appSessionId, title);
  }

  try {
    runService.linkSession(runId, appSessionId);
    runService.updateStatus(runId, 'starting');
  } catch {
    /* optional */
  }

  // Liveness clock for stall detection: every normalized provider event
  // (assistant text, tool call, tool result, permission request) counts as
  // progress. Started before the spawn so a provider that never emits anything
  // is still caught.
  let lastEventAt = Date.now();

  let result: Awaited<ReturnType<typeof startProviderRun>>;
  try {
    result = await startProviderRun({
      appSessionId,
      provider,
      providerSessionId: null,
      projectPath,
      spawnFn,
      content: prompt,
      options: buildHeadlessOptions(provider, {
        model: params.model,
        effort: params.effort,
        permissionMode: params.permissionMode,
        sessionSummary: title,
      }),
      connection: DETACHED_CONNECTION,
      userId: null,
      onEvent: (message) => {
        lastEventAt = Date.now();
        recordNormalizedRunEvent(runId, message, 'swarm');
        if (message.kind === 'permission_request') {
          // Fire-and-forget: the broker resolves the pending approval via the
          // process-wide registry; the runtime's own bounded unattended
          // timeout remains the last-resort backstop.
          void swarmPermissionBroker
            .handlePermissionRequest(runId, message as unknown as AnyRecord)
            .catch((error) => {
              console.error('[SwarmPermissionBroker] Unhandled broker failure', error);
            });
        }
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      runService.markTerminal(runId, { status: 'failed', errorSummary: msg });
    } catch {
      /* optional */
    }
    throw error;
  }

  if (!result.ok) {
    const msg = 'A run is already in progress for this session';
    try {
      runService.markTerminal(runId, { status: 'failed', errorSummary: msg });
    } catch {
      /* optional */
    }
    throw new AppError(msg, { code: 'SWARM_RUN_IN_PROGRESS', statusCode: 409 });
  }

  try {
    if (runService.get(runId)?.status === 'starting') {
      runService.updateStatus(runId, 'running');
    }
  } catch {
    /* optional */
  }

  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : null;
  const stallTimeoutMs =
    params.stallTimeoutMs === null
      ? null
      : typeof params.stallTimeoutMs === 'number'
        ? params.stallTimeoutMs > 0
          ? params.stallTimeoutMs
          : null
        : swarmStallTimeoutMs();

  /** Whatever the agent managed to say before being killed. */
  const partialText = (): string => {
    try {
      return extractRunOutcome(appSessionId).text ?? '';
    } catch {
      return '';
    }
  };

  let timedOut = false;
  let stalled = false;
  let cancelled = false;
  try {
    let timer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    let rejectCancellation: ((error: Error) => void) | null = null;
    const onAbort = () => {
      cancelled = true;
      const error = new Error('Swarm agent cancelled');
      error.name = 'AbortError';
      rejectCancellation?.(error);
    };
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
      if (params.signal?.aborted) onAbort();
      else params.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const races: Promise<unknown>[] = [result.completion, cancellation];
    if (timeoutMs != null) {
      races.push(new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Swarm agent exceeded its hard limit of ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }));
    }
    if (stallTimeoutMs != null) {
      // Poll the liveness clock instead of one fixed deadline: each event
      // pushes the deadline out, so busy agents are never killed.
      const pollMs = Math.max(5_000, Math.min(30_000, Math.floor(stallTimeoutMs / 4)));
      races.push(new Promise<never>((_resolve, reject) => {
        stallTimer = setInterval(() => {
          const silentFor = Date.now() - lastEventAt;
          if (silentFor >= stallTimeoutMs) {
            timedOut = true;
            stalled = true;
            reject(
              new Error(
                `Swarm agent stalled: no output for ${silentFor}ms (stall budget ${stallTimeoutMs}ms)`,
              ),
            );
          }
        }, pollMs);
        stallTimer.unref?.();
      }));
    }
    try {
      await Promise.race(races);
    } finally {
      if (timer) clearTimeout(timer);
      if (stallTimer) clearInterval(stallTimer);
      params.signal?.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    try {
      if (timedOut || cancelled) {
        // Stop the underlying provider process (best-effort, mirrors chat abort).
        await abortSwarmAgentSession(appSessionId, provider);
      }
    } catch {
      /* best-effort */
    }
    const msg = error instanceof Error ? error.message : String(error);
    try {
      runService.markTerminal(runId, {
        status: cancelled ? 'aborted' : timedOut ? 'timed_out' : 'failed',
        errorSummary: msg,
      });
    } catch {
      /* optional */
    }
    if (timedOut && !cancelled) {
      // Return the partial transcript: the next agent to pick this task up
      // needs to know how far the killed one actually got.
      return {
        appSessionId,
        runId,
        text: partialText(),
        success: false,
        errorMessage: msg,
        timedOut: true,
        stalled,
      };
    }
    throw error;
  }

  if (timedOut) {
    const msg = stalled
      ? `Swarm run stalled (stall budget ${stallTimeoutMs}ms)`
      : `Swarm run exceeded its hard limit of ${timeoutMs}ms`;
    try {
      runService.markTerminal(runId, {
        status: 'timed_out',
        errorSummary: msg,
      });
    } catch {
      /* optional */
    }
    return {
      appSessionId,
      runId,
      text: partialText(),
      success: false,
      errorMessage: msg,
      timedOut: true,
      stalled,
    };
  }

  const { text, failed, errorMessage } = extractRunOutcome(appSessionId);

  if (failed) {
    // Falling back to the transcript here used to report the agent's own
    // opening line ("I'll audit the storefront…") as the failure reason, which
    // reads as if the agent said something wrong rather than as "the provider
    // exited non-zero". The transcript is returned below either way, so the
    // error field says what actually happened.
    const auth =
      resolveProviderAuthFailure(provider, errorMessage, text) ||
      errorMessage ||
      `Provider "${provider}" exited with a failure before finishing this step`;
    // recordNormalizedRunEvent may already have closed the run; still return outcome.
    return { appSessionId, runId, text, success: false, errorMessage: auth };
  }

  return {
    appSessionId,
    runId,
    text,
    success: true,
    errorMessage: errorMessage,
  };
}

export type ParsedAcceptanceEvidence = {
  criterion: string;
  met: boolean;
  evidence: string;
};

/** Lowercase, strip punctuation, collapse whitespace — for criterion comparison. */
function normalizeCriterionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does one reported acceptance entry satisfy the step's numbered criterion?
 *
 * Exact echo is the happy path, but weaker models paraphrase the criterion or
 * reference it by number ("1", "#2", "criterion 3"), and orchestrators write
 * multi-clause criteria hundreds of characters long — demanding a verbatim
 * echo of those turned honest reports into "Acceptance evidence missing" and
 * sent whole retry cascades after work that was actually done. Accepted forms:
 *   - a numbered reference matching the criterion's 1-based position
 *   - exact or substring match after punctuation/whitespace normalization
 *   - >=60% significant-token overlap (paraphrase tolerance)
 */
export function acceptanceEvidenceMatches(
  criterion: string,
  index: number,
  evidence: ParsedAcceptanceEvidence,
): boolean {
  if (!evidence.met) return false;
  const actualRaw = evidence.criterion.trim();
  const numbered = actualRaw.match(/^(?:acceptance\s+)?(?:criterion|criteria|ac)?\s*#?(\d{1,2})[.)]?$/i);
  if (numbered) return Number(numbered[1]) === index + 1;

  const expected = normalizeCriterionText(criterion);
  const actual = normalizeCriterionText(actualRaw);
  if (!expected || !actual) return false;
  if (expected === actual || expected.includes(actual) || actual.includes(expected)) return true;

  const significant = (text: string): Set<string> =>
    new Set(text.split(' ').filter((token) => token.length > 3));
  const expectedTokens = significant(expected);
  const actualTokens = significant(actual);
  if (expectedTokens.size === 0 || actualTokens.size === 0) return false;
  const [smaller, larger] =
    expectedTokens.size <= actualTokens.size
      ? [expectedTokens, actualTokens]
      : [actualTokens, expectedTokens];
  let hits = 0;
  for (const token of smaller) {
    if (larger.has(token)) hits += 1;
  }
  return hits / smaller.size >= 0.6;
}

export type ParsedMemberFindings = {
  summary: string;
  findings: string[];
  changedFiles: string[];
  verification: string[];
  acceptance: ParsedAcceptanceEvidence[];
  recommendations: string[];
  risks: string[];
  severity: 'info' | 'warning' | 'critical';
  rawText: string;
};

export function parseMemberFindings(text: string): ParsedMemberFindings {
  const rawText = text.trim();
  if (!rawText) {
    return {
      summary: 'No output from agent.',
      findings: [],
      changedFiles: [],
      verification: [],
      acceptance: [],
      recommendations: [],
      risks: [],
      severity: 'info',
      rawText,
    };
  }

  try {
    const parsed = parseJsonFromAgentText(rawText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      const summary =
        typeof o.summary === 'string' && o.summary.trim()
          ? o.summary.trim()
          : firstParagraph(rawText);
      const findings = stringArray(o.findings);
      const changedFiles = stringArray(o.changedFiles ?? o.changed_files).slice(0, 40);
      const verification = stringArray(o.verification ?? o.verificationCommands).slice(0, 20);
      const acceptance = Array.isArray(o.acceptance)
        ? o.acceptance
            .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
            .map((entry) => ({
              criterion: typeof entry.criterion === 'string' ? entry.criterion.trim() : '',
              met: entry.met === true,
              evidence: typeof entry.evidence === 'string' ? entry.evidence.trim().slice(0, 800) : '',
            }))
            .filter((entry) => entry.criterion)
            .slice(0, 8)
        : [];
      const recommendations = stringArray(o.recommendations);
      const risks = stringArray(o.risks);
      const severity =
        o.severity === 'critical' || o.severity === 'warning' || o.severity === 'info'
          ? o.severity
          : 'info';
      return { summary, findings, changedFiles, verification, acceptance, recommendations, risks, severity, rawText };
    }
  } catch {
    /* free-form prose */
  }

  return {
    summary: firstParagraph(rawText, 800),
    findings: [],
    changedFiles: [],
    verification: [],
    acceptance: [],
    recommendations: [],
    risks: [],
    severity: 'info',
    rawText,
  };
}

export type ParsedSynthesis = {
  summary: string;
  recommendations: string[];
  risks: string[];
  actionItems: Array<{ title: string; prompt: string; priority: 'high' | 'medium' | 'low' }>;
};

export function parseSynthesis(text: string, fallbackMembers: ParsedMemberFindings[]): ParsedSynthesis {
  try {
    const parsed = parseJsonFromAgentText(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      const summary =
        typeof o.summary === 'string' && o.summary.trim()
          ? o.summary.trim()
          : firstParagraph(text, 1000);
      const recommendations = stringArray(o.recommendations);
      const risks = stringArray(o.risks);
      const actionItems = coerceActionItems(o.actionItems ?? o.action_items);
      return {
        summary,
        recommendations:
          recommendations.length > 0
            ? recommendations
            : actionItems.map((a) => a.title),
        risks,
        actionItems,
      };
    }
  } catch {
    /* fall through */
  }

  // Merge member-level structure when synthesizer returned prose or failed.
  const recommendations = fallbackMembers.flatMap((m) => m.recommendations).slice(0, 12);
  const risks = fallbackMembers.flatMap((m) => m.risks).slice(0, 8);
  const summary =
    firstParagraph(text, 1200) ||
    `Combined ${fallbackMembers.length} role review(s).`;
  const actionItems = recommendations.slice(0, 8).map((title) => ({
    title: title.slice(0, 120),
    prompt: title,
    priority: 'medium' as const,
  }));
  return { summary, recommendations, risks, actionItems };
}

export function mergeFindingsFallback(
  goal: string,
  members: Array<{ role: string; label?: string | null; findings: ParsedMemberFindings }>,
): ParsedSynthesis {
  const lines = members
    .filter((m) => m.findings.summary)
    .map((m) => `### ${m.label || m.role}\n${m.findings.summary}`);
  const recommendations = members.flatMap((m) => m.findings.recommendations).slice(0, 12);
  const risks = members.flatMap((m) => m.findings.risks).slice(0, 8);
  const actionItems: Array<{ title: string; prompt: string; priority: 'high' | 'medium' | 'low' }> =
    recommendations.slice(0, 8).map((title) => ({
      title: title.slice(0, 120),
      prompt: `${title}\n\nContext goal: ${goal}`,
      priority: 'medium' as const,
    }));
  if (actionItems.length === 0) {
    for (const m of members) {
      for (const f of m.findings.findings.slice(0, 3)) {
        actionItems.push({
          title: f.slice(0, 120),
          prompt: `[${m.label || m.role}] ${f}\n\nGoal: ${goal}`,
          priority: m.findings.severity === 'critical' ? 'high' : 'medium',
        });
      }
    }
  }
  return {
    summary:
      lines.length > 0
        ? `Agent swarm for “${goal}” (${members.length} agents):\n\n${lines.join('\n\n')}`
        : `Agent swarm for “${goal}” completed with ${members.length} agent(s).`,
    recommendations:
      recommendations.length > 0
        ? recommendations
        : actionItems.map((a) => a.title),
    risks,
    actionItems: actionItems.slice(0, 10),
  };
}

export type ParsedPlan = {
  summary: string;
  strategy: string;
  costNotes?: string;
  steps: Array<{
    id: string;
    title: string;
    kind: string;
    assignTo?: string | null;
    /** Auto-roster: agent profile the orchestrator picked for this step. */
    profileId?: string | null;
    /** Capability tier the step demands: basic | medium | advanced. */
    difficulty?: 'basic' | 'medium' | 'advanced' | null;
    /** Files/globs/areas this step exclusively owns. */
    scope?: string[];
    acceptanceCriteria?: string[];
    verificationCommands?: string[];
    requiresChanges?: boolean;
    provider?: string | null;
    model?: string | null;
    effort?: string | null;
    permissionMode?: string | null;
    prompt: string;
    dependsOn?: string[];
    wave?: number;
  }>;
};

export function parseOrchestratorPlan(text: string, fallbackAgents: Array<{ kind: string; label: string }>): ParsedPlan {
  try {
    const parsed = parseJsonFromAgentText(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      const summary =
        typeof o.summary === 'string' && o.summary.trim()
          ? o.summary.trim()
          : firstParagraph(text, 600);
      const strategy =
        typeof o.strategy === 'string' && o.strategy.trim()
          ? o.strategy.trim()
          : 'Execute roster in explore → implement → review order.';
      const costNotes =
        typeof o.costNotes === 'string'
          ? o.costNotes.trim()
          : typeof o.cost_notes === 'string'
            ? o.cost_notes.trim()
            : undefined;
      const rawSteps = Array.isArray(o.steps) ? o.steps : [];
      const steps = rawSteps
        .map((entry, index) => {
          if (!entry || typeof entry !== 'object') return null;
          const e = entry as Record<string, unknown>;
          const id =
            typeof e.id === 'string' && e.id.trim()
              ? e.id.trim()
              : `step-${index + 1}`;
          const title =
            typeof e.title === 'string' && e.title.trim()
              ? e.title.trim()
              : `Step ${index + 1}`;
          const kind =
            typeof e.kind === 'string' && e.kind.trim()
              ? e.kind.trim()
              : 'implementer';
          const prompt =
            typeof e.prompt === 'string' && e.prompt.trim()
              ? e.prompt.trim()
              : title;
          const assignTo =
            typeof e.assignTo === 'string'
              ? e.assignTo.trim()
              : typeof e.assign_to === 'string'
                ? e.assign_to.trim()
                : null;
          const profileId =
            typeof e.profileId === 'string'
              ? e.profileId.trim()
              : typeof e.profile_id === 'string'
                ? e.profile_id.trim()
                : null;
          const dependsOn = Array.isArray(e.dependsOn)
            ? e.dependsOn.filter((d): d is string => typeof d === 'string')
            : Array.isArray(e.depends_on)
              ? e.depends_on.filter((d): d is string => typeof d === 'string')
              : [];
          const wave =
            typeof e.wave === 'number' && Number.isFinite(e.wave)
              ? e.wave
              : typeof e.parallelGroup === 'number'
                ? e.parallelGroup
                : index + 1;
          const difficulty: 'basic' | 'medium' | 'advanced' | null =
            e.difficulty === 'basic' || e.difficulty === 'medium' || e.difficulty === 'advanced'
              ? e.difficulty
              : null;
          const scope = Array.isArray(e.scope)
            ? (e.scope as unknown[])
                .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
                .map((entry) => entry.trim().slice(0, 300))
                .slice(0, 24)
            : typeof e.scope === 'string' && e.scope.trim()
              ? [e.scope.trim().slice(0, 300)]
              : [];
          const acceptanceCriteria = stringArray(e.acceptanceCriteria ?? e.acceptance_criteria)
            .map((criterion) => criterion.slice(0, 500))
            .slice(0, 5);
          const verificationCommands = stringArray(e.verificationCommands ?? e.verification_commands)
            .map((command) => command.slice(0, 300))
            .slice(0, 5);
          return {
            id,
            title: title.slice(0, 200),
            kind,
            assignTo,
            profileId,
            difficulty,
            scope,
            acceptanceCriteria,
            verificationCommands,
            requiresChanges: e.requiresChanges === true || e.requires_changes === true,
            provider: typeof e.provider === 'string' ? e.provider : null,
            model: typeof e.model === 'string' ? e.model : null,
            effort: typeof e.effort === 'string' ? e.effort : null,
            permissionMode:
              typeof e.permissionMode === 'string'
                ? e.permissionMode
                : typeof e.permission_mode === 'string'
                  ? e.permission_mode
                  : null,
            prompt,
            dependsOn,
            wave,
          };
        })
        .filter((s): s is NonNullable<typeof s> => Boolean(s));
      if (steps.length > 0) {
        return { summary, strategy, costNotes, steps };
      }
    }
  } catch {
    /* fall through */
  }

  // Structural fallback: one step per non-orchestrator roster agent.
  const workers = fallbackAgents.filter((a) => a.kind !== 'orchestrator');
  const steps = (workers.length ? workers : fallbackAgents).map((a, index) => ({
    id: `step-${index + 1}`,
    title: `${a.label}: contribute to goal`,
    kind: a.kind,
    assignTo: a.label,
    prompt: `As ${a.label} (${a.kind}), work toward the swarm goal. Inspect the repo, do your kind of work, and report concrete results.`,
    dependsOn: index > 0 ? [`step-${index}`] : [],
    wave: index + 1,
  }));
  return {
    summary: firstParagraph(text, 600) || 'Default phased plan from roster.',
    strategy: 'Sequential explore → implement → review using the provided roster.',
    costNotes: 'Prefer cheaper models for exploration; reserve stronger models for implementation/review.',
    steps,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

function coerceActionItems(
  value: unknown,
): Array<{ title: string; prompt: string; priority: 'high' | 'medium' | 'low' }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ title: string; prompt: string; priority: 'high' | 'medium' | 'low' }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title =
      typeof e.title === 'string'
        ? e.title.trim()
        : typeof e.summary === 'string'
          ? e.summary.trim()
          : '';
    if (!title) continue;
    const prompt =
      typeof e.prompt === 'string' && e.prompt.trim()
        ? e.prompt.trim()
        : typeof e.description === 'string' && e.description.trim()
          ? e.description.trim()
          : title;
    const priority =
      e.priority === 'high' || e.priority === 'low' || e.priority === 'medium'
        ? e.priority
        : 'medium';
    out.push({ title: title.slice(0, 160), prompt, priority });
  }
  return out.slice(0, 12);
}

function firstParagraph(text: string, max = 600): string {
  const cleaned = text
    .replace(/^```[\w]*\n?/gm, '')
    .replace(/^```$/gm, '')
    .trim();
  const para = cleaned.split(/\n{2,}/)[0]?.trim() || cleaned;
  return para.length > max ? `${para.slice(0, max)}…` : para;
}

export function resolveProjectPath(projectId: string): string {
  const path = projectsDb.getProjectPathById(projectId);
  if (!path) {
    throw new AppError('Project path not found', {
      code: 'SWARM_PROJECT_PATH_MISSING',
      statusCode: 400,
    });
  }
  return path;
}

/** Exported for tests that need to clear registry between cases. */
export { chatRunRegistry };
