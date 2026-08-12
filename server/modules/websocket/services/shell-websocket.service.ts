import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { parseIncomingJsonObject } from '@/shared/utils.js';
import { ensureManagedGrokHome } from '@/shared/grok-home.js';
// Import the capabilities module directly (not the providers barrel) so shell
// init does not create a circular load path through sessions → websocket.
// eslint-disable-next-line boundaries/dependencies
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { LLMProvider } from '@/shared/types.js';

export type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
  forceRestart?: boolean;
  permissionMode?: string;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  provider: string;
  startedAt: number;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;

export type ShellWebSocketDependencies = {
  resolveProviderSessionId: (
    sessionId: string,
    provider: string,
  ) => string | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
  /** Return whether Chatbar currently owns an active run for an app session. */
  isChatbarRunActive?: (appSessionId: string) => boolean;
  /** Resolve when the active Chatbar run for an app session becomes idle. */
  waitForChatbarRunIdle?: (appSessionId: string) => Promise<void>;
  /**
   * Adopt a provider session the interactive shell created back into the app:
   * called when a shell PTY ends, is replaced, or its websocket detaches, so
   * providers whose TUI forks new session ids (Grok) can map them onto the
   * app session and keep Chat ↔ Shell on one transcript. Optional — providers
   * without an implementation simply skip the adoption.
   */
  syncShellSession?: (info: {
    provider: string;
    projectPath: string;
    appSessionId: string | null;
    startedAt: number;
  }) => void;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isPlainShellRequest(message: ShellIncomingMessage): boolean {
  const hasSession = readBoolean(message.hasSession);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');

  return (
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell'
  );
}

/**
 * Identifies an agent-backed shell request that can resume an existing app
 * session. The non-plain shell path is intentionally provider-agnostic so
 * every provider-native session gets the same Chatbar coordination guard.
 */
export function isAgentShellRequestWithExistingSession(
  message: ShellIncomingMessage,
): boolean {
  return (
    !isPlainShellRequest(message) &&
    readBoolean(message.hasSession) &&
    Boolean(readString(message.sessionId))
  );
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

const SAFE_SESSION_ID_PATTERN = /^[a-zA-Z0-9_.\-:]+$/;

function resolveResumeSessionId(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const provider = readString(message.provider, 'claude');

  if (!hasSession || !sessionId) {
    return '';
  }

  let resumeSessionId: string | null | undefined;
  try {
    resumeSessionId = dependencies.resolveProviderSessionId(sessionId, provider);
  } catch (error) {
    console.error('Failed to resolve provider session ID:', error);
    resumeSessionId = undefined;
  }

  // Prefer provider-native id; fall back to the app session id when the DB row
  // has not been mapped yet (null from resolve, not "lookup threw") — except
  // for Grok, where an unmapped app id is a CloudCLI uuid that `grok --resume`
  // can never resolve: trying it would error the TUI out with a non-zero exit.
  // With no mapping the shell starts a fresh TUI instead, and the shell
  // session sync (see syncShellSession) adopts whatever session it creates.
  // (Disk-discovered Grok sessions have session_id === provider_session_id, so
  // only blank the id when the fallback actually happened, not when the DB
  // legitimately returned the same string.)
  const fellBackToAppId =
    resumeSessionId === undefined || resumeSessionId === null || resumeSessionId === '';
  const resolvedSessionId = fellBackToAppId ? sessionId : resumeSessionId;
  if (provider === 'grok' && fellBackToAppId) {
    return '';
  }
  if (!resolvedSessionId || !SAFE_SESSION_ID_PATTERN.test(resolvedSessionId)) {
    return '';
  }

  return resolvedSessionId;
}

/** POSIX single-quote escape for embedding paths/ids in `bash -c` commands. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Validates the client-supplied chatbar permission mode against the provider's
 * advertised capability list. Returns '' when absent/invalid, so callers can
 * skip mode flags entirely (older clients keep their previous behavior).
 */
function resolveShellPermissionMode(provider: string, permissionMode: string): string {
  if (!permissionMode) {
    return '';
  }

  // Legacy alias: Codex previously surfaced the workspace-write/no-approval
  // mode as acceptEdits. The Codex CLI calls this "Auto".
  if (provider === 'codex' && permissionMode === 'acceptEdits') {
    return 'auto';
  }

  // Legacy alias: opencode previously exposed `bypassPermissions` for what is
  // really `--auto`. Old persisted session values and kanban tasks still carry
  // it, so keep resolving it to the real mode (see opencode-cli.js).
  if (provider === 'opencode' && permissionMode === 'bypassPermissions') {
    return 'auto';
  }

  try {
    const capabilities = providerCapabilitiesService.getProviderCapabilities(provider as LLMProvider);
    return capabilities?.permissionModes?.includes(permissionMode) ? permissionMode : '';
  } catch {
    return '';
  }
}

/**
 * Codex sandbox/approval overrides for the interactive TUI, mirroring
 * mapPermissionModeToCodexOptions in openai-codex.js. `-c` config overrides
 * work for both `codex` and `codex resume <id>`.
 */
function buildCodexPermissionFlags(permissionMode: string): string {
  switch (permissionMode) {
    case 'auto':
    case 'acceptEdits':
      return ' -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="never"';
    case 'bypassPermissions':
      return ' -c sandbox_mode="danger-full-access" -c approval_policy="never"';
    case 'default':
      return ' -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="untrusted"';
    default:
      return '';
  }
}

/**
 * Launch interactive Grok TUI for the Shell tab.
 *
 * Do **not** pipe `grok export` into the same PTY before the TUI — plain
 * markdown plus Grok's screen-addressed UI corrupts the layout. Full history
 * lives in the Chat tab (`chat_history.jsonl`). Shell is for interactive use.
 *
 * Use a clean process each open (see force-fresh agent shell handling below);
 * reconnecting to a live Grok TUI after wiping the client leaves a blank frame.
 *
 * The chatbar permission mode selects the managed GROK_HOME (each mode gets
 * its own home with `[ui] permission_mode` overlaid — see grok-home.js), so
 * the TUI starts in the same mode the chat runtime would use.
 */
function buildGrokShellCommand(resumeSessionId: string, projectPath: string, permissionMode: string): string {
  // bypassPermissions maps to Grok's always-approve (see
  // resolveGrokPermissionRuntime in grok-cli.js); every other valid mode uses
  // its own identifier verbatim in config.toml.
  const configPermissionMode =
    permissionMode === 'bypassPermissions'
      ? 'always-approve'
      : permissionMode || 'default';
  // Resolve via ensureManagedGrokHome so the credential sync (newest-wins
  // across real ~/.grok and all managed homes) runs before the TUI starts —
  // otherwise the shell tab keeps using a stale, rotated-out token.
  const managedHome = ensureManagedGrokHome(configPermissionMode);
  const resolvedCwd = projectPath ? path.resolve(projectPath) : '';
  // Fullscreen alt-screen is what Grok's TUI expects; xterm.js handles it when
  // we don't mix in plain-text dumps or half-reconnects.
  const cwdFlag = resolvedCwd
    ? os.platform() === 'win32'
      ? ` --cwd '${resolvedCwd.replace(/'/g, "''")}'`
      : ` --cwd ${shellSingleQuote(resolvedCwd)}`
    : '';

  if (os.platform() === 'win32') {
    const homePs = managedHome.replace(/'/g, "''");
    const idPs = resumeSessionId.replace(/'/g, "''");
    if (resumeSessionId) {
      // Resume failure (stale/deleted session) falls back to a fresh TUI —
      // same contract as the claude/codex shell commands.
      return `$env:GROK_HOME='${homePs}'; grok --resume '${idPs}'${cwdFlag}; if ($LASTEXITCODE -ne 0) { grok${cwdFlag} }`;
    }
    return `$env:GROK_HOME='${homePs}'; grok${cwdFlag}`;
  }

  const homeQ = shellSingleQuote(managedHome);
  if (resumeSessionId) {
    const idQ = shellSingleQuote(resumeSessionId);
    return `export GROK_HOME=${homeQ}; grok --resume ${idQ}${cwdFlag} || exec grok${cwdFlag}`;
  }
  return `export GROK_HOME=${homeQ}; exec grok${cwdFlag}`;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 *
 * `message.permissionMode` carries the chatbar's current permission mode so
 * the interactive CLI starts in the same mode the chat runtime would use.
 * Each provider maps the mode onto its real interactive flags (validated
 * against provider capabilities first — invalid/unknown modes add no flags).
 */
export function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const projectPath = readString(message.projectPath);
  const resumeSessionId = resolveResumeSessionId(message, dependencies);
  const permissionMode = resolveShellPermissionMode(provider, readString(message.permissionMode));
  const isPlainShell = isPlainShellRequest(message);

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    // cursor-agent only exposes force-approve as `-f` (capabilities advertise
    // default | bypassPermissions).
    const forceFlag = permissionMode === 'bypassPermissions' ? ' -f' : '';
    if (resumeSessionId) {
      return `cursor-agent --resume="${resumeSessionId}"${forceFlag}`;
    }
    return `cursor-agent${forceFlag}`;
  }

  if (provider === 'codex') {
    const modeFlags = buildCodexPermissionFlags(permissionMode);
    if (resumeSessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${resumeSessionId}"${modeFlags}; if ($LASTEXITCODE -ne 0) { codex${modeFlags} }`;
      }
      return `codex resume "${resumeSessionId}"${modeFlags} || codex${modeFlags}`;
    }
    return `codex${modeFlags}`;
  }

  if (provider === 'opencode') {
    // Mirrors resolveOpenCodePermissionOptions in opencode-cli.js.
    let modeArgs = '';
    let modeEnvPrefix = '';
    if (permissionMode === 'plan') {
      modeArgs = ' --agent plan';
    } else if (permissionMode === 'auto' || permissionMode === 'bypassPermissions') {
      modeArgs = ' --auto';
    } else if (permissionMode === 'acceptEdits') {
      const permissionJson = JSON.stringify({ edit: 'allow' });
      modeEnvPrefix =
        os.platform() === 'win32'
          ? `$env:OPENCODE_PERMISSION='${permissionJson}'; `
          : `OPENCODE_PERMISSION='${permissionJson}' `;
    }
    if (resumeSessionId) {
      return `${modeEnvPrefix}opencode --session "${resumeSessionId}"${modeArgs}`;
    }
    return `${modeEnvPrefix}${initialCommand || 'opencode'}${modeArgs}`;
  }

  if (provider === 'grok') {
    return buildGrokShellCommand(resumeSessionId, projectPath, permissionMode);
  }

  if (provider === 'kimi') {
    // Kimi's interactive start-in-mode flags (see `kimi --help`).
    let modeFlag = '';
    if (permissionMode === 'plan') {
      modeFlag = ' --plan';
    } else if (permissionMode === 'auto') {
      modeFlag = ' --auto';
    } else if (permissionMode === 'bypassPermissions') {
      modeFlag = ' --yolo';
    }
    if (resumeSessionId) {
      return `kimi --session="${resumeSessionId}"${modeFlag}`;
    }
    return `kimi${modeFlag}`;
  }

  if (provider === 'pi') {
    // Plan mode maps to Pi's read-only tool allowlist (see buildPiSpawnArgs in
    // pi-cli.js); everything else keeps the full default tool set.
    const modeArgs = permissionMode === 'plan' ? ' --tools read,grep,find,ls' : '';
    if (resumeSessionId) {
      return `pi --session "${resumeSessionId}"${modeArgs}`;
    }
    return `pi${modeArgs}`;
  }

  const modeArgs = permissionMode && permissionMode !== 'default'
    ? ` --permission-mode ${permissionMode}`
    : '';
  const command = initialCommand || 'claude';
  if (resumeSessionId) {
    if (os.platform() === 'win32') {
      return `claude --resume "${resumeSessionId}"${modeArgs}; if ($LASTEXITCODE -ne 0) { claude${modeArgs} }`;
    }
    return `claude --resume "${resumeSessionId}"${modeArgs} || claude${modeArgs}`;
  }
  return `${command}${modeArgs}`;
}

function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return resolvedKey ? env[resolvedKey] : undefined;
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prioritizeUserNpmGlobalBin(env: NodeJS.ProcessEnv): { key: string; value: string | undefined } {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey];
  if (!currentPath) {
    return { key: pathKey, value: currentPath };
  }

  const delimiter = path.delimiter;
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const npmPrefix = readEnvValue(env, 'npm_config_prefix');
  const appData = readEnvValue(env, 'APPDATA');
  const candidates = [
    npmPrefix || '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
    appData ? path.join(appData, 'npm') : '',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ].filter(Boolean);

  const normalizedPathEntries = pathEntries.map((entry) => os.platform() === 'win32' ? entry.toLowerCase() : entry);
  const preferredEntries = candidates.filter((candidate, index) => {
    const normalizedCandidate = os.platform() === 'win32' ? candidate.toLowerCase() : candidate;
    return (
      candidates.indexOf(candidate) === index &&
      normalizedPathEntries.includes(normalizedCandidate)
    );
  });

  if (preferredEntries.length === 0) {
    return { key: pathKey, value: currentPath };
  }

  const normalizedPreferredEntries = preferredEntries.map((entry) =>
    os.platform() === 'win32' ? entry.toLowerCase() : entry
  );

  const value = [
    ...preferredEntries,
    ...pathEntries.filter((entry) => {
      const normalizedEntry = os.platform() === 'win32' ? entry.toLowerCase() : entry;
      return !normalizedPreferredEntries.includes(normalizedEntry);
    }),
  ].join(delimiter);

  return { key: pathKey, value };
}

/**
 * Reports a finished/detached shell PTY to the optional session-sync hook so
 * a provider can adopt whatever session the interactive TUI created. Never
 * throws — sync is best-effort and must not break shell teardown.
 */
function captureShellSessionSync(
  dependencies: ShellWebSocketDependencies,
  session: Pick<PtySessionEntry, 'provider' | 'projectPath' | 'sessionId' | 'startedAt'> | null | undefined,
): void {
  if (!session || !dependencies.syncShellSession) {
    return;
  }
  try {
    dependencies.syncShellSession({
      provider: session.provider,
      projectPath: session.projectPath,
      appSessionId: session.sessionId,
      startedAt: session.startedAt,
    });
  } catch (error) {
    console.error('[ERROR] Shell session sync failed:', error);
  }
}

const CHATBAR_WAIT_OUTPUT =
  '\r\n\x1b[33m[Shell waiting] Chatbar is still running for this session. Shell will start when Chatbar finishes.\x1b[0m\r\n';

function sendShellWaitingOutput(ws: WebSocket): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    ws.send(JSON.stringify({ type: 'output', data: CHATBAR_WAIT_OUTPUT }));
    return true;
  } catch {
    return false;
  }
}

async function waitForChatbarIdleOrSocketClose(
  ws: WebSocket,
  appSessionId: string,
  waitForChatbarRunIdle: (appSessionId: string) => Promise<void>,
): Promise<'idle' | 'closed' | 'failed'> {
  return new Promise((resolve) => {
    let settled = false;
    let cleanup = () => {};
    const settle = (result: 'idle' | 'closed' | 'failed') => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const onClose = () => settle('closed');
    cleanup = () => ws.off('close', onClose);

    ws.once('close', onClose);
    if (ws.readyState !== WebSocket.OPEN) {
      settle('closed');
      return;
    }

    void waitForChatbarRunIdle(appSessionId).then(
      () => settle('idle'),
      () => settle('failed'),
    );
  });
}

/**
 * Prevents a provider-native Shell TUI from competing with Chatbar for the
 * same session. A failed/missing wait signal fails closed and never starts a
 * second provider process.
 */
export async function waitForChatbarRunIfNeeded(
  ws: WebSocket,
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies,
): Promise<boolean> {
  if (!isAgentShellRequestWithExistingSession(message) || !dependencies.isChatbarRunActive) {
    return true;
  }

  const appSessionId = readString(message.sessionId);
  let isActive: boolean;
  try {
    isActive = dependencies.isChatbarRunActive(appSessionId);
  } catch {
    return false;
  }

  if (!isActive) {
    return true;
  }

  if (!sendShellWaitingOutput(ws) || !dependencies.waitForChatbarRunIdle) {
    return false;
  }

  const waitResult = await waitForChatbarIdleOrSocketClose(
    ws,
    appSessionId,
    dependencies.waitForChatbarRunIdle,
  );
  if (waitResult !== 'idle') {
    return false;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    return !dependencies.isChatbarRunActive(appSessionId);
  } catch {
    return false;
  }
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 */
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies
): void {
  console.log('[INFO] Shell websocket connected');

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const forceRestart = readBoolean(data.forceRestart);
        const isPlainShell =
          isPlainShellRequest(data);

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        ptySessionKey = `${projectPath}_${sessionId ?? 'default'}${commandSuffix}`;

        // Interactive agent TUIs (Grok, Claude, Cursor, …) own the full screen.
        // Reusing a live PTY while the client terminal was reset/hidden leaves
        // the UI desynced (blank frame, broken chrome). Always start a fresh
        // process for agent shells; plain shells may still reconnect.
        const isAgentShell = !isPlainShell;
        const shouldStartFresh = isLoginCommand || forceRestart || isAgentShell;

        if (!(await waitForChatbarRunIfNeeded(ws, data, dependencies))) {
          return;
        }

        if (shouldStartFresh) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            // Adopt the session the outgoing TUI created before killing it —
            // otherwise a fresh Grok TUI's work would be orphaned.
            captureShellSessionSync(dependencies, oldSession);
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            try {
              oldSession.pty.kill();
            } catch {
              // Already gone.
            }
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const existingSession = shouldStartFresh ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            }),
          );

          // Plain shells only: short tail, not thousands of chunks.
          const tail = existingSession.buffer.slice(-120);
          for (const bufferedData of tail) {
            ws.send(
              JSON.stringify({
                type: 'output',
                data: bufferedData,
              }),
            );
          }

          existingSession.ws = ws;
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        const shellCommand = buildShellCommand(data, dependencies);
        const resumeSessionId = resolveResumeSessionId(data, dependencies);
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);
        const prioritizedPath = prioritizeUserNpmGlobalBin(process.env);

        shellProcess = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...process.env,
            [prioritizedPath.key]: prioritizedPath.value,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
          },
        });

        ptySessionsMap.set(ptySessionKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
          provider,
          startedAt: Date.now(),
        });

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = dependencies.stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = dependencies.extractUrlsFromText(urlDetectionBuffer)
              .map((url) => dependencies.normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.pty !== shellProcess) {
            return;
          }

          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
          captureShellSessionSync(dependencies, session);
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'opencode'
                    ? 'OpenCode'
                  : provider === 'grok'
                    ? 'Grok Build'
                    : provider === 'kimi'
                      ? 'Kimi'
                      : provider === 'pi'
                        ? 'Pi'
                        : 'Claude';
          welcomeMsg = hasSession && resumeSessionId
            ? provider === 'grok'
              ? `\x1b[36mResuming ${providerName} session ${resumeSessionId} in: ${projectPath}\x1b[0m\r\n` +
                `\x1b[33mTip: full conversation history is in the Chat tab. Shell is the interactive Grok TUI.\x1b[0m\r\n`
              : `\x1b[36mResuming ${providerName} session ${resumeSessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session) {
      return;
    }

    // The client closed (tab switch / unmount) but the PTY stays alive for
    // the reconnect window. Sync whatever the TUI already wrote so the Chat
    // tab reflects shell work immediately on return.
    captureShellSessionSync(dependencies, session);

    session.ws = null;
    session.timeoutId = setTimeout(() => {
      if (ptySessionsMap.get(ptySessionKey as string) !== session) {
        return;
      }

      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
