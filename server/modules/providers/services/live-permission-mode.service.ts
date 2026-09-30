import type { LLMProvider } from '@/shared/types.js';

type Updater = (sessionId: string, mode: string, appSessionId: string) => Promise<boolean>;
let updaters: Partial<Record<LLMProvider, Updater>> = {};
const pending = new Map<string, Promise<unknown>>();

export function configureLivePermissionModes(value: typeof updaters): void {
  updaters = value;
}

/** Serialize rapid toggles, including changes made through the HTTP fallback. */
export function updateLivePermissionMode(session: {
  session_id: string;
  provider: string;
  provider_session_id?: string | null;
}, mode: string): Promise<{ applied: boolean; error?: string }> {
  const id = session.session_id;
  const update = (pending.get(id) ?? Promise.resolve()).then(async () => {
    try {
      const applied = await updaters[session.provider as LLMProvider]?.(
        session.provider_session_id || id, mode, id,
      );
      return { applied: Boolean(applied) };
    } catch (error) {
      return { applied: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  pending.set(id, update);
  void update.finally(() => {
    if (pending.get(id) === update) pending.delete(id);
  });
  return update;
}

export function waitForPermissionModeUpdate(sessionId: string): Promise<unknown> | undefined {
  return pending.get(sessionId);
}
