import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_STUDIO_TOKENS, parseStudioTokens } from '@/modules/studio/studio.tokens.js';
import { STUDIO_FORMAT, type StudioDesignTokens, type StudioPrototype, type StudioVariant, type StudioVersion, type StudioVersionDetail } from '@/modules/studio/studio.types.js';
import { AppError } from '@/shared/utils.js';

export const STUDIO_DIR = path.join('.cloudcli', 'studio');
export const MANIFEST = 'manifest.json';
export const TOKENS_FILE = 'tokens.json';
export const HTML_FILE = 'prototype.html';
export const NOTES_FILE = 'notes.md';
export const HANDOFF_FILE = 'handoff.md';
export const VERSIONS_DIR = 'versions';
export const VARIANTS_DIR = 'variants';
export const VERSION_FILE = 'version.json';
export const VARIANT_FILE = 'variant.json';

export type StudioWriteUtf8Fn = (filePath: string, content: string) => Promise<void>;

let writeUtf8Override: StudioWriteUtf8Fn | null = null;

export function setStudioWriteUtf8Fn(fn: StudioWriteUtf8Fn | null): void {
  writeUtf8Override = fn;
}

/**
 * Atomic UTF-8 write: content goes to a same-directory temp file, then `rename`s
 * over the target so a crash cannot leave truncated JSON or artifacts.
 * Matches the writeJsonConfig helper in server/shared/utils.ts.
 */
export async function writeUtf8Atomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeUtf8(filePath: string, content: string): Promise<void> {
  await (writeUtf8Override ?? writeUtf8Atomic)(filePath, content);
}

export async function readUtf8(filePath: string, fallback = ''): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function readManifest(dir: string): Promise<StudioPrototype | null> {
  try {
    const raw = await readFile(path.join(dir, MANIFEST), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.format !== STUDIO_FORMAT) return null;
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    if (typeof parsed.activeVersionId !== 'string' || !parsed.activeVersionId) return null;
    return parsed as StudioPrototype;
  } catch {
    return null;
  }
}

/**
 * Read the pre-version-history manifest shape so the service can migrate it
 * without making existing prototypes disappear after the v2 rollout.
 */
export async function readLegacyManifest(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path.join(dir, MANIFEST), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.format === STUDIO_FORMAT) return null;
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    if (typeof parsed.projectId !== 'string' || !parsed.projectId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeManifest(dir: string, manifest: StudioPrototype): Promise<void> {
  await writeUtf8(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readTokens(dir: string, fallback = DEFAULT_STUDIO_TOKENS): Promise<StudioDesignTokens> {
  try {
    const raw = await readFile(path.join(dir, TOKENS_FILE), 'utf8');
    return parseStudioTokens(JSON.parse(raw), fallback);
  } catch {
    return structuredClone(fallback);
  }
}

export async function writeTokens(dir: string, tokens: StudioDesignTokens): Promise<void> {
  await writeUtf8(path.join(dir, TOKENS_FILE), `${JSON.stringify(tokens, null, 2)}\n`);
}

function versionDir(protoDir: string, versionId: string): string {
  if (!/^ver_[a-z0-9]+$/i.test(versionId)) {
    throw new AppError('Invalid version id', { code: 'STUDIO_INVALID_VERSION', statusCode: 400 });
  }
  return path.join(protoDir, VERSIONS_DIR, versionId);
}

function variantDir(protoDir: string, versionId: string, variantId: string): string {
  if (!/^var_[a-z0-9]+$/i.test(variantId)) {
    throw new AppError('Invalid variant id', { code: 'STUDIO_INVALID_VARIANT', statusCode: 400 });
  }
  return path.join(versionDir(protoDir, versionId), VARIANTS_DIR, variantId);
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function parseVersionMeta(raw: unknown): StudioVersion | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.kind !== 'string') return null;
  return {
    id: raw.id,
    parentVersionId: typeof raw.parentVersionId === 'string' ? raw.parentVersionId : null,
    kind: raw.kind as StudioVersion['kind'],
    message: typeof raw.message === 'string' ? raw.message : '',
    selectedElement: (raw.selectedElement as StudioVersion['selectedElement']) ?? null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    variantIds: Array.isArray(raw.variantIds)
      ? raw.variantIds.filter((id): id is string => typeof id === 'string')
      : [],
    promotedFromVariantId: typeof raw.promotedFromVariantId === 'string' ? raw.promotedFromVariantId : null,
    revertedFromVersionId: typeof raw.revertedFromVersionId === 'string' ? raw.revertedFromVersionId : null,
  };
}

export async function writeVersion(
  protoDirPath: string,
  version: StudioVersion,
  artifacts: { html: string; notes: string; handoff: string },
): Promise<void> {
  const dir = versionDir(protoDirPath, version.id);
  await writeUtf8(path.join(dir, VERSION_FILE), `${JSON.stringify(version, null, 2)}\n`);
  await writeUtf8(path.join(dir, HTML_FILE), artifacts.html);
  await writeUtf8(path.join(dir, NOTES_FILE), artifacts.notes);
  await writeUtf8(path.join(dir, HANDOFF_FILE), artifacts.handoff);
}

export async function readVersionDetail(
  protoDirPath: string,
  versionId: string,
): Promise<StudioVersionDetail | null> {
  const dir = versionDir(protoDirPath, versionId);
  const meta = parseVersionMeta(await readJsonFile(path.join(dir, VERSION_FILE)));
  if (!meta) return null;
  try {
    const [html, notes, handoff] = await Promise.all([
      readFile(path.join(dir, HTML_FILE), 'utf8'),
      readFile(path.join(dir, NOTES_FILE), 'utf8'),
      readFile(path.join(dir, HANDOFF_FILE), 'utf8'),
    ]);
    return { ...meta, html, notes, handoff };
  } catch {
    return null;
  }
}

export async function listVersionDetails(protoDirPath: string): Promise<StudioVersionDetail[]> {
  const root = path.join(protoDirPath, VERSIONS_DIR);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const versions: StudioVersionDetail[] = [];
  for (const name of names) {
    if (!name.startsWith('ver_')) continue;
    const detail = await readVersionDetail(protoDirPath, name);
    if (detail) versions.push(detail);
  }
  versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return versions;
}

export async function writeVariant(
  protoDirPath: string,
  variant: Omit<StudioVariant, 'html' | 'notes' | 'handoff'>,
  artifacts: { html: string; notes: string; handoff: string },
): Promise<void> {
  const dir = variantDir(protoDirPath, variant.versionId, variant.id);
  const meta = {
    id: variant.id,
    versionId: variant.versionId,
    label: variant.label,
    direction: variant.direction,
    createdAt: variant.createdAt,
  };
  await writeUtf8(path.join(dir, VARIANT_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  await writeUtf8(path.join(dir, HTML_FILE), artifacts.html);
  await writeUtf8(path.join(dir, NOTES_FILE), artifacts.notes);
  await writeUtf8(path.join(dir, HANDOFF_FILE), artifacts.handoff);
}

export async function readVariant(
  protoDirPath: string,
  versionId: string,
  variantId: string,
): Promise<StudioVariant | null> {
  const dir = variantDir(protoDirPath, versionId, variantId);
  const raw = await readJsonFile(path.join(dir, VARIANT_FILE));
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  try {
    const [html, notes, handoff] = await Promise.all([
      readFile(path.join(dir, HTML_FILE), 'utf8'),
      readFile(path.join(dir, NOTES_FILE), 'utf8'),
      readFile(path.join(dir, HANDOFF_FILE), 'utf8'),
    ]);
    return {
      id: raw.id,
      versionId: typeof raw.versionId === 'string' ? raw.versionId : versionId,
      label: typeof raw.label === 'string' ? raw.label : 'Variant',
      direction: typeof raw.direction === 'string' ? raw.direction : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      html,
      notes,
      handoff,
    };
  } catch {
    return null;
  }
}

export async function listVariants(protoDirPath: string, versionId: string): Promise<StudioVariant[]> {
  const root = path.join(versionDir(protoDirPath, versionId), VARIANTS_DIR);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const variants: StudioVariant[] = [];
  for (const name of names) {
    if (!name.startsWith('var_')) continue;
    const variant = await readVariant(protoDirPath, versionId, name);
    if (variant) variants.push(variant);
  }
  variants.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return variants;
}

export async function replaceVariants(
  protoDirPath: string,
  version: StudioVersion,
  variants: StudioVariant[],
): Promise<StudioVersion> {
  const root = path.join(versionDir(protoDirPath, version.id), VARIANTS_DIR);
  await rm(root, { recursive: true, force: true });
  for (const variant of variants) {
    await writeVariant(protoDirPath, variant, {
      html: variant.html,
      notes: variant.notes,
      handoff: variant.handoff,
    });
  }
  const next: StudioVersion = {
    ...version,
    variantIds: variants.map((variant) => variant.id),
  };
  const current = await readVersionDetail(protoDirPath, version.id);
  await writeVersion(protoDirPath, next, {
    html: current?.html ?? '',
    notes: current?.notes ?? '',
    handoff: current?.handoff ?? '',
  });
  return next;
}

export async function findVariant(
  protoDirPath: string,
  variantId: string,
): Promise<StudioVariant | null> {
  const versions = await listVersionDetails(protoDirPath);
  for (const version of versions) {
    const listed = await listVariants(protoDirPath, version.id);
    const match = listed.find((item) => item.id === variantId);
    if (match) return match;
  }
  return null;
}

export async function writeActiveArtifacts(
  protoDirPath: string,
  artifacts: { html: string; notes: string; handoff: string },
): Promise<void> {
  await writeUtf8(path.join(protoDirPath, HTML_FILE), artifacts.html);
  await writeUtf8(path.join(protoDirPath, NOTES_FILE), artifacts.notes);
  await writeUtf8(path.join(protoDirPath, HANDOFF_FILE), artifacts.handoff);
}

export async function readRootArtifacts(protoDirPath: string): Promise<{ html: string; notes: string; handoff: string }> {
  const [html, notes, handoff] = await Promise.all([
    readFile(path.join(protoDirPath, HTML_FILE), 'utf8'),
    readFile(path.join(protoDirPath, NOTES_FILE), 'utf8'),
    readFile(path.join(protoDirPath, HANDOFF_FILE), 'utf8'),
  ]);
  return { html, notes, handoff };
}

export function walkVersionChain(
  versions: StudioVersionDetail[],
  fromId: string,
): StudioVersionDetail[] {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const chain: StudioVersionDetail[] = [];
  const seen = new Set<string>();
  let current = byId.get(fromId) ?? null;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentVersionId ? (byId.get(current.parentVersionId) ?? null) : null;
  }
  return chain.reverse();
}
