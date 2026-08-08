import { execFileSync } from 'node:child_process';

import { projectsDb } from '@/modules/database/index.js';
import {
  extractRunOutcome,
  parseJsonFromAgentText,
} from '@/modules/mission-control/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/index.js';
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
  'agy',
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
  },
): AnyRecord {
  // Default to bypass so unattended swarm agents do not hang on permission UI.
  const permissionMode = opts?.permissionMode?.trim() || 'bypassPermissions';
  const options: AnyRecord = { permissionMode, unattended: true };
  if (opts?.model) options.model = opts.model;
  if (opts?.effort && opts.effort !== 'default') options.effort = opts.effort;

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
  /** True when the run hit the per-step timeout and was force-aborted. */
  timedOut?: boolean;
};

/**
 * One headless provider run for a swarm member (or synthesizer).
 * Creates a fresh app session, records events on the given run spine row,
 * awaits completion, returns assistant text. An optional per-run timeout
 * force-aborts the provider session and marks the run `timed_out`.
 */
export async function runSwarmAgent(params: {
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
  /** Force-abort after this many ms (0/null disables). */
  timeoutMs?: number | null;
}): Promise<SwarmMemberAgentResult> {
  const { provider, projectPath, prompt, runId } = params;
  const spawnFn = runtimeSpawnFns[provider];
  if (!spawnFn) {
    throw new AppError(`Provider "${provider}" runtime is not available for agent swarm`, {
      code: 'SWARM_RUNTIME_UNAVAILABLE',
      statusCode: 400,
    });
  }

  const created = sessionsService.createAppSession(provider, projectPath);
  const appSessionId = created.sessionId;

  try {
    runService.linkSession(runId, appSessionId);
    runService.updateStatus(runId, 'starting');
  } catch {
    /* optional */
  }

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
      }),
      connection: DETACHED_CONNECTION,
      userId: null,
      onEvent: (message) => recordNormalizedRunEvent(runId, message, 'swarm'),
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

  let timedOut = false;
  try {
    if (timeoutMs != null) {
      // Force-abort the provider session if the completion never settles in
      // time. The run spine is closed here so the swarm pipeline knows it
      // failed instead of hanging forever.
      const timeout = new Promise<never>((_resolve, reject) => {
        const t = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Swarm agent timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        t.unref?.();
      });
      await Promise.race([result.completion, timeout]);
    } else {
      await result.completion;
    }
  } catch (error) {
    try {
      if (timedOut) {
        // Stop the underlying provider process (best-effort, mirrors chat abort).
        const run = chatRunRegistry.getRun(appSessionId);
        const providerSessionId = run?.providerSessionId ?? null;
        const abortFn = providerSessionId ? getSwarmAbortFn(provider) : undefined;
        if (abortFn && providerSessionId) {
          try {
            await abortFn(providerSessionId);
          } catch {
            /* best-effort */
          }
        }
        chatRunRegistry.completeRun(appSessionId, { exitCode: 1, aborted: true });
      }
    } catch {
      /* best-effort */
    }
    const msg = error instanceof Error ? error.message : String(error);
    try {
      runService.markTerminal(runId, {
        status: timedOut ? 'timed_out' : 'failed',
        errorSummary: msg,
      });
    } catch {
      /* optional */
    }
    throw error;
  }

  if (timedOut) {
    const msg = `Swarm run timed out after ${timeoutMs}ms`;
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
      text: '',
      success: false,
      errorMessage: msg,
      timedOut: true,
    };
  }

  const { text, failed, errorMessage } = extractRunOutcome(appSessionId);

  if (failed) {
    const auth =
      resolveProviderAuthFailure(provider, errorMessage, text) ||
      errorMessage ||
      text.slice(0, 500) ||
      `Provider "${provider}" run failed`;
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

export type ParsedMemberFindings = {
  summary: string;
  findings: string[];
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
      const recommendations = stringArray(o.recommendations);
      const risks = stringArray(o.risks);
      const severity =
        o.severity === 'critical' || o.severity === 'warning' || o.severity === 'info'
          ? o.severity
          : 'info';
      return { summary, findings, recommendations, risks, severity, rawText };
    }
  } catch {
    /* free-form prose */
  }

  return {
    summary: firstParagraph(rawText, 800),
    findings: [],
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
          return {
            id,
            title: title.slice(0, 200),
            kind,
            assignTo,
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
