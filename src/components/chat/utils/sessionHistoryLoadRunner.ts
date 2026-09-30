/**
 * Runs the first history load for the session in view.
 *
 * Validity is tied to a load token, not to React effect runs: an unrelated
 * dependency change (provider sync after opening a session from another
 * provider, a websocket reconnect, a new callback identity) re-runs the load
 * effect, and cancelling there used to strand the view with the spinner stuck
 * and pagination unset. Only `start()` for a new load or `cancel()` (session
 * deselected / switched) invalidates an in-flight request.
 *
 * Failures and "history not persisted yet" responses are retried with
 * backoff while the same load is current, instead of being shown as an empty
 * new chat.
 */

export type HistoryLoadAttemptOutcome =
  /** Rows (possibly legitimately empty) were applied, or a newer fetch applied. */
  | 'applied'
  /** Request failed; retry a few times, then report `failed`. */
  | 'error'
  /** Server says history is not available yet; retry up to the pending budget. */
  | 'pending';

export type HistoryLoadResult = 'applied' | 'failed' | 'unavailable';

export type HistoryLoadRunnerOptions = {
  /** Delays before each retry after an error. Length = max error retries. */
  errorRetryDelaysMs?: number[];
  /** Total wall time to keep retrying pending history. */
  pendingBudgetMs?: number;
  /** Cap for a single pending retry delay. */
  maxPendingDelayMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
};

export const DEFAULT_ERROR_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];
export const DEFAULT_PENDING_BUDGET_MS = 30_000;

export function createHistoryLoadRunner(options: HistoryLoadRunnerOptions = {}) {
  const errorDelays = options.errorRetryDelaysMs ?? DEFAULT_ERROR_RETRY_DELAYS_MS;
  const pendingBudget = options.pendingBudgetMs ?? DEFAULT_PENDING_BUDGET_MS;
  const maxPendingDelay = options.maxPendingDelayMs ?? 4000;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());

  let token = 0;
  let timer: unknown = null;
  let inFlightKey: string | null = null;

  const clearPending = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  return {
    /**
     * Starts a load for `key`, superseding any previous one. `attempt` runs
     * one request; `onDone` fires exactly once, only if still current.
     */
    start(
      key: string,
      attempt: (attemptIndex: number) => Promise<HistoryLoadAttemptOutcome>,
      onDone: (result: HistoryLoadResult) => void,
      onRetry?: (outcome: HistoryLoadAttemptOutcome, attemptIndex: number) => void,
    ): number {
      clearPending();
      const loadToken = ++token;
      inFlightKey = key;
      const startedAt = now();
      let errorCount = 0;
      let pendingCount = 0;

      const finish = (result: HistoryLoadResult) => {
        if (loadToken !== token) return;
        inFlightKey = null;
        onDone(result);
      };

      const run = async (attemptIndex: number) => {
        timer = null;
        let outcome: HistoryLoadAttemptOutcome;
        try {
          outcome = await attempt(attemptIndex);
        } catch {
          outcome = 'error';
        }
        if (loadToken !== token) return;

        if (outcome === 'applied') {
          finish('applied');
          return;
        }

        let delay: number | null = null;
        if (outcome === 'error') {
          delay = errorCount < errorDelays.length ? errorDelays[errorCount] : null;
          errorCount++;
        } else {
          const nextDelay = Math.min(maxPendingDelay, 500 * 2 ** pendingCount);
          pendingCount++;
          delay = now() - startedAt + nextDelay <= pendingBudget ? nextDelay : null;
        }

        if (delay === null) {
          finish(outcome === 'error' ? 'failed' : 'unavailable');
          return;
        }
        onRetry?.(outcome, attemptIndex);
        timer = setTimer(() => { void run(attemptIndex + 1); }, delay);
      };

      void run(0);
      return loadToken;
    },
    /** Invalidates the current load (session switched or deselected). */
    cancel() {
      clearPending();
      token++;
      inFlightKey = null;
    },
    isCurrent(loadToken: number) {
      return loadToken === token;
    },
    /** Key of the load still waiting for a result or retry, if any. */
    get inFlightKey() {
      return inFlightKey;
    },
  };
}

export type HistoryLoadRunner = ReturnType<typeof createHistoryLoadRunner>;
