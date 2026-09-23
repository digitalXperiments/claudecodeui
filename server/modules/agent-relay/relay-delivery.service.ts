/**
 * Relay delivery: verify → rehearse → land, runnable by the lead, the
 * operator, or automatically by the server when writers finish.
 *
 * Every Relay writer workspace starts from a snapshot commit of the primary
 * checkout's uncommitted files, so a writer's own work is exactly the
 * committed range `snapshot..tip`. Delivery never merges branches into the
 * primary: it applies that range file by file (three-way where the operator
 * also edited a file), which works on a checkout full of uncommitted work and
 * never sweeps the operator's edits into a commit.
 *
 * - verify:   host checks in the writer worktree at its committed tip.
 * - rehearse: apply every selected writer's range onto a throwaway snapshot
 *             of the primary as it is *now*, then run the checks there. This
 *             is precisely what the primary will look like after landing.
 * - land:     apply each rehearsed range onto the primary, commit the paths
 *             that were clean there, then retire the worktree and branch.
 */

import path from 'node:path';

import { agentRelayDb } from '@/modules/agent-relay/agent-relay.repository.js';
import { relayDeliveryDb, type RelayDeliveryRecord } from '@/modules/agent-relay/relay-delivery.repository.js';
import type { AgentRelayJob, AgentRelayScope } from '@/modules/agent-relay/agent-relay.types.js';
import { runRelayHostChecks, type RelayHostChecksInput, type RelayHostChecksResult } from '@/modules/agent-relay/relay-host-check.service.js';
import { projectsDb } from '@/modules/database/index.js';
import {
  committedChanges,
  repositoryRoot,
  revParse,
  workspaceService,
  type AgentWorkspace,
  type RangeApplyResult,
} from '@/modules/workspaces/index.js';
import { AppError } from '@/shared/utils.js';

function conflict(message: string): AppError {
  return new AppError(message, { code: 'RELAY_DELIVERY_CONFLICT', statusCode: 409 });
}

function inScope(job: AgentRelayJob, scope: AgentRelayScope): boolean {
  return Boolean(scope.allowUnscoped) || job.source_session_id === scope.sourceSessionId;
}

function requireJob(relayId: string, scope: AgentRelayScope): AgentRelayJob {
  const job = agentRelayDb.get(relayId);
  if (!job || !inScope(job, scope)) {
    throw new AppError('Relay job not found in this lead session.', { code: 'RELAY_NOT_FOUND', statusCode: 404 });
  }
  if (job.mode !== 'isolated_write' || !job.workspace_id) {
    throw conflict('This relay has no isolated writer workspace.');
  }
  return job;
}

function requireGitWorkspace(workspaceId: string, projectId: string): AgentWorkspace {
  const workspace = workspaceService.get(workspaceId);
  if (!workspace || workspace.project_id !== projectId || workspace.mode !== 'git_worktree') {
    throw conflict(`Workspace ${workspaceId} is not an isolated git workspace in this project.`);
  }
  if (workspace.status === 'discarded' || workspace.status === 'orphan') {
    throw conflict(`Workspace ${workspaceId} is ${workspace.status}.`);
  }
  return workspace;
}

function projectPath(projectId: string): string {
  const value = projectsDb.getProjectPathById(projectId);
  if (!value) throw new AppError('Project not found.', { code: 'RELAY_PROJECT_NOT_FOUND', statusCode: 404 });
  return path.resolve(value);
}

function isDeliverable(job: AgentRelayJob): boolean {
  return job.status === 'completed'
    && job.result?.status === 'completed'
    && job.result.contractValidation?.valid !== false
    && job.result.outputValidation?.valid !== false;
}

/** Where a writer's own changes start: its snapshot, else its base. */
function landingBase(workspace: AgentWorkspace): string | null {
  return workspace.snapshot_sha ?? workspace.base_sha;
}

async function projectPathspec(workspace: AgentWorkspace): Promise<{ repoRoot: string; pathspec?: string }> {
  const primary = projectPath(workspace.project_id);
  const repoRoot = (await repositoryRoot(primary)) ?? primary;
  const relative = path.relative(repoRoot, primary);
  return { repoRoot, pathspec: relative && !relative.startsWith('..') ? relative.split(path.sep).join('/') : undefined };
}

async function committedTip(workspace: AgentWorkspace): Promise<string> {
  const tip = await revParse(workspace.root_path, 'HEAD');
  if (!tip) throw conflict(`Workspace ${workspace.workspace_id} has no resolvable tip.`);
  return tip;
}

/** A verification that neither failed nor was skipped for cause. */
function verificationAcceptable(verification: RelayHostChecksResult): boolean {
  return verification.passed || (verification.unavailable && verification.evidence.length === 0);
}

function latestVerification(projectId: string, workspaceId: string, tip: string): RelayDeliveryRecord | null {
  return relayDeliveryDb.list({ projectId, kind: 'verify', limit: 500 })
    .find((record) => record.workspace_ids.includes(workspaceId) && record.tips[workspaceId] === tip) ?? null;
}

function landedWorkspaceIds(projectId: string): Set<string> {
  return new Set(relayDeliveryDb.list({ projectId, kind: 'land', limit: 500 }).flatMap((record) => record.workspace_ids));
}

type RehearsalEntry = { relayId: string; workspaceId: string; tip: string; apply: RangeApplyResult | null; error?: string };

export const relayDeliveryService = {
  async verify(input: Omit<RelayHostChecksInput, 'workspaceId'> & { relayId: string; scope: AgentRelayScope }) {
    const job = requireJob(input.relayId, input.scope);
    if (!isDeliverable(job)) {
      throw conflict('Host checks can only run after the writer has completed successfully.');
    }
    const workspace = requireGitWorkspace(job.workspace_id!, job.project_id);
    await workspaceService.commitPendingChanges(workspace.workspace_id, `relay: uncommitted changes of ${job.relay_id}`);
    const verification = await runRelayHostChecks({
      workspaceId: workspace.workspace_id,
      commands: input.commands,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const tip = verification.testedCommit ?? await committedTip(workspace);
    const record = relayDeliveryDb.create({
      project_id: job.project_id,
      source_session_id: job.source_session_id,
      kind: 'verify',
      workspace_ids: [workspace.workspace_id],
      tips: { [workspace.workspace_id]: tip },
      base_sha: landingBase(workspace),
      result: verification as unknown as Record<string, unknown>,
      passed: verificationAcceptable(verification),
      landed_sha: null,
    });
    return { deliveryId: record.delivery_id, verification, passed: record.passed };
  },

  async rehearse(input: { projectId: string; relayIds: string[]; commands?: string[]; scope: AgentRelayScope }) {
    const relayIds = [...new Set(input.relayIds ?? [])];
    if (relayIds.length < 1 || relayIds.length > 20) {
      throw new AppError('Provide 1–20 relayIds.', { code: 'RELAY_DELIVERY_INPUT_INVALID', statusCode: 400 });
    }
    const jobs = relayIds.map((relayId) => requireJob(relayId, input.scope));
    if (jobs.some((job) => job.project_id !== input.projectId)) throw conflict('All relayIds must belong to the requested project.');
    for (const job of jobs) {
      if (!isDeliverable(job)) throw conflict(`Relay ${job.relay_id} has not completed successfully.`);
    }
    const primary = projectPath(input.projectId);
    const baseSha = await revParse(primary, 'HEAD');
    if (!baseSha) throw conflict('Could not resolve the primary checkout HEAD.');

    const entries: RehearsalEntry[] = [];
    for (const job of jobs) {
      const workspace = requireGitWorkspace(job.workspace_id!, job.project_id);
      await workspaceService.commitPendingChanges(workspace.workspace_id, `relay: uncommitted changes of ${job.relay_id}`);
      entries.push({ relayId: job.relay_id, workspaceId: workspace.workspace_id, tip: await committedTip(workspace), apply: null });
    }

    // A throwaway worktree of the primary exactly as it is now (HEAD plus the
    // operator's uncommitted files), onto which each range is applied the
    // same way landing will apply it.
    const target = await workspaceService.create({
      projectId: input.projectId,
      projectPath: primary,
      taskId: `rehearsal-${Date.now()}`,
      branchName: `relay-rehearsal/${Date.now().toString(36)}`,
      snapshotPrimaryChanges: true,
    });
    let checks: RelayHostChecksResult | null = null;
    try {
      for (const entry of entries) {
        const workspace = workspaceService.get(entry.workspaceId)!;
        const { pathspec } = await projectPathspec(workspace);
        try {
          entry.apply = await workspaceService.applyCommittedRange({
            sourceRoot: workspace.root_path,
            fromRef: landingBase(workspace)!,
            toRef: entry.tip,
            targetRoot: target.root_path,
            scratchDir: path.join(workspace.root_path, 'tmp', 'cloudcli'),
            pathspec,
          });
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
        }
      }
      const conflicts = entries.flatMap((entry) => (entry.apply?.conflicts ?? []).map((item) => ({ relayId: entry.relayId, ...item })));
      const failedApply = entries.filter((entry) => entry.error);
      const outcome = failedApply.length > 0 ? 'error' : conflicts.length > 0 ? 'conflict' : 'applied';
      if (outcome === 'applied') {
        await workspaceService.commitPendingChanges(target.workspace_id, 'relay: rehearsal of combined writers');
        checks = await runRelayHostChecks({ workspaceId: target.workspace_id, commands: input.commands });
      }
      const passed = outcome === 'applied' && Boolean(checks && verificationAcceptable(checks));
      const record = relayDeliveryDb.create({
        project_id: input.projectId,
        source_session_id: input.scope.allowUnscoped ? jobs[0]!.source_session_id : (input.scope.sourceSessionId ?? null),
        kind: 'rehearse',
        workspace_ids: entries.map((entry) => entry.workspaceId),
        tips: Object.fromEntries(entries.map((entry) => [entry.workspaceId, entry.tip])),
        base_sha: baseSha,
        result: {
          outcome,
          relayIds,
          conflicts,
          errors: failedApply.map((entry) => ({ relayId: entry.relayId, error: entry.error })),
          files: entries.map((entry) => ({
            relayId: entry.relayId,
            applied: entry.apply?.applied.length ?? 0,
            merged: entry.apply?.merged ?? [],
            alreadyApplied: entry.apply?.alreadyApplied.length ?? 0,
          })),
          checks,
        },
        passed,
        landed_sha: null,
      });
      return { deliveryId: record.delivery_id, passed, outcome, conflicts, checks };
    } finally {
      await workspaceService.discard(target.workspace_id, { deleteBranch: true }).catch(() => undefined);
    }
  },

  async unlanded(input: { projectId: string; scope: AgentRelayScope }) {
    const landed = landedWorkspaceIds(input.projectId);
    const jobs = agentRelayDb.list({
      projectId: input.projectId,
      sourceSessionId: input.scope.allowUnscoped ? undefined : (input.scope.sourceSessionId || '__unowned__'),
      limit: 200,
    }).filter((job) => job.mode === 'isolated_write' && Boolean(job.workspace_id) && !landed.has(job.workspace_id!));
    const entries = await Promise.all(jobs.map(async (job) => {
      const workspace = workspaceService.get(job.workspace_id!);
      if (!workspace || workspace.status === 'discarded' || workspace.status === 'merged') return null;
      let changedFiles = 0;
      const base = landingBase(workspace);
      if (workspace.mode === 'git_worktree' && base) {
        try {
          const tip = await revParse(workspace.root_path, 'HEAD');
          const { pathspec } = await projectPathspec(workspace);
          if (tip) {
            changedFiles = (await committedChanges(workspace.root_path, base, tip, pathspec)).length;
          }
        } catch {
          changedFiles = -1;
        }
      }
      return {
        relay_id: job.relay_id,
        label: job.label,
        batch_id: job.batch_id,
        status: job.status,
        result_status: job.result?.status ?? null,
        workspace_id: workspace.workspace_id,
        branch: workspace.feature_branch,
        head_sha: workspace.head_sha,
        changed_files: changedFiles,
        delivery: relayDeliveryService.deliveryState(job),
      };
    }));
    return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  },

  /**
   * Land one writer (or every writer of a rehearsal) onto the primary. The
   * rehearsal pins each writer's tip; a tip that moved since needs a new
   * rehearsal. The primary may have moved or be dirty: the per-file apply
   * reports anything it could not place instead of guessing.
   */
  async land(input: { relayId?: string; rehearsalId: string; scope: AgentRelayScope; commit?: boolean; cleanup?: boolean }) {
    const rehearsal = relayDeliveryDb.get(input.rehearsalId);
    if (!rehearsal || rehearsal.kind !== 'rehearse' || !rehearsal.passed) {
      throw conflict('A passing rehearsal is required before landing.');
    }
    const rehearsedRelayIds = Array.isArray(rehearsal.result.relayIds) ? rehearsal.result.relayIds as string[] : [];
    const relayIds = input.relayId ? [input.relayId] : rehearsedRelayIds;
    if (relayIds.length === 0) throw conflict('The rehearsal lists no writers to land.');
    const alreadyLanded = landedWorkspaceIds(rehearsal.project_id);
    const results = [];
    for (const relayId of relayIds) {
      const job = requireJob(relayId, input.scope);
      if (!isDeliverable(job)) throw conflict(`Relay ${relayId} is not a completed writer with a valid result.`);
      if (job.project_id !== rehearsal.project_id) throw conflict('The rehearsal belongs to another project.');
      const workspace = requireGitWorkspace(job.workspace_id!, job.project_id);
      if (!rehearsal.workspace_ids.includes(workspace.workspace_id)) throw conflict(`The rehearsal did not include ${relayId}.`);
      if (alreadyLanded.has(workspace.workspace_id)) {
        results.push({ relayId, skipped: 'already landed' });
        continue;
      }
      const tip = await committedTip(workspace);
      if (tip !== rehearsal.tips[workspace.workspace_id]) {
        throw conflict(`Relay ${relayId} changed after the rehearsal; rehearse its current tip again.`);
      }
      const landed = await workspaceService.landOntoPrimary(workspace.workspace_id, {
        commit: input.commit,
        message: `${(job.label || job.task).split('\n')[0]!.slice(0, 72)}\n\nLanded from Agent Relay ${job.relay_id} (${workspace.feature_branch}).`,
      });
      if (landed.conflicts.length > 0 && landed.applied.length + landed.merged.length === 0) {
        throw conflict(`Nothing from ${relayId} could be applied: ${landed.conflicts.map((item) => `${item.path} (${item.reason})`).join(', ')}`);
      }
      const delivery = relayDeliveryDb.create({
        project_id: job.project_id,
        source_session_id: job.source_session_id,
        kind: 'land',
        workspace_ids: [workspace.workspace_id],
        tips: { [workspace.workspace_id]: tip },
        base_sha: rehearsal.base_sha,
        result: {
          relayId,
          rehearsalId: rehearsal.delivery_id,
          applied: landed.applied,
          merged: landed.merged,
          conflicts: landed.conflicts,
          leftUncommitted: landed.leftUncommitted,
          committed: landed.committed,
        },
        passed: landed.conflicts.length === 0,
        landed_sha: landed.commit_sha,
      });
      let cleaned = false;
      if (input.cleanup !== false && landed.conflicts.length === 0) {
        try {
          await workspaceService.discard(workspace.workspace_id, { deleteBranch: true });
          cleaned = true;
        } catch {
          cleaned = false;
        }
      }
      results.push({
        relayId,
        deliveryId: delivery.delivery_id,
        commitSha: landed.commit_sha,
        applied: landed.applied.length,
        merged: landed.merged,
        conflicts: landed.conflicts,
        leftUncommitted: landed.leftUncommitted,
        cleanedUp: cleaned,
      });
    }
    return { landed: results };
  },

  /** Discard a writer's worktree and branch without landing it. */
  async discard(input: { relayId: string; scope: AgentRelayScope }) {
    const job = requireJob(input.relayId, input.scope);
    const workspace = workspaceService.get(job.workspace_id!);
    if (!workspace) throw conflict('Workspace already removed.');
    await workspaceService.discard(workspace.workspace_id, { deleteBranch: workspace.mode === 'git_worktree' });
    return { discarded: true, workspaceId: workspace.workspace_id };
  },

  recordRecovery(input: { relayId: string; scope: AgentRelayScope; action: 'inspect' | 'resume_read_only' | 'leave_for_review'; result: Record<string, unknown> }) {
    const job = agentRelayDb.get(input.relayId);
    if (!job || !inScope(job, input.scope)) {
      throw new AppError('Relay job not found in this lead session.', { code: 'RELAY_NOT_FOUND', statusCode: 404 });
    }
    const record: RelayDeliveryRecord = relayDeliveryDb.create({
      project_id: job.project_id,
      source_session_id: job.source_session_id,
      kind: 'recover',
      workspace_ids: job.workspace_id ? [job.workspace_id] : [],
      tips: {},
      base_sha: null,
      result: { action: input.action, ...input.result },
      passed: false,
      landed_sha: null,
    });
    return record;
  },

  /** Delivery state of every writer in a batch, for summaries and the UI. */
  deliveryState(job: AgentRelayJob): AgentRelayDeliveryState | null {
    if (job.mode !== 'isolated_write' || !job.workspace_id) return null;
    const records = relayDeliveryDb.list({ projectId: job.project_id, limit: 200 })
      .filter((record) => record.workspace_ids.includes(job.workspace_id!));
    const workspace = workspaceService.get(job.workspace_id);
    const verify = records.find((record) => record.kind === 'verify') ?? null;
    const rehearse = records.find((record) => record.kind === 'rehearse') ?? null;
    const land = records.find((record) => record.kind === 'land') ?? null;
    const stage: AgentRelayDeliveryState['stage'] = land
      ? 'landed'
      : workspace?.status === 'discarded'
        ? 'discarded'
        : rehearse?.passed
          ? 'ready_to_land'
          : rehearse
            ? 'rehearsal_failed'
            : verify?.passed
              ? 'verified'
              : verify
                ? 'verify_failed'
                : 'pending';
    return {
      stage,
      verifyId: verify?.delivery_id ?? null,
      verifyPassed: verify ? verify.passed : null,
      rehearsalId: rehearse?.delivery_id ?? null,
      rehearsalPassed: rehearse ? rehearse.passed : null,
      landId: land?.delivery_id ?? null,
      landedSha: land?.landed_sha ?? null,
    };
  },
};

export type AutoDeliverySettings = {
  autoVerify: boolean;
  autoRehearse: boolean;
  autoLand: 'off' | 'on_pass';
};

export type AutoDeliveryOutcome = {
  batchId: string;
  verified: Array<{ relayId: string; passed: boolean; deliveryId: string }>;
  rehearsal: { deliveryId: string; passed: boolean; outcome: string; relayIds: string[] } | null;
  landed: Awaited<ReturnType<typeof relayDeliveryService.land>> | null;
  error?: string;
};

const deliveryChains = new Map<string, Promise<unknown>>();

/** Serialize auto-delivery per project: host checks are heavy and share the primary. */
function serialized<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = deliveryChains.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  deliveryChains.set(projectId, next.finally(() => {
    if (deliveryChains.get(projectId) === next) deliveryChains.delete(projectId);
  }));
  return next;
}

/**
 * Writers in a batch that no other writer of the batch builds on. A stacked
 * stage's range already contains its predecessors' changes, so only leaves
 * are rehearsed and landed.
 */
function leafWriters(batchJobs: AgentRelayJob[]): AgentRelayJob[] {
  const writers = batchJobs.filter((job) => job.mode === 'isolated_write' && job.workspace_id);
  const builtOn = new Set(writers.flatMap((job) => job.depends_on));
  return writers.filter((job) => !builtOn.has(job.relay_id));
}

/**
 * Server-side continuation after a writer finishes, so a lead that is idle,
 * out of quota, or gone does not stall delivery: verify this writer, and once
 * its whole batch has settled, rehearse the batch's deliverable leaf writers
 * together and (only if the operator opted in) land a passing rehearsal.
 */
export async function autoDeliverAfterWriter(
  relayId: string,
  settings: AutoDeliverySettings,
): Promise<AutoDeliveryOutcome | null> {
  const job = agentRelayDb.get(relayId);
  if (!job || job.mode !== 'isolated_write' || !job.workspace_id || !settings.autoVerify) return null;
  return serialized(job.project_id, async () => {
    const scope: AgentRelayScope = { allowUnscoped: true };
    const outcome: AutoDeliveryOutcome = { batchId: job.batch_id, verified: [], rehearsal: null, landed: null };
    try {
      const current = agentRelayDb.get(relayId);
      if (current && isDeliverable(current)) {
        const workspace = workspaceService.get(current.workspace_id!);
        if (workspace?.mode === 'git_worktree' && workspace.status !== 'discarded') {
          const tip = await committedTip(workspace);
          if (!latestVerification(current.project_id, workspace.workspace_id, tip)) {
            const verified = await relayDeliveryService.verify({ relayId, scope });
            outcome.verified.push({ relayId, passed: verified.passed, deliveryId: verified.deliveryId });
          }
        }
      }
      if (!settings.autoRehearse) return outcome;

      const batch = agentRelayDb.list({ projectId: job.project_id, limit: 500 }).filter((candidate) => candidate.batch_id === job.batch_id);
      if (batch.some((candidate) => !['completed', 'blocked', 'failed', 'cancelled', 'timed_out'].includes(candidate.status))) {
        return outcome; // The batch is still running; the last writer to finish rehearses.
      }
      const landed = landedWorkspaceIds(job.project_id);
      const leaves = leafWriters(batch).filter((candidate) => isDeliverable(candidate) && !landed.has(candidate.workspace_id!));
      if (leaves.length === 0) return outcome;
      for (const leaf of leaves) {
        const workspace = workspaceService.get(leaf.workspace_id!);
        if (!workspace || workspace.mode !== 'git_worktree') return outcome;
        const record = latestVerification(leaf.project_id, workspace.workspace_id, await committedTip(workspace));
        if (!record?.passed) return outcome; // Only rehearse writers that verified.
      }
      const rehearsed = await relayDeliveryService.rehearse({
        projectId: job.project_id,
        relayIds: leaves.map((leaf) => leaf.relay_id),
        scope,
      });
      outcome.rehearsal = {
        deliveryId: rehearsed.deliveryId,
        passed: rehearsed.passed,
        outcome: rehearsed.outcome,
        relayIds: leaves.map((leaf) => leaf.relay_id),
      };
      if (rehearsed.passed && settings.autoLand === 'on_pass') {
        outcome.landed = await relayDeliveryService.land({ rehearsalId: rehearsed.deliveryId, scope });
      }
    } catch (error) {
      outcome.error = error instanceof Error ? error.message : String(error);
    }
    return outcome;
  });
}

export type AgentRelayDeliveryState = {
  stage: 'pending' | 'verified' | 'verify_failed' | 'ready_to_land' | 'rehearsal_failed' | 'landed' | 'discarded';
  verifyId: string | null;
  verifyPassed: boolean | null;
  rehearsalId: string | null;
  rehearsalPassed: boolean | null;
  landId: string | null;
  landedSha: string | null;
};
