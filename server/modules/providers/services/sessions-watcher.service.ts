import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { antigravityConversationsDir } from '@/modules/providers/list/antigravity/antigravity-conversation-store.js';
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

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

const watchers: FSWatcher[] = [];

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
  if (provider === 'opencode' || provider === 'kilo') {
    return path.basename(filePath) === `${provider}.db`;
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
  // cwd the row is filed under. The `-wal`/`-shm` siblings churn on every write
  // and would re-index on each one, so they are deliberately not targets — the
  // `.db` mtime moves at checkpoint time, which is soon enough.
  if (provider === 'antigravity') {
    return filePath.endsWith('.db') || filePath.endsWith('.meta');
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

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

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

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
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
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  const disabledProviders = await getDisabledProviderIds();
  for (const { provider, rootPath } of getEnabledProviderWatchPaths(disabledProviders)) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: true,
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
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
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();

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
