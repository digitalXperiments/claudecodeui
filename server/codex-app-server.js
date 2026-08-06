import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);

function resolveCodexLauncher() {
  const configuredPath = process.env.CODEX_CLI_PATH?.trim();
  if (configuredPath) {
    return { command: configuredPath, args: [] };
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
      .map(([key, child]) => `${key} = ${toTomlValue(child, `${keyPath}.${key}`)}`)
      .join(', ')}}`;
  }
  throw new Error(`Unsupported Codex config value at ${keyPath}`);
}

function flattenConfigOverrides(value, prefix = '', output = []) {
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
      flattenConfigOverrides(child, nextPath, output);
    } else {
      output.push(`${nextPath}=${toTomlValue(child, nextPath)}`);
    }
  }

  return output;
}

function createJsonRpcClient(child) {
  const pending = new Map();
  const handlers = new Set();
  const rl = readline.createInterface({ input: child.stdout });
  let nextId = 1;
  let closed = false;

  const rejectPending = (error) => {
    for (const [id, waiter] of pending.entries()) {
      pending.delete(id);
      waiter.reject(error);
    }
  };

  const write = (message) => {
    if (closed || child.stdin.destroyed) {
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

    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
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

    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[Codex app-server] Message handler failed:', error);
      }
    }
  };

  rl.on('line', handleLine);
  child.on('error', (error) => {
    closed = true;
    rejectPending(error);
  });
  child.on('exit', (code, signal) => {
    closed = true;
    rejectPending(new Error(`Codex app-server exited (${signal || `code ${code ?? 1}`})`));
  });
  child.stdin.on('error', (error) => {
    console.error('[Codex app-server] stdin write failed:', error?.message || error);
  });

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
    close() {
      if (closed) {
        return;
      }
      closed = true;
      rl.close();
      rejectPending(new Error('Codex app-server closed'));
      try {
        child.stdin.end();
      } catch {
        // The process may already have torn down its stdin.
      }
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
    },
    child,
  };
}

/**
 * Start a short-lived Codex app-server connection for one turn. The app
 * server persists the thread itself, while this process stays alive long
 * enough to answer interactive approval requests from the Chatbar.
 */
export function createCodexAppServer({ cwd, env, config = {} }) {
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

  const child = spawn(launcher.command, args, {
    cwd,
    env: env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) {
      console.warn('[Codex app-server]', message);
    }
  });

  return createJsonRpcClient(child);
}

