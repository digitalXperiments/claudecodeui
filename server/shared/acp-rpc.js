import readline from 'node:readline';

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio — the transport
 * every Agent Client Protocol (ACP) agent speaks (`opencode acp`, `kilo acp`,
 * `kimi acp`, `grok acp`).
 *
 * Three message shapes arrive on stdout and must be told apart:
 *  - a RESPONSE to one of our requests  (has `id`, no `method`)
 *  - a REQUEST from the agent to us    (has `id` AND `method`) — this is how
 *    `session/request_permission` arrives, and it must be answered with
 *    `respond(id, result)` or the agent's turn blocks forever.
 *  - a NOTIFICATION                     (has `method`, no `id`) — `session/update`.
 *
 * All stdio ACP runtimes use this client. Keeping the lifecycle here is
 * important: a dead child must reject pending calls, and a permission reply
 * must use the optionId the agent actually offered.
 */
export function createAcpJsonRpcClient(child, { label = 'ACP' } = {}) {
  const pending = new Map();
  const messageHandlers = new Set();
  const rl = readline.createInterface({ input: child.stdout });
  let nextId = 1;
  let closed = false;
  let closeError = null;

  // A spawn/runtime failure (ENOENT if the binary isn't on PATH, or a mid-turn
  // crash) must reject every in-flight request rather than leave callers
  // hanging, and must not let Node's unhandled 'error' event kill the server.
  const rejectAllPending = (error) => {
    if (closed && closeError) return;
    closed = true;
    closeError = error instanceof Error ? error : new Error(String(error));
    for (const [id, waiter] of pending.entries()) {
      pending.delete(id);
      waiter.reject(error);
    }
  };
  child.on('error', rejectAllPending);
  child.on('exit', () => rejectAllPending(new Error(`${label} process exited`)));
  child.on('close', () => rejectAllPending(new Error(`${label} connection closed`)));
  // Writing to stdin after the child exited raises EPIPE on the stream itself,
  // not on `child`'s 'error' event — unhandled, that takes down the process.
  child.stdin.on('error', (error) => rejectAllPending(error));

  const write = (payload) => {
    if (closed || child.stdin.destroyed || child.stdin.writableEnded) {
      throw closeError || new Error(`${label} connection is closed`);
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const dispatch = (handler, message, isRequest) => {
    try {
      Promise.resolve(handler(message, isRequest)).catch((error) => {
        console.error(`[${label}] message handler failed:`, error?.message || error);
      });
    } catch (error) {
      console.error(`[${label}] message handler failed:`, error?.message || error);
    }
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
      for (const handler of messageHandlers) dispatch(handler, message, true);
      return;
    }

    if (typeof message.method === 'string') {
      for (const handler of messageHandlers) dispatch(handler, message, false);
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
        try {
          write({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(error);
        }
      });
    },
    notify(method, params) {
      try {
        write({ jsonrpc: '2.0', method, params });
        return true;
      } catch {
        return false;
      }
    },
    respond(id, result) {
      try {
        write({ jsonrpc: '2.0', id, result });
        return true;
      } catch {
        return false;
      }
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    close() {
      if (!closed) {
        closed = true;
        closeError = new Error(`${label} connection closed`);
      }
      rl.close();
      pending.forEach((waiter) => waiter.reject(closeError));
      pending.clear();
    },
  };
}

/** Return the exact ACP option id for a semantic permission choice. */
export function findAcpPermissionOption(options, kinds) {
  if (!Array.isArray(options)) return null;
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate?.kind === kind && typeof candidate.optionId === 'string');
    if (option) return option.optionId;
  }
  return null;
}

/** ACP requires cancellation when no offered option can satisfy a decision. */
export function createAcpPermissionCancellation() {
  return { outcome: { outcome: 'cancelled' } };
}
