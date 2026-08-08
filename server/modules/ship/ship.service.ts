import { readFile } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';
import { parse as parseYaml } from 'yaml';

import { interruptsService } from '@/modules/interrupt-queue/index.js';
import { runService } from '@/modules/runs/index.js';
import { secretsService } from '@/modules/secrets/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { CloudError } from '@/shared/run-events.js';
import type { AgentWorkspace } from '@/modules/workspaces/index.js';
import type {
  CiCheck,
  CiStatus,
  PrInput,
  PullRequest,
  ShipService,
  TestReport,
} from '@/modules/ship/ship.types.js';

type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
type CommandOptions = { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: boolean };
type CommandRunner = (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;

type ShipConfig = {
  test?: { command?: string; cwd?: string };
  pr?: { provider?: 'github' | 'gitlab'; baseBranch?: string; draft?: boolean; reviewers?: string[]; tokenRef?: string };
  ci?: { provider?: 'github' | 'gitlab' | 'none'; pollSeconds?: number };
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

function trimOutput(value: string): string {
  return secretsService.redact(value).slice(-MAX_OUTPUT_LENGTH);
}

function defaultCommandRunner(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell ?? false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), timedOut: false });
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
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
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

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map((item) => String(parseScalar(item.trim()))).filter(Boolean);
  }
  return trimmed;
}

/** Small YAML subset for the checked-in ship.yaml shape; JSON is also accepted. */
export function parseShipConfig(text: string): ShipConfig {
  try {
    const parsed = JSON.parse(text) as ShipConfig;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Fall through to the deliberately small YAML parser.
  }
  const result: Record<string, Record<string, unknown>> = {};
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z][\w-]*):\s*$/);
    if (top) {
      section = top[1];
      result[section] ??= {};
      continue;
    }
    const nested = line.match(/^\s{2,}([A-Za-z][\w-]*):\s*(.*)$/);
    if (nested && section) {
      result[section] ??= {};
      result[section][nested[1]] = parseScalar(nested[2]);
    }
  }
  return result as ShipConfig;
}

async function loadShipConfig(cwd: string): Promise<ShipConfig> {
  for (const fileName of ['ship.yaml', 'ship.yml', 'ship.json']) {
    try {
      return parseShipConfig(await readFile(path.join(cwd, '.cloudcli', fileName), 'utf8'));
    } catch {
      // Try the next supported config name.
    }
  }
  try {
    const stack = parseYaml(await readFile(path.join(cwd, '.cloudcli', 'stack.yaml'), 'utf8')) as { ship?: ShipConfig };
    if (stack?.ship && typeof stack.ship === 'object') return stack.ship;
  } catch {
    // A stack capsule is optional; fall back to auto-detection below.
  }
  return {};
}

async function detectTestCommand(cwd: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (packageJson.scripts?.test) return 'npm test';
    if (packageJson.scripts?.typecheck) return 'npm run typecheck';
  } catch {
    // Non-Node projects use the portable git check below.
  }
  return 'git diff --check';
}

function requireWorkspace(workspaceId: string): AgentWorkspace {
  const workspace = workspaceService.get(workspaceId);
  if (!workspace) throw new CloudError('WORKSPACE_NOT_FOUND', `Workspace not found: ${workspaceId}`);
  if (workspace.status === 'discarded' || workspace.status === 'orphan') {
    throw new CloudError('WORKSPACE_NOT_FOUND', `Workspace is not available in status "${workspace.status}"`);
  }
  return workspace;
}

function resolveWorkspaceCwd(workspace: AgentWorkspace, configuredCwd?: string): string {
  const root = path.resolve(workspace.root_path);
  const cwd = path.resolve(root, configuredCwd?.trim() || '.');
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) {
    throw new CloudError('WORKSPACE_CREATE_FAILED', 'Ship command cwd must stay inside the workspace');
  }
  return cwd;
}

function appendShipEvent(workspace: AgentWorkspace, type: 'test.started' | 'test.finished' | 'git.diff_summary', payload: Record<string, unknown>): void {
  if (!workspace.run_id) return;
  try {
    runService.appendEvent(workspace.run_id, {
      run_id: workspace.run_id,
      ts: nowIso(),
      source: 'ship',
      type,
      payload,
    });
  } catch {
    // Ship actions remain useful for workspaces created without a run spine row.
  }
}

export function createShipService(options: { runCommand?: CommandRunner } = {}): ShipService {
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const reports = new Map<string, TestReport>();
  const pullRequests = new Map<string, PullRequest>();

  const runTests = async (workspaceId: string): Promise<TestReport> => {
    const workspace = requireWorkspace(workspaceId);
    const config = await loadShipConfig(workspace.root_path);
    const command = config.test?.command?.trim() || await detectTestCommand(workspace.root_path);
    const cwd = resolveWorkspaceCwd(workspace, config.test?.cwd);
    const startedAt = nowIso();
    const started = Date.now();
    appendShipEvent(workspace, 'test.started', { command, cwd });
    const result = await runCommand(command, [], {
      cwd,
      env: { ...process.env, CLOUDCLI_WORKSPACE_ID: workspaceId },
      shell: true,
    });
    const report: TestReport = {
      workspace_id: workspaceId,
      command,
      cwd,
      passed: result.code === 0 && !result.timedOut,
      exit_code: result.code,
      timed_out: result.timedOut,
      stdout: trimOutput(result.stdout),
      stderr: trimOutput(result.stderr),
      duration_ms: Date.now() - started,
      started_at: startedAt,
      finished_at: nowIso(),
    };
    reports.set(workspaceId, report);
    appendShipEvent(workspace, 'test.finished', {
      passed: report.passed,
      exit_code: report.exit_code,
      duration_ms: report.duration_ms,
      stderr: report.stderr,
    });
    return report;
  };

  const createPullRequest = async (workspaceId: string, input: PrInput = {}): Promise<PullRequest> => {
    const workspace = requireWorkspace(workspaceId);
    if (workspace.mode !== 'git_worktree' || !workspace.feature_branch) {
      throw new CloudError('SHIP_PR_FAILED', 'Pull requests require a git worktree with a feature branch');
    }
    const config = await loadShipConfig(workspace.root_path);
    const testReport = reports.get(workspaceId) ?? await runTests(workspaceId);
    const provider = input.provider ?? config.pr?.provider ?? 'github';
    const baseBranch = input.baseBranch ?? config.pr?.baseBranch ?? workspace.base_branch;
    const title = input.title?.trim() || `CloudCLI: ${workspace.feature_branch}`;
    const draft = input.draft ?? config.pr?.draft ?? true;
    const reviewers = input.reviewers ?? config.pr?.reviewers ?? [];
    const tokenRef = input.tokenRef ?? config.pr?.tokenRef;
    const env = { ...process.env };
    if (tokenRef) {
      const token = secretsService.resolve(tokenRef, { projectId: workspace.project_id });
      if (provider === 'gitlab') env.GITLAB_TOKEN = token;
      else env.GH_TOKEN = token;
    }
    const testStatus = testReport.passed ? '✅ passed' : '❌ failed';
    const body = `${input.body?.trim() ? `${input.body.trim()}\n\n` : ''}## CloudCLI Ship Loop\n\n- Test command: \`${testReport.command}\`\n- Test status: ${testStatus}\n- Exit code: ${testReport.exit_code ?? 'spawn error'}\n- Duration: ${testReport.duration_ms}ms\n\n${testReport.stderr ? `### Test output\n\n\`\`\`\n${testReport.stderr.slice(-8000)}\n\`\`\`` : ''}`;
    const args = provider === 'gitlab'
      ? ['mr', 'create', '--source-branch', workspace.feature_branch, '--target-branch', baseBranch, '--title', title, '--description', body]
      : ['pr', 'create', '--head', workspace.feature_branch, '--base', baseBranch, '--title', title, '--body', body];
    if (draft) args.push('--draft');
    for (const reviewer of reviewers) {
      if (reviewer.trim()) args.push('--reviewer', reviewer.trim());
    }
    const created = await runCommand(provider === 'gitlab' ? 'glab' : 'gh', args, { cwd: workspace.root_path, env, timeoutMs: 120_000 });
    const output = trimOutput(`${created.stdout}\n${created.stderr}`);
    if (created.code !== 0) {
      throw new CloudError('SHIP_PR_FAILED', `Could not create ${provider === 'gitlab' ? 'merge request' : 'pull request'}: ${output.slice(-1000)}`);
    }
    const url = output.match(/https?:\/\/[^\s)]+/)?.[0];
    if (!url) throw new CloudError('SHIP_PR_FAILED', 'CLI created a change request but returned no URL');
    const warnings: string[] = [];
    const number = Number(url.match(/(?:pull|merge_requests)\/(\d+)/)?.[1] ?? '') || null;
    if (provider === 'github') {
      const comment = await runCommand('gh', ['pr', 'comment', url, '--body', `CloudCLI test status: ${testStatus} (${testReport.command})`], { cwd: workspace.root_path, env, timeoutMs: 60_000 });
      if (comment.code !== 0) warnings.push('Pull request was created, but the test status comment could not be posted.');
    }
    const result: PullRequest = {
      provider,
      url,
      number,
      title,
      head_branch: workspace.feature_branch,
      base_branch: baseBranch,
      draft,
      test_report: testReport,
      warnings,
    };
    pullRequests.set(workspaceId, result);
    appendShipEvent(workspace, 'git.diff_summary', { pull_request_url: url, test_passed: testReport.passed });
    return result;
  };

  const getCiStatus = async (workspaceId: string, prUrlOrId?: string): Promise<CiStatus> => {
    const workspace = requireWorkspace(workspaceId);
    const config = await loadShipConfig(workspace.root_path);
    const provider = config.ci?.provider ?? pullRequests.get(workspaceId)?.provider ?? 'github';
    if (provider === 'none') return { provider: 'none', pull_request_url: pullRequests.get(workspaceId)?.url ?? null, state: 'unknown', checks: [], fetched_at: nowIso(), message: 'CI provider disabled' };
    const saved = pullRequests.get(workspaceId);
    const ref = prUrlOrId ?? saved?.url ?? workspace.feature_branch;
    const env = { ...process.env };
    if (config.pr?.tokenRef) env.GH_TOKEN = secretsService.resolve(config.pr.tokenRef, { projectId: workspace.project_id });
    const command = provider === 'gitlab' ? 'glab' : 'gh';
    const args = provider === 'gitlab'
      ? ['mr', 'view', ref, '--output', 'json']
      : ['pr', 'checks', ref, '--json', 'name,state,bucket,link'];
    const checked = await runCommand(command, args, { cwd: workspace.root_path, env, timeoutMs: 60_000 });
    if (checked.code !== 0) {
      return { provider, pull_request_url: saved?.url ?? (ref.startsWith('http') ? ref : null), state: 'unknown', checks: [], fetched_at: nowIso(), message: trimOutput(checked.stderr || checked.stdout).slice(-1000) || 'CI status unavailable' };
    }
    let raw: unknown;
    try { raw = JSON.parse(checked.stdout); } catch { raw = []; }
    const rows: unknown[] = Array.isArray(raw)
      ? raw
      : (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).checks)
        ? (raw as Record<string, unknown>).checks as unknown[]
        : []);
    const checks: CiCheck[] = rows.map((row) => {
      const item = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      return { name: String(item.name ?? item.title ?? 'check'), state: String(item.state ?? item.status ?? item.bucket ?? 'UNKNOWN'), conclusion: item.conclusion == null ? null : String(item.conclusion), url: item.link == null ? null : String(item.link) };
    });
    const states = checks.map((check) => `${check.state} ${check.conclusion ?? ''}`.toLowerCase());
    const failed = states.some((state) => /fail|error|cancel|timed/.test(state));
    const pending = checks.some((state) => !/success|pass|complete|skipping/.test(`${state.state} ${state.conclusion ?? ''}`.toLowerCase()));
    const state: CiStatus['state'] = failed ? 'failure' : pending ? 'pending' : checks.length ? 'success' : 'unknown';
    const status: CiStatus = { provider, pull_request_url: saved?.url ?? (ref.startsWith('http') ? ref : null), state, checks, fetched_at: nowIso() };
    if (state === 'failure') {
      interruptsService.create({
        projectId: workspace.project_id,
        kind: 'ci_failed',
        severity: 'error',
        title: 'CI checks failed',
        body: `${checks.filter((check) => /fail|error|cancel|timed/i.test(`${check.state} ${check.conclusion ?? ''}`)).map((check) => check.name).join(', ') || 'One or more checks failed'} on ${workspace.feature_branch}`,
        runId: workspace.run_id,
        workspaceId,
        href: status.pull_request_url,
        actions: [{ id: 'retry_run', label: 'Open fix run', style: 'primary' }, { id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
        dedupeKey: `ci_failed:${workspaceId}:${status.pull_request_url ?? ref}`,
      });
    }
    return status;
  };

  const openFixRun = (input: { parentRunId: string; failureSummary: string }) => {
    const parent = runService.get(input.parentRunId);
    if (!parent) throw new CloudError('RUN_NOT_FOUND', `Run not found: ${input.parentRunId}`);
    const child = runService.create({
      source: 'ship',
      projectId: parent.project_id,
      sourceRef: parent.workspace_id,
      workspaceId: parent.workspace_id,
      provider: parent.provider,
      model: parent.model,
      permissionMode: parent.permission_mode,
      parentRunId: parent.run_id,
      rootRunId: parent.root_run_id ?? parent.run_id,
      trigger: 'fix_ci',
      title: `Fix CI for ${parent.title ?? parent.run_id}`,
      meta: { failureSummary: secretsService.redact(input.failureSummary) },
    });
    runService.appendEvent(child.run_id, {
      run_id: child.run_id,
      ts: nowIso(),
      source: 'ship',
      type: 'failover.triggered',
      payload: { parent_run_id: parent.run_id, failure_summary: input.failureSummary },
    });
    return child;
  };

  return { runTests, createPullRequest, getCiStatus, openFixRun };
}

export const shipService = createShipService();
