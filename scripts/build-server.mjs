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

rm(previous);
if (fs.existsSync(dest)) {
  fs.renameSync(dest, previous);
}
fs.renameSync(staging, dest);
rm(previous);
