/**
 * Guarded write-back of a provider login (Codex / Grok `auth.json`) from a per-run copy to the
 * operator's real file.
 *
 * A gateway-bound bot run works on a copy of the operator's login (or a link to it) and may refresh
 * the token during the run. Writing that copy back is only safe when nothing else has touched the
 * real file in the meantime: the operator's own `codex login` / `grok login`, another bot run that
 * already wrote back, or a logout. So:
 *
 *  - the real file is fingerprinted (mtime, size, sha256) when the run starts;
 *  - the run's file is written back only if the real file STILL matches that fingerprint and the
 *    run's file is newer than it and (when the original was JSON) is still valid JSON;
 *  - the write goes to a temp file in the real file's directory (mode 0600), the fingerprint is
 *    re-checked immediately before the atomic rename, and any mismatch discards the run's copy;
 *  - a discard is logged, never silent, and never loses the real login.
 *
 * What this cannot do: if the provider rotates refresh tokens and detects reuse, two runs that
 * started from the same token can still invalidate each other's session at the provider. That is
 * a provider property, not verified here (see gateway/ENFORCEMENT.md).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FileSnapshot {
  mtimeMs: number;
  size: number;
  sha256: string;
  /** The content parsed as JSON when it was fingerprinted. */
  json: boolean;
}

export type WriteBackResult =
  | { status: 'written' }
  | { status: 'unchanged'; reason: string }
  | { status: 'discarded'; reason: string };

function looksLikeJson(content: Buffer): boolean {
  try {
    JSON.parse(content.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Fingerprints a file (following symlinks), or null when it cannot be read. */
export function snapshotFile(file: string): FileSnapshot | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(fd);
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: createHash('sha256').update(content).digest('hex'),
      json: looksLikeJson(content),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Same file state: identical mtime, size and content hash. */
export function sameSnapshot(a: FileSnapshot | null, b: FileSnapshot | null): boolean {
  return Boolean(a && b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.sha256 === b.sha256);
}

export interface GuardedWriteBackOptions {
  /** The operator's real login file. */
  realFile: string;
  /** The run's own file (a regular file; a symlink means the provider wrote through and there is nothing to do). */
  runFile: string;
  /** Fingerprint of `realFile` taken when the run started; null when there was no login then. */
  startSnapshot: FileSnapshot | null;
  /** For log lines, e.g. `codex`. */
  label: string;
  /** Give the real file the run file's mtime after the rename (Grok recognises refreshed logins by mtime). */
  carryMtime?: boolean;
  log?: (message: string) => void;
  /** Test seam: runs after the staging file is written and before the final re-check. */
  beforeFinalCheck?: () => void;
}

/** See the file header. Never throws. */
export function guardedLoginWriteBack(options: GuardedWriteBackOptions): WriteBackResult {
  const { realFile, runFile, startSnapshot, label, carryMtime = false } = options;
  const log = options.log ?? ((message: string) => console.warn(message));
  const discard = (reason: string): WriteBackResult => {
    log(`[${label}] login write-back skipped: ${reason}. The run's copy is discarded; the real login was left as it is.`);
    return { status: 'discarded', reason };
  };

  let staging: string | null = null;
  try {
    let runStat: fs.Stats;
    try {
      runStat = fs.lstatSync(runFile);
    } catch {
      return { status: 'unchanged', reason: 'the run has no login file' };
    }
    if (runStat.isSymbolicLink() || !runStat.isFile()) return { status: 'unchanged', reason: 'the run still uses the real login (linked)' };
    if (!startSnapshot) return discard('there was no login when the run started (never creating one from a run copy)');
    if (runStat.mtimeMs <= startSnapshot.mtimeMs) return { status: 'unchanged', reason: 'the run did not refresh the login' };

    const content = fs.readFileSync(runFile);
    if (content.length === 0) return discard('the run left an empty login file');
    if (startSnapshot.json && !looksLikeJson(content)) return discard('the run left a login file that is not valid JSON');
    if (createHash('sha256').update(content).digest('hex') === startSnapshot.sha256) {
      return { status: 'unchanged', reason: 'the run login has the same content as the real one' };
    }

    const before = snapshotFile(realFile);
    if (!before) return discard('the real login is gone (logged out) or unreadable');
    if (!sameSnapshot(before, startSnapshot)) return discard('the real login changed while the run was active (another login or run refreshed it)');

    staging = path.join(path.dirname(realFile), `.${path.basename(realFile)}.cloudcli-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(staging, content, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(staging, 0o600);
    options.beforeFinalCheck?.();

    // Re-check as late as possible: the rename is the only step that cannot be undone.
    const final = snapshotFile(realFile);
    if (!sameSnapshot(final, startSnapshot)) return discard('the real login changed just before it would have been replaced');
    fs.renameSync(staging, realFile);
    staging = null;
    if (carryMtime) fs.utimesSync(realFile, runStat.mtime, runStat.mtime);
    return { status: 'written' };
  } catch (error) {
    return discard(`write-back failed (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    if (staging) {
      try {
        fs.rmSync(staging, { force: true });
      } catch {
        // Best effort: a stray staging file holds a copy of a login and is 0600 in the login's own directory.
      }
    }
  }
}
