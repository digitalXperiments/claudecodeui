import { agentRunProfilesDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { AgentRunProfile } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { DETACHED_CONNECTION, startProviderRun, type ProviderSpawnFn } from '@/modules/websocket/index.js';
import { kanbanDb } from '@/modules/kanban/kanban.repository.js';
import { ensureFeatureBranch } from '@/modules/kanban/git-branch.service.js';
import { runService } from '@/modules/runs/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import type { AgentWorkspace } from '@/modules/workspaces/index.js';
import {
  COLUMN_REVIEW,
  isKanbanProvider,
  type KanbanRunRole,
  type KanbanRunTrigger,
  type KanbanTask,
  type KanbanTaskTools,
} from '@/modules/kanban/kanban.types.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';
import { expandMcpSelectionsToTools, mergeToolAllowLists } from '@/shared/mcp-tool-expand.js';
import { AppError } from '@/shared/utils.js';

/**
 * Provider runtimes, injected once at server boot from the same `spawnFns` map
 * the websocket server uses. The runner stays decoupled from index.js wiring.
 */
let runtimeSpawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>> = {};

/** P1 defaults on, with an explicit escape hatch for legacy installations. */
export function areKanbanWorkspacesEnabled(): boolean {
  return process.env.CLOUDCLI_WORKSPACES !== '0' && process.env.FEATURE_WORKSPACES !== '0';
}

function slugifyTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

function defaultTaskBranch(task: KanbanTask): string {
  return `feat/${task.task_id}-${slugifyTitle(task.title)}`;
}

export function configureKanbanRuntimes(spawnFns: Partial<Record<LLMProvider, ProviderSpawnFn>>): void {
  runtimeSpawnFns = spawnFns;
}

/** Look up a configured spawn fn (used by headless helpers like task-field generation). */
export function getKanbanSpawnFn(provider: LLMProvider): ProviderSpawnFn | undefined {
  return runtimeSpawnFns[provider];
}

/**
 * Translate a task's stored permissions into the exact runtime option shape each
 * provider expects. The task stores a provider-agnostic allow/deny pair
 * (`tools.allowedCommands` / `tools.disallowedCommands`) plus a `permission_mode`;
 * this maps them onto the per-runtime contract:
 *
 * - claude / cursor: `toolsSettings.{allowedTools,disallowedTools,skipPermissions}`
 * - grok:            `toolsSettings.{allowedCommands,disallowedCommands}`
 * - codex/kimi/opencode:     `permissionMode` only
 *
 * Permissions are the safety boundary: `permission_mode` is passed verbatim and
 * bypass is only enabled when the task explicitly selected `bypassPermissions`.
 */
/**
 * Resolve the live agent run profile for a role, if the task references one.
 * Missing profiles fall through so legacy provider-only assignment still works.
 */
export function resolveProfileForRole(
  task: KanbanTask,
  role: KanbanRunRole,
): AgentRunProfile | null {
  const profileId = role === 'review' ? task.review_profile_id : task.implement_profile_id;
  if (!profileId) {
    return null;
  }
  return agentRunProfilesDb.get(profileId);
}

/**
 * Effective tools/permissions for a run: profile wins when present (live-link),
 * otherwise the task's own permission_mode + tools. Task-level MCP server
 * selections are always merged in so card steering is not lost under a profile.
 */
function resolvePermissionSource(
  task: KanbanTask,
  profile: AgentRunProfile | null,
  provider: LLMProvider,
): { permissionMode: string; tools: KanbanTaskTools } {
  const taskTools = task.tools ?? {};
  const base: KanbanTaskTools = profile
    ? { ...(profile.tools ?? {}) }
    : { ...taskTools };

  const mcpServers = Array.isArray(taskTools.mcpServers)
    ? taskTools.mcpServers
    : Array.isArray(base.mcpServers)
      ? base.mcpServers
      : [];
  const skills = Array.isArray(taskTools.skills)
    ? taskTools.skills
    : Array.isArray(base.skills)
      ? base.skills
      : [];

  const expandedMcp = expandMcpSelectionsToTools(mcpServers, provider);
  const allowedCommands = mergeToolAllowLists(base.allowedCommands, expandedMcp);

  return {
    permissionMode: profile
      ? profile.permission_mode || 'default'
      : task.permission_mode || 'default',
    tools: {
      ...base,
      mcpServers,
      skills,
      ...(allowedCommands.length > 0 ? { allowedCommands } : {}),
    },
  };
}

/** @internal Exported for unit tests. */
export function resolveEffectiveToolsForRun(
  task: KanbanTask,
  provider: LLMProvider,
  profile: AgentRunProfile | null = null,
): KanbanTaskTools {
  return resolvePermissionSource(task, profile, provider).tools;
}

function buildRuntimeOptions(
  task: KanbanTask,
  provider: LLMProvider,
  profile: AgentRunProfile | null,
): AnyRecord {
  const { permissionMode, tools } = resolvePermissionSource(task, profile, provider);
  const allowed = Array.isArray(tools?.allowedCommands) ? tools.allowedCommands! : [];
  const disallowed = Array.isArray(tools?.disallowedCommands) ? tools.disallowedCommands! : [];
  const mcpServerNames = Array.isArray(tools?.mcpServers) ? tools.mcpServers! : [];
  // Kanban tasks always run detached (no websocket/human on the other end) —
  // see startProviderRun's DETACHED_CONNECTION below. Providers use this to
  // fail fast on an interactive permission prompt instead of hanging forever.
  const options: AnyRecord = { permissionMode, unattended: true };

  if (mcpServerNames.length > 0) {
    options.mcpServers = mcpServerNames;
  }
  if (profile?.model) {
    options.model = profile.model;
  }
  if (profile?.effort && profile.effort !== 'default') {
    options.effort = profile.effort;
  }

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
    // codex, kimi, opencode take only permissionMode (+ model/effort above).
    default:
      break;
  }
  return options;
}

/**
 * Resolve which agent role a run should use from the trigger + current column.
 * Review triggers / review column always use the review agent; everything else
 * uses the implementation agent.
 */
export function resolveRunRole(task: KanbanTask, trigger: KanbanRunTrigger): KanbanRunRole {
  if (trigger === 'review' || task.column_id === COLUMN_REVIEW) {
    return 'review';
  }
  return 'implement';
}

/**
 * Pick the provider for a role. Review falls back to the implementation agent
 * only when no dedicated review agent is set (caller still decides whether to
 * run a review phase at all).
 */
export function resolveProviderForRole(task: KanbanTask, role: KanbanRunRole): LLMProvider | null {
  // Prefer live profile provider when a profile is linked.
  const profile = resolveProfileForRole(task, role);
  if (profile && isKanbanProvider(profile.provider)) {
    return profile.provider;
  }

  if (role === 'review') {
    const review = task.review_provider;
    if (review && isKanbanProvider(review)) {
      return review;
    }
    // No dedicated review agent — cannot run a review phase.
    return null;
  }
  const implement = task.assignee_provider;
  return implement && isKanbanProvider(implement) ? implement : null;
}

/**
 * Build the instruction string handed to the provider. Review runs get a
 * structured brief that includes the original task + implementation prompt and,
 * when available, the tail of the implementation agent's own output, so the
 * review agent can inspect both the work product (git diff, files) and the
 * implementation summary.
 */
/**
 * Build a prompt preamble that steers the agent toward selected project skills
 * and MCP servers (when present on the task).
 */
export function buildTaskSteeringPreamble(task: KanbanTask): string {
  const skills = Array.isArray(task.tools?.skills)
    ? task.tools.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  const mcpServers = Array.isArray(task.tools?.mcpServers)
    ? task.tools.mcpServers.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];

  if (skills.length === 0 && mcpServers.length === 0) {
    return '';
  }

  const parts: string[] = ['## Task steering (required)', ''];
  if (skills.length > 0) {
    parts.push(
      '### Project skills',
      'Apply these project skills before and while working. They define project context, conventions, and what to do / not do:',
      ...skills.map((name) => `- \`${name.trim()}\``),
      'Load each skill (Skill tool / skill file) and follow its guidance.',
      '',
    );
  }
  if (mcpServers.length > 0) {
    parts.push(
      '### Preferred MCP servers',
      'Prefer these MCP integrations for external systems (already allow-listed when the runtime supports it):',
      ...mcpServers.map((name) => `- \`${name.trim()}\``),
      'Do not invent alternate integrations when these cover the need.',
      '',
    );
  }
  return parts.join('\n').trim();
}

export function buildRunPrompt(
  task: KanbanTask,
  role: KanbanRunRole,
  implementOutput?: string | null,
): string {
  const steering = buildTaskSteeringPreamble(task);

  if (role === 'review') {
    const parts = [
      'You are the review agent for a Kanban task whose implementation phase has finished.',
      '',
      '## Task',
      `Title: ${task.title}`,
    ];
    if (task.description?.trim()) {
      parts.push(`Description: ${task.description.trim()}`);
    }
    if (steering) {
      parts.push('', steering);
    }
    parts.push(
      '',
      '## Original implementation instructions',
      (task.prompt || task.title).trim(),
    );
    if (implementOutput?.trim()) {
      parts.push(
        '',
        '## Implementation agent output (tail)',
        implementOutput.trim(),
      );
    }
    parts.push(
      '',
      '## Your job',
      '1. Inspect the current git status and diff in this project.',
      '2. Verify the changes match the task requirements.',
      '3. Call out bugs, missing pieces, or risky changes with file references.',
      '4. If issues are trivial and clearly in scope, fix them; otherwise report what still needs work.',
      '5. End with a clear verdict line: `VERDICT: APPROVED` or `VERDICT: CHANGES REQUESTED`, plus a short summary.',
    );
    return parts.join('\n');
  }

  const body = (task.prompt || task.title).trim();
  if (!steering) {
    return body;
  }
  return `${steering}\n\n---\n\n${body}`;
}

export type RunTaskResult = {
  runId: string;
  appSessionId: string;
  provider: LLMProvider;
  role: KanbanRunRole;
};

export const kanbanRunner = {
  /**
   * Execute a task: resolve (or create) its app session, record a `kanban_runs`
   * row, flip the task to `running`, and dispatch through the shared provider
   * run starter. Manual and automated runs share this one path.
   */
  async runTask(
    taskId: string,
    trigger: KanbanRunTrigger,
    context?: { implementOutput?: string | null },
  ): Promise<RunTaskResult> {
    const task = kanbanDb.getTask(taskId);
    if (!task) {
      throw new AppError('Task not found', { code: 'KANBAN_TASK_NOT_FOUND', statusCode: 404 });
    }

    const role = resolveRunRole(task, trigger);
    const profile = resolveProfileForRole(task, role);
    const provider = resolveProviderForRole(task, role);
    if (!provider) {
      throw new AppError(
        role === 'review'
          ? 'Task has no review agent or profile assigned'
          : 'Task has no implementation agent or profile assigned',
        {
          code: role === 'review' ? 'KANBAN_NO_REVIEW_AGENT' : 'KANBAN_NO_ASSIGNEE',
          statusCode: 400,
        },
      );
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

    // Create the durable run before allocating a workspace so the workspace
    // can point at the canonical run id from its first database row.
    const spineRun = runService.create({
      source: 'kanban',
      projectId: task.project_id,
      sourceRef: task.task_id,
      provider,
      model: profile?.model ?? null,
      effort: profile?.effort ?? null,
      permissionMode: profile?.permission_mode ?? task.permission_mode,
      profileId: profile?.profile_id ?? null,
      title: task.title,
      trigger,
    });

    let workspace: AgentWorkspace | null = null;
    try {
      if (areKanbanWorkspacesEnabled()) {
        // Reviews reuse the implementation workspace so they see the exact
        // files the implementer produced. Retries also reuse an active
        // workspace, preserving uncommitted work for the next attempt.
        // Stale workspace_id rows (deleted dir, wiped DB in tests) fall
        // through to create() rather than failing the whole run.
        const existing = task.workspace_id ? workspaceService.get(task.workspace_id) : null;
        if (existing && (existing.status === 'active' || existing.status === 'error')) {
          try {
            const refreshed = await workspaceService.refreshStatus(existing.workspace_id);
            if (refreshed.status === 'active' || refreshed.status === 'error') {
              workspace = workspaceService.bindRun(existing.workspace_id, spineRun.run_id);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn('[Kanban] failed to reuse workspace; creating a new one', {
              taskId: task.task_id,
              workspaceId: existing.workspace_id,
              error: message,
            });
            workspace = null;
          }
        }

        if (!workspace) {
          workspace = await workspaceService.create({
            projectId: task.project_id,
            projectPath,
            runId: spineRun.run_id,
            taskId: task.task_id,
            branchName: task.feature_branch ?? defaultTaskBranch(task),
          });
          kanbanDb.setTaskWorkspace(task.task_id, workspace.workspace_id);
          if (role === 'implement' && workspace.feature_branch && !task.feature_branch) {
            kanbanDb.updateTask(task.task_id, { featureBranch: workspace.feature_branch });
          }
        } else {
          kanbanDb.setTaskWorkspace(task.task_id, workspace.workspace_id);
        }
        runService.linkWorkspace(spineRun.run_id, workspace.workspace_id);
      } else if (role === 'implement' && !task.feature_branch) {
        // Explicit legacy mode retains the pre-P1 branch behavior for
        // installations that need to opt out while migrating.
        const branch = ensureFeatureBranch(projectPath, task);
        if (branch) {
          kanbanDb.updateTask(task.task_id, { featureBranch: branch });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        runService.markTerminal(spineRun.run_id, { status: 'failed', errorSummary: message });
      } catch {
        // Preserve the original workspace error for the caller.
      }
      throw error;
    }

    // Reuse the task's existing session only when it belongs to the same
    // provider. Switching implement → review (or changing agents) needs a
    // fresh session so we don't resume the wrong CLI/SDK conversation.
    let appSessionId = task.app_session_id;
    let session = appSessionId ? sessionsDb.getSessionById(appSessionId) : null;
    if (!session || session.provider !== provider) {
      const created = sessionsService.createAppSession(provider, projectPath);
      appSessionId = created.sessionId;
      kanbanDb.setTaskSession(task.task_id, appSessionId);
      session = sessionsDb.getSessionById(appSessionId);
    }

    const resolvedSessionId = appSessionId as string;
    runService.linkSession(spineRun.run_id, resolvedSessionId);
    const run = kanbanDb.createRun({
      taskId: task.task_id,
      appSessionId: resolvedSessionId,
      provider,
      trigger,
      role,
      runId: spineRun.run_id,
      agentRunId: spineRun.run_id,
    });
    kanbanDb.setTaskStatus(task.task_id, 'running');

    const runtimeOptions = buildRuntimeOptions(task, provider, profile);
    if (workspace) {
      runtimeOptions.cwd = workspace.root_path;
      runtimeOptions.projectPath = workspace.root_path;
    }
    runService.updateStatus(spineRun.run_id, 'running');

    const result = await startProviderRun({
      appSessionId: resolvedSessionId,
      provider,
      providerSessionId: session?.provider_session_id ?? null,
      projectPath: workspace?.root_path ?? projectPath,
      spawnFn,
      content: buildRunPrompt(task, role, role === 'review' ? context?.implementOutput : null),
      options: runtimeOptions,
      connection: DETACHED_CONNECTION,
      userId: null,
    });

    if (!result.ok) {
      // Another run already holds this session; roll back our bookkeeping.
      kanbanDb.finishRun(run.run_id, 'failed', null);
      kanbanDb.setTaskStatus(task.task_id, task.status);
      runService.markTerminal(spineRun.run_id, {
        status: 'failed',
        errorSummary: 'A run is already in progress for this task session',
      });
      throw new AppError('A run is already in progress for this task session', {
        code: 'KANBAN_RUN_IN_PROGRESS',
        statusCode: 409,
      });
    }

    return { runId: run.run_id, appSessionId: resolvedSessionId, provider, role };
  },
};
