/**
 * Per-job OS sandbox spec for Agent Relay workers.
 *
 * See `server/shared/worker-sandbox.js` for how each provider applies it. This
 * module only decides *whether* a job is sandboxed and computes the paths:
 * a writer may write its worktree plus exactly the git state its own branch
 * needs; everything else in the primary checkout is read-only.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { AgentRelayJob, AgentRelaySettings } from '@/modules/agent-relay/agent-relay.types.js';
import { repositoryRoot, runGit, workspaceService } from '@/modules/workspaces/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { DEFAULT_WORKER_ALLOWED_DOMAINS, processSandboxAvailable } from '@/shared/worker-sandbox.js';

export type RelaySandboxEnforcement = 'process' | 'provider';

export type RelaySandboxSpec = {
  mode: AgentRelayJob['mode'];
  enforcement: RelaySandboxEnforcement;
  cwd: string;
  writableRoots: string[];
  protectedRoots: string[];
  scratchRoots: string[];
  network: 'open' | 'restricted';
  allowedDomains: string[];
};

/** Providers launched as a CLI process that `sandbox-exec` can wrap whole. */
const PROCESS_SANDBOX_PROVIDERS = new Set<LLMProvider>(['grok', 'opencode', 'kilo', 'cline', 'qwencode', 'antigravity']);

/**
 * How a provider's worker is confined, or null when it cannot be (the string
 * classifier then remains the only envelope, exactly as before).
 *
 * - Claude: the Agent SDK sandbox (macOS Seatbelt underneath).
 * - Codex: its native workspace-write seatbelt. Read-only Codex already runs
 *   in a read-only sandbox that never prompts.
 * - ACP CLIs: the whole process under `sandbox-exec`.
 */
export function relaySandboxEnforcement(
  provider: LLMProvider,
  platform: NodeJS.Platform = process.platform,
): RelaySandboxEnforcement | null {
  if (provider === 'codex') return 'provider';
  if (!processSandboxAvailable(platform)) return null;
  if (provider === 'claude') return 'provider';
  if (PROCESS_SANDBOX_PROVIDERS.has(provider)) return 'process';
  return null;
}

async function gitPath(cwd: string, args: string[]): Promise<string | null> {
  const result = await runGit(cwd, ['rev-parse', ...args]);
  const value = result.code === 0 ? result.stdout.trim() : '';
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/**
 * Git state a linked worktree writes when it commits on its own branch: its
 * private gitdir (HEAD, index, logs), the shared object store, and the loose
 * ref + reflog directory for its branch namespace. `packed-refs` is rewritten
 * by ref updates that touch a packed ref.
 */
async function worktreeGitWritableRoots(worktreeRoot: string, branch: string | null): Promise<string[]> {
  const gitDir = await gitPath(worktreeRoot, ['--absolute-git-dir']);
  const commonDir = await gitPath(worktreeRoot, ['--git-common-dir']);
  if (!gitDir || !commonDir) return [];
  const roots = [gitDir, path.join(commonDir, 'objects'), path.join(commonDir, 'packed-refs'), path.join(commonDir, 'packed-refs.lock')];
  const namespace = branch?.includes('/') ? branch.slice(0, branch.indexOf('/')) : branch;
  if (namespace) {
    roots.push(path.join(commonDir, 'refs', 'heads', namespace));
    roots.push(path.join(commonDir, 'logs', 'refs', 'heads', namespace));
  }
  return roots;
}

/**
 * Sandbox for host checks (verify/rehearse) run inside a Relay worktree.
 * Project test suites run arbitrary code with the server's privileges; a
 * suite that opens CloudCLI's database or writes into the primary checkout
 * must not be able to. Same shape as a writer's process sandbox.
 */
export async function hostCheckSandboxSpec(input: {
  worktreeRoot: string;
  cwd: string;
  projectPath: string;
  branch: string | null;
}): Promise<RelaySandboxSpec | null> {
  if (!processSandboxAvailable()) return null;
  const protectedRoot = (await repositoryRoot(input.projectPath)) ?? path.resolve(input.projectPath);
  const scratch = path.join(input.cwd, 'tmp', 'cloudcli');
  await mkdir(scratch, { recursive: true }).catch(() => undefined);
  return {
    mode: 'isolated_write',
    enforcement: 'process',
    cwd: input.cwd,
    writableRoots: [...new Set([input.worktreeRoot, input.cwd, ...await worktreeGitWritableRoots(input.worktreeRoot, input.branch)])],
    protectedRoots: [protectedRoot],
    scratchRoots: [scratch],
    network: 'open',
    allowedDomains: [...DEFAULT_WORKER_ALLOWED_DOMAINS],
  };
}

export async function buildRelaySandboxSpec(
  job: Pick<AgentRelayJob, 'mode' | 'provider' | 'project_path' | 'workspace_id'>,
  cwd: string,
  settings: Pick<AgentRelaySettings, 'workerSandbox' | 'workerNetwork' | 'workerAllowedDomains'>,
): Promise<RelaySandboxSpec | null> {
  if (settings.workerSandbox === 'off') return null;
  const enforcement = relaySandboxEnforcement(job.provider);
  if (!enforcement) return null;

  const protectedRoot = (await repositoryRoot(job.project_path)) ?? path.resolve(job.project_path);
  const writableRoots: string[] = [];
  if (job.mode === 'isolated_write') {
    const workspace = job.workspace_id ? workspaceService.get(job.workspace_id) : null;
    if (!workspace) return null;
    writableRoots.push(workspace.root_path);
    if (workspace.mode === 'git_worktree') {
      writableRoots.push(...await worktreeGitWritableRoots(workspace.root_path, workspace.feature_branch));
    }
  }

  // The project temp rule says scratch lives in tmp/cloudcli; create it up
  // front because a read-only sandbox cannot mkdir inside the checkout.
  // Read-only jobs may be reviewing a writer's worktree, which must stay
  // clean for landing, so their scratch lives under the primary instead.
  const scratch = job.mode === 'isolated_write'
    ? path.join(cwd, 'tmp', 'cloudcli')
    : path.join(path.resolve(job.project_path), 'tmp', 'cloudcli');
  try {
    await mkdir(scratch, { recursive: true });
  } catch {
    // A missing scratch dir only costs the worker its scratch space.
  }

  return {
    mode: job.mode,
    enforcement,
    cwd,
    writableRoots: job.mode === 'isolated_write' ? [...new Set([cwd, ...writableRoots])] : [],
    protectedRoots: [protectedRoot],
    scratchRoots: [scratch],
    network: settings.workerNetwork === 'restricted' ? 'restricted' : 'open',
    allowedDomains: settings.workerAllowedDomains?.length
      ? [...settings.workerAllowedDomains]
      : [...DEFAULT_WORKER_ALLOWED_DOMAINS],
  };
}
