import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveAcpCliCommand } from '@/shared/acp-cli-path.js';

const makeExecutable = async (filePath: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(filePath, 0o755);
};

const withTempRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'acp-cli-path-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test('resolveAcpCliCommand prefers the PATH match over the installer location', async () => {
  await withTempRoot(async (root) => {
    const pathDir = path.join(root, 'path-bin');
    const homeDir = path.join(root, 'home');
    await makeExecutable(path.join(pathDir, 'kilo'));
    await makeExecutable(path.join(homeDir, '.kilo', 'bin', 'kilo'));

    const resolved = resolveAcpCliCommand('kilo', { pathEnv: pathDir, homedir: homeDir });

    assert.equal(resolved, path.join(pathDir, 'kilo'));
  });
});

test('resolveAcpCliCommand falls back to ~/.kilo/bin when PATH has no kilo', async () => {
  await withTempRoot(async (root) => {
    const pathDir = path.join(root, 'path-bin');
    const homeDir = path.join(root, 'home');
    await mkdir(pathDir, { recursive: true });
    const installed = path.join(homeDir, '.kilo', 'bin', 'kilo');
    await makeExecutable(installed);

    const resolved = resolveAcpCliCommand('kilo', { pathEnv: pathDir, homedir: homeDir });

    assert.equal(resolved, installed);
  });
});

test('resolveAcpCliCommand keeps the bare command when nothing is installed', async () => {
  await withTempRoot(async (root) => {
    const resolved = resolveAcpCliCommand('kilo', {
      pathEnv: path.join(root, 'empty-bin'),
      homedir: path.join(root, 'empty-home'),
    });

    assert.equal(resolved, 'kilo');
  });
});

test('resolveAcpCliCommand leaves explicit paths and Windows commands untouched', async () => {
  await withTempRoot(async (root) => {
    assert.equal(resolveAcpCliCommand('/opt/tools/kilo', { pathEnv: '', homedir: root }), '/opt/tools/kilo');
    assert.equal(resolveAcpCliCommand('kilo', { platform: 'win32', pathEnv: '', homedir: root }), 'kilo');
  });
});
