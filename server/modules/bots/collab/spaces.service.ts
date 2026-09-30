/** Spaces: living markdown artifacts a bot owns and updates (a note, a report, an Obsidian page). */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError } from '@/shared/utils.js';
import type { BotSpace } from '@/modules/bots/bots.types.js';
import { botSpacesDb } from '@/modules/bots/collab/bot-spaces.repository.js';
import {
  defaultSpacesDir,
  isInside,
  isTccPath,
  listSpacesRoots,
  realpathLoose,
  resolveSpaceFile,
  slugifyTitle,
  SpacePathError,
} from '@/modules/bots/collab/spaces.paths.js';

export const MAX_SPACE_BYTES = 256 * 1024;
export const MAX_SPACE_TITLE_CHARS = 120;
export const SPACE_KINDS = ['markdown'] as const;

export type SpaceWriteMode = 'replace' | 'append';

const invalid = (message: string): AppError => new AppError(message, { code: 'BOT_SPACE_INVALID', statusCode: 400 });
const notFound = (): AppError => new AppError('Space not found', { code: 'BOT_SPACE_NOT_FOUND', statusCode: 404 });

function guardedFile(space: BotSpace): string {
  try {
    return resolveSpaceFile(space.bot_id, space.path);
  } catch (error) {
    if (error instanceof SpacePathError) throw new AppError(error.message, { code: 'BOT_SPACE_PATH', statusCode: 400 });
    throw error;
  }
}

function pickRoot(botId: string, requested: unknown): string {
  if (requested === undefined || requested === null || requested === '') return defaultSpacesDir(botId);
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw invalid('root must be an absolute path.');
  if (isTccPath(requested)) throw invalid('Spaces cannot live in Documents, Desktop or Downloads.');
  const real = realpathLoose(requested);
  const match = listSpacesRoots().find((root) => root === real);
  if (!match) throw invalid('root is not in CLOUDCLI_SPACES_ROOTS.');
  return match;
}

function writeAtomic(target: string, content: string): void {
  const temp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o644 });
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function readCapped(file: string): { content: string; truncated: boolean } {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', truncated: false };
    throw error;
  }
  const truncated = raw.length > MAX_SPACE_BYTES;
  return { content: (truncated ? raw.subarray(0, MAX_SPACE_BYTES) : raw).toString('utf8'), truncated };
}

/** The owner's space by id or (case-insensitive) title; null when missing or owned by another bot. */
export function findOwnedSpace(botId: string, ref: string): BotSpace | null {
  const needle = ref.trim();
  if (!needle) return null;
  const owned = botSpacesDb.list(botId);
  return (
    owned.find((space) => space.space_id === needle) ??
    owned.find((space) => space.title.toLowerCase() === needle.toLowerCase()) ??
    null
  );
}

export const spaces = {
  create(botId: string, input: { title: unknown; kind?: unknown; root?: unknown; content?: unknown }): BotSpace {
    if (!missionControlDb.getSection(botId)) throw new AppError('Bot not found', { code: 'BOT_NOT_FOUND', statusCode: 404 });
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, MAX_SPACE_TITLE_CHARS) : '';
    if (!title) throw invalid('title is required.');
    const kind = input.kind === undefined ? 'markdown' : input.kind;
    if (kind !== 'markdown') throw invalid('Only markdown spaces are supported.');
    const initial = typeof input.content === 'string' ? input.content : `# ${title}\n\n`;
    if (Buffer.byteLength(initial) > MAX_SPACE_BYTES) throw invalid(`content exceeds ${MAX_SPACE_BYTES} bytes.`);

    const root = pickRoot(botId, input.root);
    fs.mkdirSync(root, { recursive: true });
    const realRoot = realpathLoose(root);
    if (isTccPath(realRoot)) throw invalid('Spaces cannot live in Documents, Desktop or Downloads.');
    const stem = slugifyTitle(title);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const name = `${attempt === 0 ? stem : `${stem}-${attempt + 1}`}.md`;
      const target = path.join(realRoot, name);
      if (!isInside(realpathLoose(target), realRoot)) continue; // a symlink named like our target: pick another name
      try {
        fs.writeFileSync(target, initial, { flag: 'wx', mode: 0o644 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      return botSpacesDb.create({ botId, title, path: target, kind: 'markdown' });
    }
    throw invalid('Could not pick a free file name for this space.');
  },

  list: (botId: string): BotSpace[] => botSpacesDb.list(botId),

  get(botId: string, ref: string): { space: BotSpace; content: string; truncated: boolean } {
    const space = findOwnedSpace(botId, ref);
    if (!space) throw notFound();
    return { space, ...readCapped(guardedFile(space)) };
  },

  write(botId: string, ref: string, content: unknown, mode: SpaceWriteMode = 'replace'): BotSpace {
    const space = findOwnedSpace(botId, ref);
    if (!space) throw notFound();
    if (typeof content !== 'string') throw invalid('content must be a string.');
    if (mode !== 'replace' && mode !== 'append') throw invalid('mode must be replace or append.');
    const file = guardedFile(space);
    const existing = mode === 'append' ? readCapped(file).content : '';
    const next = mode === 'append' ? `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${content}` : content;
    if (Buffer.byteLength(next) > MAX_SPACE_BYTES) {
      throw invalid(`A space is capped at ${MAX_SPACE_BYTES} bytes; this write would make it ${Buffer.byteLength(next)}.`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, next);
    botSpacesDb.touch(space.space_id);
    // No WS union member fits a space update (run-events.ts is not ours to extend); clients read updated_at.
    return botSpacesDb.get(space.space_id)!;
  },

  /** Removes the row. Files in the bot's own `spaces/` folder go too; external-root files are left alone. */
  remove(botId: string, ref: string): boolean {
    const space = findOwnedSpace(botId, ref);
    if (!space) return false;
    try {
      const file = resolveSpaceFile(botId, space.path);
      if (isInside(file, defaultSpacesDir(botId))) fs.rmSync(file, { force: true });
    } catch {
      // a file that is unsafe or already gone must not block removing the record
    }
    return botSpacesDb.delete(space.space_id);
  },
};
