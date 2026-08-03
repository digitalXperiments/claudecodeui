import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import {
  ARTICLE_STUDIO_DIRS,
  ARTICLE_STUDIO_MARKER,
  ARTICLE_STUDIO_TEMPLATE_VERSION,
  articleStudioScaffold,
} from '@/modules/mission-control/article-studio.templates.js';

/**
 * The article studio: a real working directory the writing agent runs inside,
 * so it picks up house rules (CLAUDE.md) and skills (.claude/skills) the same
 * way any project does.
 *
 * The directory is the user's, not ours. We create files that are missing and
 * upgrade ones that still carry our marker at an older version. The moment a
 * file loses its marker — because the user edited it and dropped the line, or
 * deliberately took ownership — we never touch it again.
 */

export const DEFAULT_ARTICLE_STUDIO_DIRNAME = 'x_articles';

export function defaultArticleStudioPath(): string {
  return path.join(os.homedir(), DEFAULT_ARTICLE_STUDIO_DIRNAME);
}

export type ScaffoldOutcome = 'created' | 'upgraded' | 'kept' | 'user-owned';

export type EnsureWorkspaceResult = {
  workspacePath: string;
  projectId: string;
  files: Array<{ path: string; outcome: ScaffoldOutcome }>;
  createdWorkspace: boolean;
};

const MARKER_PATTERN = new RegExp(`${ARTICLE_STUDIO_MARKER} v(\\d+)`);

/** Which of our template versions a file was written from, if any. */
function markerVersion(contents: string): number | null {
  const match = contents.match(MARKER_PATTERN);
  if (!match) return null;
  const version = Number.parseInt(match[1], 10);
  return Number.isFinite(version) ? version : null;
}

async function writeScaffoldFile(
  workspacePath: string,
  relativePath: string,
  contents: string,
): Promise<ScaffoldOutcome> {
  const target = path.join(workspacePath, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });

  let existing: string | null = null;
  try {
    existing = await fs.readFile(target, 'utf8');
  } catch {
    existing = null;
  }

  if (existing === null) {
    await fs.writeFile(target, contents, 'utf8');
    return 'created';
  }

  const version = markerVersion(existing);
  if (version === null) {
    // No marker: the user owns this file now.
    return 'user-owned';
  }
  if (version >= ARTICLE_STUDIO_TEMPLATE_VERSION) {
    return 'kept';
  }

  await fs.writeFile(target, contents, 'utf8');
  return 'upgraded';
}

/**
 * Create (or refresh) the studio directory and make sure CloudCLI knows it as a
 * project, so a project-scoped Mission Control section can run inside it.
 */
export async function ensureArticleStudioWorkspace(
  workspacePath = defaultArticleStudioPath(),
): Promise<EnsureWorkspaceResult> {
  const resolved = path.resolve(workspacePath);

  let createdWorkspace = false;
  try {
    await fs.access(resolved);
  } catch {
    createdWorkspace = true;
  }
  await fs.mkdir(resolved, { recursive: true });

  for (const dir of ARTICLE_STUDIO_DIRS) {
    await fs.mkdir(path.join(resolved, dir), { recursive: true });
  }

  const files: Array<{ path: string; outcome: ScaffoldOutcome }> = [];
  for (const file of articleStudioScaffold()) {
    files.push({
      path: file.path,
      outcome: await writeScaffoldFile(resolved, file.path, file.contents),
    });
  }

  // Registering the path is idempotent: an already-active path comes back as
  // `active_conflict` with the existing row, which is exactly what we want.
  const registered = projectsDb.createProjectPath(resolved, 'Article Studio');
  const project = registered.project ?? projectsDb.getProjectPath(resolved);
  if (!project) {
    throw new Error(`Could not register the article studio project at ${resolved}`);
  }

  return {
    workspacePath: resolved,
    projectId: project.project_id,
    files,
    createdWorkspace,
  };
}
