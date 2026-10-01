import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);

export function resolveCodexLauncher() {
  const configuredPath = process.env.CODEX_CLI_PATH?.trim();
  if (configuredPath) {
    return { command: configuredPath, args: [] };
  }

  // A user-installed Codex in ~/.local/bin is almost always newer than the
  // optional `@openai/codex` package pinned beside CloudCLI, and newer CLIs
  // are the ones that know about preview models. Prefer it when present.
  const userCodexPath = path.join(os.homedir(), '.local', 'bin', 'codex');
  if (existsSync(userCodexPath)) {
    return { command: userCodexPath, args: [] };
  }

  try {
    const packageRoot = path.dirname(require.resolve('@openai/codex/package.json'));
    return {
      command: process.execPath,
      args: [path.join(packageRoot, 'bin', 'codex.js')],
    };
  } catch {
    // A globally-installed Codex remains a valid fallback for packaged builds
    // where the optional npm package is not present beside CloudCLI.
    return { command: 'codex', args: [] };
  }
}

// TOML bare keys are limited to [A-Za-z0-9_-]. Anything else (an absolute path used as a
// permissions-profile entry) must be quoted. Codex splits a dotted `--config` key on every `.`,
// quoted or not, so a table with such keys is sent as ONE inline table instead of dotted paths.
function isBareTomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key);
}

function tomlKeySegment(key) {
  return isBareTomlKey(key) ? key : JSON.stringify(key);
}

function toTomlValue(value, keyPath) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => toTomlValue(item, `${keyPath}[${index}]`)).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, child]) => `${tomlKeySegment(key)} = ${toTomlValue(child, `${keyPath}.${key}`)}`)
      .join(', ')}}`;
  }
  throw new Error(`Unsupported Codex config value at ${keyPath}`);
}

export function flattenConfigOverrides(value, prefix = '', output = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) {
      output.push(`${prefix}=${toTomlValue(value, prefix)}`);
      return output;
    }
    throw new Error('Codex config overrides must be an object');
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      if (Object.keys(child).some((childKey) => !isBareTomlKey(childKey))) {
        output.push(`${nextPath}=${toTomlValue(child, nextPath)}`);
      } else {
        flattenConfigOverrides(child, nextPath, output);
      }
    } else {
      output.push(`${nextPath}=${toTomlValue(child, nextPath)}`);
    }
  }

  // An empty table is an intentional override (for example, a Relay worker
  // must clear inherited user/project MCP servers). Do not silently drop it.
  if (Object.keys(value).length === 0 && prefix) {
    output.push(`${prefix}={}`);
  }

  return output;
}

// After SIGTERM, a Codex app-server that has not exited within this window is
// SIGKILLed so a wedged child can never pin its pipes (fds) forever.
const CODEX_KILL_GRACE_MS = 1_500;
// Upper bound on waiting for stdio to drain after the child exited.
const EXIT_DRAIN_MS = 250;

function createJsonRpcClient(child) {
  const pending = new Map();
  const handlers = new Set();
  const exitHandlers = new Set();
  const rl = readline.createInterface({ input: child.stdout });
  let nextId = 1;
  let closed = false;
  let exited = child.exitCode !== null && child.exitCode !== undefined;
  let exitInfo = exited ? { code: child.exitCode, signal: null } : null;
  let killTimer = null;
  let resolveExited;
  const exitedPromise = new Promise((resolve) => {
    resolveExited = resolve;
  });
  if (exited) {
    resolveExited(exitInfo);
  }

  const rejectPending = (error) => {
    for (const [id, waiter] of pending.entries()) {
      pending.delete(id);
      waiter.reject(error);
    }
  };

  const write = (message) => {
    if (closed || exited || child.stdin.destroyed) {
      throw new Error('Codex app-server stdin is closed');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // The app-server protocol is JSONL. Ignore stray stdout noise rather
      // than taking down an otherwise healthy session.
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, 'id')
      && !Object.prototype.hasOwnProperty.call(message, 'method')) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(new Error(message.error.message || 'Codex app-server request failed'));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
    }

    for (const handler of [...handlers]) {
      try {
        handler(message);
      } catch (error) {
        console.error('[Codex app-server] Message handler failed:', error);
      }
    }
  };

  const onStderr = (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.warn('[Codex app-server]', text);
    }
  };

  const onChildError = (error) => {
    closed = true;
    rejectPending(error);
  };

  // 'exit' can fire before the last stdout lines were read, so the final
  // teardown (listener release + exit callbacks) waits for 'close' (all
  // stdio drained), bounded in case a grandchild holds the pipes open.
  let finalized = false;
  let finalizeTimer = null;
  const finalizeExit = () => {
    if (finalized) {
      return;
    }
    finalized = true;
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    closed = true;
    releaseStreams();
    handlers.clear();
    const listeners = [...exitHandlers];
    exitHandlers.clear();
    for (const handler of listeners) {
      try {
        handler(exitInfo);
      } catch (error) {
        console.error('[Codex app-server] Exit handler failed:', error);
      }
    }
    resolveExited(exitInfo);
  };

  const onChildExit = (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    rejectPending(new Error(`Codex app-server exited (${signal || `code ${code ?? 1}`})`));
    finalizeTimer = setTimeout(finalizeExit, EXIT_DRAIN_MS);
    finalizeTimer.unref?.();
  };

  const onChildClose = () => {
    if (!exited) {
      exited = true;
      exitInfo = exitInfo || { code: child.exitCode, signal: child.signalCode ?? null };
      rejectPending(new Error('Codex app-server exited'));
    }
    finalizeExit();
  };

  const onStdinError = (error) => {
    console.error('[Codex app-server] stdin write failed:', error?.message || error);
  };

  let streamsReleased = false;
  // Drops every listener this client attached to the child's stdio and
  // destroys the pipes so their fds are released even if the child lingers.
  // The 'error' listeners stay (as no-ops once closed) so a late EPIPE can
  // never become an uncaught exception.
  function releaseStreams() {
    if (streamsReleased) {
      return;
    }
    streamsReleased = true;
    rl.removeListener('line', handleLine);
    rl.close();
    child.stderr?.removeListener('data', onStderr);
    try {
      child.stdin.end();
    } catch {
      // The process may already have torn down its stdin.
    }
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
  }

  rl.on('line', handleLine);
  child.stderr?.on('data', onStderr);
  child.on('error', onChildError);
  child.once('exit', onChildExit);
  child.once('close', onChildClose);
  child.stdin.on('error', onStdinError);
  if (exited) {
    finalizeExit();
  }

  return {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          write({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params = {}) {
      write({ jsonrpc: '2.0', method, params });
    },
    respond(id, result) {
      write({ jsonrpc: '2.0', id, result });
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    /** Registers a one-shot callback for the child's exit (crash or close). */
    onExit(handler) {
      if (finalized) {
        queueMicrotask(() => handler(exitInfo));
        return () => {};
      }
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    /** Resolves once the child process has exited. */
    exited: exitedPromise,
    /** True once close() was called or the child exited/failed. */
    get closed() {
      return closed;
    },
    get alive() {
      return !closed && !exited && !child.stdin.destroyed;
    },
    close() {
      if (!closed) {
        closed = true;
        rejectPending(new Error('Codex app-server closed'));
      }
      handlers.clear();
      releaseStreams();
      if (!exited && child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      }
      if (!exited && !killTimer) {
        killTimer = setTimeout(() => {
          killTimer = null;
          if (!exited) {
            try {
              child.kill('SIGKILL');
            } catch {
              // already gone
            }
          }
        }, CODEX_KILL_GRACE_MS);
        killTimer.unref?.();
      }
    },
    /** Diagnostics / tests: listeners still attached by this client. */
    getListenerStats() {
      return {
        messageHandlers: handlers.size,
        exitHandlers: exitHandlers.size,
        pendingRequests: pending.size,
        stdoutData: child.stdout?.listenerCount?.('data') ?? 0,
        stderrData: child.stderr?.listenerCount?.('data') ?? 0,
        rlLine: rl.listenerCount('line'),
      };
    },
    child,
  };
}

/**
 * Start a Codex app-server connection. The app server persists the thread
 * itself; openai-codex.js either closes the process after one turn or parks
 * it in the warm pool for the next turn of the same thread.
 * `spawnFn` is a test seam (defaults to child_process.spawn).
 */
export function createCodexAppServer({ cwd, env, config = {}, spawnFn = spawn }) {
  const launcher = resolveCodexLauncher();
  const args = [
    ...launcher.args,
    'app-server',
    '--listen',
    'stdio://',
  ];

  for (const override of flattenConfigOverrides(config)) {
    args.push('--config', override);
  }

  const child = spawnFn(launcher.command, args, {
    cwd,
    env: env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return createJsonRpcClient(child);
}
