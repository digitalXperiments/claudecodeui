#!/usr/bin/env node
/**
 * Compile the server into a staging directory, then atomically swap it over
 * `dist-server`. LaunchAgent runs `dist-server/server/cli.js` with KeepAlive;
 * the previous `prebuild:server` `rmSync(dist-server)` deleted those files
 * from under the live process and flapped the job (orphaned runs + JWT races).
 *
 * Staging + rename leaves the running process on the old inode until a single
 * planned restart.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'dist-server');
const staging = path.join(root, 'dist-server.next');
const previous = path.join(root, 'dist-server.prev');
const ENTRY = 'server/index.js';
const mode = process.argv[2] ?? 'promote';

if (mode === 'recover') {
  // Ran before every packaged server start: if a promotion was interrupted
  // between the two renames, put the previous build back so the server can boot.
  if (!fs.existsSync(path.join(dest, ENTRY)) && fs.existsSync(path.join(previous, ENTRY))) {
    console.error('build-server: restoring previous dist-server after an interrupted promotion.');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(previous, dest);
  }
  process.exit(0);
}

if (mode !== 'promote') {
  console.error(`build-server: unknown mode "${mode}" (expected "promote" or "recover").`);
  process.exit(64);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

rm(staging);
run('npx', ['tsc', '-p', 'server/tsconfig.json', '--outDir', 'dist-server.next']);
run('npx', ['tsc-alias', '-p', 'server/tsconfig.json', '--outDir', 'dist-server.next']);

// TypeScript does not emit non-code assets. Agent Relay installs this managed
// skill at runtime, including in the source-free local-server bundle, so keep
// its Markdown/YAML payload beside the compiled service.
fs.cpSync(
  path.join(root, 'server', 'modules', 'agent-relay', 'skill'),
  path.join(staging, 'server', 'modules', 'agent-relay', 'skill'),
  { recursive: true },
);

rm(previous);
if (fs.existsSync(dest)) {
  fs.renameSync(dest, previous);
}
try {
  fs.renameSync(staging, dest);
} catch (error) {
  if (fs.existsSync(previous) && !fs.existsSync(dest)) {
    fs.renameSync(previous, dest);
  }
  throw error;
}
rm(previous);
