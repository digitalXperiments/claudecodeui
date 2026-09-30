import fsp from 'node:fs/promises';

/**
 * Incremental JSONL readers for append-only provider transcripts.
 *
 * Provider transcripts (Claude's `<session>.jsonl`, `history.jsonl`) only
 * ever grow while a session is live, yet every history read, watcher event
 * and sync used to re-read and re-parse the whole file. These helpers keep a
 * byte offset per file and parse only the bytes appended since the last read.
 *
 * Append detection: same device/inode, size >= the consumed offset, and two
 * small fingerprints still matching — the file's first bytes and the bytes
 * just before the consumed offset. Anything else (truncation, rewrite, atomic
 * replace, a different file at the same path) triggers a full reparse, so the
 * result is always identical to parsing the file from scratch.
 *
 * Partial trailing line: bytes after the last `\n` are never committed. If
 * they already form valid JSON (a writer that ends the file without a
 * newline) they are included in that one result, but re-read next time.
 */

const READ_CHUNK_BYTES = 1024 * 1024;
const FINGERPRINT_BYTES = 4096;
const NEWLINE = 0x0a;

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

type FingerprintState = {
  /** Bytes consumed (end offset of the last complete line). */
  offset: number;
  head: Buffer;
  /** Bytes [offset - boundary.length, offset). */
  boundary: Buffer;
};

async function readRange(handle: fsp.FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

async function captureFingerprint(
  handle: fsp.FileHandle,
  offset: number,
  fingerprintBytes = FINGERPRINT_BYTES,
): Promise<FingerprintState> {
  const headLength = Math.min(fingerprintBytes, offset);
  const boundaryLength = Math.min(fingerprintBytes, offset);
  const head = headLength > 0 ? Buffer.from(await readRange(handle, 0, headLength)) : Buffer.alloc(0);
  const boundary = boundaryLength > 0
    ? Buffer.from(await readRange(handle, offset - boundaryLength, boundaryLength))
    : Buffer.alloc(0);
  return { offset, head, boundary };
}

async function fingerprintMatches(handle: fsp.FileHandle, state: FingerprintState): Promise<boolean> {
  if (state.head.length > 0) {
    const head = await readRange(handle, 0, state.head.length);
    if (!head.equals(state.head)) return false;
  }
  if (state.boundary.length > 0) {
    const boundary = await readRange(handle, state.offset - state.boundary.length, state.boundary.length);
    if (!boundary.equals(state.boundary)) return false;
  }
  return true;
}

/**
 * Streams complete lines of `[start, end)` to `onLine` and returns the end
 * offset of the last complete line plus the unterminated remainder (if any).
 * Splitting happens on raw bytes: 0x0A never occurs inside a UTF-8 multibyte
 * sequence, so chunk boundaries can never corrupt a character.
 */
async function scanLines(
  handle: fsp.FileHandle,
  start: number,
  end: number,
  onLine: (line: string) => void,
): Promise<{ consumedTo: number; remainder: string }> {
  let position = start;
  let consumedTo = start;
  let carry: Buffer | null = null;

  while (position < end) {
    const chunk = await readRange(handle, position, Math.min(READ_CHUNK_BYTES, end - position));
    if (chunk.length === 0) break;
    const chunkStart = position;
    position += chunk.length;

    let lineStart = 0;
    let newlineIndex = chunk.indexOf(NEWLINE, lineStart);
    while (newlineIndex !== -1) {
      const piece = chunk.subarray(lineStart, newlineIndex);
      const lineBuffer: Buffer = carry ? Buffer.concat([carry, piece]) : piece;
      carry = null;
      onLine(lineBuffer.toString('utf8'));
      consumedTo = chunkStart + newlineIndex + 1;
      lineStart = newlineIndex + 1;
      newlineIndex = chunk.indexOf(NEWLINE, lineStart);
    }
    if (lineStart < chunk.length) {
      const rest = chunk.subarray(lineStart);
      carry = carry ? Buffer.concat([carry, rest]) : Buffer.from(rest);
    }
  }

  return { consumedTo, remainder: carry ? carry.toString('utf8') : '' };
}

function tryParseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Malformed lines happen during concurrent writes; skip like readline did.
    return undefined;
  }
}

async function statIdentity(filePath: string): Promise<FileIdentity | null> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Serializes async work per key so concurrent readers never double-append. */
function createKeyedLock() {
  const tails = new Map<string, Promise<unknown>>();
  return async function withLock<R>(key: string, work: () => Promise<R>): Promise<R> {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    tails.set(key, run);
    try {
      return await run;
    } finally {
      if (tails.get(key) === run) tails.delete(key);
    }
  };
}

type EntriesCacheEntry = {
  identity: FileIdentity;
  fingerprint: FingerprintState;
  entries: unknown[];
};

export type IncrementalJsonlReadResult = {
  /** Parsed JSON values of every non-empty, valid line, in file order. Treat as read-only. */
  entries: readonly unknown[];
  /** 'hit' = unchanged file, 'append' = only new bytes parsed, 'full' = parsed from byte 0. */
  mode: 'hit' | 'append' | 'full' | 'missing';
  /** Bytes read from disk for this call (excluding fingerprint checks). */
  bytesRead: number;
};

/**
 * Parsed-entries cache for append-only JSONL files, bounded by entry count and
 * consumed file bytes (a parsed transcript costs roughly its file size).
 */
export function createIncrementalJsonlReader(options: { maxEntries?: number; maxTotalBytes?: number } = {}) {
  const maxEntries = options.maxEntries ?? 6;
  const maxTotalBytes = options.maxTotalBytes ?? 128 * 1024 * 1024;
  const cache = new Map<string, EntriesCacheEntry>();
  const withLock = createKeyedLock();

  function evictOverBudget(): void {
    let totalBytes = 0;
    for (const entry of cache.values()) totalBytes += entry.fingerprint.offset;
    for (const key of cache.keys()) {
      if (cache.size <= 1 || (totalBytes <= maxTotalBytes && cache.size <= maxEntries)) break;
      totalBytes -= cache.get(key)!.fingerprint.offset;
      cache.delete(key);
    }
  }

  async function readUnlocked(filePath: string): Promise<IncrementalJsonlReadResult> {
    const identity = await statIdentity(filePath);
    if (!identity) {
      cache.delete(filePath);
      return { entries: [], mode: 'missing', bytesRead: 0 };
    }

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(filePath, 'r');
    } catch {
      cache.delete(filePath);
      return { entries: [], mode: 'missing', bytesRead: 0 };
    }

    try {
      const cached = cache.get(filePath);
      let entries: unknown[];
      let start = 0;
      let mode: IncrementalJsonlReadResult['mode'] = 'full';

      if (
        cached
        && cached.identity.dev === identity.dev
        && cached.identity.ino === identity.ino
        && identity.size >= cached.fingerprint.offset
        && await fingerprintMatches(handle, cached.fingerprint)
      ) {
        entries = cached.entries;
        start = cached.fingerprint.offset;
        mode = identity.size === cached.fingerprint.offset ? 'hit' : 'append';
      } else {
        entries = [];
      }

      const { consumedTo, remainder } = await scanLines(handle, start, identity.size, (line) => {
        const parsed = tryParseJsonLine(line);
        if (parsed !== undefined) entries.push(parsed);
      });
      const bytesRead = identity.size - start;

      const fingerprint = consumedTo === cached?.fingerprint.offset && mode !== 'full'
        ? cached.fingerprint
        : await captureFingerprint(handle, consumedTo);
      cache.delete(filePath);
      cache.set(filePath, { identity, fingerprint, entries });
      evictOverBudget();

      const trailing = tryParseJsonLine(remainder);
      if (mode === 'hit' && bytesRead > 0) mode = 'append';
      return {
        entries: trailing === undefined ? entries : [...entries, trailing],
        mode,
        bytesRead,
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    read(filePath: string): Promise<IncrementalJsonlReadResult> {
      return withLock(filePath, () => readUnlocked(filePath));
    },
    delete(filePath: string): void {
      cache.delete(filePath);
    },
    clear(): void {
      cache.clear();
    },
    size(): number {
      return cache.size;
    },
  };
}

type LastMatchCacheEntry<T> = {
  identity: FileIdentity;
  fingerprint: FingerprintState;
  match: T | undefined;
};

/**
 * Finds the LAST line in a JSONL file whose parsed value satisfies `extract`
 * (returns a non-undefined value), remembering per file how far it has
 * scanned. A grown file only scans its appended bytes: a match there
 * supersedes the remembered one, otherwise the remembered match stands —
 * exactly what a full backwards scan of the whole file would return.
 *
 * `cacheKey` must identify the extractor semantics (e.g. `title:<sessionId>`)
 * because the remembered match is extractor-specific.
 */
export function createLastJsonlMatchScanner<T>(options: {
  maxEntries?: number;
  /**
   * Cheap raw-line prefilter run before JSON.parse (e.g. "contains
   * `\"ai-title\"`"). Lines it rejects are never parsed, which keeps the
   * first full scan of a multi-megabyte transcript cheap.
   */
  lineFilter?: (line: string) => boolean;
} = {}) {
  const maxEntries = options.maxEntries ?? 2000;
  const lineFilter = options.lineFilter;
  // Many small entries (one per transcript): keep fingerprints small.
  const scannerFingerprintBytes = 512;
  const cache = new Map<string, LastMatchCacheEntry<T>>();
  const withLock = createKeyedLock();

  async function scanUnlocked(
    filePath: string,
    cacheKey: string,
    extract: (value: unknown) => T | undefined,
  ): Promise<T | undefined> {
    const key = `${cacheKey}\u0000${filePath}`;
    const identity = await statIdentity(filePath);
    if (!identity) {
      cache.delete(key);
      return undefined;
    }

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(filePath, 'r');
    } catch {
      cache.delete(key);
      return undefined;
    }

    try {
      const cached = cache.get(key);
      let start = 0;
      let match: T | undefined;
      if (
        cached
        && cached.identity.dev === identity.dev
        && cached.identity.ino === identity.ino
        && identity.size >= cached.fingerprint.offset
        && await fingerprintMatches(handle, cached.fingerprint)
      ) {
        if (identity.size === cached.fingerprint.offset) {
          cache.delete(key);
          cache.set(key, cached);
          return cached.match;
        }
        start = cached.fingerprint.offset;
        match = cached.match;
      }

      const { consumedTo, remainder } = await scanLines(handle, start, identity.size, (line) => {
        if (lineFilter && !lineFilter(line)) return;
        const parsed = tryParseJsonLine(line);
        if (parsed === undefined) return;
        const extracted = extract(parsed);
        if (extracted !== undefined) match = extracted;
      });

      const fingerprint = await captureFingerprint(handle, consumedTo, scannerFingerprintBytes);
      cache.delete(key);
      cache.set(key, { identity, fingerprint, match });
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }

      const trailing = !remainder.trim() || (lineFilter && !lineFilter(remainder))
        ? undefined
        : tryParseJsonLine(remainder);
      if (trailing !== undefined) {
        const extracted = extract(trailing);
        if (extracted !== undefined) return extracted;
      }
      return match;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    scan(filePath: string, cacheKey: string, extract: (value: unknown) => T | undefined): Promise<T | undefined> {
      return withLock(`${cacheKey}\u0000${filePath}`, () => scanUnlocked(filePath, cacheKey, extract));
    },
    clear(): void {
      cache.clear();
    },
  };
}

/**
 * Builds a first-seen key/value lookup map from a JSONL index file (e.g.
 * `~/.claude/history.jsonl`), maintained incrementally: appended lines only
 * add keys not seen before, which matches a from-scratch first-wins build.
 * A rewritten/truncated file is rebuilt from byte 0.
 */
export function createIncrementalLookupMap(keyField: string, valueField: string) {
  let state: { filePath: string; identity: FileIdentity; fingerprint: FingerprintState; map: Map<string, string> } | null = null;
  const withLock = createKeyedLock();

  async function buildUnlocked(filePath: string): Promise<Map<string, string>> {
    const identity = await statIdentity(filePath);
    if (!identity) {
      state = null;
      return new Map();
    }

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(filePath, 'r');
    } catch {
      state = null;
      return new Map();
    }

    try {
      let map: Map<string, string>;
      let start = 0;
      if (
        state
        && state.filePath === filePath
        && state.identity.dev === identity.dev
        && state.identity.ino === identity.ino
        && identity.size >= state.fingerprint.offset
        && await fingerprintMatches(handle, state.fingerprint)
      ) {
        if (identity.size === state.fingerprint.offset) {
          return state.map;
        }
        map = state.map;
        start = state.fingerprint.offset;
      } else {
        map = new Map();
      }

      const add = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        const key = record[keyField];
        const mapped = record[valueField];
        if (typeof key === 'string' && typeof mapped === 'string' && !map.has(key)) {
          map.set(key, mapped);
        }
      };

      const { consumedTo, remainder } = await scanLines(handle, start, identity.size, (line) => {
        add(tryParseJsonLine(line));
      });
      state = { filePath, identity, fingerprint: await captureFingerprint(handle, consumedTo), map };

      const trailing = tryParseJsonLine(remainder);
      if (trailing === undefined) return map;
      // Don't commit the unterminated line into the persistent map.
      const withTrailing = new Map(map);
      const record = trailing as Record<string, unknown> | null;
      const key = record?.[keyField];
      const mapped = record?.[valueField];
      if (typeof key === 'string' && typeof mapped === 'string' && !withTrailing.has(key)) {
        withTrailing.set(key, mapped);
      }
      return withTrailing;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    get(filePath: string): Promise<Map<string, string>> {
      return withLock(filePath, () => buildUnlocked(filePath));
    },
    clear(): void {
      state = null;
    },
  };
}
