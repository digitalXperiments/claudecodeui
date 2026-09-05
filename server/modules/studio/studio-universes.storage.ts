import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { STUDIO_DIR, writeUtf8 } from '@/modules/studio/studio.storage.js';
import { STUDIO_UNIVERSE_FORMAT, type StudioUniverse } from '@/modules/studio/studio-universes.types.js';

export const UNIVERSES_DIR = path.join(STUDIO_DIR, 'universes');
export const UNIVERSE_MANIFEST = 'manifest.json';

export function universesRoot(projectPath: string): string {
  return path.join(projectPath, UNIVERSES_DIR);
}

export function universeDir(projectPath: string, id: string): string {
  if (!/^uni_[a-z0-9]+$/i.test(id)) {
    throw new Error(`Invalid universe id: ${id}`);
  }
  return path.join(universesRoot(projectPath), id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function readUniverseManifest(dir: string): Promise<StudioUniverse | null> {
  try {
    const raw = await readFile(path.join(dir, UNIVERSE_MANIFEST), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.format !== STUDIO_UNIVERSE_FORMAT) return null;
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    return parsed as StudioUniverse;
  } catch {
    return null;
  }
}

export async function writeUniverseManifest(dir: string, manifest: StudioUniverse): Promise<void> {
  await writeUtf8(path.join(dir, UNIVERSE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function listUniverseManifests(projectPath: string): Promise<StudioUniverse[]> {
  const root = universesRoot(projectPath);
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const items: StudioUniverse[] = [];
  for (const name of entries) {
    const manifest = await readUniverseManifest(path.join(root, name));
    if (manifest) items.push(manifest);
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items;
}

export async function removeUniverse(projectPath: string, id: string): Promise<void> {
  await rm(universeDir(projectPath, id), { recursive: true, force: true });
}
