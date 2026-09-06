import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import JSZip from 'jszip';
import { Cron } from 'croner';

import { appConfigDb, getConnection, getDatabasePath, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getEnabledProviderWatchPaths } from '@/modules/providers/index.js';
import { getKiloDatabasePath, getOpenCodeDatabasePath, normalizeProjectPath } from '@/shared/utils.js';

const CONFIG_KEY = 'backup_manager_config';
const HISTORY_KEY = 'backup_manager_history';
const DEFAULT_CONFIG = {
  enabled: false,
  schedule: '0 2 * * *',
  destination: path.join(os.homedir(), '.cloudcli', 'backups'),
  includeDatabase: true,
  includeCodebase: true,
  includeAgentConversations: true,
  excludedProjectPaths: [],
  includeProjects: false,
  projectPaths: [],
  retention: 7,
};

// How a provider's on-disk session artifact can be isolated to a single
// project. `file`/`dir` back up exactly the entry sessions.jsonl_path points
// at (a transcript file, or — for providers that anchor a session on a
// directory — that directory). `dirOfFile` backs up the parent directory of
// the anchor file, for providers whose transcript lives in a sibling file
// inside a per-session directory. `sharedStore` means the provider keeps
// every project's sessions in one shared store with no per-session boundary
// CloudCLI can safely cut along, so it is only backed up whole, and only when
// doing so cannot include an excluded project's data.
const PROVIDER_SESSION_ARTIFACT_MODE = {
  claude: 'file',
  codex: 'file',
  cursor: 'file',
  omp: 'file',
  pi: 'file',
  qwencode: 'file',
  kimi: 'dirOfFile',
  grok: 'dirOfFile',
  cline: 'dir',
  opencode: 'sharedStore',
  kilo: 'sharedStore',
  antigravity: 'antigravity',
};

const SHARED_PROVIDER_DATABASE_PATH = {
  opencode: getOpenCodeDatabasePath,
  kilo: getKiloDatabasePath,
};

let appRoot = process.cwd();
let cronJob = null;
let running = false;
let conversationSourcesForTests = null;

export function setBackupConversationSourcesForTests(sources) {
  conversationSourcesForTests = sources;
}

function readJson(key, fallback) {
  try {
    const value = appConfigDb.get(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizePathList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const resolved = path.resolve(item.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
    seen.add(resolved);
  }
  return [...seen];
}

function normalizeConfig(value = {}) {
  const retention = Number.parseInt(String(value.retention ?? DEFAULT_CONFIG.retention), 10);
  return {
    ...DEFAULT_CONFIG,
    ...value,
    enabled: Boolean(value.enabled),
    schedule: typeof value.schedule === 'string' && value.schedule.trim() ? value.schedule.trim() : DEFAULT_CONFIG.schedule,
    destination: typeof value.destination === 'string' && value.destination.trim()
      ? path.resolve(value.destination.trim().replace(/^~(?=$|[\\/])/, os.homedir()))
      : DEFAULT_CONFIG.destination,
    includeDatabase: value.includeDatabase !== false,
    includeCodebase: value.includeCodebase !== false,
    includeAgentConversations: value.includeAgentConversations !== false,
    excludedProjectPaths: Array.isArray(value.excludedProjectPaths)
      ? [...new Set(value.excludedProjectPaths.filter((item) => typeof item === 'string' && item.trim()).map((item) => normalizeProjectPath(item)))]
      : [],
    includeProjects: Boolean(value.includeProjects),
    projectPaths: normalizePathList(value.projectPaths),
    retention: Number.isFinite(retention) ? Math.max(1, Math.min(100, retention)) : DEFAULT_CONFIG.retention,
  };
}

function assertValidCron(schedule) {
  try {
    new Cron(schedule).stop();
  } catch (error) {
    throw new Error(`Invalid backup cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getBackupConfig() {
  return normalizeConfig(readJson(CONFIG_KEY, DEFAULT_CONFIG));
}

export function getBackupHistory() {
  const history = readJson(HISTORY_KEY, []);
  return Array.isArray(history) ? history.slice(0, 20) : [];
}

function saveConfig(config) {
  appConfigDb.set(CONFIG_KEY, JSON.stringify(config));
}

function saveHistory(entry) {
  appConfigDb.set(HISTORY_KEY, JSON.stringify([entry, ...getBackupHistory()].slice(0, 20)));
}

function shouldSkip(relativePath) {
  return relativePath.split(path.sep).some((part) => ['node_modules', '.git', 'dist', 'dist-server', 'tmp'].includes(part));
}

/**
 * Recursively copies `source` into the zip under `archivePrefix`. Symlinks are
 * skipped outright (never followed) so a link planted inside a watched
 * directory cannot walk the archiver outside the intended tree or back into
 * the backup destination itself; `excludedRoot` is an extra belt-and-braces
 * check against the destination folder being nested inside a source root.
 */
async function addDirectory(zip, source, archivePrefix, excludedRoot) {
  let entries;
  try { entries = await fs.readdir(source, { withFileTypes: true }); } catch { return { filesAdded: 0, errors: 1, unsafeSkipped: 0 }; }
  let filesAdded = 0;
  let errors = 0;
  let unsafeSkipped = 0;
  for (const entry of entries) {
    const fullPath = path.join(source, entry.name);
    if (excludedRoot && path.resolve(fullPath) === path.resolve(excludedRoot)) continue;
    if (entry.isSymbolicLink()) {
      unsafeSkipped += 1;
      continue;
    }
    const relative = path.join(archivePrefix, entry.name);
    if (shouldSkip(relative)) continue;
    if (entry.isDirectory()) {
      const result = await addDirectory(zip, fullPath, relative, excludedRoot);
      filesAdded += result.filesAdded;
      errors += result.errors;
      unsafeSkipped += result.unsafeSkipped;
    }
    else if (entry.isFile()) {
      try {
        zip.file(relative.replaceAll(path.sep, '/'), await fs.readFile(fullPath));
        filesAdded += 1;
      } catch {
        // A file may disappear during a snapshot, but callers still need to
        // know the requested tree was only partially captured.
        errors += 1;
      }
    }
  }
  return { filesAdded, errors, unsafeSkipped };
}

function isStrictlyContained(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveReadableConversationRoot(rootPath) {
  try {
    const canonicalPath = await fs.realpath(rootPath);
    const stat = await fs.stat(canonicalPath);
    if (!stat.isDirectory()) return null;
    await fs.access(canonicalPath, fsConstants.R_OK | fsConstants.X_OK);
    return { configuredPath: path.resolve(rootPath), canonicalPath };
  } catch {
    return null;
  }
}

/**
 * Resolves a session-derived artifact without following a planted symlink or
 * accepting a lexical/canonical escape from the provider's conversation root.
 */
async function resolveContainedArtifact(root, artifactPath) {
  const absolutePath = path.resolve(artifactPath);
  if (!isStrictlyContained(root.configuredPath, absolutePath)) {
    return { ok: false, kind: 'unsafe' };
  }

  try {
    const lexicalRelativePath = path.relative(root.configuredPath, absolutePath);
    const lstat = await fs.lstat(absolutePath);
    if (lstat.isSymbolicLink()) return { ok: false, kind: 'unsafe' };

    const realPath = await fs.realpath(absolutePath);
    const expectedRealPath = path.resolve(root.canonicalPath, lexicalRelativePath);
    if (realPath !== expectedRealPath || !isStrictlyContained(root.canonicalPath, realPath)) {
      return { ok: false, kind: 'unsafe' };
    }
    return { ok: true, realPath, stat: lstat };
  } catch (error) {
    return { ok: false, kind: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function archiveSessionSegment(sessionId) {
  return encodeURIComponent(sessionId);
}

function projectArchivePrefix(projectPath) {
  const identity = createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 16);
  return path.join('projects', `${path.basename(projectPath)}-${identity}`);
}

async function addContainedFile(zip, root, artifactPath, archivePath) {
  const resolved = await resolveContainedArtifact(root, artifactPath);
  if (!resolved.ok) return resolved;
  if (!resolved.stat.isFile()) return { ok: false, kind: 'unsafe' };
  try {
    zip.file(archivePath.replaceAll(path.sep, '/'), await fs.readFile(resolved.realPath));
    return { ok: true };
  } catch {
    return { ok: false, kind: 'unreadable' };
  }
}

async function addDatabase(zip) {
  const databasePath = getDatabasePath();
  try {
    getConnection().pragma('wal_checkpoint(PASSIVE)');
  } catch { /* best effort; the copy still includes WAL/SHM when present */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { zip.file(`database/${path.basename(databasePath)}${suffix}`, await fs.readFile(`${databasePath}${suffix}`)); } catch { /* optional sidecar */ }
  }
}

/**
 * Backs up provider-native conversation/session data, scoped to the
 * registered CloudCLI projects that are not in `excludedProjectPaths`.
 *
 * Providers whose sessions are addressable one-by-one on disk (see
 * `PROVIDER_SESSION_ARTIFACT_MODE`) are filtered per session, so an excluded
 * project's transcripts are never written to the archive. Providers that
 * keep every project's sessions in one shared store can only be backed up
 * whole: that only happens when no excluded project has sessions in that
 * store, and the outcome is always recorded truthfully in the returned
 * summary rather than silently degrading or silently over-including.
 */
async function addAgentConversations(zip, config) {
  const excludedSet = new Set(config.excludedProjectPaths);
  const registeredProjects = projectsDb.getProjectPaths();
  const registeredPathSet = new Set(registeredProjects.map((project) => project.project_path));
  const excludedProjectPaths = [...excludedSet].filter((projectPath) => registeredPathSet.has(projectPath));
  const includedProjectPaths = registeredProjects
    .map((project) => project.project_path)
    .filter((projectPath) => !excludedSet.has(projectPath));

  // The visible-session query deliberately hides archived and internal rows.
  // Backup privacy cannot: their provider-native artifacts remain on disk and
  // can leak through a shared store unless they participate in exclusions.
  const allSessions = sessionsDb.getAllSessionsForBackup();
  const providerWatchPaths = conversationSourcesForTests ?? getEnabledProviderWatchPaths(new Set());
  const providers = [];
  const warnings = [];

  for (const { provider, rootPath, databasePath: configuredDatabasePath } of providerWatchPaths) {
    const providerSessions = allSessions.filter((session) => session.provider === provider);
    const mode = PROVIDER_SESSION_ARTIFACT_MODE[provider] ?? 'sharedStore';
    const includedSessions = providerSessions.filter((session) => {
      const projectPath = normalizeProjectPath(session.project_path || session.runtime_project_path || '');
      return !excludedSet.has(projectPath);
    });
    const sessionsExcluded = providerSessions.length - includedSessions.length;

    if (mode === 'sharedStore') {
      if (sessionsExcluded > 0) {
        providers.push({
          provider,
          mode,
          coverage: 'skipped',
          sessionsInStore: providerSessions.length,
          sessionsExcluded,
          reason: 'This provider keeps every project\'s sessions in one shared store with no per-session boundary, so it cannot be split by project. It was skipped entirely to honor the excluded project(s).',
        });
        warnings.push(`${provider}: skipped — cannot exclude projects from its shared session store, and at least one excluded project has ${provider} sessions.`);
        continue;
      }

      if (providerSessions.length === 0) {
        providers.push({ provider, mode, coverage: 'empty', sessionsInStore: 0 });
        continue;
      }

      const root = await resolveReadableConversationRoot(rootPath);
      if (!root) {
        providers.push({ provider, mode, coverage: 'unavailable', sessionsInStore: providerSessions.length });
        warnings.push(`${provider}: its requested conversation root is missing or unreadable, so no sessions were backed up.`);
        continue;
      }

      const databasePath = configuredDatabasePath ?? SHARED_PROVIDER_DATABASE_PATH[provider]?.();
      if (!databasePath) {
        providers.push({ provider, mode, coverage: 'skipped', sessionsInStore: providerSessions.length });
        warnings.push(`${provider}: skipped — no exact transcript store is known, so the provider data root was not copied.`);
        continue;
      }

      const archiveDatabaseName = path.basename(databasePath);
      const mainResult = await addContainedFile(
        zip,
        root,
        databasePath,
        path.join('conversations', provider, archiveDatabaseName),
      );
      if (!mainResult.ok) {
        providers.push({ provider, mode, coverage: 'unavailable', sessionsInStore: providerSessions.length });
        warnings.push(`${provider}: its shared conversation database is missing, unreadable, or outside the expected conversation root, so it was skipped.`);
        continue;
      }

      let sidecarErrors = 0;
      for (const suffix of ['-wal', '-shm']) {
        const sidecarResult = await addContainedFile(
          zip,
          root,
          `${databasePath}${suffix}`,
          path.join('conversations', provider, `${archiveDatabaseName}${suffix}`),
        );
        if (!sidecarResult.ok && sidecarResult.kind !== 'missing') sidecarErrors += 1;
      }
      providers.push({
        provider,
        mode,
        coverage: sidecarErrors > 0 ? 'partial' : 'full-store',
        sessionsInStore: providerSessions.length,
      });
      if (sidecarErrors > 0) {
        warnings.push(`${provider}: ${sidecarErrors} SQLite sidecar(s) were unsafe or unreadable and were skipped.`);
      }
      continue;
    }

    if (includedSessions.length === 0) {
      providers.push({
        provider,
        mode,
        coverage: 'empty',
        sessionsBackedUp: 0,
        sessionsSkippedMissing: 0,
        sessionsSkippedUnsafe: 0,
        sessionsExcluded,
      });
      continue;
    }

    const root = await resolveReadableConversationRoot(rootPath);
    if (!root) {
      providers.push({
        provider,
        mode,
        coverage: 'unavailable',
        sessionsBackedUp: 0,
        sessionsSkippedMissing: includedSessions.length,
        sessionsSkippedUnsafe: 0,
        sessionsExcluded,
      });
      warnings.push(`${provider}: its requested conversation root is missing or unreadable, so ${includedSessions.length} session(s) were skipped.`);
      continue;
    }

    let sessionsBackedUp = 0;
    let sessionsSkippedMissing = 0;
    let sessionsSkippedUnsafe = 0;
    let sessionsWithSidecarWarnings = 0;
    let sessionsWithNestedUnsafeArtifacts = 0;
    for (const session of includedSessions) {
      const archiveBase = path.join('conversations', provider, archiveSessionSegment(session.session_id));

      if (mode === 'antigravity') {
        const providerSessionId = session.provider_session_id || session.session_id;
        if (!providerSessionId || path.basename(providerSessionId) !== providerSessionId || ['.', '..'].includes(providerSessionId)) {
          sessionsSkippedUnsafe += 1;
          continue;
        }

        const databasePath = path.join(rootPath, `${providerSessionId}.db`);
        const databaseResult = await addContainedFile(
          zip,
          root,
          databasePath,
          path.join(archiveBase, `${providerSessionId}.db`),
        );
        if (!databaseResult.ok) {
          if (databaseResult.kind === 'unsafe') sessionsSkippedUnsafe += 1;
          else sessionsSkippedMissing += 1;
          continue;
        }

        let sidecarWarnings = 0;
        for (const suffix of ['-wal', '-shm', '.meta']) {
          const sidecarPath = suffix === '.meta'
            ? path.join(rootPath, `${providerSessionId}.meta`)
            : `${databasePath}${suffix}`;
          const sidecarResult = await addContainedFile(
            zip,
            root,
            sidecarPath,
            path.join(archiveBase, path.basename(sidecarPath)),
          );
          if (!sidecarResult.ok && sidecarResult.kind !== 'missing') sidecarWarnings += 1;
        }
        if (sidecarWarnings > 0) sessionsWithSidecarWarnings += 1;
        sessionsBackedUp += 1;
        continue;
      }

      if (!session.jsonl_path) { sessionsSkippedMissing += 1; continue; }

      const anchorPath = session.jsonl_path;
      const sourcePath = mode === 'dirOfFile' ? path.dirname(anchorPath) : anchorPath;
      const anchorResult = await resolveContainedArtifact(root, anchorPath);
      const sourceResult = sourcePath === anchorPath
        ? anchorResult
        : await resolveContainedArtifact(root, sourcePath);
      if (!anchorResult.ok || !sourceResult.ok) {
        if (anchorResult.kind === 'unsafe' || sourceResult.kind === 'unsafe') sessionsSkippedUnsafe += 1;
        else sessionsSkippedMissing += 1;
        continue;
      }

      if (sourceResult.stat.isDirectory()) {
        const addResult = await addDirectory(zip, sourceResult.realPath, archiveBase, config.destination);
        if (addResult.unsafeSkipped > 0) sessionsWithNestedUnsafeArtifacts += 1;
        if (addResult.errors > 0) {
          sessionsSkippedMissing += 1;
          continue;
        }
      } else if (sourceResult.stat.isFile()) {
        try {
          zip.file(path.join(archiveBase, path.basename(sourceResult.realPath)).replaceAll(path.sep, '/'), await fs.readFile(sourceResult.realPath));
        } catch {
          sessionsSkippedMissing += 1;
          continue;
        }
      } else {
        sessionsSkippedMissing += 1;
        continue;
      }
      sessionsBackedUp += 1;
    }

    providers.push({
      provider,
      mode,
      coverage: sessionsSkippedMissing > 0 || sessionsSkippedUnsafe > 0 || sessionsWithSidecarWarnings > 0 || sessionsWithNestedUnsafeArtifacts > 0 ? 'partial' : 'complete',
      sessionsBackedUp,
      sessionsSkippedMissing,
      sessionsSkippedUnsafe,
      sessionsExcluded,
    });
    if (sessionsSkippedMissing > 0) {
      warnings.push(`${provider}: ${sessionsSkippedMissing} session(s) referenced in the database could not be read from disk and were skipped.`);
    }
    if (sessionsSkippedUnsafe > 0) {
      warnings.push(`${provider}: ${sessionsSkippedUnsafe} session artifact(s) escaped the expected conversation root or used a symlink and were skipped.`);
    }
    if (sessionsWithSidecarWarnings > 0) {
      warnings.push(`${provider}: unsafe or unreadable sidecars were skipped for ${sessionsWithSidecarWarnings} Antigravity session(s).`);
    }
    if (sessionsWithNestedUnsafeArtifacts > 0) {
      warnings.push(`${provider}: symlinked entries were skipped inside ${sessionsWithNestedUnsafeArtifacts} session director${sessionsWithNestedUnsafeArtifacts === 1 ? 'y' : 'ies'}.`);
    }
  }

  return {
    enabled: true,
    projectsTotal: registeredProjects.length,
    projectsIncluded: includedProjectPaths,
    projectsExcluded: excludedProjectPaths,
    providers,
    warnings,
  };
}

async function removeOldBackups(destination, retention) {
  const entries = await fs.readdir(destination, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
    const fullPath = path.join(destination, entry.name);
    const stat = await fs.stat(fullPath);
    backups.push({ fullPath, mtime: stat.mtimeMs });
  }
  backups.sort((a, b) => b.mtime - a.mtime);
  await Promise.all(backups.slice(retention).map(({ fullPath }) => fs.unlink(fullPath)));
}

export async function runBackup(reason = 'manual') {
  if (running) throw new Error('A backup is already running');
  const config = getBackupConfig();
  running = true;
  const startedAt = new Date().toISOString();
  try {
    await fs.mkdir(config.destination, { recursive: true });
    const zip = new JSZip();
    if (config.includeDatabase) await addDatabase(zip);
    if (config.includeCodebase) await addDirectory(zip, appRoot, 'codebase', config.destination);
    if (config.includeProjects) {
      for (const projectPath of config.projectPaths) {
        await addDirectory(zip, projectPath, projectArchivePrefix(projectPath), config.destination);
      }
    }
    const agentConversations = config.includeAgentConversations
      ? await addAgentConversations(zip, config)
      : { enabled: false };

    zip.file('manifest.json', JSON.stringify({
      createdAt: startedAt,
      reason,
      cloudcli: true,
      agentConversations,
    }, null, 2));

    const filename = `cloudcli-backup-${startedAt.replace(/[.:]/g, '-')}.zip`;
    const outputPath = path.join(config.destination, filename);
    await fs.writeFile(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    await removeOldBackups(config.destination, config.retention);
    const stat = await fs.stat(outputPath);
    const result = {
      status: 'success',
      reason,
      filename,
      path: outputPath,
      bytes: stat.size,
      completedAt: new Date().toISOString(),
      warnings: agentConversations.warnings || [],
    };
    saveHistory(result);
    return result;
  } catch (error) {
    const result = { status: 'error', reason, error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() };
    saveHistory(result);
    throw error;
  } finally {
    running = false;
  }
}

export function configureBackupRuntime(nextAppRoot) {
  if (nextAppRoot) appRoot = nextAppRoot;
  syncBackupSchedule();
}

export function syncBackupSchedule() {
  cronJob?.stop();
  cronJob = null;
  const config = getBackupConfig();
  if (!config.enabled) return;
  try {
    cronJob = new Cron(config.schedule, () => {
      void runBackup('scheduled').catch((error) => console.error('[Backups] scheduled backup failed:', error.message));
    });
  } catch (error) {
    throw new Error(`Invalid backup cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function updateBackupConfig(input) {
  const config = normalizeConfig(input);
  assertValidCron(config.schedule);
  saveConfig(config);
  syncBackupSchedule();
  return config;
}

export function stopBackupScheduler() {
  cronJob?.stop();
  cronJob = null;
}
