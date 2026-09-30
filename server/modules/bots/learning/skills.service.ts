/**
 * Bot skills: SKILL.md files under `<botHome>/skills/<slug>/` plus bot_skills link rows.
 * All writes stay inside the bot home (slug validation + symlink-safe realpath checks); catalog
 * skills are read-only links to global skills and are never written or deleted on disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { missionControlDb } from '@/modules/mission-control/index.js';
import { resolveBotHome } from '@/modules/bots/bots-home.js';
import type { BotSkill } from '@/modules/bots/bots.types.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botSkillsDb } from '@/modules/bots/learning/bot-skills.repository.js';
import { clip, learningError, SLUG_PATTERN, slugify } from '@/modules/bots/learning/learning.util.js';
import { draftSkill, ensureFrontmatter, episodeItems, executedSteps, readDescription } from '@/modules/bots/learning/skill-draft.js';
import { runsDb } from '@/modules/runs/index.js';

const MAX_SKILL_BYTES = 64 * 1024;

export interface SkillView extends BotSkill {
  description: string;
  readonly: boolean;
}

function requireBot(botId: string): void {
  if (!missionControlDb.getSection(botId)) throw learningError('Bot not found', 404, 'BOT_NOT_FOUND');
}

export function assertSkillName(name: string): string {
  if (typeof name !== 'string' || !SLUG_PATTERN.test(name)) {
    throw learningError('Skill name must be lowercase letters, digits and dashes (max 64 characters)');
  }
  return name;
}

const isInside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(root + path.sep);

/** Absolute SKILL.md path for a bot-owned skill; throws when it would leave `<home>/skills`. */
export function skillFilePath(botId: string, name: string): string {
  assertSkillName(name);
  const home = resolveBotHome(botId);
  const skillsRoot = path.join(home, 'skills');
  const file = path.resolve(skillsRoot, name, 'SKILL.md');
  if (!isInside(skillsRoot, file)) throw learningError('Invalid skill path');
  // Refuse to follow a symlink out of the bot home through an existing directory.
  const realHome = fs.realpathSync(home);
  for (const existing of [skillsRoot, path.dirname(file), file]) {
    if (fs.existsSync(existing) && !isInside(realHome, fs.realpathSync(existing))) throw learningError('Skill path escapes the bot home');
  }
  return file;
}

function relativePath(name: string): string {
  return `skills/${name}/SKILL.md`;
}

function resolveLinkPath(skill: BotSkill): string {
  if (skill.origin === 'catalog') return skill.path;
  return skillFilePath(skill.bot_id, skill.name);
}

function describe(skill: BotSkill): SkillView {
  let description = '';
  try {
    description = readDescription(fs.readFileSync(resolveLinkPath(skill), 'utf8'));
  } catch {
    description = '';
  }
  return { ...skill, description, readonly: skill.origin === 'catalog' };
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function catalogRoots(): string[] {
  const extra = (process.env.CLOUDCLI_SKILLS_CATALOG_DIRS ?? '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  return [...extra, path.join(home, '.claude', 'skills'), path.join(home, '.codex', 'skills'), path.join(home, '.cloudcli', 'skills')]
    .map((dir) => {
      try {
        return fs.realpathSync(dir);
      } catch {
        return null;
      }
    })
    .filter((dir): dir is string => Boolean(dir));
}

function uniqueName(botId: string, base: string): string {
  let name = base;
  for (let i = 2; botSkillsDb.getByName(botId, name) || fs.existsSync(skillFilePath(botId, name)); i += 1) name = `${base.slice(0, 58)}-${i}`;
  return name;
}

export interface SaveSkillInput {
  name: string;
  content: string;
  description?: string;
  origin?: string;
  enabled?: boolean;
}

export const skills = {
  list(botId: string): SkillView[] {
    requireBot(botId);
    return botSkillsDb.list(botId).map(describe);
  },

  get(botId: string, name: string): { skill: SkillView; content: string } {
    requireBot(botId);
    const skill = botSkillsDb.getByName(botId, assertSkillName(name));
    if (!skill) throw learningError('Skill not found', 404, 'BOT_SKILL_NOT_FOUND');
    let content = '';
    try {
      content = fs.readFileSync(resolveLinkPath(skill), 'utf8');
    } catch {
      content = '';
    }
    return { skill: describe(skill), content };
  },

  /** Create or update a bot-owned skill file and its link row (version bumps on update). */
  save(botId: string, input: SaveSkillInput): SkillView {
    requireBot(botId);
    const name = assertSkillName(input.name);
    const existing = botSkillsDb.getByName(botId, name);
    if (existing?.origin === 'catalog') throw learningError('Catalog skills are read-only; unlink it and create a copy instead', 409);
    if (typeof input.content !== 'string' || !input.content.trim()) throw learningError('Skill content is required');
    if (Buffer.byteLength(input.content) > MAX_SKILL_BYTES) throw learningError('Skill content is too large (64 KB max)');
    const description = (input.description ?? readDescription(input.content)) || `Skill ${name}`;
    const file = skillFilePath(botId, name);
    writeFileAtomic(file, ensureFrontmatter(input.content, name, description));
    return describe(
      botSkillsDb.upsert({ botId, name, path: relativePath(name), origin: input.origin ?? existing?.origin ?? 'manual', enabled: input.enabled ?? existing?.enabled ?? true }),
    );
  },

  setEnabled(botId: string, name: string, enabled: boolean): SkillView {
    requireBot(botId);
    const skill = botSkillsDb.getByName(botId, assertSkillName(name));
    if (!skill) throw learningError('Skill not found', 404, 'BOT_SKILL_NOT_FOUND');
    return describe(botSkillsDb.setEnabled(skill.link_id, enabled) ?? skill);
  },

  enable: (botId: string, name: string): SkillView => skills.setEnabled(botId, name, true),
  disable: (botId: string, name: string): SkillView => skills.setEnabled(botId, name, false),

  /** Remove the link and, for bot-owned skills, the SKILL.md directory. */
  remove(botId: string, name: string): boolean {
    requireBot(botId);
    const skill = botSkillsDb.getByName(botId, assertSkillName(name));
    if (!skill) return false;
    if (skill.origin !== 'catalog') {
      const file = skillFilePath(botId, name);
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
    return botSkillsDb.delete(skill.link_id);
  },

  /** Append a dated lesson under "## Lessons" (created when missing) and bump the version. */
  appendLesson(botId: string, name: string, note: string): SkillView {
    const { skill, content } = skills.get(botId, name);
    if (skill.origin === 'catalog') throw learningError('Catalog skills are read-only', 409);
    const bullet = `- ${clip(note.replace(/\s+/g, ' ').trim(), 600)}`;
    const match = /^## Lessons[^\n]*$/m.exec(content);
    let next: string;
    if (!match) {
      next = `${content.replace(/\s+$/, '')}\n\n## Lessons\n${bullet}\n`;
    } else {
      const start = match.index + match[0].length;
      const rest = content.slice(start);
      const nextHeading = /^## /m.exec(rest);
      const end = nextHeading ? start + nextHeading.index : content.length;
      const section = content.slice(start, end).replace(/\s+$/, '');
      next = `${content.slice(0, start)}${section}\n${bullet}\n${nextHeading ? '\n' : ''}${content.slice(end)}`;
    }
    return skills.save(botId, { name, content: next, origin: skill.origin });
  },

  /** A draft (disabled) skill built from a run or episode for the operator to edit. */
  async fromRun(botId: string, ref: { runId?: string; episodeId?: string }): Promise<SkillView> {
    requireBot(botId);
    let episode = ref.episodeId ? botEpisodesDb.get(ref.episodeId) : null;
    if (!episode && ref.runId) {
      const fromMeta = runsDb.getById(ref.runId)?.meta?.episode_id;
      episode =
        botEpisodesDb.list(botId, 500).find((e) => e.run_ids.includes(ref.runId!)) ??
        (typeof fromMeta === 'string' ? botEpisodesDb.get(fromMeta) : null);
    }
    if (!episode || episode.bot_id !== botId) throw learningError('No episode found for that run', 404, 'BOT_EPISODE_NOT_FOUND');
    const { steps } = executedSteps(botId, { episodeId: episode.episode_id });
    const draft = await draftSkill({ botId, episode, steps, items: episodeItems(botId, episode.episode_id) });
    const name = uniqueName(botId, slugify(draft.name));
    return skills.save(botId, { name, content: draft.content, description: draft.description, origin: 'reflector', enabled: false });
  },

  /** Link an existing global skill (read-only). `target` is a SKILL.md file or a directory holding one. */
  linkCatalogSkill(botId: string, target: string): SkillView {
    requireBot(botId);
    if (typeof target !== 'string' || !target.trim()) throw learningError('Skill path is required');
    let resolved: string;
    try {
      resolved = fs.realpathSync(path.resolve(target));
      if (fs.statSync(resolved).isDirectory()) resolved = fs.realpathSync(path.join(resolved, 'SKILL.md'));
    } catch {
      throw learningError('Skill not found at that path', 404, 'BOT_SKILL_NOT_FOUND');
    }
    if (path.basename(resolved) !== 'SKILL.md') throw learningError('Only SKILL.md skills can be linked');
    if (!catalogRoots().some((root) => isInside(root, resolved))) throw learningError('Path is not inside a known skills catalog', 403, 'BOT_SKILL_FORBIDDEN');
    const name = slugify(path.basename(path.dirname(resolved)));
    const existing = botSkillsDb.getByName(botId, name);
    if (existing && existing.origin !== 'catalog') throw learningError(`A bot skill named "${name}" already exists`, 409);
    return describe(botSkillsDb.upsert({ botId, name, path: resolved, origin: 'catalog', enabled: true }));
  },
};
