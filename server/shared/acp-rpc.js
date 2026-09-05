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
  /**
   * Requests whose bound is an INACTIVITY budget rather than a wall-clock one
   * (see `request`'s `idle` option). Every line the agent writes rearms them.
   */
  const idleWaiters = new Set();
  const rearmIdleTimers = () => {
    for (const waiter of idleWaiters) waiter.rearm();
  };

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
    // Answering an agent request (a permission decision, an fs read) is also
    // progress: it means the turn was waiting on US, not wedged.
    rearmIdleTimers();
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
    // Any traffic at all — a stream chunk, a tool call, a permission request —
    // proves the agent is still working, so idle-bounded requests get a fresh
    // budget. This is what lets one `session/prompt` run for hours as long as
    // it keeps producing output.
    rearmIdleTimers();

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
     *
     * `options.idle` turns `timeoutMs` from a wall-clock deadline into an
     * INACTIVITY budget: the timer restarts on every line the agent writes.
     * That distinction is what makes long-horizon turns work. A wall-clock
     * bound kills a healthy multi-hour turn purely for being long (the
     * "session/prompt timed out after 900000ms" failure), while an idle bound
     * still catches the case the bound exists for — an agent that has silently
     * wedged and will never settle.
     */
    request(method, params, timeoutMs, options = {}) {
      const id = nextId++;
      const idle = Boolean(options.idle) && Boolean(timeoutMs);
      return new Promise((resolve, reject) => {
        let timer = null;
        let waiter = null;
        const settle = (fn, value) => {
          if (timer) clearTimeout(timer);
          if (waiter) idleWaiters.delete(waiter);
          pending.delete(id);
          fn(value);
        };
        pending.set(id, {
          resolve: (value) => settle(resolve, value),
          reject: (error) => settle(reject, error),
        });
        if (timeoutMs) {
          const fire = () => {
            if (waiter) idleWaiters.delete(waiter);
            if (pending.delete(id)) {
              reject(new Error(idle
                ? `${label} request "${method}" produced no output for ${timeoutMs}ms`
                : `${label} request "${method}" timed out after ${timeoutMs}ms`));
            }
          };
          // Deliberately not unref'd: a pending request's deadline has to be
          // able to hold the process up long enough to reject its caller.
          timer = setTimeout(fire, timeoutMs);
          if (idle) {
            waiter = {
              rearm: () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(fire, timeoutMs);
              },
            };
            idleWaiters.add(waiter);
          }
        }
        try {
          write({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          pending.delete(id);
          if (waiter) idleWaiters.delete(waiter);
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
    /**
     * Answer an agent request with a JSON-RPC error.
     *
     * An agent request MUST be answered either way: leaving it unanswered
     * hangs the agent's tool call, and with it the whole `session/prompt`,
     * until the turn's timeout fires. `-32603` (internal error) is the right
     * generic code for "we tried and the operation failed".
     */
    respondError(id, message, code = -32603) {
      try {
        write({ jsonrpc: '2.0', id, error: { code, message: String(message) } });
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
      idleWaiters.clear();
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
