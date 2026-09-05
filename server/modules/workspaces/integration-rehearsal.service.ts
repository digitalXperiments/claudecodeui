/**
 * Integration Rehearsal: merge committed workspace tips onto an explicit
 * common base in a disposable worktree, run the project's Ship test command,
 * and always remove the temporary branch/worktree/process.
 */

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { parseShipConfig } from '@/modules/ship/index.js';
import { workspaceDb } from '@/modules/workspaces/workspace.repository.js';
import {
  deleteBranch,
  revParse,
  runGit,
  statusPorcelain,
  worktreeAdd,
  worktreePrune,
  worktreeRemove,
} from '@/modules/workspaces/workspace-git.service.js';
import type { AgentWorkspace } from '@/modules/workspaces/workspace.types.js';
import { CloudError } from '@/shared/run-events.js';

import type {
  IntegrationRehearsalInput,
  IntegrationRehearsalResult,
  IntegrationRehearsalServiceOptions,
  IntegrationRehearsalTestReport,
} from '@/modules/workspaces/integration-rehearsal.types.js';

const SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const UNSAFE_COMMAND = /[;&|`$<>(){}\\!\n\r]/;
const MAX_OUTPUT = 30_000;
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const COMPLETED_STATUSES = new Set(['active', 'merged']);

type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function nowIso(): string {
  return new Date().toISOString();
}

function trimOutput(value: string): string {
  return value.slice(-MAX_OUTPUT);
}

function isSafeRef(value: string): boolean {
  return SHA_RE.test(value) || BRANCH_RE.test(value);
}

function tokenizeCommand(command: string): { file: string; args: string[] } {
  const trimmed = command.trim();
  if (!trimmed || UNSAFE_COMMAND.test(trimmed)) {
    throw new CloudError(
      'WORKSPACE_CREATE_FAILED',
      'Test command contains unsafe shell metacharacters',
    );
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const file = parts[0];
  if (!file || file.includes('..') || file.startsWith('-')) {
    throw new CloudError('WORKSPACE_CREATE_FAILED', 'Invalid test command');
  }
  return { file, args: parts.slice(1) };
}

function runArgv(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, options.timeoutMs);
    timer.unref();
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

async function loadShipTestCommand(projectPath: string): Promise<{ command: string; relativeCwd?: string }> {
  for (const fileName of ['ship.yaml', 'ship.yml', 'ship.json']) {
    try {
      const parsed = parseShipConfig(await readFile(path.join(projectPath, '.cloudcli', fileName), 'utf8'));
      const command = parsed.test?.command?.trim();
      if (command) {
        return { command, relativeCwd: parsed.test?.cwd };
      }
    } catch {
      // Try the next Ship config filename.
    }
  }
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    if (packageJson.scripts?.test) return { command: 'npm test' };
  } catch {
    // Fall through to git diff --check.
  }
  return { command: 'git diff --check' };
}

function requireCompletedWorkspace(workspace: AgentWorkspace, projectId: string): void {
  if (workspace.project_id !== projectId) {
    throw new CloudError(
      'WORKSPACE_CREATE_FAILED',
      `Workspace ${workspace.workspace_id} is not in the requested project`,
    );
  }
  if (workspace.mode !== 'git_worktree' || !workspace.feature_branch) {
    throw new CloudError(
      'WORKSPACE_CREATE_FAILED',
      `Workspace ${workspace.workspace_id} is not a git worktree with a feature branch`,
    );
  }
  if (!isSafeRef(workspace.feature_branch)) {
    throw new CloudError(
      'WORKSPACE_CREATE_FAILED',
      `Workspace ${workspace.workspace_id} has an invalid feature branch name`,
    );
  }
  if (!COMPLETED_STATUSES.has(workspace.status)) {
    throw new CloudError(
      'WORKSPACE_CREATE_FAILED',
      `Workspace ${workspace.workspace_id} is not completed (status ${workspace.status})`,
    );
  }
}

async function persistResult(tmpRoot: string, result: IntegrationRehearsalResult): Promise<void> {
  const dir = path.join(tmpRoot, 'rehearsals');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${result.rehearsal_id}.json`), `${JSON.stringify(result, null, 2)}\n`);
}

export function createIntegrationRehearsalService(options: IntegrationRehearsalServiceOptions = {}) {
  const tmpRoot = options.tmpRoot ?? path.resolve('tmp/cloudcli');
  const testTimeoutMs = Math.max(1_000, options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS);
  const lastByProject = new Map<string, IntegrationRehearsalResult>();

  const cleanup = async (projectPath: string, rehearsalPath: string, branch: string): Promise<boolean> => {
    try {
      await worktreeRemove(projectPath, rehearsalPath);
    } catch {
      // Best-effort; prune + rm still run.
    }
    await worktreePrune(projectPath);
    await deleteBranch(projectPath, branch);
    try {
      await rm(rehearsalPath, { recursive: true, force: true });
    } catch {
      // Directory may already be gone after worktree remove.
    }
    const stillListed = await runGit(projectPath, ['worktree', 'list', '--porcelain']);
    return !stillListed.stdout.includes(rehearsalPath);
  };

  const run = async (input: IntegrationRehearsalInput): Promise<IntegrationRehearsalResult> => {
    const startedAt = nowIso();
    const rehearsalId = `rh_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const rehearsalBranch = `rehearsal/${rehearsalId}`;
    const warnings: string[] = [];
    const uniqueIds = [...new Set(input.workspaceIds.map((id) => id.trim()).filter(Boolean))];

    if (uniqueIds.length < 2) {
      throw new CloudError('WORKSPACE_CREATE_FAILED', 'Select at least two completed workspaces from the same project');
    }
    const requestedBase = input.baseSha.trim();
    if (!isSafeRef(requestedBase)) {
      throw new CloudError('WORKSPACE_CREATE_FAILED', 'baseSha must be an explicit git object name');
    }

    const workspaces = uniqueIds.map((id) => {
      const workspace = workspaceDb.get(id);
      if (!workspace) {
        throw new CloudError('WORKSPACE_NOT_FOUND', `Workspace not found: ${id}`);
      }
      requireCompletedWorkspace(workspace, input.projectId);
      return workspace;
    });

    const registered = projectsDb.getProjectPathById(input.projectId);
    if (!registered) {
      throw new CloudError('WORKSPACE_NOT_FOUND', `Project not found: ${input.projectId}`);
    }
    const primaryPath = path.resolve(registered);

    const resolvedBase = await revParse(primaryPath, requestedBase);
    if (!resolvedBase || !SHA_RE.test(resolvedBase)) {
      throw new CloudError('WORKSPACE_CREATE_FAILED', `Cannot resolve baseSha ${input.baseSha}`);
    }

    const inputs = [];
    for (const workspace of workspaces) {
      let workspaceExists = false;
      try {
        await access(workspace.root_path);
        workspaceExists = true;
      } catch {
        workspaceExists = false;
      }
      if (workspaceExists) {
        const live = await statusPorcelain(workspace.root_path);
        if (live.dirtyFiles.length > 0) {
          throw new CloudError(
            'WORKSPACE_DIRTY_CONFLICT',
            `Workspace ${workspace.workspace_id} has uncommitted edits; rehearsal uses committed tips only`,
          );
        }
      } else {
        warnings.push(
          `Workspace ${workspace.workspace_id} worktree is gone; using committed branch tip only.`,
        );
      }
      const tip = await revParse(primaryPath, `refs/heads/${workspace.feature_branch}`);
      if (!tip) {
        throw new CloudError(
          'WORKSPACE_CREATE_FAILED',
          `Cannot resolve committed tip for ${workspace.feature_branch}`,
        );
      }
      if (workspace.head_sha && workspace.head_sha !== tip) {
        warnings.push(
          `Workspace ${workspace.workspace_id} stored head_sha ${workspace.head_sha} but branch tip is ${tip}; using the committed tip`,
        );
      }
      const isAncestor = await runGit(primaryPath, ['merge-base', '--is-ancestor', resolvedBase, tip]);
      if (isAncestor.code !== 0) {
        throw new CloudError(
          'WORKSPACE_CREATE_FAILED',
          `Base ${resolvedBase} is not an ancestor of ${workspace.feature_branch} (${tip})`,
        );
      }
      inputs.push({
        workspace_id: workspace.workspace_id,
        feature_branch: workspace.feature_branch,
        head_sha: tip,
        status: workspace.status,
      });
    }

    warnings.push('Uncommitted edits are excluded; rehearsal merges recorded committed SHAs only.');

    const rehearsalPath = path.join(tmpRoot, 'rehearsals', input.projectId, rehearsalId);
    await mkdir(path.dirname(rehearsalPath), { recursive: true });

    const primaryHeadBefore = await revParse(primaryPath, 'HEAD');
    const primaryStatusBefore = await runGit(primaryPath, ['status', '--porcelain']);
    const primaryBranchBefore = await runGit(primaryPath, ['branch', '--show-current']);

    let cleanedUp = false;
    let mergeConflicts: string[] = [];
    let test: IntegrationRehearsalTestReport | null = null;
    let outcome: IntegrationRehearsalResult['outcome'] = 'invalid_input';
    let message = '';

    try {
      const added = await worktreeAdd(primaryPath, rehearsalPath, rehearsalBranch, resolvedBase);
      if (added.code !== 0) {
        throw new CloudError(
          'WORKSPACE_CREATE_FAILED',
          `Failed to create rehearsal worktree: ${added.stderr.trim().slice(0, 400)}`,
        );
      }

      for (const entry of inputs) {
        const merge = await runGit(rehearsalPath, ['merge', '--no-edit', '--no-ff', entry.head_sha]);
        if (merge.code !== 0) {
          const status = await statusPorcelain(rehearsalPath);
          mergeConflicts = [...new Set(status.conflicts)];
          await runGit(rehearsalPath, ['merge', '--abort']);
          outcome = 'merge_conflict';
          message = `Merge conflict combining ${entry.feature_branch} (${entry.head_sha.slice(0, 8)})`;
          break;
        }
      }

      if (outcome !== 'merge_conflict') {
        const ship = await loadShipTestCommand(rehearsalPath);
        const { file, args } = tokenizeCommand(ship.command);
        const cwd = path.resolve(rehearsalPath, ship.relativeCwd?.trim() || '.');
        if (cwd !== rehearsalPath && !cwd.startsWith(`${rehearsalPath}${path.sep}`)) {
          throw new CloudError('WORKSPACE_CREATE_FAILED', 'Ship test cwd must stay inside the rehearsal worktree');
        }
        const testStartedAt = nowIso();
        const started = Date.now();
        const result = await runArgv(file, args, { cwd, timeoutMs: testTimeoutMs });
        test = {
          command: ship.command,
          cwd,
          passed: result.code === 0 && !result.timedOut,
          exit_code: result.code,
          timed_out: result.timedOut,
          stdout: trimOutput(result.stdout),
          stderr: trimOutput(result.stderr),
          duration_ms: Date.now() - started,
          started_at: testStartedAt,
          finished_at: nowIso(),
        };
        if (result.timedOut) {
          outcome = 'timeout';
          message = `Test command timed out after ${testTimeoutMs}ms`;
        } else if (test.passed) {
          outcome = 'success';
          message = 'Combined committed tips merged cleanly and the configured test command passed';
        } else {
          outcome = 'test_failed';
          message = 'Combined committed tips merged cleanly but the configured test command failed';
        }
      }
    } finally {
      cleanedUp = await cleanup(primaryPath, rehearsalPath, rehearsalBranch);
    }

    const primaryHeadAfter = await revParse(primaryPath, 'HEAD');
    const primaryStatusAfter = await runGit(primaryPath, ['status', '--porcelain']);
    const primaryBranchAfter = await runGit(primaryPath, ['branch', '--show-current']);
    if (
      primaryHeadBefore !== primaryHeadAfter ||
      primaryStatusBefore.stdout !== primaryStatusAfter.stdout ||
      primaryBranchBefore.stdout !== primaryBranchAfter.stdout
    ) {
      warnings.push('Primary checkout changed during rehearsal; this is unexpected.');
    }

    const result: IntegrationRehearsalResult = {
      rehearsal_id: rehearsalId,
      project_id: input.projectId,
      outcome,
      message,
      inputs,
      base_sha: resolvedBase,
      merge_conflicts: mergeConflicts,
      test,
      warnings,
      cleaned_up: cleanedUp,
      rehearsal_branch: rehearsalBranch,
      rehearsal_path: cleanedUp ? null : rehearsalPath,
      started_at: startedAt,
      finished_at: nowIso(),
    };
    lastByProject.set(input.projectId, result);
    await persistResult(tmpRoot, result);
    return result;
  };

  return {
    run,
    last(projectId: string): IntegrationRehearsalResult | null {
      return lastByProject.get(projectId) ?? null;
    },
  };
}

export const integrationRehearsalService = createIntegrationRehearsalService();
