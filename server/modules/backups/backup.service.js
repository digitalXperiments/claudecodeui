import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import JSZip from 'jszip';
import { Cron } from 'croner';

import { appConfigDb, getConnection, getDatabasePath, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getEnabledProviderWatchPaths } from '@/modules/providers/index.js';
import { normalizeProjectPath } from '@/shared/utils.js';

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
// inside a per-session directory. `unsplittable` means the provider keeps
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
  opencode: 'unsplittable',
  kilo: 'unsplittable',
  antigravity: 'unsplittable',
};

let appRoot = process.cwd();
let cronJob = null;
let running = false;

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
  try { entries = await fs.readdir(source, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(source, entry.name);
    if (excludedRoot && path.resolve(fullPath) === path.resolve(excludedRoot)) continue;
    if (entry.isSymbolicLink()) continue;
    const relative = path.join(archivePrefix, entry.name);
    if (shouldSkip(relative)) continue;
    if (entry.isDirectory()) await addDirectory(zip, fullPath, relative, excludedRoot);
    else if (entry.isFile()) {
      try { zip.file(relative.replaceAll(path.sep, '/'), await fs.readFile(fullPath)); } catch { /* file may disappear during a snapshot */ }
    }
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

  const allSessions = sessionsDb.getAllSessions();
  const providerWatchPaths = getEnabledProviderWatchPaths(new Set());
  const providers = [];
  const warnings = [];

  for (const { provider, rootPath } of providerWatchPaths) {
    const providerSessions = allSessions.filter((session) => session.provider === provider);
    const mode = PROVIDER_SESSION_ARTIFACT_MODE[provider] ?? 'unsplittable';

    if (mode === 'unsplittable') {
      const touchesExcludedProject = providerSessions.some((session) => {
        const projectPath = normalizeProjectPath(session.project_path || session.runtime_project_path || '');
        return excludedSet.has(projectPath);
      });

      if (touchesExcludedProject) {
        providers.push({
          provider,
          mode,
          coverage: 'skipped',
          sessionsInStore: providerSessions.length,
          reason: 'This provider keeps every project\'s sessions in one shared store with no per-session boundary, so it cannot be split by project. It was skipped entirely to honor the excluded project(s).',
        });
        warnings.push(`${provider}: skipped — cannot exclude projects from its shared session store, and at least one excluded project has ${provider} sessions.`);
        continue;
      }

      if (providerSessions.length === 0) {
        providers.push({ provider, mode, coverage: 'empty', sessionsInStore: 0 });
        continue;
      }

      await addDirectory(zip, rootPath, path.join('conversations', provider), config.destination);
      providers.push({ provider, mode, coverage: 'full-store', sessionsInStore: providerSessions.length });
      continue;
    }

    let sessionsBackedUp = 0;
    let sessionsSkippedMissing = 0;
    let sessionsExcluded = 0;
    for (const session of providerSessions) {
      const projectPath = normalizeProjectPath(session.project_path || session.runtime_project_path || '');
      if (excludedSet.has(projectPath)) { sessionsExcluded += 1; continue; }
      if (!session.jsonl_path) { sessionsSkippedMissing += 1; continue; }

      const anchorPath = session.jsonl_path;
      const sourcePath = mode === 'dirOfFile' ? path.dirname(anchorPath) : anchorPath;
      const archiveBase = path.join('conversations', provider, session.session_id);
      try {
        const stat = await fs.lstat(sourcePath);
        if (stat.isSymbolicLink()) { sessionsSkippedMissing += 1; continue; }
        if (stat.isDirectory()) {
          await addDirectory(zip, sourcePath, archiveBase, config.destination);
        } else {
          zip.file(path.join(archiveBase, path.basename(sourcePath)).replaceAll(path.sep, '/'), await fs.readFile(sourcePath));
        }
        sessionsBackedUp += 1;
      } catch {
        sessionsSkippedMissing += 1;
      }
    }

    providers.push({
      provider,
      mode,
      coverage: sessionsSkippedMissing > 0 ? 'partial' : 'complete',
      sessionsBackedUp,
      sessionsSkippedMissing,
      sessionsExcluded,
    });
    if (sessionsSkippedMissing > 0) {
      warnings.push(`${provider}: ${sessionsSkippedMissing} session(s) referenced in the database could not be read from disk and were skipped.`);
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
        await addDirectory(zip, projectPath, path.join('projects', path.basename(projectPath)), config.destination);
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
