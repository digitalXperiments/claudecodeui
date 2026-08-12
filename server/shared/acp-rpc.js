import readline from 'node:readline';

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio — the transport
 * every Agent Client Protocol (ACP) agent speaks (`opencode acp`, `kimi acp`,
 * `grok acp`).
 *
 * Three message shapes arrive on stdout and must be told apart:
 *  - a RESPONSE to one of our requests  (has `id`, no `method`)
 *  - a REQUEST from the agent to us    (has `id` AND `method`) — this is how
 *    `session/request_permission` arrives, and it must be answered with
 *    `respond(id, result)` or the agent's turn blocks forever.
 *  - a NOTIFICATION                     (has `method`, no `id`) — `session/update`.
 *
 * `server/kimi-cli.js` still carries its own copy of this client; it predates
 * this module and has no test coverage of its own, so it is left alone rather
 * than migrated blind.
 */
export function createAcpJsonRpcClient(child, { label = 'ACP' } = {}) {
  const pending = new Map();
  const messageHandlers = new Set();
  const rl = readline.createInterface({ input: child.stdout });
  let nextId = 1;

  // A spawn/runtime failure (ENOENT if the binary isn't on PATH, or a mid-turn
  // crash) must reject every in-flight request rather than leave callers
  // hanging, and must not let Node's unhandled 'error' event kill the server.
  const rejectAllPending = (error) => {
    for (const [id, waiter] of pending.entries()) {
      pending.delete(id);
      waiter.reject(error);
    }
  };
  child.on('error', rejectAllPending);
  child.on('exit', () => rejectAllPending(new Error(`${label} process exited`)));
  // Writing to stdin after the child exited raises EPIPE on the stream itself,
  // not on `child`'s 'error' event — unhandled, that takes down the process.
  child.stdin.on('error', (error) => {
    console.error(`[${label}] stdin write failed (process likely exited):`, error?.message || error);
  });

  const write = (payload) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Non-JSON-RPC noise on stdout is not expected; drop it rather than
      // crash the session over a stray line.
      return;
    }

    if (typeof message.id !== 'undefined' && typeof message.method === 'string') {
      for (const handler of messageHandlers) handler(message, true);
      return;
    }

    if (typeof message.method === 'string') {
      for (const handler of messageHandlers) handler(message, false);
      return;
    }

    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message || `${label} request failed`));
      } else {
        waiter.resolve(message.result);
      }
    }
  });

  return {
    /**
     * `timeoutMs` is opt-in on purpose: `session/prompt` can legitimately run
     * for a long time (a long agentic turn, or waiting on a permission
     * round-trip) and must not be killed for being slow. Only the setup calls
     * — initialize / session/new / session/load / session/set_config_option —
     * have no reason to hang, so only those pass a bound.
     */
    request(method, params, timeoutMs) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        let timer = null;
        const settle = (fn, value) => {
          if (timer) clearTimeout(timer);
          pending.delete(id);
          fn(value);
        };
        pending.set(id, {
          resolve: (value) => settle(resolve, value),
          reject: (error) => settle(reject, error),
        });
        if (timeoutMs) {
          timer = setTimeout(() => {
            if (pending.delete(id)) {
              reject(new Error(`${label} request "${method}" timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs);
        }
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, params });
    },
    respond(id, result) {
      write({ jsonrpc: '2.0', id, result });
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    close() {
      rl.close();
      pending.forEach((waiter) => waiter.reject(new Error(`${label} connection closed`)));
      pending.clear();
    },
  };
}
