/**
 * Studio Parallel Universes — orchestration.
 *
 * A universe explores one goal through exactly two named, independent
 * approaches. Each approach is dispatched as its own `isolated_write` Agent
 * Relay job against the real selected project repository (see
 * server/modules/agent-relay/agent-relay.service.ts `submitBatch`), which
 * already owns worker dispatch, model catalog validation, and isolated
 * workspace/branch creation. This module only coordinates: it launches jobs,
 * mirrors their status/workspace into a Studio-owned manifest, and exposes
 * diff/preview/apply actions scoped to the workspace each job produced.
 *
 * This module never merges or publishes a variant on its own — "apply" is a
 * deliberate, explicit action the caller takes via `applyVariant`.
 */

import path from 'node:path';

import { agentRelayService } from '@/modules/agent-relay/index.js';
import type { AgentRelayJob, AgentRelayStatus } from '@/modules/agent-relay/index.js';
import { projectsDb } from '@/modules/database/index.js';
import {
  reconcilePreviewState,
  startPreview as startPreviewProcess,
  stopPreview as stopPreviewProcess,
} from '@/modules/studio/studio-universes.preview.js';
import {
  listUniverseManifests,
  readUniverseManifest,
  removeUniverse,
  universeDir,
  writeUniverseManifest,
} from '@/modules/studio/studio-universes.storage.js';
import {
  STOPPED_PREVIEW,
  STUDIO_UNIVERSE_FORMAT,
  type ApplyUniverseVariantInput,
  type CreateStudioUniverseInput,
  type StartUniversePreviewInput,
  type StudioUniverse,
  type UniverseAppliedRecord,
  type UniverseDiffResult,
  type UniverseStatus,
  type UniverseVariant,
  type UniverseVariantStatus,
} from '@/modules/studio/studio-universes.types.js';
import { newStudioUniverseId, newStudioUniverseVariantId } from '@/modules/studio/studio.ids.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { AppError } from '@/shared/utils.js';
import type { LLMProvider } from '@/shared/types.js';

const MAX_GOAL_CHARS = 4_000;
const MAX_APPROACH_CHARS = 4_000;
const MAX_LABEL_CHARS = 60;

const locks = new Map<string, Promise<unknown>>();

/** Serializes read-modify-write manifest updates per universe (see studio.service.ts withPrototypeLock). */
async function withUniverseLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const queued = run.catch(() => undefined);
  locks.set(key, queued);
  try {
    return await run;
  } finally {
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function projectPathForId(projectId: string): string {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new AppError(`Project not found: ${projectId}`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
  return path.resolve(projectPath);
}

function requireUniverse(manifest: StudioUniverse | null, id: string): StudioUniverse {
  if (!manifest) {
    throw new AppError(`Universe not found: ${id}`, { code: 'STUDIO_UNIVERSE_NOT_FOUND', statusCode: 404 });
  }
  return manifest;
}

function requireVariant(universe: StudioUniverse, variantId: string): UniverseVariant {
  const variant = universe.variants.find((entry) => entry.id === variantId);
  if (!variant) {
    throw new AppError(`Variant not found: ${variantId}`, { code: 'STUDIO_UNIVERSE_VARIANT_NOT_FOUND', statusCode: 404 });
  }
  return variant;
}

function trimmed(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function statusFromJob(job: AgentRelayJob | null): UniverseVariantStatus {
  if (!job) return 'unknown';
  const status: AgentRelayStatus = job.status;
  return status;
}

function aggregateStatus(variants: UniverseVariant[]): UniverseStatus {
  if (variants.some((variant) => variant.status === 'queued' || variant.status === 'running' || variant.status === 'waiting_approval')) {
    return 'running';
  }
  const failed = variants.filter((variant) => variant.status === 'failed' || variant.status === 'cancelled' || variant.status === 'timed_out');
  if (failed.length === variants.length) return 'failed';
  if (failed.length > 0) return 'partial';
  return 'ready';
}

function buildVariantTask(goal: string, variant: { label: string; approach: string }): string {
  return [
    'You are implementing one of several parallel candidate approaches to the same goal, each in its own isolated workspace, so they can be compared side by side.',
    `Approach name: ${variant.label}`,
    '',
    'Goal:',
    goal,
    '',
    `Approach to take for this attempt (this is what must make it distinct from the other parallel attempt): ${variant.approach}`,
    '',
    'Implement the goal fully following this specific approach. Make real, working code changes in this repository (not a mock or a plan). Keep the project buildable.',
    'Add or update tests that demonstrate the change works wherever the project has a test setup, and actually run them before you report success.',
    'Report `filesTouched` and `testsRun` accurately in your result — do not claim a test passed unless you ran it and saw it pass.',
  ].join('\n');
}

function jobToVariantPatch(job: AgentRelayJob | null): Partial<UniverseVariant> {
  if (!job) return {};
  const result = job.result;
  return {
    status: statusFromJob(job),
    workspaceId: job.workspace_id,
    branch: job.result?.workspace?.featureBranch ?? workspaceBranch(job.workspace_id),
    error: job.error,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    result: result
      ? {
          summary: result.summary,
          evidence: result.evidence,
          filesTouched: result.filesTouched,
          testsRun: result.testsRun,
          openQuestions: result.openQuestions,
        }
      : null,
  };
}

function workspaceBranch(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  try {
    return workspaceService.get(workspaceId)?.feature_branch ?? null;
  } catch {
    return null;
  }
}

async function persist(projectPath: string, universe: StudioUniverse): Promise<StudioUniverse> {
  const next = { ...universe, updatedAt: nowIso() };
  await writeUniverseManifest(universeDir(projectPath, universe.id), next);
  return next;
}

/** Pull the latest Agent Relay job status/result into each variant and persist. */
async function refresh(projectId: string, projectPath: string, universe: StudioUniverse): Promise<StudioUniverse> {
  let changed = false;
  const variants = universe.variants.map((variant) => {
    if (!variant.relayId) return variant;
    const job = agentRelayService.get(variant.relayId);
    const patch = jobToVariantPatch(job);
    const preview = reconcilePreviewState(variant.id, variant.preview ?? STOPPED_PREVIEW);
    const merged: UniverseVariant = { ...variant, ...patch, preview, updatedAt: nowIso() };
    if (
      merged.status !== variant.status
      || merged.workspaceId !== variant.workspaceId
      || merged.error !== variant.error
      || JSON.stringify(merged.result) !== JSON.stringify(variant.result)
      || JSON.stringify(merged.preview) !== JSON.stringify(variant.preview)
    ) {
      changed = true;
    }
    return merged;
  });
  const status = aggregateStatus(variants);
  if (status !== universe.status) changed = true;
  if (!changed) return universe;
  return persist(projectPath, { ...universe, variants, status });
}

export const studioUniversesService = {
  async list(projectId: string): Promise<StudioUniverse[]> {
    const projectPath = projectPathForId(projectId);
    const manifests = await listUniverseManifests(projectPath);
    const refreshed: StudioUniverse[] = [];
    for (const manifest of manifests) {
      refreshed.push(await withUniverseLock(`${projectId}:${manifest.id}`, () => refresh(projectId, projectPath, manifest)));
    }
    refreshed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return refreshed;
  },

  async get(projectId: string, id: string): Promise<StudioUniverse> {
    const projectPath = projectPathForId(projectId);
    const manifest = requireUniverse(await readUniverseManifest(universeDir(projectPath, id)), id);
    return withUniverseLock(`${projectId}:${id}`, () => refresh(projectId, projectPath, manifest));
  },

  async create(input: CreateStudioUniverseInput, sourceSessionId?: string | null): Promise<StudioUniverse> {
    const goal = trimmed(input.goal, MAX_GOAL_CHARS);
    if (!goal) {
      throw new AppError('Describe the goal for this universe.', { code: 'STUDIO_UNIVERSE_GOAL_REQUIRED', statusCode: 400 });
    }
    if (!Array.isArray(input.approaches) || input.approaches.length !== 2) {
      throw new AppError('Provide exactly two named alternative approaches.', {
        code: 'STUDIO_UNIVERSE_APPROACHES_INVALID',
        statusCode: 400,
      });
    }
    const projectPath = projectPathForId(input.projectId);

    type NormalizedApproach = { label: string; approach: string; provider: LLMProvider; model: string };
    const normalizedApproaches: NormalizedApproach[] = input.approaches.map((approach, index) => {
      const label = trimmed(approach.label, MAX_LABEL_CHARS) || `Approach ${index === 0 ? 'A' : 'B'}`;
      const approachText = trimmed(approach.approach, MAX_APPROACH_CHARS);
      const provider = approach.provider;
      const model = trimmed(approach.model, 200);
      if (!approachText) {
        throw new AppError(`Describe the alternative approach for "${label}".`, {
          code: 'STUDIO_UNIVERSE_APPROACH_REQUIRED',
          statusCode: 400,
        });
      }
      if (!provider) {
        throw new AppError(`Choose a provider for "${label}".`, {
          code: 'STUDIO_UNIVERSE_PROVIDER_REQUIRED',
          statusCode: 400,
        });
      }
      if (!model) {
        throw new AppError(`Choose a model for "${label}". Explicit model selection avoids silently expensive defaults.`, {
          code: 'STUDIO_UNIVERSE_MODEL_REQUIRED',
          statusCode: 400,
        });
      }
      return { label, approach: approachText, provider, model };
    });

    // submitBatch validates providers/models against live catalogs and
    // normalizes the whole batch before writing any rows, so an invalid
    // second task cannot strand the first as an orphaned job.
    const { batchId, jobs } = await agentRelayService.submitBatch({
      projectPath,
      sourceSessionId: sourceSessionId ?? undefined,
      tasks: normalizedApproaches.map((approach) => ({
        task: buildVariantTask(goal, approach),
        label: approach.label,
        provider: approach.provider,
        model: approach.model,
        mode: 'isolated_write',
        timeoutMs: input.timeoutMs,
      })),
    });

    const createdAt = nowIso();
    const variants: UniverseVariant[] = normalizedApproaches.map((approach, index) => {
      const job = jobs[index]!;
      return {
        id: newStudioUniverseVariantId(),
        label: approach.label,
        approach: approach.approach,
        provider: approach.provider,
        model: approach.model,
        relayId: job.relay_id,
        batchId,
        workspaceId: job.workspace_id,
        branch: workspaceBranch(job.workspace_id),
        status: statusFromJob(job),
        error: job.error,
        result: null,
        preview: { ...STOPPED_PREVIEW },
        applied: null,
        createdAt,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
        updatedAt: createdAt,
      };
    });

    const universe: StudioUniverse = {
      format: STUDIO_UNIVERSE_FORMAT,
      id: newStudioUniverseId(),
      projectId: input.projectId,
      goal,
      status: aggregateStatus(variants),
      variants,
      createdAt,
      updatedAt: createdAt,
    };
    await writeUniverseManifest(universeDir(projectPath, universe.id), universe);
    return universe;
  },

  async cancelVariant(projectId: string, id: string, variantId: string): Promise<StudioUniverse> {
    return withUniverseLock(`${projectId}:${id}`, async () => {
      const projectPath = projectPathForId(projectId);
      const manifest = requireUniverse(await readUniverseManifest(universeDir(projectPath, id)), id);
      const variant = requireVariant(manifest, variantId);
      if (variant.relayId) {
        await agentRelayService.cancel(variant.relayId, { allowUnscoped: true });
      }
      return refresh(projectId, projectPath, manifest);
    });
  },

  async diffVariant(projectId: string, id: string, variantId: string, includePatch = true): Promise<UniverseDiffResult> {
    const universe = await this.get(projectId, id);
    const variant = requireVariant(universe, variantId);
    if (!variant.relayId) {
      return { files: [], summary: { additions: 0, deletions: 0 } };
    }
    const diff = await agentRelayService.diff(variant.relayId, includePatch, { allowUnscoped: true });
    return {
      files: diff.files.map((file) => ({
        path: file.path,
        status: file.status,
        patch: 'patch' in file ? file.patch : undefined,
      })),
      summary: diff.summary,
    };
  },

  async applyVariant(
    projectId: string,
    id: string,
    variantId: string,
    input: ApplyUniverseVariantInput = {},
  ): Promise<StudioUniverse> {
    return withUniverseLock(`${projectId}:${id}`, async () => {
      const projectPath = projectPathForId(projectId);
      const manifest = requireUniverse(await readUniverseManifest(universeDir(projectPath, id)), id);
      const variant = requireVariant(manifest, variantId);
      if (!variant.workspaceId) {
        throw new AppError('This variant has no workspace yet — it has not produced any changes to apply.', {
          code: 'STUDIO_UNIVERSE_NO_WORKSPACE',
          statusCode: 409,
        });
      }
      const workspace = workspaceService.get(variant.workspaceId);
      if (!workspace || workspace.project_id !== projectId) {
        throw new AppError('This variant workspace no longer belongs to this project.', {
          code: 'STUDIO_UNIVERSE_WORKSPACE_MISMATCH',
          statusCode: 409,
        });
      }
      const result = await workspaceService.applyToPrimary(variant.workspaceId, {
        commit: input.commit,
        message: input.message,
      });
      const applied: UniverseAppliedRecord = {
        at: nowIso(),
        committed: result.committed,
        commitSha: result.commit_sha,
        applied: result.applied,
        skipped: result.skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
      };
      const variants = manifest.variants.map((entry) => (entry.id === variantId ? { ...entry, applied, updatedAt: nowIso() } : entry));
      const persisted = await persist(projectPath, { ...manifest, variants });
      return refresh(projectId, projectPath, persisted);
    });
  },

  async startPreview(projectId: string, id: string, variantId: string, input: StartUniversePreviewInput): Promise<StudioUniverse> {
    return withUniverseLock(`${projectId}:${id}`, async () => {
      const projectPath = projectPathForId(projectId);
      const manifest = requireUniverse(await readUniverseManifest(universeDir(projectPath, id)), id);
      const variant = requireVariant(manifest, variantId);
      if (!variant.workspaceId) {
        throw new AppError('This variant has no workspace yet — wait for it to start running.', {
          code: 'STUDIO_UNIVERSE_NO_WORKSPACE',
          statusCode: 409,
        });
      }
      const workspace = workspaceService.get(variant.workspaceId);
      if (!workspace || workspace.project_id !== projectId) {
        throw new AppError('This variant workspace no longer belongs to this project.', {
          code: 'STUDIO_UNIVERSE_WORKSPACE_MISMATCH',
          statusCode: 409,
        });
      }
      const cwd = workspaceService.resolveCwd(variant.workspaceId);
      const preview = await startPreviewProcess(variantId, { command: input.command, cwd, port: input.port });
      const variants = manifest.variants.map((entry) => (entry.id === variantId ? { ...entry, preview, updatedAt: nowIso() } : entry));
      return persist(projectPath, { ...manifest, variants });
    });
  },

  async stopPreview(projectId: string, id: string, variantId: string): Promise<StudioUniverse> {
    return withUniverseLock(`${projectId}:${id}`, async () => {
      const projectPath = projectPathForId(projectId);
      const manifest = requireUniverse(await readUniverseManifest(universeDir(projectPath, id)), id);
      requireVariant(manifest, variantId);
      const preview = await stopPreviewProcess(variantId);
      const variants = manifest.variants.map((entry) => (entry.id === variantId ? { ...entry, preview, updatedAt: nowIso() } : entry));
      return persist(projectPath, { ...manifest, variants });
    });
  },

  async remove(projectId: string, id: string): Promise<void> {
    return withUniverseLock(`${projectId}:${id}`, async () => {
      const projectPath = projectPathForId(projectId);
      const manifest = requireUniverse(await readUniverseManifest(universeDir(projectPath, id)), id);
      await Promise.all(manifest.variants.map((variant) => stopPreviewProcess(variant.id).catch(() => undefined)));
      await removeUniverse(projectPath, id);
    });
  },
};
