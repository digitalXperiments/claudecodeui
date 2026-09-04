import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * Antigravity keeps no CloudCLI-readable transcript files on disk, so there is
 * nothing to scan or index. The facet is still present because the provider
 * wrapper requires it and the orchestration service iterates every provider.
 *
 * Reporting 0 (and `null` for a single file) is the honest answer: it keeps the
 * shared `scan_state.last_scanned_at` advancing instead of failing the whole
 * multi-provider sync, and it avoids inventing a scan root. If a transcript
 * store is confirmed later, implement it here and add the root to
 * `sessions-watcher.service.ts`.
 */
export class AntigravitySessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(_since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(_filePath: string): Promise<string | null> {
    return null;
  }
}
