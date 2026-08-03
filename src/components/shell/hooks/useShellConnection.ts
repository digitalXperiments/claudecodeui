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
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

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

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

    },
    [handleProcessCompletion, onOutputRef, terminalRef],
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
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;

          window.setTimeout(() => {
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
            // Mirror the chatbar's mode resolution (per-session first, then the
            // provider's last-picked mode) so the interactive CLI launches with
            // the same permission mode the chat runtime would use.
            const shellPermissionMode = isPlainShellRef.current
              ? undefined
              : (shellSessionId ? localStorage.getItem(`permissionMode-${shellSessionId}`) : null)
                || localStorage.getItem(`permissionMode-last-${shellProvider}`)
                || undefined;

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
              permissionMode: shellPermissionMode,
              // Agent TUIs always get a fresh process (server also enforces this).
              forceRestart: forceRestart || !isPlainShellRef.current,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
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
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

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
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

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
      disconnectFromShell();
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
