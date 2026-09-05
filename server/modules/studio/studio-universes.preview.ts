/**
 * Local preview process lifecycle for a Parallel Universes variant workspace.
 *
 * Deliberately in-memory only: a preview is a live, long-running dev-server
 * process tied to *this* server process. State is mirrored into the universe
 * manifest for display, but a fresh server process cannot resume ownership of
 * a pid that outlived it — see `reconcile()`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';

import type { UniversePreviewState, UniversePreviewStatus } from '@/modules/studio/studio-universes.types.js';
import { STOPPED_PREVIEW } from '@/modules/studio/studio-universes.types.js';
import { AppError } from '@/shared/utils.js';

const MAX_LOG_LINES = 200;
const MAX_LINE_CHARS = 2_000;
const READY_POLL_MS = 400;
const READY_TIMEOUT_MS = 15_000;
const START_FAIL_GRACE_MS = 800;

type PreviewProcess = {
  child: ChildProcess;
  state: UniversePreviewState;
};

const registry = new Map<string, PreviewProcess>();

export async function allocateFreePort(preferred?: number): Promise<number> {
  const tryPort = (port: number): Promise<number | null> => new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : null;
      server.close(() => resolve(bound));
    });
  });
  if (preferred) {
    const bound = await tryPort(preferred);
    if (bound) return bound;
  }
  const bound = await tryPort(0);
  if (!bound) {
    throw new AppError('Could not allocate a free port for the preview server.', {
      code: 'STUDIO_UNIVERSE_PREVIEW_PORT_UNAVAILABLE',
      statusCode: 409,
    });
  }
  return bound;
}

function pushLine(state: UniversePreviewState, line: string): void {
  const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
  state.logTail.push(clipped);
  if (state.logTail.length > MAX_LOG_LINES) {
    state.logTail.splice(0, state.logTail.length - MAX_LOG_LINES);
  }
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve(result);
    };
    conn.once('connect', () => finish(true));
    conn.once('error', () => finish(false));
    setTimeout(() => finish(false), READY_POLL_MS - 50);
  });
}

async function waitForReady(variantId: string, port: number, startedAt: number): Promise<void> {
  const deadline = startedAt + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const entry = registry.get(variantId);
    if (!entry || entry.state.status !== 'starting') return;
    if (await isPortOpen(port)) {
      entry.state.status = 'running';
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  const entry = registry.get(variantId);
  // Best-effort: the process is still alive but never announced the port.
  // Flip to running anyway so the user can retry the preview URL manually
  // instead of being stuck on "starting" forever.
  if (entry && entry.state.status === 'starting') entry.state.status = 'running';
}

export type StartPreviewOptions = {
  command: string;
  cwd: string;
  port?: number;
};

export async function startPreview(variantId: string, options: StartPreviewOptions): Promise<UniversePreviewState> {
  const command = options.command.trim();
  if (!command) {
    throw new AppError('A start command is required to launch a preview.', {
      code: 'STUDIO_UNIVERSE_PREVIEW_COMMAND_REQUIRED',
      statusCode: 400,
    });
  }
  await stopPreview(variantId).catch(() => undefined);

  const port = await allocateFreePort(options.port);
  const startedAt = Date.now();
  const state: UniversePreviewState = {
    status: 'starting',
    command,
    pid: null,
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: new Date(startedAt).toISOString(),
    stoppedAt: null,
    exitCode: null,
    error: null,
    logTail: [],
  };

  const child = spawn(command, {
    cwd: options.cwd,
    shell: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, PORT: String(port), CI: 'true', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.pid = child.pid ?? null;
  const entry: PreviewProcess = { child, state };
  registry.set(variantId, entry);

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) pushLine(entry.state, line);
  });
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) pushLine(entry.state, `[stderr] ${line}`);
  });
  child.on('error', (error) => {
    entry.state.status = 'failed';
    entry.state.error = error instanceof Error ? error.message : String(error);
  });
  child.on('exit', (code) => {
    entry.state.exitCode = code ?? null;
    entry.state.stoppedAt = new Date().toISOString();
    if (entry.state.status !== 'stopped') {
      entry.state.status = Date.now() - startedAt < START_FAIL_GRACE_MS ? 'failed' : 'exited';
      if (entry.state.status === 'failed' && !entry.state.error) {
        entry.state.error = `Process exited immediately with code ${code ?? 'null'}.`;
      }
    }
  });

  void waitForReady(variantId, port, startedAt);

  await new Promise((resolve) => setTimeout(resolve, Math.min(START_FAIL_GRACE_MS, 400)));
  return { ...entry.state, logTail: [...entry.state.logTail] };
}

export async function stopPreview(variantId: string): Promise<UniversePreviewState> {
  const entry = registry.get(variantId);
  if (!entry) return { ...STOPPED_PREVIEW };
  registry.delete(variantId);
  const { child, state } = entry;
  if (state.status !== 'exited' && state.status !== 'failed' && child.exitCode === null && child.pid) {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      // Process may have already exited between checks.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (child.exitCode === null && child.pid) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  state.status = 'stopped';
  state.stoppedAt = new Date().toISOString();
  return { ...state, logTail: [...state.logTail] };
}

/**
 * Reconcile a persisted preview state against this process's live registry.
 * A manifest saying "running" after a server restart describes a pid this
 * process never spawned and cannot safely signal — report it truthfully as
 * stopped rather than pretend control over it.
 */
export function reconcilePreviewState(
  variantId: string,
  persisted: UniversePreviewState,
): UniversePreviewState {
  const live = registry.get(variantId);
  if (live) return { ...live.state, logTail: [...live.state.logTail] };
  const stale: UniversePreviewStatus[] = ['starting', 'running'];
  if (stale.includes(persisted.status)) {
    return {
      ...persisted,
      status: 'stopped',
      stoppedAt: persisted.stoppedAt ?? new Date().toISOString(),
      error: 'The server restarted; this preview process is no longer tracked. Start it again.',
    };
  }
  return persisted;
}

export function getLivePreviewState(variantId: string): UniversePreviewState | null {
  const entry = registry.get(variantId);
  return entry ? { ...entry.state, logTail: [...entry.state.logTail] } : null;
}

/** Test-only: stop every tracked preview process without touching disk state. */
export async function stopAllPreviewsForTests(): Promise<void> {
  await Promise.all([...registry.keys()].map((id) => stopPreview(id)));
}
