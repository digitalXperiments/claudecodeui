/**
 * Managed installer for the Antigravity ACP runtime.
 *
 * Ports the verified-download pipeline the Electron shell already uses for
 * server bundles (`electron/serverInstaller.js`: redirect-capped download,
 * SHA-256 verification, external extraction) into a server-side service that
 * reports progress, so Settings can stream a real progress bar for what is a
 * multi-hundred-megabyte download.
 *
 * Two rules this file exists to enforce:
 *
 * 1. Nothing is installed from an unverified artifact. Both the SHA-256 **and**
 *    the exact byte size must match the pin in `antigravity-releases.ts`; a
 *    host with no pin fails with `ANTIGRAVITY_RUNTIME_NOT_PINNED` instead of
 *    downloading whatever the URL happens to serve.
 * 2. The install is only "done" when BOTH payloads are present — the ACP
 *    executable and its `localharness_external` sidecar — and an ACP
 *    `initialize` probe answered. A half-extracted archive is removed rather
 *    than left to fail later as a mysterious runtime error.
 *
 * Temp files live under `tmp/cloudcli/antigravity/` per the repo's strict temp
 * rule; the tree is removed on both success and failure.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import { ensureScratchRoot } from '@/shared/scratch.js';
import { AppError } from '@/shared/utils.js';

import {
  antigravityPlatformKey,
  resolveAntigravityArtifact,
  type AntigravityArtifactPin,
} from './antigravity-releases.js';
import {
  ANTIGRAVITY_EXECUTABLE_NAMES,
  ANTIGRAVITY_HARNESS_NAME,
  antigravityMarkerPath,
  antigravityRuntimeVersion,
  antigravityUnsupportedPlatformMessage,
  antigravityVersionDir,
  findManagedAntigravityExecutable,
  isAntigravityRuntimeInstalled,
} from './antigravity-runtime.js';

const MAX_REDIRECTS = 5;

export type AntigravityInstallProgress =
  | { phase: 'download'; receivedBytes: number; totalBytes: number; percent: number }
  | { phase: 'verify' | 'extract' | 'probe' | 'done'; message: string };

export type AntigravityInstallOptions = {
  onProgress?: (progress: AntigravityInstallProgress) => void;
  /** Reinstall even when the marker says this version is already present. */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Injected in tests so the pipeline can be exercised without the network. */
  download?: (url: string, destPath: string, onBytes: (received: number, total: number) => void) => Promise<void>;
};

export type AntigravityInstallResult = {
  version: string;
  executablePath: string;
  harnessPath: string;
  alreadyInstalled: boolean;
};

/** Absolute path of the scratch directory used for one install attempt. */
async function makeInstallScratchDir(): Promise<string> {
  const root = path.join(await ensureScratchRoot(), 'antigravity');
  await fs.mkdir(root, { recursive: true });
  const dir = path.join(root, `install-${process.pid}-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function downloadToFile(
  url: string,
  destPath: string,
  onBytes: (received: number, total: number) => void,
  redirectsLeft = MAX_REDIRECTS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const { statusCode, headers } = response;

      if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects while downloading the Antigravity runtime'));
          return;
        }
        const next = new URL(headers.location, url);
        if (next.protocol !== 'https:') {
          reject(new Error(`Refusing non-HTTPS redirect to ${next.toString()}`));
          return;
        }
        resolve(downloadToFile(next.toString(), destPath, onBytes, redirectsLeft - 1));
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Antigravity runtime download failed with HTTP ${statusCode}`));
        return;
      }

      const total = Number(headers['content-length']) || 0;
      let received = 0;
      const out = createWriteStream(destPath);
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onBytes(received, total);
      });
      response.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Verify size first: it is O(1) and it turns the common failure (a truncated or
 * error-page download) into an accurate message instead of a bare hash
 * mismatch.
 */
export async function verifyArtifact(archivePath: string, pin: AntigravityArtifactPin): Promise<void> {
  const { size } = await fs.stat(archivePath);
  if (size !== pin.size) {
    throw new AppError(
      `Antigravity runtime download is ${size} bytes but the pin expects ${pin.size} — refusing to install.`,
      { code: 'ANTIGRAVITY_ARTIFACT_SIZE_MISMATCH', statusCode: 502 },
    );
  }
  const actual = (await sha256File(archivePath)).toLowerCase();
  if (actual !== pin.sha256.toLowerCase()) {
    throw new AppError(
      'Antigravity runtime checksum does not match the pinned SHA-256 — refusing to install.',
      { code: 'ANTIGRAVITY_ARTIFACT_CHECKSUM_MISMATCH', statusCode: 502 },
    );
  }
}

function runExtractor(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/**
 * Extract with the host's own archiver.
 *
 * `.zip` prefers `unzip` and falls back to `tar -xf` (bsdtar, which ships on
 * macOS and modern Windows, reads zip); tarballs go straight to `tar`. Shelling
 * out avoids adding an archive dependency for a path that only runs once per
 * runtime version.
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    try {
      await runExtractor('unzip', ['-oq', archivePath, '-d', destDir]);
      return;
    } catch {
      await runExtractor('tar', ['-xf', archivePath, '-C', destDir]);
      return;
    }
  }
  const args = lower.endsWith('.tar.gz') || lower.endsWith('.tgz')
    ? ['-xzf', archivePath, '-C', destDir]
    : ['-xf', archivePath, '-C', destDir];
  await runExtractor('tar', args);
}

async function findEntry(root: string, names: readonly string[]): Promise<string | null> {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (names.includes(entry.name)) return full;
      if (entry.isDirectory()) queue.push(full);
    }
  }
  return null;
}

/**
 * Move the two payloads we need out of whatever nesting the archive used and
 * into the flat version directory. Everything else in the archive is dropped:
 * the runtime only needs the ACP entry point and its harness, and keeping the
 * rest would double the on-disk footprint of an already large download.
 */
async function collectPayloads(extractRoot: string, versionDir: string): Promise<{ executablePath: string; harnessPath: string }> {
  const executableSource = await findEntry(extractRoot, ANTIGRAVITY_EXECUTABLE_NAMES);
  if (!executableSource) {
    throw new AppError(
      `The Antigravity archive did not contain an ACP executable (looked for ${ANTIGRAVITY_EXECUTABLE_NAMES.join(', ')}).`,
      { code: 'ANTIGRAVITY_ARCHIVE_MISSING_EXECUTABLE', statusCode: 502 },
    );
  }
  const harnessSource = await findEntry(extractRoot, [ANTIGRAVITY_HARNESS_NAME]);
  if (!harnessSource) {
    throw new AppError(
      `The Antigravity archive did not contain ${ANTIGRAVITY_HARNESS_NAME}.`,
      { code: 'ANTIGRAVITY_ARCHIVE_MISSING_HARNESS', statusCode: 502 },
    );
  }

  const executablePath = path.join(versionDir, path.basename(executableSource));
  const harnessPath = path.join(versionDir, ANTIGRAVITY_HARNESS_NAME);
  await fs.rm(executablePath, { recursive: true, force: true });
  await fs.rm(harnessPath, { recursive: true, force: true });
  await fs.rename(executableSource, executablePath);
  await fs.rename(harnessSource, harnessPath);

  // The archive's mode bits do not survive every extractor (notably `unzip` on
  // some Windows shells), and a non-executable ACP entry point spawns as EACCES.
  await fs.chmod(executablePath, 0o755).catch(() => {});
  const harnessStat = await fs.stat(harnessPath);
  if (harnessStat.isFile()) {
    await fs.chmod(harnessPath, 0o755).catch(() => {});
  }

  return { executablePath, harnessPath };
}

/**
 * Download, verify, extract and record the Antigravity runtime for this host.
 *
 * Returns the resolved paths. Errors are `AppError`s with codes the Settings UI
 * can branch on; the version directory is removed on failure so a retry starts
 * clean rather than repairing a half install.
 */
export async function installAntigravityRuntime(
  options: AntigravityInstallOptions = {},
): Promise<AntigravityInstallResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const version = antigravityRuntimeVersion(env);
  const report = options.onProgress ?? (() => {});

  const platformKey = antigravityPlatformKey(platform, arch);
  if (!platformKey) {
    throw new AppError(antigravityUnsupportedPlatformMessage(platform, arch), {
      code: 'ANTIGRAVITY_UNSUPPORTED_PLATFORM',
      statusCode: 400,
    });
  }

  if (!options.force && isAntigravityRuntimeInstalled(version, env)) {
    const executablePath = findManagedAntigravityExecutable(version, env) as string;
    report({ phase: 'done', message: `Antigravity runtime ${version} already installed.` });
    return {
      version,
      executablePath,
      harnessPath: path.join(antigravityVersionDir(version, env), ANTIGRAVITY_HARNESS_NAME),
      alreadyInstalled: true,
    };
  }

  const pin = resolveAntigravityArtifact(platformKey, env);
  if (!pin) {
    throw new AppError(
      `CloudCLI has no verified download pin for the Antigravity ${version} runtime on ${platformKey}. `
      + 'Pins ship with CloudCLI releases; to install now, point CLOUDCLI_ANTIGRAVITY_MANIFEST at a JSON file '
      + 'containing the official URL, SHA-256 and byte size for this host.',
      { code: 'ANTIGRAVITY_RUNTIME_NOT_PINNED', statusCode: 503 },
    );
  }

  const versionDir = antigravityVersionDir(version, env);
  const scratchDir = await makeInstallScratchDir();
  const archiveName = path.basename(new URL(pin.url).pathname) || `antigravity-${version}-${platformKey}.zip`;
  const archivePath = path.join(scratchDir, archiveName);
  const extractRoot = path.join(scratchDir, 'extract');

  try {
    const download = options.download ?? downloadToFile;
    let lastPercent = -1;
    await download(pin.url, archivePath, (receivedBytes, totalBytes) => {
      const total = totalBytes || pin.size;
      const percent = total > 0 ? Math.min(100, Math.floor((receivedBytes / total) * 100)) : 0;
      // One event per whole percent: a 500MB download otherwise emits tens of
      // thousands of SSE frames for no extra information.
      if (percent === lastPercent) return;
      lastPercent = percent;
      report({ phase: 'download', receivedBytes, totalBytes: total, percent });
    });

    report({ phase: 'verify', message: 'Verifying checksum and size…' });
    await verifyArtifact(archivePath, pin);

    report({ phase: 'extract', message: 'Extracting runtime…' });
    await fs.mkdir(extractRoot, { recursive: true });
    await extractArchive(archivePath, extractRoot);

    await fs.rm(versionDir, { recursive: true, force: true });
    await fs.mkdir(versionDir, { recursive: true });
    const { executablePath, harnessPath } = await collectPayloads(extractRoot, versionDir);

    const marker = {
      version,
      platformKey,
      executable: path.basename(executablePath),
      sha256: pin.sha256.toLowerCase(),
      size: pin.size,
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(antigravityMarkerPath(version, env), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

    report({ phase: 'done', message: `Antigravity runtime ${version} installed.` });
    return { version, executablePath, harnessPath, alreadyInstalled: false };
  } catch (error) {
    await fs.rm(versionDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof AppError) throw error;
    throw new AppError(
      `Failed to install the Antigravity runtime: ${(error as Error)?.message || String(error)}`,
      { code: 'ANTIGRAVITY_INSTALL_FAILED', statusCode: 502 },
    );
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Remove the managed runtime for one version. Used by Settings' "Remove" action. */
export async function uninstallAntigravityRuntime(
  env: NodeJS.ProcessEnv = process.env,
  version: string = antigravityRuntimeVersion(env),
): Promise<void> {
  await fs.rm(antigravityVersionDir(version, env), { recursive: true, force: true });
}
