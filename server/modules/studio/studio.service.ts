import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { runStudioGenerate, VARIANT_DIRECTIONS } from '@/modules/studio/studio.generate.js';
import { newStudioVariantId, newStudioVersionId } from '@/modules/studio/studio.ids.js';
import {
  getStudioSeats,
  saveStudioSeats,
  seatsToRoster,
  type StudioSeatProfile,
} from '@/modules/studio/studio.profiles.js';
import { CLICKABLE_PROTOTYPE_SKILL } from '@/modules/studio/studio.skill.js';
import {
  findVariant,
  HTML_FILE,
  HANDOFF_FILE,
  listVariants,
  listVersionDetails,
  NOTES_FILE,
  readLegacyManifest,
  readManifest,
  readRootArtifacts,
  readTokens,
  readVersionDetail,
  replaceVariants,
  STUDIO_DIR,
  walkVersionChain,
  writeActiveArtifacts,
  writeManifest,
  writeTokens,
  writeUtf8,
  writeVersion,
} from '@/modules/studio/studio.storage.js';
import {
  starterHandoff,
  starterNotes,
  starterPrototypeHtml,
} from '@/modules/studio/studio.templates.js';
import { defaultTokensForBrief, mergeStudioTokens } from '@/modules/studio/studio.tokens.js';
import { STUDIO_FORMAT } from '@/modules/studio/studio.types.js';
import type {
  AppendStudioTurnInput,
  CreateStudioPrototypeInput,
  GenerateStudioVariantsInput,
  StudioDesignTokens,
  StudioGenerateRequest,
  StudioGenerationProgress,
  StudioPrototype,
  StudioPrototypeDetail,
  StudioSelectedElement,
  StudioVariant,
  StudioVersion,
  StudioVersionDetail,
  UpdateStudioPrototypeInput,
  UpdateStudioTokensInput,
} from '@/modules/studio/studio.types.js';
import { swarmService, type SwarmAgentSpec } from '@/modules/swarm/index.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { newPrototypeId } from '@/shared/ids.js';
import { AppError } from '@/shared/utils.js';

export function designStudioRoster(): SwarmAgentSpec[] {
  return seatsToRoster();
}

const watching = new Set<string>();
const inFlight = new Map<string, Promise<void>>();
const prototypeLocks = new Map<string, Promise<unknown>>();

const PROMOTE_FILES = [HTML_FILE, NOTES_FILE, HANDOFF_FILE] as const;
const MAX_VARIANTS = 5;
const MIN_VARIANTS = 1;
const DEFAULT_VARIANTS = 3;

function jobKey(projectId: string, prototypeId: string): string {
  return `${projectId}:${prototypeId}`;
}

export async function waitForStudioGeneration(projectId?: string, prototypeId?: string): Promise<void> {
  if (projectId && prototypeId) {
    const pending = inFlight.get(jobKey(projectId, prototypeId));
    if (pending) await pending;
    return;
  }
  await Promise.all([...inFlight.values()]);
}

function trackJob(projectId: string, prototypeId: string, work: () => Promise<void>): void {
  const key = jobKey(projectId, prototypeId);
  const running = work().finally(() => {
    if (inFlight.get(key) === running) inFlight.delete(key);
  });
  inFlight.set(key, running);
}

/**
 * Serializes check-then-act reservation of `status: generating` per prototype.
 * The lock is not held for the duration of generation — only for the busy check
 * plus the generating-state write — so a second caller either waits briefly and
 * then sees STUDIO_BUSY, or proceeds after the first job has finished.
 */
async function withPrototypeLock<T>(
  projectId: string,
  prototypeId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = jobKey(projectId, prototypeId);
  const previous = prototypeLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const queued = run.catch(() => undefined);
  prototypeLocks.set(key, queued);
  try {
    return await run;
  } finally {
    if (prototypeLocks.get(key) === queued) {
      prototypeLocks.delete(key);
    }
  }
}

function watchSwarm(projectId: string, prototypeId: string, swarmId: string): void {
  if (watching.has(swarmId)) return;
  watching.add(swarmId);
  const tick = async () => {
    try {
      const swarm = swarmService.get(swarmId);
      const status = swarm?.status;
      if (status === 'succeeded') {
        await promotePrototypeFromSwarm(projectId, prototypeId);
        await ingestRootIfNewer(projectId, prototypeId, 'Design swarm');
        await studioService.update(projectId, prototypeId, {
          status: 'ready',
          generation: null,
        });
        watching.delete(swarmId);
        return;
      }
      if (status === 'failed' || status === 'aborted') {
        await studioService.update(projectId, prototypeId, {
          status: 'failed',
          generation: {
            kind: 'swarm',
            startedAt: new Date().toISOString(),
            message: null,
            error: `Design swarm ${status}`,
          },
        });
        watching.delete(swarmId);
        return;
      }
    } catch {
      // keep polling until the swarm row exists or finishes
    }
    setTimeout(() => {
      void tick();
    }, 4000);
  };
  setTimeout(() => {
    void tick();
  }, 4000);
}

function projectPathForId(projectId: string): string {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new AppError(`Project not found: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }
  return path.resolve(projectPath);
}

function studioRoot(projectPath: string): string {
  return path.join(projectPath, STUDIO_DIR);
}

function protoDir(projectPath: string, id: string): string {
  if (!/^[a-z0-9_-]+$/i.test(id)) {
    throw new AppError('Invalid prototype id', { code: 'STUDIO_INVALID_ID', statusCode: 400 });
  }
  return path.join(studioRoot(projectPath), id);
}

function nowIso(): string {
  return new Date().toISOString();
}

function titleFromBrief(brief: string): string {
  const line = brief.split('\n').map((part) => part.trim()).find(Boolean) ?? 'Untitled prototype';
  return line.slice(0, 80);
}

function errorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Design swarms write inside an isolated worktree. Studio preview reads the
 * project checkout. Copy prototype files across when the worktree copy is
 * newer or a different size so the iframe is not stuck on the starter stub.
 */
export async function promotePrototypeFromWorkspace(
  destDir: string,
  workspaceRoot: string,
  prototypeId: string,
): Promise<boolean> {
  const srcDir = path.join(workspaceRoot, STUDIO_DIR, prototypeId);
  let copied = false;
  for (const file of PROMOTE_FILES) {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    let srcInfo;
    try {
      srcInfo = await stat(src);
    } catch {
      continue;
    }
    if (!srcInfo.isFile()) continue;
    let destInfo;
    try {
      destInfo = await stat(dest);
    } catch {
      destInfo = null;
    }
    const stale = !destInfo
      || srcInfo.size !== destInfo.size
      || srcInfo.mtimeMs > destInfo.mtimeMs + 5;
    if (!stale) continue;
    await mkdir(destDir, { recursive: true });
    await copyFile(src, dest);
    copied = true;
  }
  return copied;
}

async function promotePrototypeFromSwarm(projectId: string, prototypeId: string): Promise<void> {
  const projectPath = projectPathForId(projectId);
  const destDir = protoDir(projectPath, prototypeId);
  const manifest = await readManifest(destDir);
  if (!manifest?.swarmId) return;
  const swarm = swarmService.get(manifest.swarmId);
  if (!swarm?.workspace_id) return;
  try {
    const workPath = workspaceService.resolveCwd(swarm.workspace_id);
    await promotePrototypeFromWorkspace(destDir, workPath, prototypeId);
  } catch {
    // worktree may already be discarded; leave checkout files as-is
  }
}

async function ensureSkill(projectPath: string): Promise<void> {
  const skillPath = path.join(studioRoot(projectPath), '_skill', 'clickable-prototype', 'SKILL.md');
  await writeUtf8(skillPath, CLICKABLE_PROTOTYPE_SKILL);
}

function requireManifest(manifest: StudioPrototype | null): StudioPrototype {
  if (!manifest) {
    throw new AppError('Prototype not found', { code: 'STUDIO_NOT_FOUND', statusCode: 404 });
  }
  return manifest;
}

function assertNotBusy(manifest: StudioPrototype): void {
  if (manifest.status === 'generating') {
    throw new AppError('Prototype is already generating', {
      code: 'STUDIO_BUSY',
      statusCode: 409,
    });
  }
}

async function loadActiveVersion(dir: string, manifest: StudioPrototype): Promise<StudioVersionDetail> {
  const active = await readVersionDetail(dir, manifest.activeVersionId);
  if (active) return active;
  const versions = await listVersionDetails(dir);
  if (versions.length === 0) {
    throw new AppError('Prototype has no versions', {
      code: 'STUDIO_VERSION_NOT_FOUND',
      statusCode: 404,
    });
  }
  return versions[versions.length - 1];
}

async function toDetail(
  dir: string,
  manifest: StudioPrototype,
  options: { liveRoot?: boolean } = {},
): Promise<StudioPrototypeDetail> {
  const versions = await listVersionDetails(dir);
  const activeVersion = versions.find((version) => version.id === manifest.activeVersionId)
    ?? await loadActiveVersion(dir, manifest);
  const tokens = await readTokens(dir, defaultTokensForBrief(manifest.brief));
  const variants = await listVariants(dir, activeVersion.id);
  const root = options.liveRoot ? await readRootArtifacts(dir) : null;
  const html = root?.html || activeVersion.html;
  const notes = root?.notes || activeVersion.notes;
  const handoff = root?.handoff || activeVersion.handoff;
  return {
    ...manifest,
    html,
    notes,
    handoff,
    tokens,
    versions,
    activeVersion,
    variants,
  };
}

async function persistVersion(
  dir: string,
  manifest: StudioPrototype,
  version: StudioVersion,
  artifacts: { html: string; notes: string; handoff: string },
  extras: Partial<StudioPrototype> = {},
): Promise<StudioPrototype> {
  // Additive version files first, then convenience root copies. The manifest
  // pointer is the commit: write it last so a mid-write crash leaves the
  // previously active version intact and readable.
  await writeVersion(dir, version, artifacts);
  await writeActiveArtifacts(dir, artifacts);
  const next: StudioPrototype = {
    ...manifest,
    ...extras,
    activeVersionId: version.id,
    updatedAt: nowIso(),
  };
  await writeManifest(dir, next);
  return next;
}

function legacyString(row: Record<string, unknown>, key: string, fallback: string): string {
  return typeof row[key] === 'string' && row[key] ? row[key] : fallback;
}

function legacyStatus(value: unknown): StudioPrototype['status'] {
  return value === 'draft' || value === 'generating' || value === 'ready' || value === 'failed'
    ? value
    : 'draft';
}

/**
 * Upgrade the original flat Studio layout on first read. The root artifacts
 * remain untouched and become the initial immutable version snapshot.
 */
async function readOrMigrateManifest(dir: string): Promise<StudioPrototype | null> {
  const current = await readManifest(dir);
  if (current) return current;

  const legacy = await readLegacyManifest(dir);
  if (!legacy) return null;

  const id = legacyString(legacy, 'id', path.basename(dir));
  const projectId = legacyString(legacy, 'projectId', '');
  if (!projectId) return null;

  const brief = legacyString(legacy, 'brief', 'Untitled prototype');
  const title = legacyString(legacy, 'title', titleFromBrief(brief));
  const createdAt = legacyString(legacy, 'createdAt', nowIso());
  const updatedAt = legacyString(legacy, 'updatedAt', createdAt);
  const relativeDir = legacyString(legacy, 'relativeDir', path.join(STUDIO_DIR, id));
  const version: StudioVersion = {
    id: newStudioVersionId(),
    parentVersionId: null,
    kind: 'initial',
    message: brief,
    selectedElement: null,
    createdAt,
    variantIds: [],
  };
  const status = legacyStatus(legacy.status);
  const swarmId = typeof legacy.swarmId === 'string' ? legacy.swarmId : null;
  const manifest: StudioPrototype = {
    format: STUDIO_FORMAT,
    id,
    projectId,
    title,
    brief,
    skills: Array.isArray(legacy.skills)
      ? legacy.skills.filter((skill): skill is string => typeof skill === 'string')
      : [],
    status,
    relativeDir,
    htmlRelativePath: legacyString(legacy, 'htmlRelativePath', path.join(relativeDir, HTML_FILE)),
    notesRelativePath: legacyString(legacy, 'notesRelativePath', path.join(relativeDir, NOTES_FILE)),
    handoffRelativePath: legacyString(legacy, 'handoffRelativePath', path.join(relativeDir, HANDOFF_FILE)),
    swarmId,
    activeVersionId: version.id,
    generation: status === 'generating'
      ? {
          kind: swarmId ? 'swarm' : 'turn',
          startedAt: updatedAt,
          message: brief,
          error: null,
        }
      : null,
    createdAt,
    updatedAt,
  };
  const artifacts = await readRootArtifacts(dir);
  const tokens = await readTokens(dir, defaultTokensForBrief(brief));
  await writeTokens(dir, tokens);
  await writeVersion(dir, version, artifacts);
  await writeManifest(dir, manifest);
  return manifest;
}

function historyFromChain(chain: StudioVersionDetail[]): StudioGenerateRequest['history'] {
  return chain.map((version) => ({ kind: version.kind, message: version.message }));
}

function buildGenerateInput(args: {
  projectPath: string;
  manifest: StudioPrototype;
  tokens: StudioDesignTokens;
  parent: StudioVersionDetail;
  versions: StudioVersionDetail[];
  message: string;
  selectedElement?: StudioSelectedElement | null;
  variantDirection?: { label: string; direction: string } | null;
}): StudioGenerateRequest {
  const chain = walkVersionChain(args.versions, args.parent.id);
  return {
    projectPath: args.projectPath,
    brief: args.manifest.brief,
    title: args.manifest.title,
    message: args.message,
    history: [
      ...historyFromChain(chain),
      { kind: 'turn', message: args.message },
    ],
    tokens: args.tokens,
    parentHtml: args.parent.html,
    parentNotes: args.parent.notes,
    parentHandoff: args.parent.handoff,
    selectedElement: args.selectedElement ?? null,
    variantDirection: args.variantDirection ?? null,
    skills: args.manifest.skills,
  };
}

async function ingestRootIfNewer(
  projectId: string,
  prototypeId: string,
  message: string,
): Promise<void> {
  const projectPath = projectPathForId(projectId);
  const dir = protoDir(projectPath, prototypeId);
  const manifest = await readManifest(dir);
  if (!manifest) return;
  if (manifest.status !== 'ready') return;
  const root = await readRootArtifacts(dir);
  const active = await readVersionDetail(dir, manifest.activeVersionId);
  if (active && active.html === root.html && active.notes === root.notes && active.handoff === root.handoff) {
    return;
  }
  const version: StudioVersion = {
    id: newStudioVersionId(),
    parentVersionId: manifest.activeVersionId,
    kind: 'turn',
    message,
    selectedElement: null,
    createdAt: nowIso(),
    variantIds: [],
  };
  await persistVersion(dir, manifest, version, root);
}

export function buildIdeatePrompt(proto: StudioPrototype): string {
  return [
    `You are designing a clickable prototype in CloudCLI Studio.`,
    `Work only in \`${proto.relativeDir}\`. Edits there are the source-of-truth diff for this job.`,
    `Do not explore or rewrite the host CloudCLI application.`,
    `Replace \`${proto.htmlRelativePath}\` with a self-contained HTML prototype that matches the brief — not a generic three-card shell.`,
    `Keep \`${proto.notesRelativePath}\` and \`${proto.handoffRelativePath}\` current.`,
    `Honor design tokens in \`${path.join(proto.relativeDir, 'tokens.json')}\`.`,
    `Use the clickable-prototype skill.`,
    proto.skills.length ? `Also use these skills: ${proto.skills.join(', ')}.` : '',
    `Plan as two steps only: builder writes the HTML, reviewer walks every click.`,
    ``,
    `Brief:`,
    proto.brief,
  ].filter(Boolean).join('\n');
}

async function markGenerating(
  dir: string,
  manifest: StudioPrototype,
  generation: StudioGenerationProgress,
): Promise<StudioPrototype> {
  const next: StudioPrototype = {
    ...manifest,
    status: 'generating',
    generation,
    updatedAt: nowIso(),
  };
  await writeManifest(dir, next);
  return next;
}

async function markFailed(
  projectId: string,
  prototypeId: string,
  generation: StudioGenerationProgress,
): Promise<void> {
  const projectPath = projectPathForId(projectId);
  const dir = protoDir(projectPath, prototypeId);
  const manifest = await readManifest(dir);
  if (!manifest) return;
  if (manifest.status !== 'generating' || manifest.generation?.startedAt !== generation.startedAt) return;
  await writeManifest(dir, {
    ...manifest,
    status: 'failed',
    generation,
    updatedAt: nowIso(),
  });
}

async function reconcileInterruptedGeneration(
  projectId: string,
  prototypeId: string,
  dir: string,
  manifest: StudioPrototype,
): Promise<StudioPrototype> {
  if (manifest.status !== 'generating' || inFlight.has(jobKey(projectId, prototypeId))) {
    return manifest;
  }

  if (manifest.generation?.kind === 'swarm' && manifest.swarmId) {
    const swarmStatus = swarmService.get(manifest.swarmId)?.status;
    if (swarmStatus === 'succeeded') {
      await promotePrototypeFromSwarm(projectId, prototypeId);
      const ready = { ...manifest, status: 'ready' as const, generation: null, updatedAt: nowIso() };
      await writeManifest(dir, ready);
      await ingestRootIfNewer(projectId, prototypeId, 'Design swarm');
      return requireManifest(await readManifest(dir));
    }
    if (swarmStatus !== 'failed' && swarmStatus !== 'aborted') {
      watchSwarm(projectId, prototypeId, manifest.swarmId);
      return manifest;
    }
  }

  const failed: StudioPrototype = {
    ...manifest,
    status: 'failed',
    generation: {
      ...(manifest.generation ?? {
        kind: 'turn',
        startedAt: manifest.updatedAt,
        message: null,
      }),
      error: manifest.generation?.kind === 'swarm'
        ? 'Design swarm stopped before completion'
        : 'Generation was interrupted by a server restart',
    },
    updatedAt: nowIso(),
  };
  await writeManifest(dir, failed);
  return failed;
}

export const studioService = {
  designStudioRoster,

  getSeats(): StudioSeatProfile[] {
    return getStudioSeats();
  },

  saveSeats(input: unknown): StudioSeatProfile[] {
    return saveStudioSeats(input);
  },

  async list(projectId: string): Promise<StudioPrototype[]> {
    const projectPath = projectPathForId(projectId);
    const root = studioRoot(projectPath);
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }

    const items: StudioPrototype[] = [];
    for (const name of entries) {
      if (name.startsWith('_')) continue;
      const manifest = await readOrMigrateManifest(path.join(root, name));
      if (manifest) items.push(manifest);
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return items;
  },

  async get(projectId: string, id: string): Promise<StudioPrototypeDetail> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const manifest = requireManifest(await readOrMigrateManifest(dir));
    await promotePrototypeFromSwarm(projectId, id);
    const latest = requireManifest(await readManifest(dir));
    const reconciled = await reconcileInterruptedGeneration(projectId, id, dir, latest);
    if (reconciled.status === 'generating') {
      return toDetail(dir, reconciled, { liveRoot: true });
    }
    await ingestRootIfNewer(projectId, id, 'Imported prototype files');
    const ready = requireManifest(await readManifest(dir));
    return toDetail(dir, ready);
  },

  async create(input: CreateStudioPrototypeInput): Promise<StudioPrototypeDetail> {
    const brief = input.brief.trim();
    if (!brief) {
      throw new AppError('Brief is required', { code: 'STUDIO_BRIEF_REQUIRED', statusCode: 400 });
    }

    const projectPath = projectPathForId(input.projectId);
    await ensureSkill(projectPath);

    const id = newPrototypeId();
    const dir = protoDir(projectPath, id);
    const title = (input.title || titleFromBrief(brief)).trim();
    const createdAt = nowIso();
    const relativeDir = path.join(STUDIO_DIR, id);
    const tokens = mergeStudioTokens(defaultTokensForBrief(brief), input.tokens);
    const versionId = newStudioVersionId();
    const html = starterPrototypeHtml(title, brief, tokens);
    const notes = starterNotes(title, brief);
    const handoff = starterHandoff(title);

    const version: StudioVersion = {
      id: versionId,
      parentVersionId: null,
      kind: 'initial',
      message: brief,
      selectedElement: null,
      createdAt,
      variantIds: [],
    };

    const manifest: StudioPrototype = {
      format: STUDIO_FORMAT,
      id,
      projectId: input.projectId,
      title,
      brief,
      skills: input.skills ?? [],
      status: 'ready',
      relativeDir,
      htmlRelativePath: path.join(relativeDir, HTML_FILE),
      notesRelativePath: path.join(relativeDir, NOTES_FILE),
      handoffRelativePath: path.join(relativeDir, HANDOFF_FILE),
      swarmId: null,
      activeVersionId: versionId,
      generation: null,
      createdAt,
      updatedAt: createdAt,
    };

    await writeTokens(dir, tokens);
    await persistVersion(dir, manifest, version, { html, notes, handoff });
    return this.get(input.projectId, id);
  },

  async update(
    projectId: string,
    id: string,
    patch: UpdateStudioPrototypeInput,
  ): Promise<StudioPrototypeDetail> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const current = requireManifest(await readOrMigrateManifest(dir));

    const hasArtifacts = typeof patch.html === 'string'
      || typeof patch.notes === 'string'
      || typeof patch.handoff === 'string';
    if (hasArtifacts) assertNotBusy(current);

    const next: StudioPrototype = {
      ...current,
      title: patch.title?.trim() || current.title,
      brief: patch.brief?.trim() || current.brief,
      skills: patch.skills ?? current.skills,
      status: patch.status ?? current.status,
      swarmId: patch.swarmId === undefined ? current.swarmId : patch.swarmId,
      generation: patch.generation === undefined ? current.generation : patch.generation,
      activeVersionId: patch.activeVersionId ?? current.activeVersionId,
      updatedAt: nowIso(),
    };

    if (hasArtifacts) {
      const active = await loadActiveVersion(dir, current);
      const artifacts = {
        html: typeof patch.html === 'string' ? patch.html : active.html,
        notes: typeof patch.notes === 'string' ? patch.notes : active.notes,
        handoff: typeof patch.handoff === 'string' ? patch.handoff : active.handoff,
      };
      const version: StudioVersion = {
        id: newStudioVersionId(),
        parentVersionId: current.activeVersionId,
        kind: 'turn',
        message: 'Manual edit',
        selectedElement: null,
        createdAt: nowIso(),
        variantIds: [],
      };
      await persistVersion(dir, next, version, artifacts);
    } else {
      await writeManifest(dir, next);
    }
    return this.get(projectId, id);
  },

  async remove(projectId: string, id: string): Promise<void> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const manifest = requireManifest(await readOrMigrateManifest(dir));
    assertNotBusy(manifest);
    await rm(dir, { recursive: true, force: true });
  },

  async launchSwarm(projectId: string, prototypeId: string) {
    const proto = await this.get(projectId, prototypeId);
    assertNotBusy(proto);
    const swarm = swarmService.start({
      projectId,
      goal: buildIdeatePrompt(proto),
      agents: designStudioRoster(),
      skills: ['clickable-prototype', ...proto.skills],
      requirePlanApproval: false,
      validateBeforePr: false,
      prOnRedValidation: false,
      parallelWriters: false,
      stallTimeoutMs: 12 * 60 * 1000,
      stepTimeoutMs: 18 * 60 * 1000,
      stepMaxAttempts: 2,
    });
    await this.update(projectId, prototypeId, {
      status: 'generating',
      swarmId: swarm.swarm_id,
      generation: {
        kind: 'swarm',
        startedAt: nowIso(),
        message: proto.brief,
        error: null,
      },
    });
    watchSwarm(projectId, prototypeId, swarm.swarm_id);
    return { swarmId: swarm.swarm_id, prototype: await this.get(projectId, prototypeId) };
  },

  async getTokens(projectId: string, id: string): Promise<StudioDesignTokens> {
    const detail = await this.get(projectId, id);
    return detail.tokens;
  },

  async updateTokens(
    projectId: string,
    id: string,
    input: UpdateStudioTokensInput,
  ): Promise<StudioPrototypeDetail> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const manifest = requireManifest(await readOrMigrateManifest(dir));
    assertNotBusy(manifest);
    const currentTokens = await readTokens(dir, defaultTokensForBrief(manifest.brief));
    const tokens = mergeStudioTokens(currentTokens, input.tokens);
    await writeTokens(dir, tokens);
    await writeManifest(dir, { ...manifest, updatedAt: nowIso() });
    if (input.regenerate === false) {
      return this.get(projectId, id);
    }
    return this.appendTurn(projectId, id, {
      message: 'Apply updated design tokens',
    });
  },

  async appendTurn(
    projectId: string,
    id: string,
    input: AppendStudioTurnInput,
  ): Promise<StudioPrototypeDetail> {
    const message = input.message.trim();
    if (!message) {
      throw new AppError('Message is required', { code: 'STUDIO_MESSAGE_REQUIRED', statusCode: 400 });
    }
    return withPrototypeLock(projectId, id, async () => {
      const projectPath = projectPathForId(projectId);
      const dir = protoDir(projectPath, id);
      const manifest = requireManifest(await readOrMigrateManifest(dir));
      assertNotBusy(manifest);
      const parent = await loadActiveVersion(dir, manifest);
      const tokens = await readTokens(dir, defaultTokensForBrief(manifest.brief));
      const versions = await listVersionDetails(dir);
      const generation: StudioGenerationProgress = {
        kind: 'turn',
        startedAt: nowIso(),
        message,
        error: null,
      };
      const busy = await markGenerating(dir, manifest, generation);

      trackJob(projectId, id, async () => {
        try {
          const generated = await runStudioGenerate(buildGenerateInput({
            projectPath,
            manifest,
            tokens,
            parent,
            versions,
            message,
            selectedElement: input.selectedElement,
          }));
          await withPrototypeLock(projectId, id, async () => {
            const latest = requireManifest(await readManifest(dir));
            if (latest.activeVersionId !== parent.id || latest.generation?.startedAt !== generation.startedAt) {
              throw new AppError('Prototype changed while generation was running', {
                code: 'STUDIO_GENERATE_CONFLICT',
                statusCode: 409,
              });
            }
            const version: StudioVersion = {
              id: newStudioVersionId(),
              parentVersionId: parent.id,
              kind: 'turn',
              message,
              selectedElement: input.selectedElement ?? null,
              createdAt: nowIso(),
              variantIds: [],
            };
            await persistVersion(dir, latest, version, generated, {
              status: 'ready',
              generation: null,
            });
          });
        } catch (error) {
          await markFailed(projectId, id, {
            ...generation,
            error: errorMessage(error),
          });
        }
      });

      return toDetail(dir, busy, { liveRoot: true });
    });
  },

  async generateVariants(
    projectId: string,
    id: string,
    input: GenerateStudioVariantsInput = {},
  ): Promise<StudioPrototypeDetail> {
    return withPrototypeLock(projectId, id, async () => {
      const projectPath = projectPathForId(projectId);
      const dir = protoDir(projectPath, id);
      const manifest = requireManifest(await readOrMigrateManifest(dir));
      assertNotBusy(manifest);
      const parent = await loadActiveVersion(dir, manifest);
      const message = (input.message ?? parent.message).trim();
      if (!message) {
        throw new AppError('Message is required', { code: 'STUDIO_MESSAGE_REQUIRED', statusCode: 400 });
      }
      const requested = input.count ?? DEFAULT_VARIANTS;
      if (!Number.isFinite(requested) || requested < MIN_VARIANTS) {
        throw new AppError('Variant count must be a positive integer', {
          code: 'STUDIO_VARIANT_COUNT',
          statusCode: 400,
        });
      }
      const count = Math.min(MAX_VARIANTS, Math.max(MIN_VARIANTS, Math.trunc(requested)));
      const tokens = await readTokens(dir, defaultTokensForBrief(manifest.brief));
      const versions = await listVersionDetails(dir);
      const generation: StudioGenerationProgress = {
        kind: 'variants',
        startedAt: nowIso(),
        message,
        error: null,
        variantCount: count,
      };
      const busy = await markGenerating(dir, manifest, generation);

      trackJob(projectId, id, async () => {
        try {
          const directions = VARIANT_DIRECTIONS.slice(0, count);
          const variants: StudioVariant[] = [];
          for (const direction of directions) {
            const generated = await runStudioGenerate(buildGenerateInput({
              projectPath,
              manifest,
              tokens,
              parent,
              versions,
              message,
              selectedElement: input.selectedElement,
              variantDirection: direction,
            }));
            variants.push({
              id: newStudioVariantId(),
              versionId: parent.id,
              label: direction.label,
              direction: direction.direction,
              createdAt: nowIso(),
              ...generated,
            });
          }
          await withPrototypeLock(projectId, id, async () => {
            const latest = requireManifest(await readManifest(dir));
            if (latest.activeVersionId !== parent.id || latest.generation?.startedAt !== generation.startedAt) {
              throw new AppError('Prototype changed while variants were generating', {
                code: 'STUDIO_GENERATE_CONFLICT',
                statusCode: 409,
              });
            }
            const parentMeta: StudioVersion = {
              id: parent.id,
              parentVersionId: parent.parentVersionId,
              kind: parent.kind,
              message: parent.message,
              selectedElement: parent.selectedElement,
              createdAt: parent.createdAt,
              variantIds: parent.variantIds,
              promotedFromVariantId: parent.promotedFromVariantId,
              revertedFromVersionId: parent.revertedFromVersionId,
            };
            await replaceVariants(dir, parentMeta, variants);
            await writeManifest(dir, {
              ...latest,
              status: 'ready',
              generation: null,
              updatedAt: nowIso(),
            });
          });
        } catch (error) {
          await markFailed(projectId, id, {
            ...generation,
            error: errorMessage(error),
          });
        }
      });

      return toDetail(dir, busy, { liveRoot: true });
    });
  },

  async promoteVariant(
    projectId: string,
    id: string,
    variantId: string,
  ): Promise<StudioPrototypeDetail> {
    return withPrototypeLock(projectId, id, async () => {
      const projectPath = projectPathForId(projectId);
      const dir = protoDir(projectPath, id);
      const manifest = requireManifest(await readOrMigrateManifest(dir));
      assertNotBusy(manifest);
      const variant = await findVariant(dir, variantId);
      if (!variant) {
        throw new AppError('Variant not found', { code: 'STUDIO_VARIANT_NOT_FOUND', statusCode: 404 });
      }
      const version: StudioVersion = {
        id: newStudioVersionId(),
        parentVersionId: variant.versionId,
        kind: 'variant-promotion',
        message: `Promoted variant: ${variant.label}`,
        selectedElement: null,
        createdAt: nowIso(),
        variantIds: [],
        promotedFromVariantId: variant.id,
      };
      await persistVersion(dir, manifest, version, {
        html: variant.html,
        notes: variant.notes,
        handoff: variant.handoff,
      }, { status: 'ready', generation: null });
      return this.get(projectId, id);
    });
  },

  async revertToVersion(
    projectId: string,
    id: string,
    versionId: string,
  ): Promise<StudioPrototypeDetail> {
    return withPrototypeLock(projectId, id, async () => {
      const projectPath = projectPathForId(projectId);
      const dir = protoDir(projectPath, id);
      const manifest = requireManifest(await readOrMigrateManifest(dir));
      assertNotBusy(manifest);
      const target = await readVersionDetail(dir, versionId);
      if (!target) {
        throw new AppError('Version not found', { code: 'STUDIO_VERSION_NOT_FOUND', statusCode: 404 });
      }
      const version: StudioVersion = {
        id: newStudioVersionId(),
        parentVersionId: target.id,
        kind: 'revert',
        message: `Reverted to ${target.id}`,
        selectedElement: null,
        createdAt: nowIso(),
        variantIds: [],
        revertedFromVersionId: target.id,
      };
      await persistVersion(dir, manifest, version, {
        html: target.html,
        notes: target.notes,
        handoff: target.handoff,
      }, { status: 'ready', generation: null });
      return this.get(projectId, id);
    });
  },
};
