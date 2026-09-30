import os from 'node:os';
import path from 'node:path';
import fs, { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { antigravityConversationsDir } from '@/modules/providers/list/antigravity/antigravity-conversation-store.js';
import {
  prewarmRecentAntigravityHistory,
  scheduleAntigravityHistoryRefresh,
} from '@/modules/providers/list/antigravity/antigravity-history.js';
import { grokSessionsRoot } from '@/modules/providers/list/grok/grok-sessions.provider.js';
import { ompSessionsRoot } from '@/modules/providers/list/omp/omp-paths.js';
import {
  getDisabledProviderIds,
  sessionSynchronizerService,
} from '@/modules/providers/services/session-synchronizer.service.js';
import { qwenRuntimeRoot } from '@/modules/providers/list/qwencode/qwencode-sessions.provider.js';
import { broadcastSessionUpsertedBatch } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { getClineDataDirectory, getKiloDatabasePath } from '@/shared/utils.js';

type WatcherEventType = 'add' | 'change';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'cursor',
    rootPath: path.join(os.homedir(), '.cursor', 'projects'),
  },
  {
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
  {
    provider: 'opencode',
    rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
  },
  {
    provider: 'kilo',
    rootPath: path.dirname(getKiloDatabasePath()),
  },
  {
    provider: 'cline',
    rootPath: getClineDataDirectory(),
  },
  {
    provider: 'kimi',
    rootPath: path.join(os.homedir(), '.kimi-code', 'sessions'),
  },
  {
    provider: 'qwencode',
    rootPath: qwenRuntimeRoot(),
  },
  {
    provider: 'pi',
    rootPath: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
  },
  {
    provider: 'omp',
    rootPath: ompSessionsRoot(),
  },
  {
    provider: 'grok',
    rootPath: grokSessionsRoot(),
  },
  {
    provider: 'antigravity',
    rootPath: antigravityConversationsDir(),
  },
];

/**
 * chokidar v4 dropped glob support, so `ignored` strings only match exact
 * paths. The same intent (skip dependency/VCS/build trees and editor/OS
 * scratch files) is expressed as a matcher on path segments relative to the
 * watched root, so a root that itself lives under e.g. `/build/` still works.
 */
const IGNORED_DIRECTORY_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'build']);
const IGNORED_FILE_SUFFIXES = ['.tmp', '.swp'];
const IGNORED_FILE_NAMES = new Set(['.DS_Store']);

export function createWatcherIgnoreMatcher(rootPath: string): (filePath: string) => boolean {
  const normalizedRoot = path.resolve(rootPath);
  return (filePath: string) => {
    const relative = path.relative(normalizedRoot, path.resolve(filePath));
    if (!relative || relative.startsWith('..')) {
      return false;
    }
    const segments = relative.split(path.sep);
    const baseName = segments[segments.length - 1] ?? '';
    if (IGNORED_FILE_NAMES.has(baseName) || IGNORED_FILE_SUFFIXES.some((suffix) => baseName.endsWith(suffix))) {
      return true;
    }
    return segments.some((segment) => IGNORED_DIRECTORY_SEGMENTS.has(segment));
  };
}

/**
 * Per-root choice between native filesystem events and stat polling.
 *
 * Polling stats every watched file on an interval (thousands of transcripts
 * under ~/.claude/projects), which is pure CPU/IO overhead on macOS where
 * native events are reliable and cheap. Native is therefore the default on
 * darwin and win32; other platforms keep polling (inotify watch limits make a
 * deep recursive tree risky there). Overrides:
 * - `CLOUDCLI_WATCHER_POLLING=1|0` forces polling on/off for every root;
 * - `CLOUDCLI_WATCHER_POLL_PROVIDERS=antigravity,cline` polls just those roots
 *   (e.g. a provider home on a network mount where native events never fire).
 * A native watcher that fails with a resource/unsupported error falls back to
 * polling for that root at runtime (see `armNativeRecursiveWatcher`).
 */
export function shouldUsePollingForRoot(
  provider: LLMProvider,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const forced = env.CLOUDCLI_WATCHER_POLLING?.trim();
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;

  const pollProviders = (env.CLOUDCLI_WATCHER_POLL_PROVIDERS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (pollProviders.includes(provider)) return true;

  return platform !== 'darwin' && platform !== 'win32';
}

function isWatcherDebugEnabled(): boolean {
  const value = process.env.CLOUDCLI_DEBUG_WATCHER?.trim();
  return Boolean(value) && value !== '0' && value !== 'false';
}


/**
 * Native events fire on every append to an actively streaming transcript
 * (many per second). File-level syncs are coalesced per file: trailing
 * debounce, bounded by a max wait so a continuously written file still
 * refreshes the sidebar regularly, and never more than one sync per file in
 * flight (a change landing mid-sync schedules exactly one re-run).
 */
const FILE_SYNC_DEBOUNCE_MS = 300;
const FILE_SYNC_MAX_WAIT_MS = 1_500;

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

type ClosableWatcher = Pick<FSWatcher, 'close'>;

const watchers: ClosableWatcher[] = [];
const WATCH_MAX_DEPTH = 6;

type PendingFileSync = {
  provider: LLMProvider;
  eventType: WatcherEventType;
  timer: ReturnType<typeof setTimeout> | null;
  firstQueuedAt: number;
  running: boolean;
  dirty: boolean;
};

const pendingFileSyncs = new Map<string, PendingFileSync>();

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
export function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  // Like Antigravity below: new messages land in the WAL before a checkpoint
  // touches the main database, so the `-wal` file is data-bearing too.
  if (provider === 'opencode' || provider === 'kilo') {
    const fileName = path.basename(filePath);
    return fileName === `${provider}.db` || fileName === `${provider}.db-wal`;
  }

  if (provider === 'cline') {
    return path.basename(filePath) === 'task_metadata.json' || path.basename(filePath) === 'api_conversation_history.json';
  }

  if (provider === 'kimi') {
    return path.basename(filePath) === 'state.json' || filePath.endsWith('wire.jsonl');
  }

  if (provider === 'grok') {
    return path.basename(filePath) === 'summary.json' || path.basename(filePath) === 'chat_history.jsonl';
  }

  // The conversation database is the session; its `.meta` sidecar carries the
  // cwd the row is filed under. New messages land in SQLite's WAL before the
  // main `.db` is checkpointed, so the WAL is data-bearing and must trigger a
  // refresh. Chokidar events are coalesced below; the `-shm` coordination file
  // carries no conversation data and stays ignored.
  if (provider === 'antigravity') {
    return filePath.endsWith('.db') || filePath.endsWith('.db-wal') || filePath.endsWith('.meta');
  }

  return filePath.endsWith('.jsonl');
}

/**
 * Watch paths minus the providers the user turned off in Settings → Agents.
 */
export function getEnabledProviderWatchPaths(
  disabledProviders: ReadonlySet<string>
): Array<{ provider: LLMProvider; rootPath: string }> {
  return PROVIDER_WATCH_PATHS.filter(({ provider }) => !disabledProviders.has(provider));
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(`${provider}\0${updatedSessionId}`);
  }

  schedulePendingWatcherFlush();
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic. The event
    // payload itself comes from the shared `session_upserted` builder in the
    // websocket module, so this path can never drift from the run registry's.
    const updates: Array<{ sessionId: string; provider: LLMProvider }> = [];
    for (const encodedUpdate of queuedUpdate.updatedSessionIds) {
      const separator = encodedUpdate.indexOf('\0');
      if (separator <= 0) continue;
      const provider = encodedUpdate.slice(0, separator) as LLMProvider;
      const updatedSessionId = encodedUpdate.slice(separator + 1);
      updates.push({ sessionId: updatedSessionId, provider });
    }

    await broadcastSessionUpsertedBatch(updates);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

function clearPendingFileSyncs(): void {
  for (const pending of pendingFileSyncs.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingFileSyncs.clear();
}

function runPendingFileSync(filePath: string): void {
  const pending = pendingFileSyncs.get(filePath);
  if (!pending) return;
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  if (pending.running) {
    pending.dirty = true;
    return;
  }

  pending.running = true;
  pending.dirty = false;
  const { eventType, provider } = pending;
  void syncWatchedFile(eventType, filePath, provider).finally(() => {
    const current = pendingFileSyncs.get(filePath);
    if (current !== pending) return;
    pending.running = false;
    if (pending.dirty) {
      pending.dirty = false;
      pending.firstQueuedAt = Date.now();
      pending.timer = setTimeout(() => runPendingFileSync(filePath), FILE_SYNC_DEBOUNCE_MS);
      return;
    }
    if (!pending.timer) pendingFileSyncs.delete(filePath);
  });
}

/**
 * Queues one watcher event for coalesced file-level synchronization.
 */
function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): void {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  const now = Date.now();
  let pending = pendingFileSyncs.get(filePath);
  if (!pending) {
    pending = { provider, eventType, timer: null, firstQueuedAt: now, running: false, dirty: false };
    pendingFileSyncs.set(filePath, pending);
  } else if (eventType === 'add') {
    // Keep 'add' sticky within a coalesced burst so logs/labels stay accurate.
    pending.eventType = 'add';
  }

  if (pending.running) {
    pending.dirty = true;
    return;
  }

  if (pending.timer) clearTimeout(pending.timer);
  const remainingMaxWait = Math.max(0, FILE_SYNC_MAX_WAIT_MS - (now - pending.firstQueuedAt));
  pending.timer = setTimeout(
    () => runPendingFileSync(filePath),
    Math.min(FILE_SYNC_DEBOUNCE_MS, remainingMaxWait),
  );
}

/**
 * Runs provider file-level synchronization for one (coalesced) watcher event.
 */
async function syncWatchedFile(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  // Defense in depth: ignore events for providers disabled after their watcher
  // was armed (or for a stray watcher that outlived a refresh).
  if ((await getDisabledProviderIds()).has(provider)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    if (isWatcherDebugEnabled()) {
      console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
        filePath,
        sessionId: result.sessionId,
        ...(result.sessionIds.length > 1 ? { sessionIds: result.sessionIds } : {}),
      });
    }
    for (const sessionId of result.sessionIds) {
      queuePendingWatcherUpdate(eventType, provider, sessionId);
    }
    if (provider === 'antigravity' && result.sessionId) {
      // Antigravity history is an ACP replay (seconds per read). Warm it in the
      // background — debounced, throttled, one at a time, and skipped while a
      // live turn is writing — so opening the session is served from cache.
      scheduleAntigravityHistoryRefresh(result.sessionId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 * Providers the user turned off in Settings → Agents get no watcher.
 */
let antigravityBootPrewarmScheduled = false;

export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  const disabledProviders = await getDisabledProviderIds();
  if (!disabledProviders.has('antigravity') && !antigravityBootPrewarmScheduled) {
    // Once per process (re-arming the watchers must not re-prewarm): replay the
    // few most recent conversations, serially, after startup settles.
    antigravityBootPrewarmScheduled = true;
    prewarmRecentAntigravityHistory();
  }
  for (const { provider, rootPath } of getEnabledProviderWatchPaths(disabledProviders)) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });
      armProviderWatcher(provider, rootPath, shouldUsePollingForRoot(provider));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Arms the watcher for a provider root. Native mode uses a single recursive
 * `fs.watch` (FSEvents on macOS, ReadDirectoryChangesW on Windows): one
 * descriptor per root. chokidar v4 has no fsevents backend, so its "native"
 * mode opens one kqueue descriptor per watched file — tens of thousands for
 * ~/.claude/projects — which exhausts the process and makes every
 * child_process.spawn fail with EBADF. Polling (and the runtime fallback when
 * the native watcher errors) still goes through chokidar.
 */
function armProviderWatcher(provider: LLMProvider, rootPath: string, usePolling: boolean): void {
  if (!usePolling) {
    try {
      armNativeRecursiveWatcher(provider, rootPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unknown';
      console.warn(`Native session watcher unavailable for provider "${provider}" (${code}); falling back to polling`, {
        rootPath,
      });
    }
  }
  armPollingWatcher(provider, rootPath);
}

function armNativeRecursiveWatcher(provider: LLMProvider, rootPath: string): void {
  const isIgnored = createWatcherIgnoreMatcher(rootPath);
  const nativeWatcher = fs.watch(rootPath, { recursive: true, persistent: true });
  const handle: ClosableWatcher = {
    close: async () => {
      nativeWatcher.close();
    },
  };

  nativeWatcher.on('change', (eventType, fileName) => {
    if (!fileName) return;
    const relative = fileName.toString();
    if (relative.split(path.sep).length > WATCH_MAX_DEPTH + 1) return;
    const filePath = path.join(rootPath, relative);
    if (isIgnored(filePath)) return;
    if (eventType === 'change') {
      onUpdate('change', filePath, provider);
      return;
    }
    // 'rename' covers create, delete and move; only surviving files matter.
    fsPromises.stat(filePath).then(
      (stats) => {
        if (stats.isFile()) onUpdate('add', filePath, provider);
      },
      () => undefined,
    );
  });

  nativeWatcher.on('error', (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    console.warn(`Native session watcher failed for provider "${provider}" (${code ?? 'unknown'}); falling back to polling`, {
      rootPath,
    });
    const index = watchers.indexOf(handle);
    if (index >= 0) watchers.splice(index, 1);
    nativeWatcher.close();
    try {
      armPollingWatcher(provider, rootPath);
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.error(`Failed to arm polling session watcher for provider "${provider}"`, { error: fallbackMessage });
    }
  });

  watchers.push(handle);
}

function armPollingWatcher(provider: LLMProvider, rootPath: string): void {
  const watcher = chokidar.watch(rootPath, {
    ignored: createWatcherIgnoreMatcher(rootPath),
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    depth: WATCH_MAX_DEPTH,
    usePolling: true,
    interval: 6_000,
    binaryInterval: 6_000,
  });

  watcher
    .on('add', (filePath: string) => {
      onUpdate('add', filePath, provider);
    })
    .on('change', (filePath: string) => {
      onUpdate('change', filePath, provider);
    })
    .on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Session watcher error for provider "${provider}"`, { error: message });
    });

  watchers.push(watcher);
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();
  clearPendingFileSyncs();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}

/**
 * Re-arms the watchers against the current disabled-provider list. Called
 * when the user changes Settings → Agents toggles at runtime; the re-init
 * runs an incremental sync so re-enabled providers catch up immediately.
 */
export async function refreshSessionsWatcher(): Promise<void> {
  await closeSessionsWatcher();
  await initializeSessionsWatcher();
}
