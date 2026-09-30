import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  asString,
  MAX_EVENTS_PER_POLL,
  type WatchAdapter,
  type WatchEventDraft,
} from '@/modules/bots/signals/adapters/adapter.types.js';

const CURSOR_CAP = 2000;
/** macOS TCC-protected folders: the server daemon cannot be granted access (MDM), so reject them up front. */
const TCC_FOLDERS = ['Documents', 'Desktop', 'Downloads'];

export function expandHome(input: string, home = os.homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return input;
}

/** Returns an error message when the directory path is not allowed, else null. */
export function validateDirectoryPath(input: unknown, home = os.homedir()): string | null {
  if (typeof input !== 'string' || !input.trim()) return 'path is required';
  const resolved = path.resolve(expandHome(input.trim(), home));
  for (const folder of TCC_FOLDERS) {
    const protectedRoot = path.join(home, folder).toLowerCase();
    const lower = resolved.toLowerCase();
    if (lower === protectedRoot || lower.startsWith(protectedRoot + path.sep)) {
      return `path must not be inside ~/${folder} (macOS privacy protection blocks the server from reading it). Move the folder elsewhere.`;
    }
  }
  return null;
}

export function createDirectoryAdapter(deps: { home?: string } = {}): WatchAdapter {
  const home = deps.home ?? os.homedir();
  return {
    validate: (config) => validateDirectoryPath(config.path, home),
    async poll(config, cursor) {
      const invalid = validateDirectoryPath(config.path, home);
      if (invalid) throw new Error(invalid);
      const dir = path.resolve(expandHome(asString(config.path).trim(), home));
      // Re-check after symlink resolution so a link cannot point into a TCC folder.
      const real = await realpath(dir);
      const realInvalid = validateDirectoryPath(real, home);
      if (realInvalid) throw new Error(realInvalid);

      const includeHidden = config.include_hidden === true;
      const pattern = asString(config.pattern);
      let matcher: RegExp | null = null;
      if (pattern) {
        try {
          matcher = new RegExp(pattern);
        } catch {
          throw new Error('pattern is not a valid regular expression');
        }
      }

      const entries = await readdir(real, { withFileTypes: true });
      const current: Record<string, number> = {};
      const sizes: Record<string, number> = {};
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!includeHidden && entry.name.startsWith('.')) continue;
        if (matcher && !matcher.test(entry.name)) continue;
        try {
          const info = await stat(path.join(real, entry.name));
          current[entry.name] = Math.round(info.mtimeMs);
          sizes[entry.name] = info.size;
        } catch {
          // file vanished between readdir and stat
        }
        if (Object.keys(current).length >= CURSOR_CAP) break;
      }

      const previous = (cursor.files && typeof cursor.files === 'object' ? cursor.files : {}) as Record<string, number>;
      const initialized = cursor.initialized === true;
      const events: WatchEventDraft[] = [];
      if (initialized || config.emit_existing === true) {
        const changes = Object.keys(current)
          .filter((name) => previous[name] === undefined || previous[name] !== current[name])
          .sort((a, b) => current[a] - current[b]);
        for (const name of changes.slice(0, MAX_EVENTS_PER_POLL)) {
          events.push({
            source: 'watch:directory',
            kind: 'watch',
            dedupeKey: `dir:${real}:${name}:${current[name]}`,
            trust: 'external',
            payload: {
              adapter: 'directory',
              directory: real,
              name,
              path: path.join(real, name),
              change: previous[name] === undefined ? 'added' : 'changed',
              size: sizes[name],
              mtime_ms: current[name],
            },
          });
        }
      }
      return { events, cursor: { initialized: true, files: current } };
    },
  };
}
