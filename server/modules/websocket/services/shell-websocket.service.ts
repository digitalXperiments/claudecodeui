import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';
import { ensureManagedGrokHome } from '@/shared/grok-home.js';
import { resolveAcpCliCommand } from '@/shared/acp-cli-path.js';
// Shell runtime readers, imported directly for the same reason as the
// capabilities service below (the providers barrel loads sessions → websocket).
/* eslint-disable boundaries/dependencies */
import {
  readClaudeShellRuntime,
  readCodexShellRuntime,
  readGrokSessionRuntime,
  readLatestGrokSessionRuntime,
  readOpenCodeShellRuntime,
  resolveClaudeShellTranscript,
} from '@/modules/providers/services/shell-session-sync.service.js';
/* eslint-enable boundaries/dependencies */
// Import the capabilities module directly (not the providers barrel) so shell
// init does not create a circular load path through sessions → websocket.
// eslint-disable-next-line boundaries/dependencies
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { shellSessionRegistry } from '@/modules/websocket/services/shell-session-registry.service.js';
import {
  classifyTuiActivity,
  isTuiSubmitInput,
} from '@/modules/websocket/services/shell-tui-activity.js';
import { broadcastSystemEvent } from '@/modules/websocket/services/system-broadcast.service.js';
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
  fastMode?: boolean;
  model?: string;
  effort?: string;
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
  /** Start of the current TUI turn (reset per turn for the running-state registry). */
  startedAt: number;
  /** When the PTY was spawned; bounds which provider files belong to it. */
  spawnedAt: number;
  isAgentShell: boolean;
  /** Launch preferences used to decide whether a parked PTY is stale. */
  model?: string;
  effort?: string;
  fastMode?: boolean;
  permissionMode?: string;
  /** Permission mode the PTY was spawned with (echoes may update `permissionMode`). */
  launchPermissionMode?: string;
  /** Provider-native id used to read Grok's on-disk model/effort. */
  providerSessionId?: string | null;
  /** Last runtime values read from the provider's own files (see diffShellRuntime). */
  runtimeObserved?: ShellRuntimeObservation;
  lastRuntimeCheckAt?: number;
  /** Claude: newest `/model` command already accounted for (see diffShellRuntime). */
  claudeModelCommandSeenAt?: number;
  /** Prompt reconstruction state (see trackShellPromptInput). */
  promptInput: ShellPromptInputState;
};

/**
 * Lines the user submitted into an Agent CLI PTY, reconstructed from the raw
 * keystrokes. Used only as adoption evidence: a provider session created
 * while the PTY was alive belongs to it only if its transcript contains one
 * of these prompts (see adoptShellCreatedSession).
 */
export type ShellPromptInputState = {
  line: string;
  inPaste: boolean;
  submittedPrompts: string[];
};

/** Runtime settings observed in a provider's session files. */
export type ShellRuntimeObservation = {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  permissionMode?: string;
};

/** One provider-file read: the observation plus provider-private signals. */
export type ShellRuntimeReading = ShellRuntimeObservation & {
  /** Claude: when an explicit `/model` switch last took effect (epoch ms). */
  modelCommandAt?: number;
};

const MAX_TRACKED_SHELL_PROMPTS = 20;
const MAX_TRACKED_PROMPT_CHARS = 8_000;

export function createShellPromptInputState(): ShellPromptInputState {
  return { line: '', inPaste: false, submittedPrompts: [] };
}

/**
 * Feed one `input` payload (raw keystrokes / pastes) into the prompt tracker.
 * Printable text accumulates, Backspace edits, Ctrl-C / Ctrl-U clear, Enter
 * outside a bracketed paste submits. Escape sequences (arrows, focus events)
 * are skipped; a line edited with cursor movement reconstructs imperfectly,
 * which only means it will not serve as evidence — never a false match.
 */
export function trackShellPromptInput(state: ShellPromptInputState, data: string): void {
  const submit = () => {
    const prompt = state.line.trim();
    state.line = '';
    if (!prompt) return;
    state.submittedPrompts.push(prompt);
    if (state.submittedPrompts.length > MAX_TRACKED_SHELL_PROMPTS) {
      state.submittedPrompts.splice(0, state.submittedPrompts.length - MAX_TRACKED_SHELL_PROMPTS);
    }
  };
  const append = (text: string) => {
    if (state.line.length < MAX_TRACKED_PROMPT_CHARS) {
      state.line = `${state.line}${text}`.slice(0, MAX_TRACKED_PROMPT_CHARS);
    }
  };

  let index = 0;
  while (index < data.length) {
    const char = data[index]!;
    if (data.startsWith('\x1b[200~', index)) {
      state.inPaste = true;
      index += 6;
      continue;
    }
    if (data.startsWith('\x1b[201~', index)) {
      state.inPaste = false;
      index += 6;
      continue;
    }
    if (char === '\x1b') {
      const next = data[index + 1];
      if (next === '\r' || next === '\n') {
        // Alt/Shift+Enter: newline inside the prompt, not a submit.
        append('\n');
        index += 2;
      } else if (next === '[') {
        let end = index + 2;
        while (end < data.length && !/[@-~]/.test(data[end]!)) end += 1;
        index = end + 1;
      } else if (next === 'O') {
        index += 3;
      } else {
        index += 2;
      }
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (state.inPaste) {
        append('\n');
      } else {
        submit();
      }
      index += 1;
      continue;
    }
    if (char === '\x7f' || char === '\b') {
      state.line = Array.from(state.line).slice(0, -1).join('');
    } else if (char === '\x03' || char === '\x15') {
      state.line = '';
    } else if (char >= ' ' || char === '\t') {
      append(char);
    }
    index += 1;
  }
}

/** Providers whose shell reports model/effort/mode back to Chatbar. */
const RUNTIME_SYNC_PROVIDERS = new Set(['claude', 'codex', 'grok', 'opencode']);
/** Providers whose shell launch honors a chat model (parked-PTY staleness input). */
const SHELL_MODEL_PROVIDERS = new Set(['claude', 'codex', 'grok', 'opencode']);
/** Providers whose shell launch honors a chat effort. */
const SHELL_EFFORT_PROVIDERS = new Set(['claude', 'codex', 'grok']);
/** Minimum gap between two runtime file reads for one PTY. */
const RUNTIME_POLL_INTERVAL_MS: Record<string, number> = {
  codex: 300,
  claude: 750,
  grok: 750,
  opencode: 1_500,
};

const isUnsetPreference = (value: string | undefined): boolean => !value || value === 'default';

/**
 * Decide which observed runtime values Chatbar must hear about.
 *
 * The baseline is what the PTY was launched with, so the first read after
 * launch never echoes an old value back at the chat. When a launch value was
 * unset ('default' model/effort) or is an alias the files resolve (Claude's
 * `opus` → `claude-opus-…`), the first observation is recorded silently and
 * only later changes — `/model`, `/effort`, Shift+Tab in the TUI — are sent.
 * Mutates `session.runtimeObserved`; returns null when nothing changed.
 */
export function diffShellRuntime(
  session: Pick<
    PtySessionEntry,
    'provider' | 'model' | 'effort' | 'fastMode' | 'permissionMode' | 'runtimeObserved' | 'claudeModelCommandSeenAt'
  >,
  observed: ShellRuntimeReading,
): ShellRuntimeObservation | null {
  const previous: ShellRuntimeObservation = session.runtimeObserved ?? {};
  const next: ShellRuntimeObservation = { ...previous };
  const changes: ShellRuntimeObservation = {};

  const consider = <K extends keyof ShellRuntimeObservation>(
    key: K,
    silentFirst: (baseline: ShellRuntimeObservation[K]) => boolean,
  ) => {
    const value = observed[key];
    if (value === undefined || value === null || value === '') return;
    const prior = previous[key];
    next[key] = value;
    if (prior === undefined) {
      const baseline = session[key] as ShellRuntimeObservation[K];
      if (silentFirst(baseline) || value === baseline) return;
      changes[key] = value;
      return;
    }
    if (value !== prior) {
      changes[key] = value;
    }
  };

  if (session.provider === 'claude') {
    // Claude records the model that ANSWERED each turn, which flips per turn
    // under `opusplan` / fallback models. Report it only for an explicit
    // `/model` in the TUI, or when it left the family of the chat's alias.
    const value = observed.model;
    const commandAt = observed.modelCommandAt;
    const explicit = commandAt !== undefined && commandAt > (session.claudeModelCommandSeenAt ?? 0);
    if (explicit) {
      session.claudeModelCommandSeenAt = commandAt;
    }
    if (value) {
      next.model = value;
      if (explicit || (value !== previous.model && !claudeModelMatchesAlias(value, session.model))) {
        changes.model = value;
      }
    }
  } else {
    consider('model', (baseline) => isUnsetPreference(baseline));
  }
  consider('effort', (baseline) => isUnsetPreference(baseline));
  consider('fastMode', (baseline) => baseline === undefined);
  consider('permissionMode', (baseline) => !baseline);

  session.runtimeObserved = next;
  return Object.keys(changes).length > 0 ? changes : null;
}

const CLAUDE_MODEL_FAMILIES = ['opus', 'sonnet', 'haiku'] as const;

/**
 * Whether a resolved Claude model id belongs to the chat's model choice:
 * `opus` / `claude-opus-…` / `opus[1m]` → opus, `opusplan` → opus or sonnet.
 * An unset or unrecognised choice accepts anything.
 */
export function claudeModelMatchesAlias(resolvedModel: string, alias: string | undefined): boolean {
  if (isUnsetPreference(alias)) return true;
  const normalizedAlias = alias!.toLowerCase().replace(/\[[^\]]*\]$/, '');
  const families: readonly string[] = normalizedAlias === 'opusplan'
    ? ['opus', 'sonnet']
    : CLAUDE_MODEL_FAMILIES.filter((family) => normalizedAlias.includes(family));
  if (families.length === 0) return true;
  const resolved = resolvedModel.toLowerCase();
  return families.some((family) => resolved.includes(family));
}

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const TUI_IDLE_SETTLE_MS = 450;
/**
 * A live turn keeps repainting busy chrome (spinner, "esc to interrupt",
 * elapsed-time counters) on practically every redraw. If a session marked
 * busy goes this long without another busy classification, the TUI has gone
 * quiet at an idle screen the regex classifier never matched (`'unknown'` is
 * a no-op — see classifyTuiActivity) rather than genuinely still working, so
 * treat the silence as done instead of leaving the indicator stuck forever.
 */
const TUI_BUSY_STALE_MS = 20_000;
const tuiIdleTimers = new Map<string, NodeJS.Timeout>();
const tuiBusyStaleTimers = new Map<string, NodeJS.Timeout>();
const AGENT_SHELL_RELEASE_TIMEOUT_MS = 3_000;
/**
 * Upper bound on waiting for a finished PTY's session adoption before Chatbar
 * (or a relaunched TUI) resumes. Adoption indexes a handful of fresh
 * transcripts; this only guards against a wedged provider store.
 */
const SHELL_SESSION_SYNC_WAIT_MS = 5_000;

/**
 * In-flight session adoptions per app session (see captureShellSessionSync).
 * Handoff paths await these so they resume from the provider session the
 * Agent CLI just created instead of the pre-adoption mapping.
 */
const pendingShellSessionSyncs = new Map<string, Set<Promise<void>>>();

function trackShellSessionSync(appSessionId: string | null, sync: Promise<void>): void {
  if (!appSessionId) {
    return;
  }
  let pending = pendingShellSessionSyncs.get(appSessionId);
  if (!pending) {
    pending = new Set();
    pendingShellSessionSyncs.set(appSessionId, pending);
  }
  pending.add(sync);
  void sync.finally(() => {
    const current = pendingShellSessionSyncs.get(appSessionId);
    current?.delete(sync);
    if (current && current.size === 0) {
      pendingShellSessionSyncs.delete(appSessionId);
    }
  });
}

/** Resolves once every in-flight adoption for the app session settled (bounded). */
export async function awaitShellSessionSyncs(
  appSessionId: string,
  timeoutMs: number = SHELL_SESSION_SYNC_WAIT_MS,
): Promise<void> {
  const pending = pendingShellSessionSyncs.get(appSessionId);
  if (!pending || pending.size === 0) {
    return;
  }
  let timer: NodeJS.Timeout | null = null;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
}

/** Kills one PTY and resolves true once it exited (false on timeout/failure). */
function killPtyAndAwaitExit(shellPty: IPty, timeoutMs: number = AGENT_SHELL_RELEASE_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      exitSubscription.dispose();
      resolve(exited);
    };
    const exitSubscription = shellPty.onExit(() => settle(true));
    const timeout = setTimeout(() => settle(false), timeoutMs);
    try {
      shellPty.kill();
    } catch {
      settle(false);
    }
  });
}

shellSessionRegistry.subscribe(() => {
  broadcastSystemEvent({ kind: 'running_sessions_changed' });
});

const clearTuiIdleTimer = (key: string): void => {
  const timer = tuiIdleTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    tuiIdleTimers.delete(key);
  }
  const staleTimer = tuiBusyStaleTimers.get(key);
  if (staleTimer) {
    clearTimeout(staleTimer);
    tuiBusyStaleTimers.delete(key);
  }
};

/**
 * Hands one app session from Agent CLI back to Chatbar.
 *
 * A detached/idle TUI still owns provider resources (Codex in particular
 * keeps an exclusive writer lock), so registry activity alone is not enough.
 * Search the parked PTYs as the source of truth and wait for each process to
 * exit before Chatbar starts another writer for the same provider thread.
 */
export async function releaseAgentShellSession(appSessionId: string): Promise<boolean> {
  const matches = Array.from(ptySessionsMap.entries()).filter(
    ([, session]) => session.isAgentShell && session.sessionId === appSessionId,
  );
  if (matches.length === 0) {
    // A PTY that exited just before this send may still be adopting.
    await awaitShellSessionSyncs(appSessionId);
    return true;
  }

  const results = await Promise.all(matches.map(([key, session]) => {
    clearTuiIdleTimer(key);
    shellSessionRegistry.unregister(key);
    if (session.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'output',
        data: '\r\n\x1b[33m[Agent CLI released to Chatbar]\x1b[0m\r\n',
      }));
    }
    return killPtyAndAwaitExit(session.pty);
  }));

  // The PTY's own exit handler (registered at spawn, so it ran first) started
  // the session adoption. Yield once so any exit handler that runs later is
  // tracked too, then wait for adoption: Chatbar must resume the provider
  // session the Agent CLI just created, not the pre-handoff mapping.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await awaitShellSessionSyncs(appSessionId);

  return results.every(Boolean);
}

/**
 * Called once when a busy TUI turn settles (idle screen or busy chrome gone
 * stale). Lets the caller re-read the provider's session files right away
 * instead of waiting for the watcher's polling interval.
 */
type AgentShellSettledHandler = () => void;

const settleIfWasBusy = (
  key: string,
  session: Pick<PtySessionEntry, 'sessionId'>,
  onSettled?: AgentShellSettledHandler,
): void => {
  const wasBusy = Boolean(session.sessionId && shellSessionRegistry.isActive(session.sessionId));
  shellSessionRegistry.unregister(key);
  if (wasBusy && onSettled) {
    try {
      onSettled();
    } catch (error) {
      console.error('[ERROR] Agent shell settle hook failed:', error);
    }
  }
};

const markAgentShellBusy = (
  key: string,
  session: PtySessionEntry,
  onSettled?: AgentShellSettledHandler,
): void => {
  if (!session.sessionId) {
    return;
  }
  clearTuiIdleTimer(key);
  if (!shellSessionRegistry.isActive(session.sessionId)) {
    session.startedAt = Date.now();
  }
  shellSessionRegistry.register(key, {
    sessionId: session.sessionId,
    provider: session.provider as LLMProvider,
    startedAt: session.startedAt,
  });
  tuiBusyStaleTimers.set(
    key,
    setTimeout(() => {
      tuiBusyStaleTimers.delete(key);
      settleIfWasBusy(key, session, onSettled);
    }, TUI_BUSY_STALE_MS),
  );
};

const markAgentShellIdle = (
  key: string,
  session: Pick<PtySessionEntry, 'sessionId'>,
  onSettled?: AgentShellSettledHandler,
): void => {
  clearTuiIdleTimer(key);
  tuiIdleTimers.set(
    key,
    setTimeout(() => {
      tuiIdleTimers.delete(key);
      settleIfWasBusy(key, session, onSettled);
    }, TUI_IDLE_SETTLE_MS),
  );
};

const applyAgentTuiActivity = (
  key: string,
  session: PtySessionEntry,
  stripAnsiSequences: (content: string) => string,
  onSettled?: AgentShellSettledHandler,
): void => {
  if (!session.sessionId) {
    return;
  }
  const stripped = stripAnsiSequences(session.buffer.slice(-80).join(''));
  const activity = classifyTuiActivity(stripped);
  if (activity === 'busy') {
    markAgentShellBusy(key, session, onSettled);
    return;
  }
  if (activity === 'idle') {
    markAgentShellIdle(key, session, onSettled);
  }
};

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
    /** When the PTY exited / the sync was requested; upper-bounds candidates. */
    endedAt: number;
    /** Prompts typed into the PTY — adoption evidence. */
    submittedPrompts: string[];
  }) => Promise<void> | void;
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

/**
 * Repaint a parked full-screen TUI when it is attached to a fresh xterm.
 *
 * Replaying an arbitrary output tail cannot reconstruct alternate-screen
 * state reliably. A real dimension change makes the TUI receive SIGWINCH and
 * redraw its current screen; restoring the requested size immediately keeps
 * the PTY and browser dimensions in sync. Plain shells only need one resize.
 */
export function resizeShellForReconnect(
  shellProcess: Pick<IPty, 'resize'>,
  cols: number,
  rows: number,
  isAgentShell: boolean,
): void {
  if (isAgentShell) {
    shellProcess.resize(cols > 2 ? cols - 1 : cols + 1, rows);
  }
  shellProcess.resize(cols, rows);
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

/** Navigation reconnects to the parked PTY; only explicit lifecycle actions replace it. */
export function shouldStartFreshShellSession(
  isLoginCommand: boolean,
  forceRestart: boolean,
): boolean {
  return isLoginCommand || forceRestart;
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

  try {
    if (sessionsDb.getSessionById(sessionId)?.is_internal) {
      return '';
    }
  } catch {
    // Session lookup is best-effort; resume proceeds as before if the DB is unavailable.
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

/** Quote one CLI argument for the PTY's shell (`bash -c` or PowerShell). */
function quoteShellArg(value: string): string {
  return os.platform() === 'win32'
    ? `'${value.replace(/'/g, "''")}'`
    : shellSingleQuote(value);
}

/**
 * Charset allowed for model / effort values interpolated into the PTY's shell
 * command. Real ids fit it (`gpt-5.6-luna`, `anthropic/claude-sonnet-4-5`,
 * `us.anthropic.claude-opus`, `opus[1m]` — brackets for Claude's context
 * suffix); anything else is dropped rather than escaped. Values are ALSO
 * quoted with quoteShellArg, so this is defense in depth.
 */
const SAFE_SHELL_RUNTIME_VALUE_PATTERN = /^[A-Za-z0-9._:/@+\-[\]]+$/;

/** Trimmed model/effort value, or '' when absent, `default`, or unsafe. */
export function readSafeShellRuntimeValue(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed === 'default' || trimmed.length > 200) {
    return '';
  }
  return SAFE_SHELL_RUNTIME_VALUE_PATTERN.test(trimmed) ? trimmed : '';
}

/** Model id from the chatbar, or '' when absent / the provider default / unsafe. */
function readShellModel(message: ShellIncomingMessage): string {
  return readSafeShellRuntimeValue(message.model);
}

/** Effort from the chatbar, or '' when absent / the provider default / unsafe. */
function readShellEffort(message: ShellIncomingMessage): string {
  return readSafeShellRuntimeValue(message.effort);
}

const CLAUDE_SHELL_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function resolveShellCli(command: string): string {
  return os.platform() === 'win32'
    ? command
    : shellSingleQuote(resolveAcpCliCommand(command));
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
 * Map OpenCode's primary agent onto the chat permission mode. `plan` is the
 * plan agent; `build` cannot tell default/acceptEdits/auto apart, so leaving
 * plan restores whatever non-plan mode the PTY was launched with.
 */
function mapOpenCodeAgentToPermissionMode(agent: string | undefined, launchMode: string | undefined): string | undefined {
  if (agent === 'plan') return 'plan';
  if (agent === 'build') return launchMode && launchMode !== 'plan' ? launchMode : 'default';
  return undefined;
}

/**
 * Read the runtime settings the shell's TUI last recorded in its own session
 * files, restricted to what was written after the PTY spawned. Provider files
 * are the source of truth — screen text is not (an assistant reply that
 * mentions a model id must never flip the chat's model).
 */
export function readShellRuntime(
  session: Pick<PtySessionEntry, 'provider' | 'projectPath' | 'sessionId' | 'spawnedAt' | 'providerSessionId' | 'launchPermissionMode'>,
): ShellRuntimeReading | null {
  const since = session.spawnedAt;
  const appRow = session.sessionId ? sessionsDb.getSessionById(session.sessionId) : null;
  let observed: ShellRuntimeReading | null = null;

  if (session.provider === 'codex') {
    const runtime = readCodexShellRuntime(appRow?.jsonl_path, { since });
    observed = runtime ? { ...runtime } : null;
  } else if (session.provider === 'grok') {
    const providerSessionId = session.providerSessionId || appRow?.provider_session_id || null;
    const runtime = providerSessionId
      ? readGrokSessionRuntime(session.projectPath, providerSessionId, undefined, { since })
      : readLatestGrokSessionRuntime(session.projectPath, undefined, { since, appSessionId: session.sessionId });
    observed = runtime
      ? { model: runtime.model ?? undefined, effort: runtime.effort ?? undefined }
      : null;
  } else if (session.provider === 'claude') {
    const transcript = resolveClaudeShellTranscript({
      appSessionId: session.sessionId,
      projectPath: session.projectPath,
      startedAt: since,
    });
    observed = readClaudeShellRuntime(transcript, { since });
  } else if (session.provider === 'opencode') {
    const runtime = readOpenCodeShellRuntime({
      providerSessionId: appRow?.provider === 'opencode' ? appRow.provider_session_id : null,
      projectPath: session.projectPath,
      appSessionId: session.sessionId,
      since,
    });
    observed = runtime
      ? {
        model: runtime.model,
        effort: runtime.effort,
        permissionMode: mapOpenCodeAgentToPermissionMode(runtime.agent, session.launchPermissionMode),
      }
      : null;
  }

  if (!observed) {
    return null;
  }
  if (observed.permissionMode) {
    observed.permissionMode = resolveShellPermissionMode(session.provider, observed.permissionMode) || undefined;
  }
  return observed;
}

/**
 * Push shell-side runtime changes (model / effort / Codex Fast / permission
 * mode) to the attached Shell client, which relays them to Chatbar. Permission
 * changes are also persisted on the app session so the next chat turn and the
 * session meta endpoint agree with the TUI.
 */
function pollShellRuntime(session: PtySessionEntry, options: { force?: boolean } = {}): void {
  if (!session.isAgentShell || !RUNTIME_SYNC_PROVIDERS.has(session.provider)) {
    return;
  }
  const ws = session.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  const now = Date.now();
  const interval = RUNTIME_POLL_INTERVAL_MS[session.provider] ?? 750;
  if (!options.force && now - (session.lastRuntimeCheckAt ?? 0) <= interval) {
    return;
  }
  session.lastRuntimeCheckAt = now;

  let changes: ShellRuntimeObservation | null = null;
  try {
    const observed = readShellRuntime(session);
    changes = observed ? diffShellRuntime(session, observed) : null;
  } catch (error) {
    console.error('[ERROR] Shell runtime read failed:', error);
    return;
  }
  if (!changes) {
    return;
  }

  // Keep the parked-PTY staleness inputs aligned with what the TUI now runs;
  // the client echoes the chat-normalized values back right after (see the
  // `runtime_state` handler). Claude reports resolved ids, not the aliases
  // the chat sends, so its model is left to that echo.
  if (changes.model && session.provider !== 'claude') session.model = changes.model;
  if (changes.effort) session.effort = changes.effort;
  if (typeof changes.fastMode === 'boolean') session.fastMode = changes.fastMode;
  if (changes.permissionMode) {
    session.permissionMode = changes.permissionMode;
    if (session.sessionId) {
      try {
        sessionsDb.updateSessionRuntimePreferences(session.sessionId, { permissionMode: changes.permissionMode });
      } catch (error) {
        console.error('[ERROR] Failed to persist shell permission mode:', error);
      }
    }
  }

  ws.send(JSON.stringify({
    type: 'runtime_state',
    provider: session.provider,
    sessionId: session.sessionId,
    ...changes,
  }));
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
      return ' -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c approval_policy="on-request"';
    case 'plan':
      return ' -c sandbox_mode="read-only" -c approval_policy="untrusted"';
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
function buildGrokRuntimeFlags(model: string | undefined, effort: string | undefined): string {
  const modelId = readSafeShellRuntimeValue(model);
  const effortId = readSafeShellRuntimeValue(effort);
  let flags = '';
  if (modelId) {
    flags += ` --model ${quoteShellArg(modelId)}`;
  }
  if (effortId) {
    flags += ` --reasoning-effort ${quoteShellArg(effortId)}`;
  }
  return flags;
}

function buildGrokShellCommand(
  resumeSessionId: string,
  projectPath: string,
  permissionMode: string,
  model?: string,
  effort?: string,
): string {
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

  const runtimeFlags = buildGrokRuntimeFlags(model, effort);

  if (os.platform() === 'win32') {
    const homePs = managedHome.replace(/'/g, "''");
    const idPs = resumeSessionId.replace(/'/g, "''");
    if (resumeSessionId) {
      // Resume failure (stale/deleted session) falls back to a fresh TUI —
      // same contract as the claude/codex shell commands.
      return `$env:GROK_HOME='${homePs}'; grok --resume '${idPs}'${cwdFlag}${runtimeFlags}; if ($LASTEXITCODE -ne 0) { grok${cwdFlag}${runtimeFlags} }`;
    }
    return `$env:GROK_HOME='${homePs}'; grok${cwdFlag}${runtimeFlags}`;
  }

  const homeQ = shellSingleQuote(managedHome);
  if (resumeSessionId) {
    const idQ = shellSingleQuote(resumeSessionId);
    return `export GROK_HOME=${homeQ}; grok --resume ${idQ}${cwdFlag}${runtimeFlags} || exec grok${cwdFlag}${runtimeFlags}`;
  }
  return `export GROK_HOME=${homeQ}; exec grok${cwdFlag}${runtimeFlags}`;
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

  if (provider === 'antigravity') {
    // Chat drives the managed ACP harness, whose conversations live in
    // CloudCLI's private profile (<profile>/antigravity-acp/conversations).
    // The interactive `agy` CLI keeps its own store and auth under
    // $HOME/.gemini/antigravity-cli with no env override short of replacing
    // HOME, so `agy --conversation <id>` cannot open a Chat session. Say so
    // instead of launching a TUI that would silently fork the transcript.
    return 'echo "Antigravity Chat sessions run on the managed ACP harness; the agy CLI keeps a separate conversation store and cannot resume them. Use the Chat tab."';
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
    const codexModel = readShellModel(message);
    const codexEffort = readShellEffort(message);
    const modelFlag = codexModel ? ` -m ${quoteShellArg(codexModel)}` : '';
    // `-c key=value` parses value as TOML and falls back to the raw string,
    // so the (charset-validated) effort needs no TOML quotes of its own.
    const effortFlag = codexEffort ? ` -c model_reasoning_effort=${quoteShellArg(codexEffort)}` : '';
    const runtimeFlags = `${modelFlag}${effortFlag}`;
    const tierFlags = typeof message.fastMode === 'boolean'
      ? message.fastMode
        ? ' -c service_tier="fast"'
        : ' -c service_tier="default"'
      : '';
    if (resumeSessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${resumeSessionId}"${modeFlags}${runtimeFlags}${tierFlags}; if ($LASTEXITCODE -ne 0) { codex${modeFlags}${runtimeFlags}${tierFlags} }`;
      }
      return `codex resume "${resumeSessionId}"${modeFlags}${runtimeFlags}${tierFlags} || codex${modeFlags}${runtimeFlags}${tierFlags}`;
    }
    return `codex${modeFlags}${runtimeFlags}${tierFlags}`;
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
    // `-m provider/model` matches the chat picker's value shape. OpenCode's
    // TUI has no effort/variant flag, so effort stays chat-only.
    const opencodeModel = readShellModel(message);
    if (opencodeModel) {
      modeArgs += ` -m ${quoteShellArg(opencodeModel)}`;
    }
    if (resumeSessionId) {
      return `${modeEnvPrefix}opencode --session "${resumeSessionId}"${modeArgs}`;
    }
    return `${modeEnvPrefix}${initialCommand || 'opencode'}${modeArgs}`;
  }

  if (provider === 'kilo') {
    let modeArgs = '';
    let modeEnvPrefix = '';
    if (permissionMode === 'auto' || permissionMode === 'bypassPermissions') {
      modeArgs = ' --auto';
    } else if (permissionMode === 'default' || permissionMode === 'acceptEdits' || permissionMode === 'plan') {
      const permission = permissionMode === 'acceptEdits'
        ? { edit: 'allow', bash: 'ask', webfetch: 'ask', external_directory: 'ask' }
        : { edit: 'ask', bash: 'ask', webfetch: 'ask', external_directory: 'ask' };
      const permissionJson = JSON.stringify(permission);
      modeEnvPrefix =
        os.platform() === 'win32'
          ? `$env:KILO_PERMISSION='${permissionJson}'; `
          : `KILO_PERMISSION='${permissionJson}' `;
    }
    // The installer drops kilo in ~/.kilo/bin, which a PTY spawned without the
    // user's shell profile never sees — resolve the absolute path so the
    // session starts instead of dying with "kilo: command not found".
    const kiloBin = resolveShellCli('kilo');
    if (resumeSessionId) {
      return `${modeEnvPrefix}${kiloBin} --session "${resumeSessionId}"${modeArgs}`;
    }
    return `${modeEnvPrefix}${initialCommand || kiloBin}${modeArgs}`;
  }

  if (provider === 'grok') {
    return buildGrokShellCommand(
      resumeSessionId,
      projectPath,
      permissionMode,
      readString(message.model),
      readString(message.effort),
    );
  }

  if (provider === 'cline') {
    // Cline's interactive terminal is explicitly enabled with --tui and its
    // provider-native session id is passed through --id (see Cline CLI).
    const clineBin = resolveShellCli('cline');
    if (resumeSessionId) {
      return `${clineBin} --tui --id "${resumeSessionId}"`;
    }
    return `${initialCommand || clineBin} --tui`;
  }

  if (provider === 'qwencode') {
    // Qwen Code resumes a known session with --resume <id>. Its approval
    // modes are CLI flags rather than the ACP session config used by Chatbar.
    const qwenBin = resolveShellCli('qwen');
    let modeArgs = '';
    if (permissionMode === 'plan' || permissionMode === 'auto') {
      modeArgs = ` --approval-mode ${quoteShellArg(permissionMode)}`;
    } else if (permissionMode === 'bypassPermissions') {
      modeArgs = ' --yolo';
    }
    if (resumeSessionId) {
      return `${qwenBin} --resume "${resumeSessionId}"${modeArgs}`;
    }
    return `${initialCommand || qwenBin}${modeArgs}`;
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

  if (provider === 'omp') {
    // Oh My Pi inherits Pi's tool allowlist for plan mode; anything else runs
    // with the full default tool set under its yolo approval mode.
    const modeArgs = permissionMode === 'plan'
      ? ' --tools read,grep,glob'
      : permissionMode === 'bypassPermissions'
        ? ' --approval-mode yolo'
        : '';
    if (resumeSessionId) {
      return `omp --resume "${resumeSessionId}"${modeArgs}`;
    }
    return `omp${modeArgs}`;
  }

  // Claude: model alias/id and effort as start-up flags (`claude --help`);
  // invalid efforts are dropped the same way resolveClaudeEffort does.
  const claudeModel = readShellModel(message);
  const claudeEffort = readShellEffort(message);
  const modeArgs = (permissionMode && permissionMode !== 'default'
    ? ` --permission-mode ${quoteShellArg(permissionMode)}`
    : '')
    + (claudeModel ? ` --model ${quoteShellArg(claudeModel)}` : '')
    + (CLAUDE_SHELL_EFFORTS.has(claudeEffort) ? ` --effort ${quoteShellArg(claudeEffort)}` : '');
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
  session: Pick<
    PtySessionEntry,
    'provider' | 'projectPath' | 'sessionId' | 'spawnedAt' | 'isAgentShell' | 'promptInput'
  > | null | undefined,
): Promise<void> {
  if (!session || !session.isAgentShell || !dependencies.syncShellSession) {
    return Promise.resolve();
  }
  let sync: Promise<void>;
  try {
    // spawnedAt, not the per-turn startedAt: a session the TUI created in its
    // first turn must still be adoptable after later turns.
    sync = Promise.resolve(dependencies.syncShellSession({
      provider: session.provider,
      projectPath: session.projectPath,
      appSessionId: session.sessionId,
      startedAt: session.spawnedAt,
      endedAt: Date.now(),
      submittedPrompts: [...session.promptInput.submittedPrompts],
    })).catch((error) => {
      console.error('[ERROR] Shell session sync failed:', error);
    });
  } catch (error) {
    console.error('[ERROR] Shell session sync failed:', error);
    return Promise.resolve();
  }
  trackShellSessionSync(session.sessionId, sync);
  return sync;
}

/** A parked Agent CLI is mid-turn (registry or its latest screen says busy). */
function isAgentShellBusy(
  session: Pick<PtySessionEntry, 'sessionId' | 'buffer'>,
  stripAnsiSequences: (content: string) => string,
): boolean {
  if (session.sessionId && shellSessionRegistry.isActive(session.sessionId)) {
    return true;
  }
  try {
    return classifyTuiActivity(stripAnsiSequences(session.buffer.slice(-80).join(''))) === 'busy';
  } catch {
    return false;
  }
}

const KEPT_BUSY_AGENT_SHELL_OUTPUT =
  '\r\n\x1b[33m[Agent CLI is busy, so it keeps its current settings. Restart the shell after this turn to apply the new ones.]\x1b[0m\r\n';

/**
 * A busy TUI was kept despite a settings mismatch: tell the user, and push
 * the settings it actually runs with to Chatbar (the client echoes them back
 * as the new launch baseline, so the next reconnect is not stale either).
 */
function reportKeptAgentShellRuntime(ws: WebSocket, session: PtySessionEntry): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify({ type: 'output', data: KEPT_BUSY_AGENT_SHELL_OUTPUT }));
  const runtime: ShellRuntimeObservation = {
    ...(session.model ? { model: session.model } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
    ...(typeof session.fastMode === 'boolean' ? { fastMode: session.fastMode } : {}),
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
  };
  if (Object.keys(runtime).length === 0) {
    return;
  }
  ws.send(JSON.stringify({
    type: 'runtime_state',
    provider: session.provider,
    sessionId: session.sessionId,
    ...runtime,
  }));
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

  // A shell turn just finished: re-read the provider's files now (runtime
  // settings + session adoption/upsert) so the turn reaches Chatbar without
  // waiting for the watcher's 6s polling.
  const handleAgentShellSettled = (session: PtySessionEntry) => {
    pollShellRuntime(session, { force: true });
    void captureShellSessionSync(dependencies, session);
  };

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

        // Navigation only detaches the websocket. Reuse its parked PTY so
        // changing chat sessions does not interrupt a running Agent CLI.
        // Explicit restart/login flows still replace the old process.
        const isAgentShell = !isPlainShell;
        // Launch preferences that are baked into the TUI at spawn. A parked
        // PTY started with different ones is stale: reconnecting would leave
        // the Agent CLI on settings the chat no longer shows.
        const requestedModel = isAgentShell && SHELL_MODEL_PROVIDERS.has(provider)
          ? readString(data.model) || undefined
          : undefined;
        const requestedEffort = isAgentShell && SHELL_EFFORT_PROVIDERS.has(provider)
          ? readString(data.effort) || undefined
          : undefined;
        const requestedFastMode = provider === 'codex' && typeof data.fastMode === 'boolean'
          ? data.fastMode
          : undefined;
        const requestedPermissionMode = isAgentShell
          ? resolveShellPermissionMode(provider, readString(data.permissionMode))
          : undefined;
        if (!(await waitForChatbarRunIfNeeded(ws, data, dependencies))) {
          return;
        }

        const parkedSession = ptySessionsMap.get(ptySessionKey);
        const parkedAgentPreferencesMatch = !isAgentShell || !parkedSession
          || (parkedSession.permissionMode === requestedPermissionMode
            && parkedSession.model === requestedModel
            && parkedSession.effort === requestedEffort
            && parkedSession.fastMode === requestedFastMode);
        // A settings mismatch alone never kills a TUI that is mid-turn: keep
        // it, and report the settings it actually runs with back to Chatbar
        // (below). Explicit restart/login still replaces it.
        const keepBusyParkedSession = Boolean(
          isAgentShell
          && parkedSession
          && !parkedAgentPreferencesMatch
          && isAgentShellBusy(parkedSession, dependencies.stripAnsiSequences),
        );
        const shouldStartFresh = shouldStartFreshShellSession(isLoginCommand, forceRestart)
          || (isAgentShell && !parkedAgentPreferencesMatch && !keepBusyParkedSession);

        if (shouldStartFresh) {
          const restartKey = ptySessionKey;
          const oldSession = ptySessionsMap.get(restartKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            ptySessionsMap.delete(restartKey);
            clearTuiIdleTimer(restartKey);
            shellSessionRegistry.unregister(restartKey);
            // Let the outgoing TUI exit, then adopt the session it created
            // BEFORE building the new command: the relaunch resumes from the
            // DB mapping (resolveResumeSessionId), which adoption may have
            // just written — otherwise a fresh TUI's work would be orphaned
            // and the new CLI would resume the stale id.
            await killPtyAndAwaitExit(oldSession.pty);
            void captureShellSessionSync(dependencies, oldSession);
            if (oldSession.sessionId) {
              await awaitShellSessionSyncs(oldSession.sessionId);
            }
            if (ws.readyState !== WebSocket.OPEN || ptySessionKey !== restartKey) {
              return;
            }
          }
        }

        const existingSession = shouldStartFresh ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          if (!isPlainShell && sessionId) {
            applyAgentTuiActivity(
              ptySessionKey,
              existingSession,
              dependencies.stripAnsiSequences,
              () => handleAgentShellSettled(existingSession),
            );
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
          if (keepBusyParkedSession) {
            reportKeptAgentShellRuntime(ws, existingSession);
          }
          resizeShellForReconnect(
            existingSession.pty,
            readNumber(data.cols, 80),
            readNumber(data.rows, 24),
            existingSession.isAgentShell,
          );
          ws.send(JSON.stringify({ type: 'replay_complete' }));
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
        const opensInteractiveProjectShell = isPlainShell && !initialCommand;
        const shell = opensInteractiveProjectShell
          ? os.platform() === 'win32'
            ? 'powershell.exe'
            : process.env.SHELL || '/bin/sh'
          : os.platform() === 'win32'
            ? 'powershell.exe'
            : 'bash';
        const shellArgs = opensInteractiveProjectShell
          ? os.platform() === 'win32' ? ['-NoLogo'] : ['-l']
          : os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
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

        const spawnedAt = Date.now();
        ptySessionsMap.set(ptySessionKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
          provider,
          startedAt: spawnedAt,
          spawnedAt,
          isAgentShell: !isPlainShell,
          model: requestedModel,
          effort: requestedEffort,
          fastMode: requestedFastMode,
          permissionMode: requestedPermissionMode,
          launchPermissionMode: requestedPermissionMode,
          providerSessionId: provider === 'grok' ? resumeSessionId : undefined,
          promptInput: createShellPromptInputState(),
        });

        // Exit/ownership checks compare against THIS spawn's PTY: the socket's
        // `shellProcess` may already point at a replacement by the time an
        // old process's exit fires.
        const spawnedPty = shellProcess;

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

          if (session.isAgentShell && session.sessionId) {
            applyAgentTuiActivity(
              ptySessionKey,
              session,
              dependencies.stripAnsiSequences,
              () => handleAgentShellSettled(session),
            );
          }

          pollShellRuntime(session);

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
          if (session && session.pty !== spawnedPty) {
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
          clearTuiIdleTimer(ptySessionKey);
          shellSessionRegistry.unregister(ptySessionKey);
          if (shellProcess === spawnedPty) {
            shellProcess = null;
          }
          // Tracked per app session, so a Chatbar handoff awaiting this exit
          // also awaits the adoption before resuming.
          void captureShellSessionSync(dependencies, session);
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
                  : provider === 'kilo'
                    ? 'Kilo Code'
                  : provider === 'grok'
                    ? 'Grok Build'
                    : provider === 'cline'
                      ? 'Cline'
                      : provider === 'qwencode'
                        ? 'Qwen Code'
                    : provider === 'kimi'
                      ? 'Kimi'
                      : provider === 'pi'
                        ? 'Pi'
                        : provider === 'omp'
                          ? 'Oh My Pi'
                          : provider === 'antigravity'
                            ? 'Antigravity'
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
        const payload = readString(data.data);
        if (shellProcess) {
          shellProcess.write(payload);
        }
        const inputSession = ptySessionKey ? ptySessionsMap.get(ptySessionKey) : null;
        if (inputSession?.isAgentShell) {
          trackShellPromptInput(inputSession.promptInput, payload);
        }
        if (ptySessionKey && isTuiSubmitInput(payload)) {
          const session = ptySessionsMap.get(ptySessionKey);
          if (session?.isAgentShell) {
            markAgentShellBusy(ptySessionKey, session, () => handleAgentShellSettled(session));
          }
        }
        return;
      }

      // Echo from the client after Chatbar adopted a shell-reported runtime
      // change: the chat-normalized preferences (the same values the next
      // `init` would carry) become the parked PTY's launch baseline, so a
      // later reconnect does not mistake it for stale and kill the TUI.
      if (data.type === 'runtime_state') {
        const session = ptySessionKey ? ptySessionsMap.get(ptySessionKey) : null;
        if (!session?.isAgentShell) {
          return;
        }
        const permissionMode = readString(data.permissionMode);
        if (permissionMode) {
          session.permissionMode = resolveShellPermissionMode(session.provider, permissionMode) || session.permissionMode;
        }
        const model = readString(data.model);
        if (model && SHELL_MODEL_PROVIDERS.has(session.provider)) {
          session.model = model;
        }
        const effort = readString(data.effort);
        if (effort && SHELL_EFFORT_PROVIDERS.has(session.provider)) {
          session.effort = effort;
        }
        if (session.provider === 'codex' && typeof data.fastMode === 'boolean') {
          session.fastMode = data.fastMode;
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

    // Mobile networks can deliver an old socket's close after its replacement
    // has attached. Only the socket that currently owns the PTY may detach it.
    if (session.ws !== ws) {
      return;
    }

    // The client closed (tab switch / unmount / Chatbar taking over) but the
    // PTY stays alive for the reconnect window. Running-state must follow the
    // live socket, not the parked process — otherwise Chat keeps showing
    // "Shell" after the turn already finished.
    void captureShellSessionSync(dependencies, session);
    clearTuiIdleTimer(ptySessionKey);
    shellSessionRegistry.unregister(ptySessionKey);

    session.ws = null;
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    session.timeoutId = setTimeout(() => {
      // A reconnect may win just as this timer becomes runnable. Re-check the
      // active socket so a queued cleanup can never kill a reattached PTY.
      if (ptySessionsMap.get(ptySessionKey as string) !== session || session.ws !== null) {
        return;
      }

      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
      clearTuiIdleTimer(ptySessionKey as string);
      shellSessionRegistry.unregister(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
