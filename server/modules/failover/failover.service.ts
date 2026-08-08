import { compileContextPack } from '@/modules/context-packs/index.js';
import { projectsDb } from '@/modules/database/index.js';
import { failoverDb } from '@/modules/failover/failover.repository.js';
import type {
  CreateFailoverPlaybookInput,
  FailoverCandidate,
  FailoverErrorClass,
  FailoverPlaybook,
  FailoverResult,
  FailoverTriggerOptions,
  UpdateFailoverPlaybookInput,
} from '@/modules/failover/failover.types.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { recordNormalizedRunEvent, runService } from '@/modules/runs/index.js';
import { sessionHandoffService } from '@/modules/providers/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { startProviderRun, DETACHED_CONNECTION, type ProviderSpawnFn } from '@/modules/websocket/index.js';
import { CloudError, TERMINAL_RUN_STATUSES } from '@/shared/run-events.js';
import type { LLMProvider } from '@/shared/types.js';

const ERROR_CLASSES: readonly FailoverErrorClass[] = ['auth', 'rate_limit', 'timeout', 'mcp_unhealthy', 'any'];
const PROVIDERS: readonly LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode', 'grok', 'kimi', 'agy', 'pi'];

let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function configureFailoverRuntimes(
  spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>,
): void {
  runtimeSpawnFns = spawnFns;
}

function normalizeMatch(value: CreateFailoverPlaybookInput['match']): NonNullable<CreateFailoverPlaybookInput['match']> {
  const input = value ?? {};
  const providers = Array.isArray(input.providers)
    ? [...new Set(input.providers.filter((provider): provider is string => typeof provider === 'string' && provider.trim().length > 0).map((provider) => provider.trim()))]
    : undefined;
  const errors = Array.isArray(input.errors)
    ? [...new Set(input.errors.filter((error): error is FailoverErrorClass => ERROR_CLASSES.includes(error)))]
    : undefined;
  return { ...(providers?.length ? { providers } : {}), ...(errors?.length ? { errors } : {}) };
}

function normalizeStrategy(strategy: CreateFailoverPlaybookInput['strategy']) {
  const candidates = Array.isArray(strategy?.candidates)
    ? strategy.candidates
        .filter((candidate) => candidate && typeof candidate.provider === 'string' && candidate.provider.trim())
        .map((candidate) => ({
          provider: candidate.provider.trim(),
          model: candidate.model?.trim() || null,
          profileId: candidate.profileId?.trim() || null,
        }))
    : [];
  const handoffMode = strategy?.handoffMode ?? 'summary';
  if (!['summary', 'full', 'fresh'].includes(handoffMode)) {
    throw new CloudError('PLAYBOOK_NO_CANDIDATE', `Unsupported handoff mode: ${handoffMode}`);
  }
  const maxFailovers = strategy?.maxFailovers ?? 1;
  if (!Number.isInteger(maxFailovers) || maxFailovers < 1 || maxFailovers > 10) {
    throw new CloudError('PLAYBOOK_NO_CANDIDATE', 'strategy.maxFailovers must be an integer from 1 to 10');
  }
  if (candidates.length === 0) {
    throw new CloudError('PLAYBOOK_NO_CANDIDATE', 'strategy.candidates must contain at least one provider');
  }
  return {
    candidates,
    handoffMode: handoffMode as 'summary' | 'full' | 'fresh',
    attachContextPack: strategy?.attachContextPack === true,
    maxFailovers,
  };
}

function normalizeInput(input: CreateFailoverPlaybookInput) {
  if (!input.name?.trim()) throw new CloudError('PLAYBOOK_NO_CANDIDATE', 'Playbook name is required');
  const approval = input.approval ?? 'auto';
  if (approval !== 'auto' && approval !== 'interrupt') {
    throw new CloudError('PLAYBOOK_NO_CANDIDATE', 'approval must be auto or interrupt');
  }
  return {
    name: input.name.trim(),
    projectId: input.projectId ?? null,
    enabled: input.enabled !== false,
    match: normalizeMatch(input.match),
    strategy: normalizeStrategy(input.strategy),
    approval,
  };
}

function classifyFailure(errorSummary: string | null, provider: string | null): FailoverErrorClass {
  const text = `${provider ?? ''} ${errorSummary ?? ''}`.toLowerCase();
  if (/(mcp|tool server|server.*unhealthy|unhealthy.*server)/i.test(text)) return 'mcp_unhealthy';
  if (/(rate[ -]?limit|too many requests|429|quota)/i.test(text)) return 'rate_limit';
  if (/(timeout|timed out|deadline exceeded|etimedout)/i.test(text)) return 'timeout';
  if (/(auth|unauthori[sz]ed|forbidden|login|credential|token|not authenticated)/i.test(text)) return 'auth';
  return 'any';
}

function matches(playbook: FailoverPlaybook, run: NonNullable<ReturnType<typeof runService.get>>): boolean {
  if (!playbook.enabled) return false;
  if (playbook.project_id && playbook.project_id !== run.project_id) return false;
  const providers = playbook.match.providers ?? [];
  if (providers.length > 0 && (!run.provider || !providers.includes(run.provider))) return false;
  const errors = playbook.match.errors ?? [];
  if (errors.length > 0) {
    const failureClass = classifyFailure(run.error_summary, run.provider);
    if (!errors.includes('any') && !errors.includes(failureClass)) return false;
  }
  return true;
}

function failoverCount(run: NonNullable<ReturnType<typeof runService.get>>): number {
  let count = run.trigger === 'failover' ? 1 : 0;
  let parentId = run.parent_run_id;
  const seen = new Set<string>([run.run_id]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = runService.get(parentId);
    if (!parent) break;
    if (parent.trigger === 'failover') count += 1;
    parentId = parent.parent_run_id;
  }
  return count;
}

function chooseCandidate(
  run: NonNullable<ReturnType<typeof runService.get>>,
  playbook: FailoverPlaybook,
): FailoverCandidate {
  const candidate = playbook.strategy.candidates.find((entry) => entry.provider !== run.provider);
  if (!candidate) {
    throw new CloudError('PLAYBOOK_NO_CANDIDATE', `No failover candidate differs from provider ${run.provider ?? '(unknown)'}`);
  }
  if (!PROVIDERS.includes(candidate.provider as LLMProvider)) {
    throw new CloudError('PLAYBOOK_NO_CANDIDATE', `Unknown failover provider: ${candidate.provider}`);
  }
  return candidate;
}

function requireRun(runId: string) {
  const run = runService.get(runId);
  if (!run) throw new CloudError('RUN_NOT_FOUND', `Run not found: ${runId}`);
  return run;
}

async function startCandidate(
  child: NonNullable<ReturnType<typeof runService.get>>,
  prompt: string,
): Promise<void> {
  const provider = child.provider as LLMProvider;
  const spawnFn = runtimeSpawnFns[provider];
  if (!spawnFn || !child.app_session_id || !child.project_id) return;
  const projectPath = projectsDb.getProjectPathById(child.project_id);
  if (!projectPath) return;

  runService.updateStatus(child.run_id, 'starting');
  const started = await startProviderRun({
    appSessionId: child.app_session_id,
    provider,
    providerSessionId: null,
    projectPath,
    spawnFn,
    content: prompt,
    options: {
      cwd: projectPath,
      projectPath,
      model: child.model ?? undefined,
      profileId: child.profile_id ?? undefined,
      permissionMode: child.permission_mode ?? undefined,
    },
    connection: DETACHED_CONNECTION,
    userId: null,
    onEvent: (message) => recordNormalizedRunEvent(child.run_id, message, 'system'),
  });
  if (!started.ok) {
    runService.markTerminal(child.run_id, {
      status: 'failed',
      errorSummary: 'A failover run is already in progress for the target session',
    });
    return;
  }
  runService.linkSession(child.run_id, child.app_session_id);
  if (runService.get(child.run_id)?.status === 'starting') runService.updateStatus(child.run_id, 'running');
  void started.completion.catch((error) => {
    const current = runService.get(child.run_id);
    if (current && !TERMINAL_RUN_STATUSES.has(current.status)) {
      runService.markTerminal(child.run_id, {
        status: 'failed',
        errorSummary: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function executeFailover(
  run: NonNullable<ReturnType<typeof runService.get>>,
  playbook: FailoverPlaybook,
): Promise<FailoverResult> {
  const candidate = chooseCandidate(run, playbook);
  let handoffPrompt: string | null = null;
  let appSessionId: string | null = null;
  let warning: string | undefined;

  if (run.app_session_id) {
    try {
      const handoff = await sessionHandoffService.createHandoffSession({
        sourceSessionId: run.app_session_id,
        targetProvider: candidate.provider as LLMProvider,
        targetModel: candidate.model ?? null,
        mode: playbook.strategy.handoffMode,
        saveToFile: playbook.strategy.handoffMode === 'full',
        includeGitState: true,
        includeKanbanState: true,
      });
      appSessionId = handoff.sessionId;
      handoffPrompt = handoff.handoffPrompt;
    } catch (error) {
      warning = `Handoff context was unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const prompt = handoffPrompt ?? `Continue the failed run. Previous provider: ${run.provider ?? 'unknown'}; failure: ${run.error_summary ?? 'unknown failure'}.`;
  const child = runService.create({
    source: 'system',
    projectId: run.project_id,
    sourceRef: playbook.playbook_id,
    workspaceId: run.workspace_id,
    appSessionId,
    provider: candidate.provider,
    model: candidate.model ?? null,
    profileId: candidate.profileId ?? null,
    title: `Failover: ${run.title ?? run.run_id}`,
    trigger: 'failover',
    parentRunId: run.run_id,
    rootRunId: run.root_run_id ?? run.run_id,
    meta: {
      handoffMode: playbook.strategy.handoffMode,
      promptExcerpt: secretsService.redact(prompt).slice(0, 4000),
      previousProvider: run.provider,
      failureClass: classifyFailure(run.error_summary, run.provider),
      playbookId: playbook.playbook_id,
    },
  });

  runService.appendEvent(run.run_id, {
    run_id: run.run_id,
    ts: new Date().toISOString(),
    source: 'system',
    type: 'failover.triggered',
    payload: { child_run_id: child.run_id, playbook_id: playbook.playbook_id, provider: candidate.provider },
  });
  runService.appendEvent(child.run_id, {
    run_id: child.run_id,
    ts: new Date().toISOString(),
    source: 'system',
    type: 'failover.triggered',
    payload: { parent_run_id: run.run_id, playbook_id: playbook.playbook_id, provider: candidate.provider },
  });

  if (playbook.strategy.attachContextPack && child.project_id) {
    try {
      await compileContextPack({
        projectId: child.project_id,
        runId: child.run_id,
        goal: run.title ?? run.error_summary ?? 'Continue the failed run',
      });
    } catch (error) {
      warning = warning ?? `Context pack was unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  await startCandidate(child, prompt);
  return {
    status: 'started',
    playbook,
    parentRunId: run.run_id,
    childRunId: child.run_id,
    candidate,
    handoffPrompt,
    ...(warning ? { warning } : {}),
  };
}

export const failoverService = {
  create(input: CreateFailoverPlaybookInput): FailoverPlaybook {
    const normalized = normalizeInput(input);
    if (normalized.projectId && !projectsDb.getProjectById(normalized.projectId)) {
      throw new CloudError('PLAYBOOK_NO_CANDIDATE', `Project not found: ${normalized.projectId}`);
    }
    return failoverDb.create(normalized);
  },
  get(playbookId: string): FailoverPlaybook | null { return failoverDb.get(playbookId); },
  list(projectId?: string): FailoverPlaybook[] { return failoverDb.list(projectId); },
  update(playbookId: string, patch: UpdateFailoverPlaybookInput): FailoverPlaybook {
    const current = failoverDb.get(playbookId);
    if (!current) throw new CloudError('PLAYBOOK_NO_CANDIDATE', `Playbook not found: ${playbookId}`);
    const normalized = normalizeInput({
      name: patch.name ?? current.name,
      projectId: patch.projectId !== undefined ? patch.projectId : current.project_id,
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      match: patch.match ?? current.match,
      strategy: patch.strategy ?? current.strategy,
      approval: patch.approval ?? current.approval,
    });
    return failoverDb.update(playbookId, normalized)!;
  },
  delete(playbookId: string): boolean { return failoverDb.delete(playbookId); },
  async trigger(runId: string, options: FailoverTriggerOptions = {}): Promise<FailoverResult> {
    const run = requireRun(runId);
    const candidates = options.playbookId
      ? [failoverDb.get(options.playbookId)].filter((playbook): playbook is FailoverPlaybook => Boolean(playbook))
      : failoverDb.list(run.project_id ?? undefined);
    const playbook = candidates.find((candidate) => matches(candidate, run));
    if (!playbook) throw new CloudError('PLAYBOOK_NO_CANDIDATE', `No failover playbook matches run ${runId}`);
    if (failoverCount(run) >= playbook.strategy.maxFailovers) {
      throw new CloudError('PLAYBOOK_NO_CANDIDATE', `Failover limit reached for run ${runId}`);
    }
    const candidate = chooseCandidate(run, playbook);
    if (playbook.approval === 'interrupt' && !options.approved) {
      const interrupt = interruptsService.create({
        projectId: run.project_id,
        kind: 'approval_pending',
        severity: 'critical',
        title: `Approve provider failover for ${run.title ?? run.run_id}`,
        body: `${run.provider ?? 'Current provider'} failed: ${run.error_summary ?? 'unknown failure'}. Continue with ${candidate.provider}?`,
        runId: run.run_id,
        actions: [
          { id: 'approve_failover', label: `Continue with ${candidate.provider}`, style: 'primary' },
          { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
        ],
        meta: { playbookId: playbook.playbook_id, candidate, failureClass: classifyFailure(run.error_summary, run.provider) },
        dedupeKey: `failover:${run.run_id}:${playbook.playbook_id}`,
      });
      return { status: 'approval_pending', playbook, parentRunId: run.run_id, interruptId: interrupt.interrupt_id, candidate };
    }
    return executeFailover(run, playbook);
  },
};

export function configureFailoverApprovalResolver(): void {
  interruptsService.configureFailoverResolver((runId, playbookId) => {
    void failoverService.trigger(runId, { playbookId: playbookId ?? undefined, approved: true }).catch((error) => {
      console.error('[Failover] approved handoff failed:', error instanceof Error ? error.message : error);
    });
  });
}
