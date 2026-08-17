import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { swarmService } from '@/modules/swarm/index.js';
import type { SwarmAgentSpec } from '@/modules/swarm/swarm.types.js';
import { workspaceService } from '@/modules/workspaces/index.js';
import { newPrototypeId } from '@/shared/ids.js';
import { AppError } from '@/shared/utils.js';

import {
  getStudioSeats,
  saveStudioSeats,
  seatsToRoster,
  type StudioSeatProfile,
} from '@/modules/studio/studio.profiles.js';
import { CLICKABLE_PROTOTYPE_SKILL } from '@/modules/studio/studio.skill.js';
import {
  starterHandoff,
  starterNotes,
  starterPrototypeHtml,
} from '@/modules/studio/studio.templates.js';
import type {
  CreateStudioPrototypeInput,
  StudioPrototype,
  StudioPrototypeDetail,
  UpdateStudioPrototypeInput,
} from '@/modules/studio/studio.types.js';

const STUDIO_DIR = path.join('.cloudcli', 'studio');
const MANIFEST = 'manifest.json';
const HTML_FILE = 'prototype.html';
const NOTES_FILE = 'notes.md';
const HANDOFF_FILE = 'handoff.md';

export function designStudioRoster(): SwarmAgentSpec[] {
  return seatsToRoster();
}

const watching = new Set<string>();

function watchSwarm(projectId: string, prototypeId: string, swarmId: string): void {
  if (watching.has(swarmId)) return;
  watching.add(swarmId);
  const tick = async () => {
    try {
      const swarm = swarmService.get(swarmId);
      const status = swarm?.status;
      if (status === 'succeeded') {
        await promotePrototypeFromSwarm(projectId, prototypeId);
        await studioService.update(projectId, prototypeId, { status: 'ready' });
        watching.delete(swarmId);
        return;
      }
      if (status === 'failed' || status === 'aborted') {
        await studioService.update(projectId, prototypeId, { status: 'failed' });
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

async function writeUtf8(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

const PROMOTE_FILES = [HTML_FILE, NOTES_FILE, HANDOFF_FILE] as const;

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

async function readUtf8(filePath: string, fallback = ''): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function toPublic(manifest: StudioPrototype): StudioPrototype {
  return manifest;
}

async function readManifest(dir: string): Promise<StudioPrototype | null> {
  try {
    const raw = await readFile(path.join(dir, MANIFEST), 'utf8');
    const parsed = JSON.parse(raw) as StudioPrototype;
    if (!parsed?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeManifest(dir: string, manifest: StudioPrototype): Promise<void> {
  await writeUtf8(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function ensureSkill(projectPath: string): Promise<void> {
  const skillPath = path.join(studioRoot(projectPath), '_skill', 'clickable-prototype', 'SKILL.md');
  await writeUtf8(skillPath, CLICKABLE_PROTOTYPE_SKILL);
}

export function buildIdeatePrompt(proto: StudioPrototype): string {
  return [
    `You are designing a clickable prototype in CloudCLI Studio.`,
    `Work only in \`${proto.relativeDir}\`. Edits there are the source-of-truth diff for this job.`,
    `Do not explore or rewrite the host CloudCLI application.`,
    `Replace \`${proto.htmlRelativePath}\` with a self-contained HTML prototype that matches the brief — not a generic three-card shell.`,
    `Keep \`${proto.notesRelativePath}\` and \`${proto.handoffRelativePath}\` current.`,
    `Use the clickable-prototype skill.`,
    proto.skills.length ? `Also use these skills: ${proto.skills.join(', ')}.` : '',
    `Plan as two steps only: builder writes the HTML, reviewer walks every click.`,
    ``,
    `Brief:`,
    proto.brief,
  ].filter(Boolean).join('\n');
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
      const manifest = await readManifest(path.join(root, name));
      if (manifest) items.push(toPublic(manifest));
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return items;
  },

  async get(projectId: string, id: string): Promise<StudioPrototypeDetail> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const manifest = await readManifest(dir);
    if (!manifest) {
      throw new AppError('Prototype not found', { code: 'STUDIO_NOT_FOUND', statusCode: 404 });
    }
    await promotePrototypeFromSwarm(projectId, id);
    return {
      ...manifest,
      html: await readUtf8(path.join(dir, HTML_FILE)),
      notes: await readUtf8(path.join(dir, NOTES_FILE)),
      handoff: await readUtf8(path.join(dir, HANDOFF_FILE)),
    };
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
    const manifest: StudioPrototype = {
      id,
      projectId: input.projectId,
      title,
      brief,
      skills: input.skills ?? [],
      status: 'draft',
      relativeDir,
      htmlRelativePath: path.join(relativeDir, HTML_FILE),
      notesRelativePath: path.join(relativeDir, NOTES_FILE),
      handoffRelativePath: path.join(relativeDir, HANDOFF_FILE),
      swarmId: null,
      createdAt,
      updatedAt: createdAt,
    };

    await writeManifest(dir, manifest);
    await writeUtf8(path.join(dir, HTML_FILE), starterPrototypeHtml(title, brief));
    await writeUtf8(path.join(dir, NOTES_FILE), starterNotes(title, brief));
    await writeUtf8(path.join(dir, HANDOFF_FILE), starterHandoff(title));

    return this.get(input.projectId, id);
  },

  async update(
    projectId: string,
    id: string,
    patch: UpdateStudioPrototypeInput,
  ): Promise<StudioPrototypeDetail> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const current = await readManifest(dir);
    if (!current) {
      throw new AppError('Prototype not found', { code: 'STUDIO_NOT_FOUND', statusCode: 404 });
    }

    const next: StudioPrototype = {
      ...current,
      title: patch.title?.trim() || current.title,
      brief: patch.brief?.trim() || current.brief,
      skills: patch.skills ?? current.skills,
      status: patch.status ?? current.status,
      swarmId: patch.swarmId === undefined ? current.swarmId : patch.swarmId,
      updatedAt: nowIso(),
    };

    if (typeof patch.html === 'string') {
      await writeUtf8(path.join(dir, HTML_FILE), patch.html);
    }
    if (typeof patch.notes === 'string') {
      await writeUtf8(path.join(dir, NOTES_FILE), patch.notes);
    }
    if (typeof patch.handoff === 'string') {
      await writeUtf8(path.join(dir, HANDOFF_FILE), patch.handoff);
    }
    await writeManifest(dir, next);
    return this.get(projectId, id);
  },

  async remove(projectId: string, id: string): Promise<void> {
    const projectPath = projectPathForId(projectId);
    const dir = protoDir(projectPath, id);
    const current = await readManifest(dir);
    if (!current) {
      throw new AppError('Prototype not found', { code: 'STUDIO_NOT_FOUND', statusCode: 404 });
    }
    await rm(dir, { recursive: true, force: true });
  },

  async launchSwarm(projectId: string, prototypeId: string) {
    const proto = await this.get(projectId, prototypeId);
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
    });
    watchSwarm(projectId, prototypeId, swarm.swarm_id);
    return { swarmId: swarm.swarm_id, prototype: await this.get(projectId, prototypeId) };
  },
};
