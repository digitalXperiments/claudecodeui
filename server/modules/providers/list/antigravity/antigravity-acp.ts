/**
 * Short-lived ACP helpers for Antigravity: health probes and the interactive
 * Google sign-in flow.
 *
 * These deliberately spawn their OWN child rather than reusing the chat runtime
 * in `server/opencode-cli.js`. A login flow prints its consent URL on stdio and
 * blocks until the browser round-trip finishes; doing that inside a chat
 * session's ACP child would interleave with `session/update` traffic and could
 * park a live chat behind an auth prompt.
 *
 * OAuth URLs are scraped from **both** stdout and stderr. ACP agents in the
 * Gemini family have printed the consent URL to either stream depending on
 * build and TTY detection, and losing it means the user has nothing to click.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { createAcpJsonRpcClient } from '@/shared/acp-rpc.js';

import {
  antigravityTokenFileExists,
  buildAntigravityLaunchEnv,
  extractOauthUrl,
  isLoopbackReturnUrl,
  parseAntigravityAuthorizationUrl,
} from './antigravity-auth-support.js';
import {
  ANTIGRAVITY_DEFAULT_AUTH_METHOD,
  antigravityAcpArgs,
  readAntigravityRuntimeConfig,
  resolveAntigravityBinary,
  type AntigravityBinaryResolution,
} from './antigravity-runtime.js';

export { extractOauthUrl, isLoopbackReturnUrl } from './antigravity-auth-support.js';

/**
 * Antigravity's first `initialize` can pay a cold-start cost (the harness
 * unpacks and warms up), so the 30s window the other ACP runtimes use is too
 * tight and produced spurious "not installed" reports. 90s is generous enough
 * for a cold start and still bounded.
 */
export const ANTIGRAVITY_SETUP_TIMEOUT_MS = 90_000;

/** How long a browser sign-in may take before the login child is torn down. */
export const ANTIGRAVITY_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export const ANTIGRAVITY_LABEL = 'Antigravity ACP';

type AcpRpcClient = ReturnType<typeof createAcpJsonRpcClient>;

export type AntigravityAcpChild = {
  child: ChildProcessWithoutNullStreams;
  rpc: AcpRpcClient;
  /** Everything the child has written to stdout/stderr, capped. */
  readOutput: () => string;
  /** Resolves with the first OAuth URL seen on either stream, or null on close. */
  waitForOauthUrl: (timeoutMs: number) => Promise<string | null>;
  dispose: () => void;
};

/**
 * Spawn the Antigravity ACP server for a one-shot operation.
 *
 * Throws when the binary cannot be resolved — the caller turns that into either
 * a "not installed" status or an explicit invalid-override error rather than an
 * ENOENT from deep inside the RPC client.
 */
export function spawnAntigravityAcpChild(
  env: NodeJS.ProcessEnv = process.env,
  extraEnv: Record<string, string> = {},
): AntigravityAcpChild {
  const resolution: AntigravityBinaryResolution = resolveAntigravityBinary(env);
  if (!resolution.ok) {
    const error = new Error(resolution.message) as Error & { code?: string };
    error.code = resolution.code;
    throw error;
  }

  const launchEnv = buildAntigravityLaunchEnv(env, resolution.command);
  const child = crossSpawn(resolution.command, antigravityAcpArgs(), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...launchEnv, ...extraEnv },
  }) as ChildProcessWithoutNullStreams;

  const rpc = createAcpJsonRpcClient(child, { label: ANTIGRAVITY_LABEL });

  let output = '';
  let oauthUrl: string | null = null;
  const urlWaiters = new Set<(url: string | null) => void>();

  const absorb = (chunk: Buffer | string) => {
    const text = chunk.toString();
    output = `${output}${text}`.slice(-16_000);
    const found = extractOauthUrl(text) ?? extractOauthUrl(output);
    if (!found) return;
    // Prefer a later real OAuth URL over the first Google link the agent printed.
    if (oauthUrl && oauthUrl === found) return;
    if (oauthUrl && /\/o\/oauth2\/|client_id=/i.test(oauthUrl) && !/\/o\/oauth2\/|client_id=/i.test(found)) {
      return;
    }
    oauthUrl = found;
    for (const waiter of urlWaiters) waiter(found);
    urlWaiters.clear();
  };

  // stdout carries JSON-RPC, but some builds also print the consent banner
  // there; the RPC reader tolerates non-JSON lines, so watching both is safe.
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);

  const settleWaiters = () => {
    for (const waiter of urlWaiters) waiter(oauthUrl);
    urlWaiters.clear();
  };
  child.once('exit', settleWaiters);
  child.once('error', settleWaiters);

  return {
    child,
    rpc,
    readOutput: () => output,
    waitForOauthUrl: (timeoutMs: number) => new Promise<string | null>((resolve) => {
      if (oauthUrl) {
        resolve(oauthUrl);
        return;
      }
      const timer = setTimeout(() => {
        urlWaiters.delete(waiter);
        resolve(oauthUrl);
      }, timeoutMs);
      timer.unref?.();
      const waiter = (url: string | null) => {
        clearTimeout(timer);
        resolve(url);
      };
      urlWaiters.add(waiter);
    }),
    dispose: () => {
      try {
        rpc.close();
      } catch {
        // Already closed.
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    },
  };
}

export type AntigravityInitializeResult = {
  /** Auth methods the agent advertises. A non-empty list means sign-in is required. */
  authMethods: { id: string; name?: string }[];
  agentCapabilities: Record<string, unknown> | null;
  raw: Record<string, unknown> | null;
};

const readAuthMethods = (raw: unknown): { id: string; name?: string }[] => {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as Record<string, unknown>).authMethods;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === 'string') return { id: entry };
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id : typeof record.methodId === 'string' ? record.methodId : null;
        if (!id) return null;
        return { id, name: typeof record.name === 'string' ? record.name : undefined };
      }
      return null;
    })
    .filter((entry): entry is { id: string; name?: string } => entry !== null);
};

/**
 * Run `initialize` against a fresh child and tear it down.
 *
 * NOTE: `authMethods` here is the agent's *catalogue* of sign-in options, not
 * its auth state. Antigravity 1.1.1 advertises all four methods on every
 * initialize, signed in or not. Use `probeAntigravitySignIn` to learn whether
 * credentials actually work.
 */
export async function probeAntigravityAcp(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = ANTIGRAVITY_SETUP_TIMEOUT_MS,
): Promise<AntigravityInitializeResult> {
  const session = spawnAntigravityAcpChild(env);
  try {
    const raw = await session.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'cloudcli', version: '1.0.0' },
    }, timeoutMs) as Record<string, unknown> | null;

    const capabilities = raw && typeof raw.agentCapabilities === 'object' && raw.agentCapabilities
      ? raw.agentCapabilities as Record<string, unknown>
      : null;

    return { authMethods: readAuthMethods(raw), agentCapabilities: capabilities, raw };
  } finally {
    session.dispose();
  }
}

export type AntigravitySignInProbe = {
  authenticated: boolean;
  /**
   * - `authenticated`: `authenticate` resolved without asking for a browser.
   * - `consent-required`: the agent printed a consent URL — no usable token.
   * - `no-token`: nothing persisted in the private profile; skipped the RPC so
   *   the agent never opens a loopback listener nobody will answer.
   * - `rpc-error` / `timeout`: the agent did not settle either way.
   */
  reason: 'authenticated' | 'consent-required' | 'no-token' | 'rpc-error' | 'timeout';
  error: string | null;
  initialize: AntigravityInitializeResult;
};

/** How long a token-backed `authenticate` may take (it refreshes the access token). */
export const ANTIGRAVITY_SIGNIN_PROBE_TIMEOUT_MS = 30_000;

/**
 * The authoritative "is Antigravity signed in?" check, mirroring how T3 Code
 * starts every session: `initialize`, then `authenticate`. With a persisted
 * token that RPC refreshes silently and resolves `{}` in a few seconds. Without
 * one the agent prints a Google consent URL within milliseconds and blocks on
 * a loopback listener — which is exactly the signal that sign-in is required.
 *
 * Throws only when the binary cannot be resolved or `initialize` fails, so the
 * caller can keep reporting "not installed / unreachable" separately.
 */
export async function probeAntigravitySignIn(
  env: NodeJS.ProcessEnv = process.env,
  methodId?: string,
  timeoutMs: number = ANTIGRAVITY_SIGNIN_PROBE_TIMEOUT_MS,
): Promise<AntigravitySignInProbe> {
  const resolvedMethod = methodId?.trim()
    || readAntigravityRuntimeConfig(env).authMethod
    || ANTIGRAVITY_DEFAULT_AUTH_METHOD;

  const session = spawnAntigravityAcpChild(env);
  try {
    const raw = await session.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'cloudcli', version: '1.0.0' },
    }, ANTIGRAVITY_SETUP_TIMEOUT_MS) as Record<string, unknown> | null;
    const capabilities = raw && typeof raw.agentCapabilities === 'object' && raw.agentCapabilities
      ? raw.agentCapabilities as Record<string, unknown>
      : null;
    const initialize: AntigravityInitializeResult = { authMethods: readAuthMethods(raw), agentCapabilities: capabilities, raw };

    if (!antigravityTokenFileExists(env)) {
      return { authenticated: false, reason: 'no-token', error: null, initialize };
    }

    const outcome = await new Promise<AntigravitySignInProbe>((resolve) => {
      let done = false;
      const finish = (result: Omit<AntigravitySignInProbe, 'initialize'>) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ...result, initialize });
      };
      const timer = setTimeout(() => {
        finish({ authenticated: false, reason: 'timeout', error: `Antigravity did not finish authenticate within ${timeoutMs / 1000}s.` });
      }, timeoutMs);
      timer.unref?.();

      // A consent URL means the stored token is missing or unusable. It can
      // arrive before the RPC would ever settle, so watch for it in parallel.
      void session.waitForOauthUrl(timeoutMs).then((url) => {
        if (url) finish({ authenticated: false, reason: 'consent-required', error: null });
      });

      session.rpc
        .request('authenticate', { methodId: resolvedMethod })
        .then(() => finish({ authenticated: true, reason: 'authenticated', error: null }))
        .catch((error: unknown) => {
          finish({ authenticated: false, reason: 'rpc-error', error: (error as Error)?.message || String(error) });
        });
    });
    return outcome;
  } finally {
    // Disposing also closes any loopback listener a consent-required
    // authenticate opened, so probes never leave half-started sign-ins around.
    session.dispose();
  }
}

export type AntigravityLoginState = {
  status: 'pending' | 'succeeded' | 'failed';
  methodId: string;
  url: string | null;
  startedAt: string;
  error: string | null;
};

type LoginSession = {
  session: AntigravityAcpChild;
  state: AntigravityLoginState;
  settled: Promise<void>;
  timer: NodeJS.Timeout;
  confirmTimer: NodeJS.Timeout | null;
};

let activeLogin: LoginSession | null = null;
/** Survives child teardown so Settings can still poll a terminal outcome. */
let lastLoginSnapshot: (AntigravityLoginState & { output: string }) | null = null;

const SIGNIN_CONFIRM_INTERVAL_MS = 3_000;

const snapshotLogin = (session: LoginSession): (AntigravityLoginState & { output: string }) => ({
  ...session.state,
  output: session.session.readOutput(),
});

const disposeActiveLogin = () => {
  if (!activeLogin) return;
  lastLoginSnapshot = snapshotLogin(activeLogin);
  clearTimeout(activeLogin.timer);
  if (activeLogin.confirmTimer) clearInterval(activeLogin.confirmTimer);
  activeLogin.session.dispose();
  activeLogin = null;
};

const markLoginFailed = (error: string) => {
  if (!activeLogin || activeLogin.state.status !== 'pending') return;
  activeLogin.state.status = 'failed';
  activeLogin.state.error = error;
  disposeActiveLogin();
};

const markLoginSucceeded = () => {
  if (!activeLogin || activeLogin.state.status !== 'pending') return;
  activeLogin.state.status = 'succeeded';
  activeLogin.state.error = null;
  // Hide a stale consent URL once credentials actually persist.
  activeLogin.state.url = null;
  disposeActiveLogin();
};

/**
 * Sign-in is confirmed only when a fresh child can `authenticate` from the
 * persisted token. The login child's own `authenticate` RPC is not trusted:
 * it has returned before credentials landed, and `initialize`'s authMethods
 * list never changes, so neither can tell us the token works.
 */
const confirmPersistedSignIn = async (env: NodeJS.ProcessEnv = process.env): Promise<boolean> => {
  // Cheap gate: with forced file storage there is nothing to confirm until the
  // agent has written its token, and probing before then would spawn a child
  // every few seconds during the browser round-trip.
  if (!antigravityTokenFileExists(env)) return false;
  const probe = await probeAntigravitySignIn(env, activeLogin?.state.methodId);
  return probe.authenticated;
};

/**
 * Begin an ACP `authenticate` sign-in and return the consent URL to show.
 *
 * The child is kept alive afterwards because `authenticate` does not resolve
 * until the browser round-trip completes; `getAntigravityLoginState` polls the
 * outcome and `submitAntigravityReturnUrl` unblocks a headless/remote host.
 */
export async function startAntigravityLogin(
  env: NodeJS.ProcessEnv = process.env,
  methodId?: string,
): Promise<AntigravityLoginState> {
  disposeActiveLogin();

  const resolvedMethod = methodId?.trim()
    || readAntigravityRuntimeConfig(env).authMethod
    || ANTIGRAVITY_DEFAULT_AUTH_METHOD;

  const session = spawnAntigravityAcpChild(env);
  const state: AntigravityLoginState = {
    status: 'pending',
    methodId: resolvedMethod,
    url: null,
    startedAt: new Date().toISOString(),
    error: null,
  };

  try {
    await session.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'cloudcli', version: '1.0.0' },
    }, ANTIGRAVITY_SETUP_TIMEOUT_MS);
  } catch (error) {
    session.dispose();
    throw error;
  }

  // No timeout: this request is the browser round-trip. The watchdog below
  // bounds it instead, so a user who abandons the flow does not leak a child.
  // Do NOT treat RPC resolve as signed-in — confirm with a fresh probe.
  const settled = session.rpc
    .request('authenticate', { methodId: resolvedMethod })
    .then(async () => {
      try {
        if (await confirmPersistedSignIn(env)) {
          markLoginSucceeded();
        }
      } catch {
        // Probe failure while the login child is still up is not terminal;
        // the confirm interval retries until timeout.
      }
    })
    .catch((error: unknown) => {
      markLoginFailed((error as Error)?.message || String(error));
    });

  const timer = setTimeout(() => {
    markLoginFailed('Google sign-in timed out. Start the sign-in again.');
  }, ANTIGRAVITY_LOGIN_TIMEOUT_MS);
  timer.unref?.();

  let confirmInFlight = false;
  const confirmTimer = setInterval(() => {
    if (confirmInFlight) return;
    confirmInFlight = true;
    void (async () => {
      if (!activeLogin || activeLogin.state.status !== 'pending') return;
      try {
        if (await confirmPersistedSignIn(env)) markLoginSucceeded();
      } catch {
        // Keep waiting; the login child may still be writing credentials.
      } finally {
        confirmInFlight = false;
      }
    })();
  }, SIGNIN_CONFIRM_INTERVAL_MS);
  confirmTimer.unref?.();

  activeLogin = { session, state, settled, timer, confirmTimer };
  lastLoginSnapshot = null;

  // Give the agent a short window to print its consent URL. Returning without
  // one is not fatal — the UI shows the captured output so the user can copy
  // the link manually.
  state.url = await session.waitForOauthUrl(20_000);
  if (state.status === 'pending' && !state.url) {
    try {
      if (await confirmPersistedSignIn(env)) {
        markLoginSucceeded();
      }
    } catch {
      // Still pending; Settings keeps polling.
    }
  }
  return getAntigravityLoginState() ?? { ...state, output: session.readOutput() };
}

export function getAntigravityLoginState(): (AntigravityLoginState & { output: string }) | null {
  if (activeLogin) return snapshotLogin(activeLogin);
  return lastLoginSnapshot ? { ...lastLoginSnapshot } : null;
}

export function cancelAntigravityLogin(): void {
  disposeActiveLogin();
}

/**
 * Complete a sign-in on a remote CloudCLI host.
 *
 * Antigravity finishes OAuth by having the browser hit a loopback listener the
 * agent opened. When CloudCLI runs on another machine, that redirect lands in
 * the user's own browser and never reaches the agent — so the user pastes the
 * `http://127.0.0.1:.../?code=…` URL here and the server replays it locally
 * against the waiting listener. Only loopback URLs are accepted: replaying an
 * arbitrary URL would make this endpoint a server-side request forwarder.
 */
export async function submitAntigravityReturnUrl(returnUrl: string): Promise<AntigravityLoginState> {
  if (!activeLogin) {
    // A browser on this same machine may already have finished the flow and
    // torn the login down; do not tell the user to start over if so.
    if (lastLoginSnapshot?.status === 'succeeded') return { ...lastLoginSnapshot };
    throw new Error('No Antigravity sign-in is in progress. Start Sign in with Google first.');
  }
  if (!isLoopbackReturnUrl(returnUrl)) {
    throw new Error('The return URL must be the local http://127.0.0.1 address the browser was redirected to.');
  }

  // Only the callback the *current* consent URL asked for may be replayed;
  // otherwise this endpoint could poke arbitrary loopback ports.
  const pending = activeLogin.state.url ? parseAntigravityAuthorizationUrl(activeLogin.state.url) : null;
  if (pending) {
    let callback: URL;
    try {
      callback = new URL(returnUrl);
    } catch {
      throw new Error('Paste the complete redirect URL from the Google sign-in page.');
    }
    const expected = new URL(pending.redirectUri);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
      throw new Error('This redirect URL does not belong to the current sign-in. Copy the full http://127.0.0.1:PORT/?state=…&code=… address.');
    }
    const states = callback.searchParams.getAll('state');
    if (states.length !== 1 || states[0] !== pending.state) {
      throw new Error('This redirect URL does not belong to the current sign-in (state mismatch). Start Sign in with Google again.');
    }
  }

  const env = process.env;
  let fetchError: string | null = null;
  const response = await fetch(returnUrl, { redirect: 'manual' }).catch((error: unknown) => {
    fetchError = (error as Error)?.message || String(error);
    return null;
  });

  if (!response) {
    // The listener is one-shot. If a browser on this host already hit it, the
    // agent has consumed the code and closed the port — so check whether the
    // token actually landed before calling this a failure.
    try {
      if (await confirmPersistedSignIn(env)) {
        markLoginSucceeded();
        return getAntigravityLoginState() ?? lastLoginSnapshot!;
      }
    } catch {
      // Fall through to the listener error.
    }
    throw new Error(
      `Could not reach the local sign-in listener: ${fetchError}. `
      + 'If the browser on this machine already showed the Google confirmation page, click refresh on Connection Status; '
      + 'otherwise start Sign in with Google again and paste the new redirect URL.',
    );
  }
  // The listener answers with its own confirmation page; a non-2xx/3xx status
  // means the code was rejected and the agent is still waiting.
  if (response.status >= 400) {
    throw new Error(`The local sign-in listener rejected the return URL (HTTP ${response.status}).`);
  }

  // Credentials are written after the listener consumes the code. Wait for a
  // fresh probe to confirm they persist — not for the authenticate RPC alone.
  const deadline = Date.now() + 45_000;
  while (activeLogin && activeLogin.state.status === 'pending' && Date.now() < deadline) {
    try {
      if (await confirmPersistedSignIn(env)) markLoginSucceeded();
    } catch {
      // Retry until the deadline.
    }
    if (!activeLogin || activeLogin.state.status !== 'pending') break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    });
  }

  return getAntigravityLoginState() ?? activeLogin?.state ?? lastLoginSnapshot!;
}
