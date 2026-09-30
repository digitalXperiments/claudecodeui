import { useEffect, useMemo, useRef } from 'react';

import type { LLMProvider } from '../../../types/app';

/** Dwell on an open session before prewarming (skipped if the user moves on). */
export const PREWARM_DWELL_MS = 800;
/** Debounce for the composer-focus trigger. */
export const PREWARM_FOCUS_DEBOUNCE_MS = 250;
/** Identical requests for a session are not re-sent within this window (the server dedupes too). */
export const PREWARM_CLIENT_REPEAT_MS = 30_000;
/** Per-browser opt-out: localStorage['cloudcli.chat.prewarm'] = '0'. */
const PREWARM_STORAGE_KEY = 'cloudcli.chat.prewarm';

export type PrewarmTarget = {
  sessionId: string | null;
  provider: LLMProvider | string;
  projectId: string | null;
  isProcessing: boolean;
  readOnly: boolean;
};

type SendMessage = (message: unknown) => boolean;
type Timer = ReturnType<typeof setTimeout>;

export type PrewarmControllerDeps = {
  getTarget: () => PrewarmTarget;
  /** The exact options chat.send would carry right now (same builder). */
  buildOptions: () => Record<string, unknown>;
  sendMessage: SendMessage;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  isDisabled?: () => boolean;
};

function readPrewarmDisabled(): boolean {
  try {
    return window.localStorage.getItem(PREWARM_STORAGE_KEY) === '0';
  } catch {
    return false;
  }
}

/** Only started Claude sessions (a concrete id) that are idle and writable. */
export function isPrewarmEligible(target: PrewarmTarget): target is PrewarmTarget & { sessionId: string } {
  return Boolean(target.sessionId) && target.provider === 'claude' && !target.isProcessing && !target.readOnly;
}

/**
 * Framework-free scheduler behind usePrewarmSession: a dwell timer per opened
 * session and a debounced focus trigger, both re-checking eligibility when
 * they fire, plus a client-side repeat guard.
 */
export function createPrewarmController(deps: PrewarmControllerDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const isDisabled = deps.isDisabled ?? readPrewarmDisabled;
  let dwellTimer: Timer | null = null;
  let focusTimer: Timer | null = null;
  let last: { sessionId: string; key: string; at: number } | null = null;

  const fire = (expectedSessionId: string | null): boolean => {
    const target = deps.getTarget();
    if (isDisabled() || !isPrewarmEligible(target)) {
      return false;
    }
    // The user navigated to another session since the trigger was armed.
    if (expectedSessionId && target.sessionId !== expectedSessionId) {
      return false;
    }
    const options = deps.buildOptions();
    const key = JSON.stringify(options);
    const at = now();
    if (last && last.sessionId === target.sessionId && last.key === key && at - last.at < PREWARM_CLIENT_REPEAT_MS) {
      return false;
    }
    const sent = deps.sendMessage({
      type: 'chat.prewarm',
      sessionId: target.sessionId,
      expectedProvider: target.provider,
      expectedProjectId: target.projectId ?? undefined,
      options,
    });
    if (sent) {
      last = { sessionId: target.sessionId, key, at };
    }
    return sent;
  };

  const cancelDwell = () => {
    if (dwellTimer) {
      clearTimer(dwellTimer);
      dwellTimer = null;
    }
  };
  const cancelFocus = () => {
    if (focusTimer) {
      clearTimer(focusTimer);
      focusTimer = null;
    }
  };

  return {
    /** A session was opened: prewarm once the user has stayed on it. */
    sessionOpened(sessionId: string | null) {
      cancelDwell();
      cancelFocus();
      if (!sessionId) return;
      dwellTimer = setTimer(() => {
        dwellTimer = null;
        fire(sessionId);
      }, PREWARM_DWELL_MS);
    },
    /** The composer gained focus. */
    focused() {
      cancelFocus();
      const sessionId = deps.getTarget().sessionId;
      if (!sessionId) return;
      focusTimer = setTimer(() => {
        focusTimer = null;
        fire(sessionId);
      }, PREWARM_FOCUS_DEBOUNCE_MS);
    },
    dispose() {
      cancelDwell();
      cancelFocus();
    },
  };
}

type UsePrewarmSessionParams = PrewarmTarget & {
  isInputFocused: boolean;
  sendMessage: SendMessage;
  buildOptions: () => Record<string, unknown>;
};

/**
 * Asks the server to boot the Claude process for the open session while the
 * user reads/types (`chat.prewarm`), so the first turn skips process + MCP
 * startup. Fires after PREWARM_DWELL_MS on a session and again on composer
 * focus (debounced). Never for new sessions without an id, non-Claude
 * providers, read-only views or while a turn is running. Best-effort: the
 * server ignores ineligible or duplicate requests and never replies.
 */
export function usePrewarmSession({
  sessionId,
  provider,
  projectId,
  isProcessing,
  readOnly,
  isInputFocused,
  sendMessage,
  buildOptions,
}: UsePrewarmSessionParams): void {
  // Latest values, read when a timer fires (not when it was armed).
  const latestRef = useRef({ sessionId, provider, projectId, isProcessing, readOnly, sendMessage, buildOptions });
  useEffect(() => {
    latestRef.current = { sessionId, provider, projectId, isProcessing, readOnly, sendMessage, buildOptions };
  });

  const controller = useMemo(() => createPrewarmController({
    getTarget: () => latestRef.current,
    buildOptions: () => latestRef.current.buildOptions(),
    sendMessage: (message) => latestRef.current.sendMessage(message),
  }), []);

  useEffect(() => () => controller.dispose(), [controller]);

  const eligibleSessionId = provider === 'claude' && !readOnly ? sessionId : null;
  useEffect(() => {
    controller.sessionOpened(eligibleSessionId);
  }, [controller, eligibleSessionId]);

  useEffect(() => {
    if (isInputFocused && eligibleSessionId) {
      controller.focused();
    }
  }, [controller, eligibleSessionId, isInputFocused]);
}
