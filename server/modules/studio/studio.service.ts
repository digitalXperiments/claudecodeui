import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseStudioPrototypeIds, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { runStudioGenerate, VARIANT_DIRECTIONS } from '@/modules/studio/studio.generate.js';
import { newStudioVariantId, newStudioVersionId } from '@/modules/studio/studio.ids.js';
import {
  getStudioSeats,
  saveStudioSeats,
  seatsToRoster,
  type StudioRosterSeat,
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
  readProjectTokens,
  readUtf8,
  readRootArtifacts,
  readTokens,
  readVersionDetail,
  replaceVariants,
  STUDIO_DIR,
  walkVersionChain,
  writeActiveArtifacts,
  writeManifest,
  writeProjectTokens,
  writeTokens,
  writeUtf8,
  writeVersion,
} from '@/modules/studio/studio.storage.js';
import {
  starterHandoff,
  starterNotes,
  starterPrototypeHtml,
} from '@/modules/studio/studio.templates.js';
import { DEFAULT_STUDIO_TOKENS, defaultTokensForBrief, mergeStudioTokens } from '@/modules/studio/studio.tokens.js';
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
  StudioPrototypeOrigin,
  StudioSelectedElement,
  StudioVariant,
  StudioVersion,
  StudioVersionDetail,
  UpdateStudioPrototypeInput,
  UpdateStudioTokensInput,
} from '@/modules/studio/studio.types.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { projectSkillsService } from '@/modules/providers/index.js';
import { newPrototypeId } from '@/shared/ids.js';
import { AppError } from '@/shared/utils.js';

export function designStudioRoster(): StudioRosterSeat[] {
  return seatsToRoster();
}

const watching = new Set<string>();
const inFlight = new Map<string, Promise<void>>();
const prototypeLocks = new Map<string, Promise<unknown>>();

const PROMOTE_FILES = [HTML_FILE, NOTES_FILE, HANDOFF_FILE] as const;
const MAX_VARIANTS = 5;
const MIN_VARIANTS = 1;
const DEFAULT_VARIANTS = 3;

async function importOrphanDirectories(projectId: string, projectPath: string): Promise<void> {
  const root = studioRoot(projectPath);
  let entries: string[];
  try { entries = await readdir(root); } catch { return; }
  const used = new Set(entries);
  for (const name of entries) {
    if (name.startsWith('_')) continue;
    const source = path.join(root, name);
    if (await readManifest(source) || await readLegacyManifest(source)) continue;
    try {
      const info = await stat(path.join(source, HTML_FILE));
      if (!info.isFile()) continue;
    } catch { continue; }
    let id = newPrototypeId();
    while (used.has(id)) id = newPrototypeId();
    const target = path.join(root, id);
    await rename(source, target);
    used.add(id);
    const brief = titleFromBrief(await readUtf8(path.join(target, HANDOFF_FILE), 'Imported prototype'));
    const title = titleFromBrief(brief);
    const createdAt = nowIso();
    const version: StudioVersion = {
      id: newStudioVersionId(), parentVersionId: null, kind: 'initial', message: 'Imported prototype',
      selectedElement: null, createdAt, variantIds: [],
    };
    const relativeDir = path.join(STUDIO_DIR, id);
    const manifest: StudioPrototype = {
      format: STUDIO_FORMAT, id, projectId, title, brief, origin: 'imported', originSessionId: null,
      originRunId: null, linkedSessionIds: [], skills: [], status: 'ready', relativeDir,
      htmlRelativePath: path.join(relativeDir, HTML_FILE), notesRelativePath: path.join(relativeDir, NOTES_FILE),
      handoffRelativePath: path.join(relativeDir, HANDOFF_FILE), swarmId: null, activeVersionId: version.id,
      generation: null, createdAt, updatedAt: createdAt,
    };
    const artifacts = await readRootArtifacts(target);
    const tokens = await readProjectTokens(root, DEFAULT_STUDIO_TOKENS);
    await writeTokens(target, tokens);
    await writeVersion(target, version, artifacts);
    await writeManifest(target, manifest);
  }
}

function studioOrigin(value: unknown, fallback: StudioPrototypeOrigin = 'studio'): StudioPrototypeOrigin {
  return value === 'studio' || value === 'chat' || value === 'agent' || value === 'imported' ? value : fallback;
}

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


async function ensureSkill(projectPath: string): Promise<void> {
  const skillPath = path.join(studioRoot(projectPath), '_skill', 'clickable-prototype', 'SKILL.md');
  await writeUtf8(skillPath, CLICKABLE_PROTOTYPE_SKILL);
  try {
    await projectSkillsService.addProjectSkills({
      workspacePath: projectPath,
      entries: [{ directoryName: 'clickable-prototype', content: CLICKABLE_PROTOTYPE_SKILL }],
    });
  } catch {
    // Studio's private copy remains available when no provider skill target is installed.
  }
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
  if (versions.length > 0) return versions[versions.length - 1];

  // Prototypes hand-written straight to disk (agents dropping prototype.html
  // outside the persistVersion() path) can point activeVersionId at a
  // versions/<id>/ folder that was never created. The root files are still
  // the real source of truth for what's on screen, so synthesize the missing
  // snapshot from them instead of 404ing the whole preview.
  const root = await readRootArtifacts(dir);
  if (!root.html) {
    throw new AppError('Prototype has no versions', {
      code: 'STUDIO_VERSION_NOT_FOUND',
      statusCode: 404,
    });
  }
  const synthesized: StudioVersion = {
    id: manifest.activeVersionId,
    parentVersionId: null,
    kind: 'initial',
    message: manifest.brief,
    selectedElement: null,
    createdAt: manifest.updatedAt || manifest.createdAt,
    variantIds: [],
  };
  await writeVersion(dir, synthesized, root);
  return { ...synthesized, ...root };
}

async function toDetail(
  dir: string,
  manifest: StudioPrototype,
  options: { liveRoot?: boolean } = {},
): Promise<StudioPrototypeDetail> {
  const versions = await listVersionDetails(dir);
  const activeVersion = versions.find((version) => version.id === manifest.activeVersionId)
    ?? await loadActiveVersion(dir, manifest);
  const projectTokens = await readProjectTokens(path.dirname(dir), defaultTokensForBrief(manifest.brief));
  const tokens = await readTokens(dir, projectTokens);
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
    origin: studioOrigin(legacy.origin, 'studio'),
    originSessionId: typeof legacy.originSessionId === 'string' ? legacy.originSessionId : null,
    originRunId: typeof legacy.originRunId === 'string' ? legacy.originRunId : null,
    linkedSessionIds: Array.isArray(legacy.linkedSessionIds)
      ? legacy.linkedSessionIds.filter((value): value is string => typeof value === 'string')
      : [],
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

/**
 * `get()`/`protoDir()` always look a prototype up by joining the project's
 * studio root with `id`, i.e. the directory name IS the id. A manifest
 * hand-written (or copied) with an `id` that doesn't match its own folder
 * name is unreachable by that id forever — every open/iterate call 404s with
 * "Prototype not found" even though `list()` happily shows it. Repair that
 * drift here, the one place that sees both the real folder name and the
 * manifest's claimed id, by making the manifest agree with its folder.
 */
async function reconcileManifestDirectory(dir: string, manifest: StudioPrototype): Promise<StudioPrototype> {
  const expectedId = path.basename(dir);
  if (manifest.id === expectedId) return manifest;
  const relativeDir = path.join(STUDIO_DIR, expectedId);
  const fixed: StudioPrototype = {
    ...manifest,
    id: expectedId,
    relativeDir,
    htmlRelativePath: path.join(relativeDir, HTML_FILE),
    notesRelativePath: path.join(relativeDir, NOTES_FILE),
    handoffRelativePath: path.join(relativeDir, HANDOFF_FILE),
  };
  await writeManifest(dir, fixed);
  return fixed;
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

export function buildIdeatePrompt(proto: StudioPrototype, handoff = ''): string {
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
    ``,
    `Handoff from the prototype (treat this as the coding brief and preserve its decisions):`,
    handoff.trim() || '(No handoff has been written yet.)',
  ].filter(Boolean).join('\n');
}

export async function ingestAgentPrototype(input: {
  projectId: string;
  html: string;
  originSessionId?: string | null;
  originRunId?: string | null;
  title?: string;
}): Promise<StudioPrototypeDetail> {
  const title = input.title?.trim()
    || /<title[^>]*>([^<]+)<\/title>/i.exec(input.html)?.[1]?.trim()
    || 'Agent prototype';
  const prototype = await studioService.create({
    projectId: input.projectId,
    title: title.slice(0, 80),
    brief: `HTML prototype emitted by an agent run ${input.originRunId ?? ''}`.trim(),
    origin: 'agent',
    originSessionId: input.originSessionId ?? null,
    originRunId: input.originRunId ?? null,
  });
  return studioService.update(input.projectId, prototype.id, {
    html: input.html,
    notes: `Imported from agent run ${input.originRunId ?? 'unknown'}.`,
    handoff: 'Agent-emitted HTML prototype. Review interactions and continue in Studio.',
    status: 'ready',
  });
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

  const failed: StudioPrototype = {
    ...manifest,
    status: 'failed',
    generation: {
      ...(manifest.generation ?? {
        kind: 'turn',
        startedAt: manifest.updatedAt,
        message: null,
      }),
      // A prototype left mid-generation by the removed design-swarm path can
      // never finish; report it honestly instead of polling forever.
      error: manifest.generation?.kind === 'swarm'
        ? 'Design swarms are no longer available; regenerate this prototype in Studio chat.'
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
    await importOrphanDirectories(projectId, projectPath);
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      return [];
    }

    const items: StudioPrototype[] = [];
    for (const name of entries) {
      if (name.startsWith('_')) continue;
      const dir = path.join(root, name);
      const manifest = await readOrMigrateManifest(dir);
      if (manifest) items.push(await reconcileManifestDirectory(dir, manifest));
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return items;
  },

  async get(projectId: string, id: string): Promise<StudioPrototypeDetail> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const manifest = requireManifest(await readOrMigrateManifest(dir));
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
    const projectRoot = studioRoot(projectPath);
    const projectTokens = await readProjectTokens(projectRoot, defaultTokensForBrief(brief));
    await writeProjectTokens(projectRoot, projectTokens);

    const id = newPrototypeId();
    const dir = protoDir(projectPath, id);
    const title = (input.title || titleFromBrief(brief)).trim();
    const createdAt = nowIso();
    const relativeDir = path.join(STUDIO_DIR, id);
    const tokens = mergeStudioTokens(projectTokens, input.tokens);
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
      origin: input.origin ?? 'studio',
      originSessionId: input.originSessionId ?? null,
      originRunId: input.originRunId ?? null,
      linkedSessionIds: [...new Set([
        ...(input.linkedSessionIds ?? []),
        ...(input.originSessionId ? [input.originSessionId] : []),
      ])],
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
    for (const sessionId of manifest.linkedSessionIds) {
      sessionsDb.addStudioPrototypeId(sessionId, id);
    }
    return this.get(input.projectId, id);
  },

  async attachSession(projectId: string, id: string, sessionId: string): Promise<StudioPrototypeDetail> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const manifest = requireManifest(await readOrMigrateManifest(dir));
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session not found: ${sessionId}`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    const project = projectsDb.getProjectById(projectId);
    const sessionProjectPaths = new Set([session.project_path, session.runtime_project_path].filter(Boolean));
    if (project?.project_path && sessionProjectPaths.size > 0 && !sessionProjectPaths.has(project.project_path)) {
      throw new AppError('Session belongs to a different project', { code: 'SESSION_PROJECT_MISMATCH', statusCode: 400 });
    }
    const linkedSessionIds = [...new Set([...manifest.linkedSessionIds, sessionId])];
    await writeManifest(dir, { ...manifest, linkedSessionIds, updatedAt: nowIso() });
    sessionsDb.addStudioPrototypeId(sessionId, id);
    return this.get(projectId, id);
  },

  async listForSession(sessionId: string): Promise<StudioPrototype[]> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session not found: ${sessionId}`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    }
    if (!session.project_path) return [];
    const ids = new Set(parseStudioPrototypeIds(session.studio_prototype_ids));
    const projectIds = new Set(
      [session.project_path, session.runtime_project_path]
        .filter((projectPath): projectPath is string => Boolean(projectPath))
        .map((projectPath) => projectsDb.getProjectPath(projectPath)?.project_id)
        .filter((projectId): projectId is string => Boolean(projectId)),
    );
    if (projectIds.size === 0) return [];

    const prototypes = (await Promise.all([...projectIds].map((projectId) => this.list(projectId))))
      .flat()
      .filter((prototype, index, all) => all.findIndex((candidate) => candidate.id === prototype.id) === index);
    return prototypes.filter((prototype) => ids.has(prototype.id) || prototype.linkedSessionIds.includes(sessionId));
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

  async getTokens(projectId: string, id: string): Promise<StudioDesignTokens> {
    const detail = await this.get(projectId, id);
    return detail.tokens;
  },

  buildIdeatePrompt,
  ingestAgentPrototype,

  async updateTokens(
    projectId: string,
    id: string,
    input: UpdateStudioTokensInput,
  ): Promise<StudioPrototypeDetail> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const manifest = requireManifest(await readOrMigrateManifest(dir));
    assertNotBusy(manifest);
    const projectTokens = await readProjectTokens(studioRoot(projectPath), defaultTokensForBrief(manifest.brief));
    const currentTokens = await readTokens(dir, projectTokens);
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
