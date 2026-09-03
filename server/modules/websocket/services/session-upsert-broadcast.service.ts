import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * Wire shape of the `session_upserted` sidebar delta.
 *
 * The event carries everything a sidebar needs to upsert a session in place
 * (its summary plus the owning project's metadata), so clients never refetch
 * the whole project list because one transcript changed on disk.
 *
 * Field names are consumed by the frontend (`useProjectsState`), so they are
 * part of the websocket wire contract — do not rename them.
 */
export type SessionUpsertedEvent = {
  kind: 'session_upserted';
  sessionId: string;
  /**
   * Provider-native id alias for the row. The client uses it to notice that a
   * row it is showing under the provider id has been merged into its
   * canonical app-session row; omitting it leaves a stale duplicate row.
   */
  providerSessionId: string | null;
  provider: LLMProvider;
  session: {
    id: string;
    summary: string;
    messageCount: number;
    lastActivity: string;
  };
  project: {
    projectId: string;
    path: string;
    fullPath: string;
    displayName: string;
    isStarred: boolean;
    categoryId: string | null;
  } | null;
  timestamp: string;
};

function assembleSessionUpsertedEvent(
  row: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  project: ReturnType<typeof projectsDb.getProjectPath>,
  displayName: string,
): SessionUpsertedEvent {
  return {
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    // The column is a plain TEXT and typed as `string` on the row, but only
    // provider adapters ever write it.
    provider: row.provider as LLMProvider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
        categoryId: project.category_id ?? null,
      }
      : null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * The single producer of the `session_upserted` delta.
 *
 * It used to be built in two places — the providers module's on-disk sessions
 * watcher and the chat run registry — and only the registry's copy set
 * `providerSessionId`. That field is how the client notices a row it is
 * showing has been merged into its canonical app-session row, so a merge
 * announced by the watcher path left a stale duplicate in the sidebar.
 * One builder, one shape.
 *
 * When `provider` is given (the watcher path), the id is resolved
 * provider-first: the watcher only ever sees the provider-native id written
 * in the transcript file name, and provider ids are only unique within one
 * provider. Without `provider` (the run-registry path), the id is the
 * canonical app session id and is resolved directly.
 *
 * Returns the event synchronously whenever no display name has to be
 * generated (the project row carries a custom name, or there is no project
 * row). The run registry relies on that: the upsert announcing a provider-id
 * merge must reach sockets in the same tick, before any later run frames, so
 * clients never observe a `session_removed` for a merged duplicate without
 * the matching upsert.
 */
export function buildSessionUpsertedEvent(
  sessionIdOrProviderSessionId: string,
  provider?: LLMProvider,
): SessionUpsertedEvent | null | Promise<SessionUpsertedEvent | null> {
  const row = provider
    ? sessionsDb.getSessionByProviderSessionId(sessionIdOrProviderSessionId, provider)
      ?? sessionsDb.getSessionById(sessionIdOrProviderSessionId)
    : sessionsDb.getSessionById(sessionIdOrProviderSessionId);
  if (!row || row.isArchived || row.is_internal) {
    return null;
  }
  // The `getSessionById` fallback above is unscoped; never announce a row
  // that belongs to a different provider than the watcher event.
  if (provider && row.provider !== provider) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const customProjectName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : null;
  if (!project || customProjectName) {
    return assembleSessionUpsertedEvent(row, project, customProjectName ?? '');
  }

  return generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath)
    .then((displayName) => assembleSessionUpsertedEvent(row, project, displayName));
}

function sendToConnectedClients(payloads: string[]): void {
  if (payloads.length === 0) {
    return;
  }

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      for (const payload of payloads) {
        client.send(payload);
      }
    }
  });
}

/**
 * Announces one session. Used by the chat run registry when a run reports its
 * provider-native id (the argument there is the canonical app session id, so
 * no `provider` scope is needed).
 *
 * Deliberately not an `async` function: when the builder resolves the event
 * synchronously the frame is sent in the same tick (see
 * `buildSessionUpsertedEvent` for why the run registry needs that).
 */
export function broadcastSessionUpserted(
  sessionIdOrProviderSessionId: string,
  provider?: LLMProvider,
): Promise<void> {
  const built = buildSessionUpsertedEvent(sessionIdOrProviderSessionId, provider);
  if (built instanceof Promise) {
    return built.then((event) => {
      if (event) {
        sendToConnectedClients([JSON.stringify(event)]);
      }
    });
  }

  if (built) {
    sendToConnectedClients([JSON.stringify(built)]);
  }
  return Promise.resolve();
}

/**
 * Announces a batch of sessions. Used by the providers module's sessions
 * watcher, whose debounced flush can carry dozens of provider-native ids at
 * once — the client set is walked once for the whole batch rather than once
 * per session.
 */
export async function broadcastSessionUpsertedBatch(
  updates: Iterable<{ sessionId: string; provider?: LLMProvider }>,
): Promise<void> {
  const payloads: string[] = [];
  for (const update of updates) {
    const event = await buildSessionUpsertedEvent(update.sessionId, update.provider);
    if (event) {
      payloads.push(JSON.stringify(event));
    }
  }

  sendToConnectedClients(payloads);
}
