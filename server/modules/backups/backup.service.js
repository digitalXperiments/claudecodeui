import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { Cron } from 'croner';

import { appConfigDb, getConnection, getDatabasePath } from '@/modules/database/index.js';

const CONFIG_KEY = 'backup_manager_config';
const HISTORY_KEY = 'backup_manager_history';
const DEFAULT_CONFIG = {
  enabled: false,
  schedule: '0 2 * * *',
  destination: path.join(os.homedir(), '.cloudcli', 'backups'),
  includeDatabase: true,
  includeCodebase: true,
  includeProjects: false,
  projectPaths: [],
  retention: 7,
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
    includeProjects: Boolean(value.includeProjects),
    projectPaths: Array.isArray(value.projectPaths) ? value.projectPaths.filter((item) => typeof item === 'string' && item.trim()).map((item) => path.resolve(item.trim().replace(/^~(?=$|[\\/])/, os.homedir()))) : [],
    retention: Number.isFinite(retention) ? Math.max(1, Math.min(100, retention)) : DEFAULT_CONFIG.retention,
  };
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

async function addDirectory(zip, source, archivePrefix, excludedRoot) {
  let entries;
  try { entries = await fs.readdir(source, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(source, entry.name);
    if (excludedRoot && path.resolve(fullPath) === path.resolve(excludedRoot)) continue;
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
    zip.file('manifest.json', JSON.stringify({ createdAt: startedAt, reason, cloudcli: true }, null, 2));
    if (config.includeDatabase) await addDatabase(zip);
    if (config.includeCodebase) await addDirectory(zip, appRoot, 'codebase', config.destination);
    if (config.includeProjects) {
      for (const projectPath of config.projectPaths) {
        await addDirectory(zip, projectPath, path.join('projects', path.basename(projectPath)), config.destination);
      }
    }
    const filename = `cloudcli-backup-${startedAt.replace(/[.:]/g, '-')}.zip`;
    const outputPath = path.join(config.destination, filename);
    await fs.writeFile(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    await removeOldBackups(config.destination, config.retention);
    const stat = await fs.stat(outputPath);
    const result = { status: 'success', reason, filename, path: outputPath, bytes: stat.size, completedAt: new Date().toISOString() };
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
  if (config.enabled) {
    try { new Cron(config.schedule).stop(); } catch (error) { throw new Error(`Invalid backup cron expression: ${error instanceof Error ? error.message : String(error)}`); }
  }
  saveConfig(config);
  syncBackupSchedule();
  return config;
}

export function stopBackupScheduler() {
  cronJob?.stop();
  cronJob = null;
}

