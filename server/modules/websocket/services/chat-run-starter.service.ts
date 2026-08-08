import path from 'node:path';

import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { getGlobalImageAssetsDir, normalizeImageDescriptors } from '@/shared/image-attachments.js';
import type { AnyRecord, LLMProvider, NormalizedMessage, RealtimeClientConnection } from '@/shared/types.js';

/**
 * One provider runtime entry point. All provider runtimes share this signature,
 * which lets both the chat websocket handler and the kanban runner dispatch
 * through a provider-keyed map instead of provider-specific branches.
 */
export type ProviderSpawnFn = (
  command: string,
  options: AnyRecord,
  writer: unknown,
) => Promise<unknown>;

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterImagesToUploadStore(images: unknown, assetsRootOverride?: string): AnyRecord[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeImageDescriptors(images).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping image outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

export type StartProviderRunParams = {
  /** Stable app session id (sessions.session_id). */
  appSessionId: string;
  provider: LLMProvider;
  /** Provider-native id when resuming an existing session, otherwise null. */
  providerSessionId: string | null;
  /** Working directory / project root for the run. */
  projectPath: string | null;
  /** The resolved provider runtime for this provider. */
  spawnFn: ProviderSpawnFn;
  /**
   * Optional mid-run injection hook (e.g. Claude's stream-json stdin). When
   * the session already has a running run, this is offered the message
   * instead of rejecting with RUN_IN_PROGRESS; returning true means the
   * message was attached to the live run.
   */
  injectFn?: (command: string, options: AnyRecord) => Promise<boolean>;
  /** Instruction/prompt handed to the runtime. */
  content: string;
  /** Raw caller options (client chat options, or task-derived options). */
  options: AnyRecord;
  /**
   * Outbound event sink. Pass the client websocket for interactive sends, or a
   * detached connection (see `DETACHED_CONNECTION`) for headless/background
   * runs — events are still buffered in the registry for later `chat.subscribe`.
   */
  connection: RealtimeClientConnection;
  userId: string | number | null;
  /** Optional durable run-spine hook for every normalized runtime event. */
  onEvent?: (message: NormalizedMessage) => void;
};

export type StartProviderRunResult =
  | {
      ok: true;
      /** True when the message was injected into an already-running run. */
      injected?: boolean;
      /** Resolves when the runtime settles (after its terminal `complete`). */
      completion: Promise<void>;
    }
  | { ok: false; code: 'RUN_IN_PROGRESS' };

/**
 * A never-open connection for headless runs. `ChatSessionWriter.forward` checks
 * `readyState === WS_OPEN` before sending, so events are decorated + buffered in
 * the run registry (enabling later replay via `chat.subscribe`) but nothing is
 * pushed to a socket.
 */
export const DETACHED_CONNECTION: RealtimeClientConnection = {
  readyState: -1,
  send: () => undefined,
};

/**
 * Headless run starter shared by the interactive chat handler and the kanban
 * runner. Registers the run, builds `runtimeOptions` exactly as the chat path
 * always has, dispatches to the provider runtime, and guarantees the
 * exactly-one-`complete` contract via the registry safety net.
 *
 * When the session already has a running run and the provider offers an
 * `injectFn`, the message is attached to that live run instead of being
 * rejected — events and the single terminal `complete` keep flowing through
 * the existing run's writer.
 *
 * Returns after registration (or injection) so callers can either await
 * `completion` (interactive chat.send) or fire-and-forget (automation).
 */
export async function startProviderRun(params: StartProviderRunParams): Promise<StartProviderRunResult> {
  // The provider runtimes receive the provider-native session id (that is the
  // id their CLI/SDK understands for resume). Brand-new sessions have no
  // provider id yet, so the runtime starts fresh and announces one, which the
  // gateway writer captures and maps back to the app session id.
  const buildRuntimeOptions = (providerSessionId: string | null): AnyRecord => ({
    ...params.options,
    // Image attachments are re-validated server-side: only files inside the
    // global upload store may reach the provider runtimes' file reads.
    images: filterImagesToUploadStore(params.options.images),
    appSessionId: params.appSessionId,
    sessionId: providerSessionId ?? undefined,
    resume: Boolean(providerSessionId),
    cwd: params.options.cwd ?? params.projectPath ?? undefined,
    projectPath: params.projectPath ?? params.options.projectPath,
  });

  const run = chatRunRegistry.startRun({
    appSessionId: params.appSessionId,
    provider: params.provider,
    providerSessionId: params.providerSessionId,
    connection: params.connection,
    userId: params.userId,
    onEvent: params.onEvent,
  });

  if (!run) {
    // A run is already active for this session. Providers with a mid-run
    // injection hook attach the message to the live run instead of rejecting.
    if (params.injectFn) {
      const activeRun = chatRunRegistry.getRun(params.appSessionId);
      const runtimeOptions = buildRuntimeOptions(activeRun?.providerSessionId ?? params.providerSessionId);
      let injected = false;
      try {
        injected = await params.injectFn(params.content, runtimeOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Chat] Provider runtime "${params.provider}" failed to inject into the active run`, {
          sessionId: params.appSessionId,
          error: message,
        });
      }
      if (injected) {
        return { ok: true, injected: true, completion: Promise.resolve() };
      }
    }
    return { ok: false, code: 'RUN_IN_PROGRESS' };
  }

  const runtimeOptions = buildRuntimeOptions(params.providerSessionId);

  const completion = (async () => {
    try {
      await params.spawnFn(params.content, runtimeOptions, run.writer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Chat] Provider runtime "${params.provider}" failed`, {
        sessionId: params.appSessionId,
        error: message,
      });
      // If the runtime threw before emitting an error event (e.g. setup
      // failure that skipped its own catch), surface the message so headless
      // callers (Mission Control / Kanban) do not only see a bare exit code.
      if (run.status === 'running') {
        try {
          run.writer.send({
            kind: 'error',
            provider: params.provider,
            content: message,
            sessionId: params.providerSessionId,
          });
        } catch {
          // Writer may already be closed; complete still runs below.
        }
      }
    } finally {
      // Safety net: a runtime that crashed (or resolved) without emitting its
      // terminal `complete` would otherwise leave the session stuck in
      // "processing" forever. Scoped to THIS run — a queued message can start
      // the session's next run before this promise settles, and the
      // session-keyed completeRun would kill that new run.
      chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
    }
  })();

  return { ok: true, completion };
}
