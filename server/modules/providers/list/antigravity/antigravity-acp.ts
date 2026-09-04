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
  ANTIGRAVITY_DEFAULT_AUTH_METHOD,
  antigravityAcpArgs,
  readAntigravityRuntimeConfig,
  resolveAntigravityBinary,
  type AntigravityBinaryResolution,
} from './antigravity-runtime.js';

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

/**
 * Pull the first OAuth consent URL out of a chunk of agent output.
 *
 * Matches Google's accounts/oauth endpoints as well as the loopback URL some
 * builds echo, and stops at the first character that cannot belong to a URL so
 * a trailing period or ANSI reset never becomes part of the link.
 */
export function extractOauthUrl(text: string): string | null {
  if (typeof text !== 'string' || !text) return null;
  // Strip ANSI colour codes so a trailing reset cannot join the URL.
  const clean = text.replace(/\[[0-9;]*[A-Za-z]/g, '');
  const matches = clean.match(/https?:\/\/[^\s"'<>)\]]+/g);
  if (!matches) return null;
  const isConsentUrl = (url: string) =>
    /accounts\.google\.com|oauth2?|antigravity|signin|auth/i.test(url);
  const candidate = matches.find(isConsentUrl) ?? null;
  if (!candidate) return null;
  return candidate.replace(/[.,;:]+$/, '');
}

/** Loopback hosts a pasted OAuth return URL is allowed to target. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

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

  const child = crossSpawn(resolution.command, antigravityAcpArgs(), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, ...extraEnv },
  }) as ChildProcessWithoutNullStreams;

  const rpc = createAcpJsonRpcClient(child, { label: ANTIGRAVITY_LABEL });

  let output = '';
  let oauthUrl: string | null = null;
  const urlWaiters = new Set<(url: string | null) => void>();

  const absorb = (chunk: Buffer | string) => {
    const text = chunk.toString();
    output = `${output}${text}`.slice(-16_000);
    if (oauthUrl) return;
    const found = extractOauthUrl(text) ?? extractOauthUrl(output);
    if (!found) return;
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

/** Run `initialize` against a fresh child and tear it down. */
export async function probeAntigravityAcp(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AntigravityInitializeResult> {
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

    return { authMethods: readAuthMethods(raw), agentCapabilities: capabilities, raw };
  } finally {
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
};

let activeLogin: LoginSession | null = null;

const disposeActiveLogin = () => {
  if (!activeLogin) return;
  clearTimeout(activeLogin.timer);
  activeLogin.session.dispose();
  activeLogin = null;
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
  const settled = session.rpc
    .request('authenticate', { methodId: resolvedMethod })
    .then(() => {
      state.status = 'succeeded';
    })
    .catch((error: unknown) => {
      state.status = 'failed';
      state.error = (error as Error)?.message || String(error);
    });

  const timer = setTimeout(() => {
    if (state.status === 'pending') {
      state.status = 'failed';
      state.error = 'Google sign-in timed out. Start the sign-in again.';
    }
    disposeActiveLogin();
  }, ANTIGRAVITY_LOGIN_TIMEOUT_MS);
  timer.unref?.();

  activeLogin = { session, state, settled, timer };

  // Give the agent a short window to print its consent URL. Returning without
  // one is not fatal — the UI shows the captured output so the user can copy
  // the link manually.
  state.url = await session.waitForOauthUrl(20_000);
  return { ...state };
}

export function getAntigravityLoginState(): (AntigravityLoginState & { output: string }) | null {
  if (!activeLogin) return null;
  return { ...activeLogin.state, output: activeLogin.session.readOutput() };
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
    throw new Error('No Antigravity sign-in is in progress. Start Sign in with Google first.');
  }
  if (!isLoopbackReturnUrl(returnUrl)) {
    throw new Error('The return URL must be the local http://127.0.0.1 address the browser was redirected to.');
  }

  const response = await fetch(returnUrl, { redirect: 'manual' }).catch((error: unknown) => {
    throw new Error(`Could not reach the local sign-in listener: ${(error as Error)?.message || String(error)}`);
  });
  // The listener answers with its own confirmation page; a non-2xx/3xx status
  // means the code was rejected and the agent is still waiting.
  if (response.status >= 400) {
    throw new Error(`The local sign-in listener rejected the return URL (HTTP ${response.status}).`);
  }

  // `authenticate` resolves shortly after the listener consumes the code.
  await Promise.race([
    activeLogin.settled,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      timer.unref?.();
    }),
  ]);

  const state = { ...activeLogin.state };
  if (state.status !== 'pending') {
    disposeActiveLogin();
  }
  return state;
}
