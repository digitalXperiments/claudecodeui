#!/usr/bin/env node
/**
 * Launch the isolated dev stack (throwaway DB + preferred ports).
 *
 * Preferred ports: SERVER_PORT=3002, VITE_PORT=5174 (alongside normal 3001/5173).
 * When another worktree or process already holds a preferred port, scan upward
 * for a free one instead of crashing with EADDRINUSE and taking down Vite via
 * concurrently --kill-others (which surfaces as ERR_EMPTY_RESPONSE /
 * ERR_CONNECTION_REFUSED during first-page validation).
 *
 * Env overrides:
 *   DATABASE_PATH, SERVER_PORT, VITE_PORT, HOST
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PREFERRED_SERVER_PORT = 3002;
const PREFERRED_VITE_PORT = 5174;
const SCAN_WINDOW = 30;

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    // Match server bind: 0.0.0.0 so we detect conflicts on all interfaces
    server.listen(port, '0.0.0.0');
  });
}

async function findFreePort(preferred, label) {
  const start = Number.parseInt(String(preferred), 10);
  if (!Number.isFinite(start) || start <= 0) {
    throw new Error(`Invalid ${label}: ${preferred}`);
  }
  for (let port = start; port < start + SCAN_WINDOW; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) {
      if (port !== start) {
        console.warn(
          `[dev:isolated] ${label}=${start} is in use; using ${port} instead`,
        );
      }
      return port;
    }
  }
  throw new Error(
    `[dev:isolated] No free port for ${label} in range ${start}–${start + SCAN_WINDOW - 1}`,
  );
}

async function main() {
  const requestedServer =
    process.env.SERVER_PORT || String(PREFERRED_SERVER_PORT);
  const requestedVite = process.env.VITE_PORT || String(PREFERRED_VITE_PORT);

  const serverPort = await findFreePort(requestedServer, 'SERVER_PORT');
  const vitePort = await findFreePort(requestedVite, 'VITE_PORT');

  // Prefer explicit DATABASE_PATH (package.json cross-env sets the throwaway
  // tmp/cloudcli/dev-db/auth.db). Never fall back to a bare process env that
  // might point at the real ~/.cloudcli/auth.db from a parent swarm shell.
  const databasePath =
    process.env.DATABASE_PATH &&
    !process.env.DATABASE_PATH.includes(`${path.sep}.cloudcli${path.sep}auth.db`)
      ? process.env.DATABASE_PATH
      : 'tmp/cloudcli/dev-db/auth.db';

  const env = {
    ...process.env,
    DATABASE_PATH: databasePath,
    SERVER_PORT: String(serverPort),
    VITE_PORT: String(vitePort),
  };

  console.log(
    `[dev:isolated] DATABASE_PATH=${env.DATABASE_PATH} SERVER_PORT=${serverPort} VITE_PORT=${vitePort}`,
  );
  console.log(
    `[dev:isolated] UI: http://127.0.0.1:${vitePort}/  (API proxy → :${serverPort})`,
  );

  // Use npx/local concurrently the same way package.json scripts do.
  const child = spawn(
    'npx',
    [
      'concurrently',
      '--kill-others',
      '--names',
      'server,client',
      '-c',
      'blue,green',
      'npm run server:dev',
      'npm run client',
    ],
    {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );

  const shutdown = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
