import type { MutableRefObject, RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';

export type ShellInitMessage = {
  type: 'init';
  projectPath: string;
  sessionId: string | null;
  hasSession: boolean;
  provider: string;
  cols: number;
  rows: number;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  forceRestart?: boolean;
  /** Chatbar permission mode the interactive CLI should launch with. */
  permissionMode?: string;
  /** Shared Chatbar/Agent CLI Codex Fast preference. */
  fastMode?: boolean;
  /** Chatbar's effective model/effort for this session (claude/codex/grok/opencode). */
  model?: string;
  effort?: string;
};

export type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

export type ShellInputMessage = {
  type: 'input';
  data: string;
};

/**
 * Echo of the chat-normalized launch preferences after Chatbar adopted a
 * shell-reported runtime change; the server uses it as the parked PTY's
 * staleness baseline.
 */
export type ShellRuntimeStateMessage = {
  type: 'runtime_state';
  permissionMode?: string;
  model?: string;
  effort?: string;
  fastMode?: boolean;
};

export type ShellOutgoingMessage =
  | ShellInitMessage
  | ShellResizeMessage
  | ShellInputMessage
  | ShellRuntimeStateMessage;

export type ShellIncomingMessage =
  | { type: 'output'; data: string }
  | { type: 'replay_complete' }
  | { type: 'auth_url'; url?: string }
  | { type: 'url_open'; url?: string }
  | { type: string; [key: string]: unknown };

export type UseShellRuntimeOptions = {
  selectedProject: Project | null | undefined;
  selectedSession: ProjectSession | null | undefined;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  minimal: boolean;
  minimumContrastRatio?: number;
  autoConnect: boolean;
  waitForChat: boolean;
  isRestarting: boolean;
  onProcessComplete?: ((exitCode: number) => void) | null;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

export type ShellSharedRefs = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
};

export type UseShellRuntimeResult = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  isConnected: boolean;
  isInitialized: boolean;
  isConnecting: boolean;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};
