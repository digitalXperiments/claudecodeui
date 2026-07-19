import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { DETACHED_CONNECTION, startProviderRun, type ProviderSpawnFn } from '@/modules/websocket/index.js';
import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import { isKanbanProvider, type KanbanRunTrigger, type KanbanTask } from '@/modules/kanban/kanban.types.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Provider runtimes, injected once at server boot from the same `spawnFns` map
 * the websocket server uses. The runner stays decoupled from index.js wiring.
 */
let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

export function configureKanbanRuntimes(spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>): void {
  runtimeSpawnFns = spawnFns;
}

/**
 * Translate a task's stored permissions into the exact runtime option shape each
 * provider expects. The task stores a provider-agnostic allow/deny pair
 * (`tools.allowedCommands` / `tools.disallowedCommands`) plus a `permission_mode`;
 * this maps them onto the per-runtime contract:
 *
 * - claude / cursor: `toolsSettings.{allowedTools,disallowedTools,skipPermissions}`
 * - grok:            `toolsSettings.{allowedCommands,disallowedCommands}`
 * - codex/agy/kimi/opencode: `permissionMode` only
 *
 * Permissions are the safety boundary: `permission_mode` is passed verbatim and
 * bypass is only enabled when the task explicitly selected `bypassPermissions`.
 */
function buildRuntimeOptions(task: KanbanTask, provider: LLMProvider): AnyRecord {
  const permissionMode = task.permission_mode || 'default';
  const allowed = Array.isArray(task.tools?.allowedCommands) ? task.tools!.allowedCommands! : [];
  const disallowed = Array.isArray(task.tools?.disallowedCommands)
    ? task.tools!.disallowedCommands!
    : [];
  const options: AnyRecord = { permissionMode };

  switch (provider) {
    case 'claude':
    case 'cursor':
      options.toolsSettings = {
        allowedTools: allowed,
        disallowedTools: disallowed,
        skipPermissions: permissionMode === 'bypassPermissions',
      };
      break;
    case 'grok':
      options.toolsSettings = {
        allowedCommands: allowed,
        disallowedCommands: disallowed,
      };
      break;
    // codex, agy, kimi, opencode take only permissionMode.
    default:
      break;
  }
  return options;
}

export type RunTaskResult = {
  runId: string;
  appSessionId: string;
  provider: LLMProvider;
};

export const kanbanRunner = {
  /**
   * Execute a task: resolve (or create) its app session, record a `kanban_runs`
   * row, flip the task to `running`, and dispatch through the shared provider
   * run starter. Manual and automated runs share this one path.
   */
  async runTask(taskId: string, trigger: KanbanRunTrigger): Promise<RunTaskResult> {
    const task = kanbanDb.getTask(taskId);
    if (!task) {
      throw new AppError('Task not found', { code: 'KANBAN_TASK_NOT_FOUND', statusCode: 404 });
    }

    const provider = task.assignee_provider;
    if (!provider) {
      throw new AppError('Task has no assigned agent', {
        code: 'KANBAN_NO_ASSIGNEE',
        statusCode: 400,
      });
    }
    if (!isKanbanProvider(provider)) {
      throw new AppError(`Task has an invalid assigned agent: ${provider}`, {
        code: 'KANBAN_INVALID_PROVIDER',
        statusCode: 400,
      });
    }

    const spawnFn = runtimeSpawnFns[provider];
    if (!spawnFn) {
      throw new AppError(`Provider "${provider}" runtime is not available`, {
        code: 'KANBAN_RUNTIME_UNAVAILABLE',
        statusCode: 400,
      });
    }

    if (task.status === 'running') {
      throw new AppError('Task is already running', {
        code: 'KANBAN_ALREADY_RUNNING',
        statusCode: 409,
      });
    }

    const projectPath = projectsDb.getProjectPathById(task.project_id);
    if (!projectPath) {
      throw new AppError('Project path not found for task', {
        code: 'KANBAN_PROJECT_PATH_MISSING',
        statusCode: 400,
      });
    }

    // Reuse the task's existing session if present, otherwise mint one.
    let appSessionId = task.app_session_id;
    let session = appSessionId ? sessionsDb.getSessionById(appSessionId) : null;
    if (!session) {
      const created = sessionsService.createAppSession(provider, projectPath);
      appSessionId = created.sessionId;
      kanbanDb.setTaskSession(task.task_id, appSessionId);
      session = sessionsDb.getSessionById(appSessionId);
    }

    const resolvedSessionId = appSessionId as string;
    const run = kanbanDb.createRun({
      taskId: task.task_id,
      appSessionId: resolvedSessionId,
      provider,
      trigger,
    });
    kanbanDb.setTaskStatus(task.task_id, 'running');

    const result = startProviderRun({
      appSessionId: resolvedSessionId,
      provider,
      providerSessionId: session?.provider_session_id ?? null,
      projectPath,
      spawnFn,
      content: task.prompt || task.title,
      options: buildRuntimeOptions(task, provider),
      connection: DETACHED_CONNECTION,
      userId: null,
    });

    if (!result.ok) {
      // Another run already holds this session; roll back our bookkeeping.
      kanbanDb.finishRun(run.run_id, 'failed', null);
      kanbanDb.setTaskStatus(task.task_id, task.status);
      throw new AppError('A run is already in progress for this task session', {
        code: 'KANBAN_RUN_IN_PROGRESS',
        statusCode: 409,
      });
    }

    return { runId: run.run_id, appSessionId: resolvedSessionId, provider };
  },
};
