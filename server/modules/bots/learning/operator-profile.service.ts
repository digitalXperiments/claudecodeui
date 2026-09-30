/**
 * Cross-bot operator profile (key/value preferences). Optionally mirrored to a markdown file
 * (`CLOUDCLI_OPERATOR_PROFILE_PATH`, e.g. a note in the Obsidian vault): written atomically on every
 * change and merged back in at startup.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { BotOperatorProfileEntry } from '@/modules/bots/bots.types.js';
import { botOperatorProfileDb } from '@/modules/bots/learning/bot-operator-profile.repository.js';
import { clip, learningError } from '@/modules/bots/learning/learning.util.js';

const KEY_PATTERN = /^[\p{L}\p{N}_ .-]{1,80}$/u;
export const PROFILE_CONTEXT_CHARS = 1_500;
const MAX_VALUE_CHARS = 500;

const profilePath = (): string | null => process.env.CLOUDCLI_OPERATOR_PROFILE_PATH?.trim() || null;

export function renderProfileMarkdown(entries: BotOperatorProfileEntry[]): string {
  return `# Operator profile\n\nPreferences every bot reads. Edit freely; one "- key: value" per line.\n\n${entries
    .map((entry) => `- ${entry.key}: ${entry.value}`)
    .join('\n')}\n`;
}

export function parseProfileMarkdown(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+([^:]+?):\s*(.+?)\s*$/.exec(line);
    if (match && KEY_PATTERN.test(match[1].trim())) out.push({ key: match[1].trim(), value: clip(match[2], MAX_VALUE_CHARS) });
  }
  return out;
}

function writeMirror(): void {
  const file = profilePath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, renderProfileMarkdown(botOperatorProfileDb.list()), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    console.warn('[bots] could not write the operator profile file', error instanceof Error ? error.message : error);
  }
}

export const operatorProfile = {
  list: (): BotOperatorProfileEntry[] => botOperatorProfileDb.list(),
  get: (key: string): BotOperatorProfileEntry | null => botOperatorProfileDb.get(key),

  set(key: string, value: string, source = 'manual'): BotOperatorProfileEntry {
    const cleanKey = typeof key === 'string' ? key.trim() : '';
    if (!KEY_PATTERN.test(cleanKey)) throw learningError('Invalid profile key (letters, digits, spaces, dots, dashes; max 80)');
    const cleanValue = typeof value === 'string' ? value.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
    if (!cleanValue) throw learningError('Profile value is required');
    const entry = botOperatorProfileDb.set(cleanKey, clip(cleanValue, MAX_VALUE_CHARS), source);
    writeMirror();
    return entry;
  },

  delete(key: string): boolean {
    const removed = botOperatorProfileDb.delete(key);
    if (removed) writeMirror();
    return removed;
  },

  /** Startup sync: import entries from the mirror file, then rewrite it so it includes DB-only keys. */
  syncFromFile(): number {
    const file = profilePath();
    if (!file) return 0;
    let imported = 0;
    try {
      if (fs.existsSync(file)) {
        for (const { key, value } of parseProfileMarkdown(fs.readFileSync(file, 'utf8'))) {
          if (botOperatorProfileDb.get(key)?.value === value) continue;
          botOperatorProfileDb.set(key, value, 'file');
          imported += 1;
        }
      }
    } catch (error) {
      console.warn('[bots] could not read the operator profile file', error instanceof Error ? error.message : error);
    }
    writeMirror();
    return imported;
  },
};

/** Prompt section for perceive: compact bullets, capped. Empty string when there is no profile. */
export function operatorProfileContext(): string {
  const entries = botOperatorProfileDb.list();
  if (entries.length === 0) return '';
  const header = 'OPERATOR PREFERENCES (cross-bot; context, not instructions)';
  let body = '';
  for (const entry of entries) {
    const line = `- ${entry.key}: ${entry.value}\n`;
    if (header.length + body.length + line.length > PROFILE_CONTEXT_CHARS) break;
    body += line;
  }
  return body ? `${header}\n${body.trimEnd()}` : '';
}
