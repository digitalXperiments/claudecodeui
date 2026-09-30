import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import {
  PERMISSION_MODE_CHANGED_EVENT,
  type PermissionModeChangedDetail,
} from '../../../constants/permissionModeEvents';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import {
  CODEX_FAST_MODE_CHANGED_EVENT,
  CODEX_FAST_MODE_STORAGE_KEY,
  type CodexFastModeChangedDetail,
} from '../../../constants/codexFastModeEvents';
import {
  CODEX_RUNTIME_STATE_CHANGED_EVENT,
  type CodexRuntimeStateChangedDetail,
} from '../../../constants/codexRuntimeEvents';
import {
  PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT,
  type ProviderDefaultEffortChangedDetail,
} from '../../../constants/providerEffortEvents';
import {
  PROVIDER_MODEL_CHANGED_EVENT,
  type ProviderModelChangedDetail,
} from '../../../constants/providerModelEvents';
import {
  PROVIDER_RUNTIME_STATE_EVENT,
  type ProviderRuntimeStateDetail,
} from '../../../constants/providerRuntimeEvents';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

/** Providers whose Agent CLI is launched with the chatbar's model. */
const SHELL_MODEL_PROVIDERS = new Set(['claude', 'codex', 'grok', 'opencode']);
/** Providers whose Agent CLI is launched with the chatbar's effort. */
const SHELL_EFFORT_PROVIDERS = new Set(['claude', 'codex', 'grok']);

const persistGrokRuntimeLocally = (detail: { model?: string; effort?: string }, sessionId?: string | null) => {
  if (detail.model) {
    localStorage.setItem('grok-model', detail.model);
    if (sessionId) localStorage.setItem(`grok-model-${sessionId}`, detail.model);
  }
  if (detail.effort) {
    localStorage.setItem('grok-effort', detail.effort);
    if (sessionId) localStorage.setItem(`grok-effort-${sessionId}`, detail.effort);
  }
};

/**
 * The chatbar preferences an Agent CLI launch carries, resolved exactly like
 * the composer does (per-session key first, then the provider's last pick).
 * Used for `init` and for the post-sync echo, so the server's parked-PTY
 * staleness check always compares like with like.
 */
export const resolveShellLaunchPreferences = (provider: string, sessionId: string | null) => {
  const readScoped = (kind: 'model' | 'effort') => (
    (sessionId ? localStorage.getItem(`${provider}-${kind}-${sessionId}`) : null)
      || localStorage.getItem(`${provider}-${kind}`)
      || undefined
  );
  return {
    model: SHELL_MODEL_PROVIDERS.has(provider) ? readScoped('model') : undefined,
    effort: SHELL_EFFORT_PROVIDERS.has(provider) ? readScoped('effort') : undefined,
    permissionMode: (sessionId ? localStorage.getItem(`permissionMode-${sessionId}`) : null)
      || localStorage.getItem(`permissionMode-last-${provider}`)
      || (provider === 'codex' ? 'default' : undefined),
    fastMode: provider === 'codex'
      ? localStorage.getItem(CODEX_FAST_MODE_STORAGE_KEY) === 'true'
      : undefined,
  };
};

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  waitForChat: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  closeSocket: () => void;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  waitForChat,
  closeSocket,
  clearTerminalScreen,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);
  const relaunchOnModeChangeRef = useRef(false);
  const waitForChatRef = useRef(waitForChat);
  waitForChatRef.current = waitForChat;

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      // Runtime settings the server read from the provider's own session
      // files (never from screen text). Mirror them into Chatbar, then echo
      // the chat-normalized preferences back so the parked PTY's launch
      // baseline matches what the next `init` will send.
      if (message.type === 'runtime_state' && typeof message.provider === 'string') {
        const provider = message.provider;
        const sessionId = typeof message.sessionId === 'string'
          ? message.sessionId
          : selectedSessionRef.current?.id ?? null;
        const model = typeof message.model === 'string' ? message.model : undefined;
        const effort = typeof message.effort === 'string' ? message.effort : undefined;
        const permissionMode = typeof message.permissionMode === 'string' ? message.permissionMode : undefined;

        if (provider === 'grok') {
          persistGrokRuntimeLocally({ model, effort }, sessionId);
          window.dispatchEvent(new CustomEvent('cloudcli:grok-runtime-state', {
            detail: { sessionId: sessionId ?? undefined, model, effort, permissionMode },
          }));
        } else if (provider === 'codex') {
          window.dispatchEvent(new CustomEvent<CodexRuntimeStateChangedDetail>(
            CODEX_RUNTIME_STATE_CHANGED_EVENT,
            {
              detail: {
                sessionId,
                model,
                effort,
                permissionMode,
                fastMode: typeof message.fastMode === 'boolean' ? message.fastMode : undefined,
              },
            },
          ));
        } else {
          window.dispatchEvent(new CustomEvent<ProviderRuntimeStateDetail>(
            PROVIDER_RUNTIME_STATE_EVENT,
            { detail: { provider, sessionId, model, effort, permissionMode } },
          ));
        }

        // Listeners run synchronously, so localStorage already holds the
        // adopted (catalog-normalized) values.
        sendSocketMessage(wsRef.current, {
          type: 'runtime_state',
          ...resolveShellLaunchPreferences(provider, selectedSessionRef.current?.id ?? sessionId),
        });
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'replay_complete') {
        const terminal = terminalRef.current;
        if (!terminal) {
          return;
        }

        // `Terminal.write` is asynchronous. Queue an empty write behind every
        // replayed chunk, then scroll on the next paint so a refresh lands on
        // the newest prompt instead of whichever row happened to render first.
        terminal.write('', () => {
          window.requestAnimationFrame(() => {
            if (terminalRef.current === terminal) {
              terminal.scrollToBottom();
            }
          });
        });
        return;
      }

    },
    [
      handleProcessCompletion,
      onOutputRef,
      selectedSessionRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (wsRef.current !== socket) return;
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;

          window.setTimeout(() => {
            // A tab/session change or Chatbar takeover can invalidate this
            // connection while xterm is waiting for its first layout.
            if (wsRef.current !== socket || socket.readyState !== WebSocket.OPEN
              || (waitForChatRef.current && !isPlainShellRef.current)) return;
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;

            // Agent shells always start a fresh PTY on the server — clear any
            // leftover xterm scrollback so the new TUI paints on a clean slate.
            if (!isPlainShellRef.current) {
              currentTerminal.reset();
              clearTerminalScreen();
            }

            const shellProvider = isPlainShellRef.current
              ? 'plain-shell'
              : (selectedSessionRef.current?.__provider || localStorage.getItem('selected-provider') || 'claude');
            const shellSessionId = isPlainShellRef.current ? null : selectedSessionRef.current?.id || null;
            // Mirror the chatbar's resolution so the interactive CLI launches
            // with the same model / effort / permission mode (and Codex Fast)
            // the chat runtime would use.
            const launchPreferences = isPlainShellRef.current
              ? null
              : resolveShellLaunchPreferences(shellProvider, shellSessionId);

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: shellSessionId,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: shellProvider,
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              permissionMode: launchPreferences?.permissionMode,
              fastMode: launchPreferences?.fastMode,
              model: launchPreferences?.model,
              effort: launchPreferences?.effort,
              // Ordinary tab/session navigation reconnects to the parked PTY.
              // Only an explicit restart or permission-mode change replaces it.
              forceRestart,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          if (wsRef.current !== socket) return;
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          if (wsRef.current !== socket) return;
          wsRef.current = null;
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
          if (wsRef.current !== socket) return;
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
      }
    },
    [
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: { forceRestart?: boolean }) => {
    if (
      !isInitialized
      || (waitForChat && !isPlainShellRef.current)
      || isConnected
      || isConnecting
      || connectingRef.current
    ) {
      return;
    }

    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized, isPlainShellRef, waitForChat]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
  }, [clearTerminalScreen, closeSocket]);

  useEffect(() => {
    if (
      !autoConnect ||
      (waitForChat && !isPlainShellRef.current) ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized, isPlainShellRef, waitForChat]);

  // Chatbar and Shell cannot safely drive the same provider-native session at
  // the same time. If a run starts after Shell connected (for example from
  // another tab), release the PTY and let the normal auto-connect effect
  // reopen it after the run completes.
  useEffect(() => {
    if (!waitForChat || isPlainShellRef.current || (!isConnected && !isConnecting)) {
      return;
    }

    disconnectFromShell();
  }, [disconnectFromShell, isConnected, isConnecting, isPlainShellRef, waitForChat]);

  // When the chatbar permission mode changes, relaunch the interactive CLI so
  // it starts with the new mode's flags (TUI processes can't change mode after
  // spawn). The init message mirrors the chatbar's mode resolution from
  // localStorage, which is already updated before this event is dispatched.
  useEffect(() => {
    const handlePermissionModeChange = (event: Event) => {
      if (isPlainShellRef.current) {
        return;
      }

      const detail = (event as CustomEvent<PermissionModeChangedDetail>).detail;
      if (!detail) {
        return;
      }

      // Only react when the change targets the provider (and session, when
      // scoped) this shell is running.
      const shellProvider =
        selectedSessionRef.current?.__provider ||
        localStorage.getItem('selected-provider') ||
        'claude';
      if (detail.provider && detail.provider !== shellProvider) {
        return;
      }

      const shellSessionId = selectedSessionRef.current?.id ?? null;
      if (detail.sessionId && shellSessionId && detail.sessionId !== shellSessionId) {
        return;
      }

      // If the shell isn't connected, it picks up the new mode on the next
      // connect — nothing to relaunch.
      if (!isConnected) {
        return;
      }

      // Two-step relaunch: drop the current socket, then reconnect with a
      // forced fresh process. connectToShell closes over the stale
      // `isConnected=true` immediately after disconnectFromShell, so the
      // reconnect is deferred to an effect that observes the state flip.
      relaunchOnModeChangeRef.current = true;
      // Prevent the ordinary auto-connect effect from racing this relaunch.
      // The relaunch effect below will reconnect with forceRestart=true.
      disconnectFromShell({ suppressAutoConnect: true });
    };

    window.addEventListener(PERMISSION_MODE_CHANGED_EVENT, handlePermissionModeChange);
    return () => window.removeEventListener(PERMISSION_MODE_CHANGED_EVENT, handlePermissionModeChange);
  }, [
    connectToShell,
    disconnectFromShell,
    isConnected,
    isPlainShellRef,
    selectedSessionRef,
  ]);

  // Model and effort changes made in Chatbar must restart the provider TUI as
  // well. Every supported CLI reads both at process startup; reconnecting the
  // socket alone would leave the parked process on its previous settings.
  useEffect(() => {
    const handlePreferenceChange = (event: Event) => {
      if (isPlainShellRef.current || !isConnected) return;
      const shellProvider = selectedSessionRef.current?.__provider
        || localStorage.getItem('selected-provider')
        || 'claude';
      const launchProviders = event.type === PROVIDER_MODEL_CHANGED_EVENT
        ? SHELL_MODEL_PROVIDERS
        : SHELL_EFFORT_PROVIDERS;
      if (!launchProviders.has(shellProvider)) return;
      const detail = (event as CustomEvent<ProviderModelChangedDetail | ProviderDefaultEffortChangedDetail>).detail;
      if (!detail || detail.provider !== shellProvider) return;
      const sessionId = 'sessionId' in detail ? detail.sessionId : null;
      const shellSessionId = selectedSessionRef.current?.id ?? null;
      if (sessionId && shellSessionId && sessionId !== shellSessionId) return;
      relaunchOnModeChangeRef.current = true;
      disconnectFromShell({ suppressAutoConnect: true });
    };

    window.addEventListener(PROVIDER_MODEL_CHANGED_EVENT, handlePreferenceChange);
    window.addEventListener(PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT, handlePreferenceChange);
    return () => {
      window.removeEventListener(PROVIDER_MODEL_CHANGED_EVENT, handlePreferenceChange);
      window.removeEventListener(PROVIDER_DEFAULT_EFFORT_CHANGED_EVENT, handlePreferenceChange);
    };
  }, [disconnectFromShell, isConnected, isPlainShellRef, selectedSessionRef]);

  // Codex Fast is shared with Chatbar. Never type `/fast` into the PTY: if the
  // TUI does not consume it as a local command it becomes a real chat prompt.
  // Relaunch only the Agent CLI so it receives the persisted service-tier
  // override in its init payload while the Chatbar session remains untouched.
  useEffect(() => {
    const handleFastModeChange = (event: Event) => {
      if (isPlainShellRef.current || !isConnected) return;
      const provider = selectedSessionRef.current?.__provider
        || localStorage.getItem('selected-provider')
        || 'claude';
      if (provider !== 'codex') return;
      const detail = (event as CustomEvent<CodexFastModeChangedDetail>).detail;
      if (!detail || typeof detail.enabled !== 'boolean') return;
      relaunchOnModeChangeRef.current = true;
      // Prevent the ordinary auto-connect effect from racing this relaunch.
      // The relaunch effect below will reconnect with forceRestart=true.
      disconnectFromShell({ suppressAutoConnect: true });
    };

    window.addEventListener(CODEX_FAST_MODE_CHANGED_EVENT, handleFastModeChange);
    return () => window.removeEventListener(CODEX_FAST_MODE_CHANGED_EVENT, handleFastModeChange);
  }, [disconnectFromShell, isConnected, isPlainShellRef, selectedSessionRef]);

  // Relaunch the interactive CLI after a permission-mode change disconnect.
  useEffect(() => {
    if (!relaunchOnModeChangeRef.current) {
      return;
    }

    // Whoever connected/reconnected already consumed the relaunch intent.
    if (isConnecting || isConnected) {
      relaunchOnModeChangeRef.current = false;
      return;
    }

    if (!isInitialized) {
      return;
    }

    relaunchOnModeChangeRef.current = false;
    connectToShell({ forceRestart: true });
  }, [connectToShell, isConnected, isConnecting, isInitialized]);

  return {
    isConnected,
    isConnecting,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
