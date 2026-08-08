import { Cron } from 'croner';

import { automationDb } from '@/modules/automation/automation.repository.js';
import type {
  AutomationAction,
  AutomationCondition,
  AutomationRecipe,
  AutomationTrigger,
  CreateAutomationRecipeInput,
  AutomationRun,
  WorkflowGraph,
  WorkflowStep,
  WorkflowStepState,
} from '@/modules/automation/automation.types.js';
import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { kanbanDb } from '@/modules/kanban/index.js';
import { enqueueTask } from '@/modules/kanban/index.js';
import { projectsDb, systemNotificationsDb } from '@/modules/database/index.js';
import { runService, redactPayload } from '@/modules/runs/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { CloudError } from '@/shared/run-events.js';

type FireInput = {
  type: AutomationTrigger['type'];
  event?: string;
  projectId?: string | null;
  payload?: Record<string, unknown>;
  recipeId?: string;
};

export type AutomationFireResult = {
  recipe: AutomationRecipe;
  automationRun: AutomationRun;
  actionResults: Array<Record<string, unknown>>;
};

const TRIGGER_TYPES: readonly AutomationTrigger['type'][] = [
  'cron',
  'webhook_inbound',
  'kanban_event',
  'run_completed',
  'interrupt_created',
  'manual',
];
const ACTION_TYPES: readonly AutomationAction['type'][] = [
  'start_agent_run',
  'enqueue_kanban_task',
  'http_webhook_out',
  'notify',
  'create_interrupt',
  'noop',
  'emit_event',
];
const STEP_KINDS = new Set(['action', 'parallel', 'branch']);

function getPath(payload: Record<string, unknown>, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>(
    (current, key) =>
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined,
    payload,
  );
}

function conditionsPass(conditions: AutomationCondition[], payload: Record<string, unknown>): boolean {
  return conditions.every((condition) => {
    const value = getPath(payload, condition.path);
    if (condition.exists !== undefined && (value !== undefined) !== condition.exists) return false;
    if (condition.equals !== undefined && JSON.stringify(value) !== JSON.stringify(condition.equals))
      return false;
    if (
      condition.notEquals !== undefined &&
      JSON.stringify(value) === JSON.stringify(condition.notEquals)
    )
      return false;
    if (
      condition.contains !== undefined &&
      (typeof value !== 'string' || !value.includes(condition.contains))
    )
      return false;
    return true;
  });
}

function validateTrigger(trigger: AutomationTrigger): void {
  if (!trigger || !TRIGGER_TYPES.includes(trigger.type))
    throw new CloudError(
      'AUTOMATION_TIMEOUT',
      `Unsupported automation trigger: ${String(trigger?.type)}`,
    );
  if (trigger.type === 'cron' && !trigger.cron?.trim())
    throw new CloudError('AUTOMATION_TIMEOUT', 'cron trigger requires a cron expression');
}

function validateAction(action: AutomationAction): void {
  if (!ACTION_TYPES.includes(action.type))
    throw new CloudError(
      'AUTOMATION_TIMEOUT',
      `Unsupported automation action: ${String(action.type)}`,
    );
  if (action.type === 'http_webhook_out' && (!action.url || !/^https?:\/\//i.test(action.url)))
    throw new CloudError('AUTOMATION_TIMEOUT', 'http_webhook_out requires an http(s) URL');
}

/** Cycle detection on dependsOn + next edges (and parallel children as soft deps). */
export function validateWorkflowGraph(graph: WorkflowGraph): void {
  if (!graph || graph.version !== 1)
    throw new CloudError('AUTOMATION_TIMEOUT', 'graph.version must be 1');
  if (!graph.entry?.trim()) throw new CloudError('AUTOMATION_TIMEOUT', 'graph.entry is required');
  if (!Array.isArray(graph.steps) || graph.steps.length === 0)
    throw new CloudError('AUTOMATION_TIMEOUT', 'graph.steps must be a non-empty array');

  const ids = new Set<string>();
  for (const step of graph.steps) {
    if (!step.id?.trim()) throw new CloudError('AUTOMATION_TIMEOUT', 'Each step requires an id');
    if (ids.has(step.id))
      throw new CloudError('AUTOMATION_TIMEOUT', `Duplicate workflow step id: ${step.id}`);
    ids.add(step.id);
    if (!STEP_KINDS.has(step.kind))
      throw new CloudError('AUTOMATION_TIMEOUT', `Unsupported step kind: ${String(step.kind)}`);
    if (step.kind === 'action' && step.action) validateAction(step.action);
    if (step.kind === 'action' && !step.action)
      throw new CloudError('AUTOMATION_TIMEOUT', `Action step ${step.id} requires action`);
    if (step.kind === 'parallel' && (!Array.isArray(step.parallel) || step.parallel.length === 0))
      throw new CloudError(
        'AUTOMATION_TIMEOUT',
        `Parallel step ${step.id} requires parallel child ids`,
      );
  }
  if (!ids.has(graph.entry))
    throw new CloudError('AUTOMATION_TIMEOUT', `graph.entry not found: ${graph.entry}`);

  const ensureRef = (ref: string, context: string) => {
    if (!ids.has(ref))
      throw new CloudError('AUTOMATION_TIMEOUT', `Unknown step id "${ref}" referenced by ${context}`);
  };

  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);

  for (const step of graph.steps) {
    for (const dep of step.dependsOn ?? []) {
      ensureRef(dep, `${step.id}.dependsOn`);
      adj.get(dep)!.push(step.id);
    }
    if (step.next) {
      ensureRef(step.next, `${step.id}.next`);
      adj.get(step.id)!.push(step.next);
    }
    for (const child of step.parallel ?? []) {
      ensureRef(child, `${step.id}.parallel`);
      adj.get(step.id)!.push(child);
    }
    for (const branch of step.branch ?? []) {
      ensureRef(branch.next, `${step.id}.branch`);
      adj.get(step.id)!.push(branch.next);
    }
  }

  // DFS cycle detection
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node))
      throw new CloudError('AUTOMATION_CYCLE', `Workflow graph has a cycle involving step ${node}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adj.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const id of ids) visit(id);
}

function validateRecipeInput(input: CreateAutomationRecipeInput): void {
  if (!input.name.trim()) throw new CloudError('AUTOMATION_TIMEOUT', 'Recipe name is required');
  validateTrigger(input.trigger);
  const actions = input.actions ?? [];
  const graph = input.graph ?? null;
  const hasGraph = Boolean(graph && Array.isArray(graph.steps) && graph.steps.length > 0);
  if (!hasGraph && actions.length === 0)
    throw new CloudError(
      'AUTOMATION_TIMEOUT',
      'Recipe requires at least one action or a workflow graph',
    );
  for (const action of actions) validateAction(action);
  if (hasGraph && graph) validateWorkflowGraph(graph);
  if (
    input.trigger.type === 'kanban_event' &&
    actions.some((action) => action.type === 'emit_event' && action.event === input.trigger.event)
  ) {
    throw new CloudError(
      'AUTOMATION_CYCLE',
      `Recipe re-emits its own kanban event: ${input.trigger.event ?? '(any)'}`,
    );
  }
  const max = input.retry?.max ?? 0;
  if (!Number.isInteger(max) || max < 0 || max > 5)
    throw new CloudError('AUTOMATION_TIMEOUT', 'retry.max must be an integer from 0 to 5');
  if (
    input.timeoutMs !== undefined &&
    input.timeoutMs !== null &&
    (!Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < 1000 ||
      input.timeoutMs > 30 * 60 * 1000)
  )
    throw new CloudError('AUTOMATION_TIMEOUT', 'timeoutMs must be between 1000 and 1800000');
}

function interpolate(value: unknown, payload: Record<string, unknown>): unknown {
  if (typeof value === 'string')
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) =>
      String(getPath(payload, key.trim()) ?? ''),
    );
  if (Array.isArray(value)) return value.map((item) => interpolate(item, payload));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolate(entry, payload)]),
    );
  return value;
}

async function executeAction(
  recipe: AutomationRecipe,
  action: AutomationAction,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const projectId =
    recipe.project_id ?? (typeof payload.projectId === 'string' ? payload.projectId : null);
  switch (action.type) {
    case 'start_agent_run': {
      const run = runService.create({
        source: 'automation',
        projectId,
        sourceRef: recipe.recipe_id,
        provider: action.provider ?? null,
        model: action.model ?? null,
        title: action.title ?? recipe.name,
        trigger: `recipe:${recipe.recipe_id}`,
        meta: {
          prompt: action.prompt ?? '',
          payload: redactPayload(payload),
        } as Record<string, unknown>,
      });
      return { action: action.type, runId: run.run_id };
    }
    case 'enqueue_kanban_task': {
      const taskId =
        action.taskId ?? (typeof payload.taskId === 'string' ? payload.taskId : '');
      if (!taskId || !kanbanDb.getTask(taskId))
        throw new CloudError('AUTOMATION_TIMEOUT', `Kanban task not found: ${taskId}`);
      enqueueTask(taskId, 'manual');
      return { action: action.type, taskId, status: kanbanDb.getTask(taskId)?.status ?? null };
    }
    case 'http_webhook_out': {
      const url = String(interpolate(action.url, payload));
      if (!/^https?:\/\//i.test(url))
        throw new CloudError('AUTOMATION_TIMEOUT', 'Only http(s) webhook URLs are allowed');
      const headers = secretsService.resolveInObject(
        interpolate(action.headers ?? {}, payload) as Record<string, string>,
        { projectId: projectId ?? undefined },
      );
      const body = secretsService.resolveInObject(
        interpolate(action.body ?? payload, payload),
        { projectId: projectId ?? undefined },
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), recipe.timeout_ms ?? 30_000);
      try {
        const response = await fetch(url, {
          method: action.method ?? 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok)
          throw new CloudError('AUTOMATION_TIMEOUT', `Webhook returned HTTP ${response.status}`);
        return { action: action.type, status: response.status };
      } finally {
        clearTimeout(timer);
      }
    }
    case 'notify': {
      const notification = systemNotificationsDb.create({
        kind: 'info',
        severity: action.severity ?? 'info',
        title: String(interpolate(action.name ?? recipe.name, payload)),
        body: String(interpolate(action.message ?? '', payload)),
        source: 'automation',
        meta: { recipeId: recipe.recipe_id },
        dedupeKey: `automation:${recipe.recipe_id}:${action.name ?? 'notify'}`,
      });
      return { action: action.type, notificationId: notification.notification_id };
    }
    case 'create_interrupt': {
      const interrupt = interruptsService.create({
        projectId,
        kind: action.kind ?? 'approval_pending',
        severity: action.severity ?? 'warning',
        title: String(interpolate(action.name ?? recipe.name, payload)),
        body: String(interpolate(action.message ?? '', payload)),
        runId: typeof payload.runId === 'string' ? payload.runId : null,
        taskId: typeof payload.taskId === 'string' ? payload.taskId : null,
        actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
        dedupeKey: `automation:${recipe.recipe_id}:${action.name ?? 'interrupt'}`,
      });
      return { action: action.type, interruptId: interrupt.interrupt_id };
    }
    case 'emit_event':
      return {
        action: action.type,
        event: action.event ?? null,
        emitted: false,
        message: 'Event emission is recorded but not recursively re-fired in v1.',
      };
    case 'noop':
      return { action: action.type, ok: true };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function hasUsableGraph(recipe: AutomationRecipe): recipe is AutomationRecipe & { graph: WorkflowGraph } {
  return Boolean(recipe.graph && recipe.graph.steps?.length);
}

async function executeGraph(
  recipe: AutomationRecipe & { graph: WorkflowGraph },
  payload: Record<string, unknown>,
  automationRunId: string,
  agentRunId: string | null,
): Promise<Array<Record<string, unknown>>> {
  const stepsById = new Map(recipe.graph.steps.map((step) => [step.id, step]));
  const stepStates: Record<string, WorkflowStepState> = {};
  for (const step of recipe.graph.steps) {
    stepStates[step.id] = { status: 'pending' };
  }
  automationDb.setStepStates(automationRunId, stepStates);

  const actionResults: Array<Record<string, unknown>> = [];
  const outputs: Record<string, unknown> = { ...payload, priorOutputs: {} as Record<string, unknown> };

  const persist = () => automationDb.setStepStates(automationRunId, { ...stepStates });

  const emitSpine = (type: string, step: WorkflowStep, extra: Record<string, unknown> = {}) => {
    if (!agentRunId) return;
    try {
      runService.appendEvent(agentRunId, {
        run_id: agentRunId,
        ts: nowIso(),
        source: 'automation',
        type,
        payload: redactPayload({
          automationRunId,
          recipeId: recipe.recipe_id,
          stepId: step.id,
          stepName: step.name,
          ...extra,
        }) as Record<string, unknown>,
      });
    } catch {
      // spine optional
    }
  };

  const depsSucceeded = (step: WorkflowStep): boolean => {
    const deps = step.dependsOn ?? [];
    if (deps.length === 0) return true;
    return deps.every((dep) => stepStates[dep]?.status === 'succeeded');
  };

  const runStep = async (stepId: string): Promise<void> => {
    const step = stepsById.get(stepId);
    if (!step) throw new CloudError('AUTOMATION_TIMEOUT', `Unknown step: ${stepId}`);
    if (stepStates[stepId]?.status === 'succeeded' || stepStates[stepId]?.status === 'running')
      return;

    stepStates[stepId] = { status: 'running', startedAt: nowIso() };
    persist();
    emitSpine('run.status', step, { stepStatus: 'running' });

    try {
      let result: Record<string, unknown> = { stepId, kind: step.kind };

      if (step.kind === 'action' && step.action) {
        const max = step.retry?.max ?? 0;
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= max; attempt += 1) {
          try {
            result = {
              stepId,
              kind: 'action',
              ...(await executeAction(recipe, step.action, outputs)),
            };
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < max) {
              const delay = Math.min((step.retry?.backoffMs ?? 500) * 2 ** attempt, 10_000);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        }
        if (lastError) throw lastError;
        actionResults.push(result);
      } else if (step.kind === 'parallel' && step.parallel) {
        await Promise.all(step.parallel.map((childId) => runStep(childId)));
        result = { stepId, kind: 'parallel', children: step.parallel };
      } else if (step.kind === 'branch' && step.branch) {
        let chosen: string | null = step.next ?? null;
        for (const arm of step.branch) {
          if (conditionsPass(arm.when ?? [], outputs)) {
            chosen = arm.next;
            break;
          }
        }
        result = { stepId, kind: 'branch', next: chosen };
        stepStates[stepId] = {
          status: 'succeeded',
          startedAt: stepStates[stepId].startedAt,
          finishedAt: nowIso(),
          result,
        };
        (outputs.priorOutputs as Record<string, unknown>)[stepId] = result;
        persist();
        emitSpine('run.status', step, { stepStatus: 'succeeded', result });
        if (chosen) await runStep(chosen);
        return;
      } else {
        result = { stepId, kind: step.kind, ok: true };
      }

      stepStates[stepId] = {
        status: 'succeeded',
        startedAt: stepStates[stepId].startedAt,
        finishedAt: nowIso(),
        result,
      };
      (outputs.priorOutputs as Record<string, unknown>)[stepId] = result;
      persist();
      emitSpine('run.status', step, { stepStatus: 'succeeded', result });

      if (step.next) await runStep(step.next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stepStates[stepId] = {
        status: 'failed',
        startedAt: stepStates[stepId].startedAt,
        finishedAt: nowIso(),
        error: secretsService.redact(message),
      };
      persist();
      emitSpine('run.status', step, { stepStatus: 'failed', error: message });
      throw error;
    }
  };

  // Seed ready steps: entry always; others with no deps that are on the entry path
  // will be reached via next/parallel/branch. Also run any orphan root deps in topo waves.
  await runStep(recipe.graph.entry);

  // Process remaining DAG roots that only use dependsOn (no next chain from entry)
  let progress = true;
  while (progress) {
    progress = false;
    for (const step of recipe.graph.steps) {
      if (stepStates[step.id]?.status !== 'pending') continue;
      if (!depsSucceeded(step)) continue;
      // Only auto-start steps that declare dependsOn (pure DAG mode) or are entry
      if ((step.dependsOn?.length ?? 0) === 0 && step.id !== recipe.graph.entry) continue;
      progress = true;
      await runStep(step.id);
    }
  }

  return actionResults;
}

async function executeRecipe(
  recipe: AutomationRecipe,
  input: FireInput,
): Promise<AutomationFireResult> {
  const inputPayload = input.payload ?? {};
  const payload = {
    ...inputPayload,
    payload: inputPayload,
    projectId: input.projectId ?? recipe.project_id ?? undefined,
    trigger: input.type,
    event: input.event,
  };
  const automationRun = automationDb.createRun(
    recipe.recipe_id,
    redactPayload(payload) as Record<string, unknown>,
  );

  // Optional parent spine run for graph observability
  let agentRunId: string | null = null;
  if (hasUsableGraph(recipe)) {
    try {
      const spine = runService.create({
        source: 'automation',
        projectId: recipe.project_id,
        sourceRef: recipe.recipe_id,
        title: `Automation: ${recipe.name}`,
        trigger: `recipe:${recipe.recipe_id}`,
        status: 'running',
        meta: {
          automationRunId: automationRun.automation_run_id,
          graph: true,
        },
      });
      agentRunId = spine.run_id;
    } catch {
      agentRunId = null;
    }
  }

  let actionResults: Array<Record<string, unknown>> = [];
  const attempts = Math.max(0, recipe.retry.max) + 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    automationDb.setRunAttempt(automationRun.automation_run_id, attempt);
    try {
      if (hasUsableGraph(recipe)) {
        actionResults = await executeGraph(
          recipe,
          payload,
          automationRun.automation_run_id,
          agentRunId,
        );
      } else {
        const attemptResults: Array<Record<string, unknown>> = [];
        for (const action of recipe.actions)
          attemptResults.push(await executeAction(recipe, action, payload));
        actionResults = attemptResults;
      }
      const linkedRunId =
        (actionResults.find((result) => typeof result.runId === 'string')?.runId as
          | string
          | undefined) ?? agentRunId ?? undefined;
      automationDb.setRunStatus(
        automationRun.automation_run_id,
        'succeeded',
        null,
        linkedRunId,
      );
      if (agentRunId) {
        try {
          runService.markTerminal(agentRunId, { status: 'succeeded' });
        } catch {
          /* optional */
        }
      }
      return {
        recipe,
        automationRun: automationDb.getRun(automationRun.automation_run_id)!,
        actionResults,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = Math.min((recipe.retry.backoffMs ?? 1000) * 2 ** (attempt - 1), 10_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  automationDb.setRunStatus(
    automationRun.automation_run_id,
    'failed',
    secretsService.redact(message),
  );
  if (agentRunId) {
    try {
      runService.markTerminal(agentRunId, {
        status: 'failed',
        errorSummary: secretsService.redact(message),
      });
    } catch {
      /* optional */
    }
  }
  throw lastError;
}

const jobs = new Map<string, Cron>();
let schedulerStarted = false;

export const automationService = {
  create(input: CreateAutomationRecipeInput): AutomationRecipe {
    validateRecipeInput(input);
    if (input.projectId && !projectsDb.getProjectById(input.projectId))
      throw new CloudError('AUTOMATION_TIMEOUT', `Project not found: ${input.projectId}`);
    return automationDb.create({
      name: input.name.trim(),
      enabled: input.enabled !== false,
      projectId: input.projectId ?? null,
      trigger: input.trigger,
      conditions: input.conditions ?? [],
      actions: input.actions ?? [],
      graph: input.graph ?? null,
      retry: { max: input.retry?.max ?? 0, backoffMs: input.retry?.backoffMs },
      timeoutMs: input.timeoutMs ?? null,
    });
  },
  get(recipeId: string): AutomationRecipe | null {
    return automationDb.get(recipeId);
  },
  list(projectId?: string): AutomationRecipe[] {
    return automationDb.list(projectId);
  },
  listRuns(recipeId: string, limit = 50): AutomationRun[] {
    return automationDb.listRuns(recipeId, limit);
  },
  update(recipeId: string, patch: Partial<CreateAutomationRecipeInput>): AutomationRecipe {
    const current = automationDb.get(recipeId);
    if (!current) throw new CloudError('AUTOMATION_TIMEOUT', `Recipe not found: ${recipeId}`);
    const next: CreateAutomationRecipeInput = {
      name: patch.name ?? current.name,
      trigger: patch.trigger ?? current.trigger,
      actions: patch.actions ?? current.actions,
      conditions: patch.conditions ?? current.conditions,
      graph: patch.graph !== undefined ? patch.graph : current.graph,
      retry: patch.retry ?? current.retry,
      timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeout_ms,
      projectId: patch.projectId !== undefined ? patch.projectId : current.project_id,
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    };
    validateRecipeInput(next);
    const updated = automationDb.update(recipeId, {
      name: next.name,
      trigger: next.trigger,
      actions: next.actions ?? [],
      conditions: next.conditions ?? [],
      graph: next.graph ?? null,
      retry: { max: next.retry?.max ?? 0, backoffMs: next.retry?.backoffMs },
      timeoutMs: next.timeoutMs ?? null,
      projectId: next.projectId ?? null,
      enabled: next.enabled,
    });
    syncSchedules();
    return updated!;
  },
  delete(recipeId: string): boolean {
    const deleted = automationDb.delete(recipeId);
    syncSchedules();
    return deleted;
  },
  async fire(input: FireInput): Promise<AutomationFireResult[]> {
    const recipes = input.recipeId
      ? [automationDb.get(input.recipeId)].filter((recipe): recipe is AutomationRecipe =>
          Boolean(recipe),
        )
      : automationDb.list(input.projectId ?? undefined);
    const results: AutomationFireResult[] = [];
    for (const recipe of recipes) {
      if (!recipe.enabled || recipe.trigger.type !== input.type) continue;
      if (recipe.project_id && input.projectId && recipe.project_id !== input.projectId) continue;
      if (recipe.trigger.event && recipe.trigger.event !== input.event) continue;
      const inputPayload = input.payload ?? {};
      const effectiveProjectId = input.projectId ?? recipe.project_id ?? undefined;
      const payload = {
        ...inputPayload,
        payload: inputPayload,
        projectId: effectiveProjectId,
        trigger: input.type,
        event: input.event,
      };
      if (!conditionsPass(recipe.conditions, payload)) continue;
      try {
        results.push(await executeRecipe(recipe, { ...input, projectId: effectiveProjectId }));
      } catch (error) {
        console.error('[Automation] recipe failed', {
          recipeId: recipe.recipe_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  },
  syncSchedules(): void {
    syncSchedules();
  },
};

export function syncSchedules(): void {
  if (!schedulerStarted) return;
  const scheduled = automationDb
    .list()
    .filter((recipe) => recipe.enabled && recipe.trigger.type === 'cron' && recipe.trigger.cron);
  const wanted = new Set(scheduled.map((recipe) => recipe.recipe_id));
  for (const [recipeId, job] of jobs) {
    if (!wanted.has(recipeId)) {
      job.stop();
      jobs.delete(recipeId);
    }
  }
  for (const recipe of scheduled) {
    const existing = jobs.get(recipe.recipe_id);
    if (existing && existing.getPattern() === recipe.trigger.cron) continue;
    existing?.stop();
    try {
      jobs.set(
        recipe.recipe_id,
        new Cron(recipe.trigger.cron!, () => {
          void automationService.fire({
            type: 'cron',
            projectId: recipe.project_id,
            recipeId: recipe.recipe_id,
            payload: { scheduledAt: new Date().toISOString() },
          });
        }),
      );
    } catch (error) {
      console.error('[Automation] invalid recipe cron', {
        recipeId: recipe.recipe_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startAutomationKernel(): void {
  schedulerStarted = true;
  syncSchedules();
}
export function stopAutomationKernel(): void {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  schedulerStarted = false;
}
