import { scanStateDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

type DisabledProvidersReader = () => Set<string>;

// Lazy import: auth-health.service statically imports the providers barrel
// (which re-exports this module), so a static import here would create a
// module cycle. The reader is resolved once and cached; it reads the current
// disabled list from app_config on every call.
let disabledProvidersReaderPromise: Promise<DisabledProvidersReader> | null = null;

/**
 * Resolves the ids of providers the user turned off in Settings → Agents.
 */
export async function getDisabledProviderIds(): Promise<Set<string>> {
  disabledProvidersReaderPromise ??= import('@/modules/auth-health/index.js').then(
    (module) => module.getDisabledProviders as DisabledProvidersReader,
  );
  return (await disabledProvidersReaderPromise)();
}

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  failures: string[];
};

/**
 * Single-flight coordination for full rescans. A full scan walks every
 * provider's artifact tree, so concurrent callers (boot, an explicit refresh,
 * a watcher re-arm) must never run parallel scans:
 * - no scan running: start one;
 * - a scan running: queue exactly one follow-up scan that starts when the
 *   current one settles, shared by every caller that arrived meanwhile. Each
 *   caller therefore observes a scan that STARTED after its call (so files
 *   written just before the call are never missed), yet at most one scan runs
 *   at a time and bursts collapse into one extra pass.
 */
let activeFullSync: Promise<SessionSynchronizeResult> | null = null;
let queuedFullSync: Promise<SessionSynchronizeResult> | null = null;

async function runFullSynchronization(): Promise<SessionSynchronizeResult> {
  // Provider transcripts for isolated runs contain the workspace cwd. Keep
  // those sessions under the registered parent project before scanning new
  // provider artifacts, including rows from older CloudCLI versions.
  sessionsDb.rehomeAgentWorkspaceSessions();

  const lastScanAt = scanStateDb.getLastScannedAt();
  const scanBoundary = new Date();
  const disabledProviders = await getDisabledProviderIds();
  const processedByProvider: Record<LLMProvider, number> = {
    claude: 0,
    codex: 0,
    cursor: 0,
    opencode: 0,
    kilo: 0,
    cline: 0,
    grok: 0,
    kimi: 0,
    qwencode: 0,
    pi: 0,
    omp: 0,
    antigravity: 0,
  };
  const failures: string[] = [];

  const results = await Promise.allSettled(
    providerRegistry
      .listProviders()
      .filter((provider) => !disabledProviders.has(provider.id))
      .map(async (provider) => ({
        provider: provider.id,
        processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined),
      }))
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      processedByProvider[result.value.provider] = result.value.processed;
      continue;
    }

    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    failures.push(reason);
  }

  if (failures.length === 0) {
    scanStateDb.updateLastScannedAt(scanBoundary);
  } else {
    console.warn(
      `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
    );
  }

  return {
    processedByProvider,
    failures,
  };
}

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Runs all provider synchronizers and updates scan_state.last_scanned_at.
   * Providers the user turned off in Settings → Agents are skipped.
   * Concurrent calls are coalesced (see `activeFullSync`).
   */
  synchronizeSessions(): Promise<SessionSynchronizeResult> {
    if (!activeFullSync) {
      const started = runFullSynchronization().finally(() => {
        if (activeFullSync === started) activeFullSync = null;
      });
      activeFullSync = started;
      return started;
    }

    if (!queuedFullSync) {
      const previous = activeFullSync;
      const queued = previous
        .catch(() => undefined)
        .then(() => {
          queuedFullSync = null;
          // A scan another caller started after ours was queued also began
          // after our callers' calls, so joining it is equally fresh.
          return activeFullSync ?? sessionSynchronizerService.synchronizeSessions();
        });
      queuedFullSync = queued;
    }
    return queuedFullSync;
  },

  /** True while a full rescan is running (diagnostics/tests). */
  isFullSyncInFlight(): boolean {
    return activeFullSync !== null;
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null; sessionIds: string[] }> {
    const { sessionSynchronizer } = providerRegistry.resolveProvider(provider);
    // Shared stores (OpenCode's SQLite) can index several sessions per pass;
    // report all of them so every changed session is broadcast.
    const sessionIds = sessionSynchronizer.synchronizeFileSessions
      ? await sessionSynchronizer.synchronizeFileSessions(filePath)
      : await sessionSynchronizer.synchronizeFile(filePath).then((sessionId) => (sessionId ? [sessionId] : []));
    const sessionId = sessionIds[0] ?? null;
    return {
      provider,
      indexed: sessionIds.length > 0,
      sessionId,
      sessionIds,
    };
  },
};
