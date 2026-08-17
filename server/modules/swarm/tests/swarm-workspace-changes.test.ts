import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  captureWorkspaceMutationSnapshot,
  workspaceMutationDetected,
} from '@/modules/swarm/swarm-workspace-changes.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

test('workspace mutation snapshots detect source edits in a non-git sandbox copy', async () => {
  const root = await makeScratchDir('swarm-workspace-change-');
  try {
    const source = path.join(root, 'Sources', 'App.swift');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'let value = 1\n');

    const before = await captureWorkspaceMutationSnapshot(root);
    await writeFile(source, 'let value = 2\n');
    const after = await captureWorkspaceMutationSnapshot(root);

    assert.equal(workspaceMutationDetected(before, after), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace mutation snapshots detect Studio prototype writes under .cloudcli/studio', async () => {
  const root = await makeScratchDir('swarm-workspace-change-');
  try {
    await writeFile(path.join(root, 'README.md'), 'unchanged\n');
    const proto = path.join(root, '.cloudcli', 'studio', 'proto_1', 'prototype.html');
    await mkdir(path.dirname(proto), { recursive: true });
    await writeFile(proto, '<html>draft</html>\n');
    const before = await captureWorkspaceMutationSnapshot(root);
    await writeFile(proto, '<html>real landing page</html>\n');
    const after = await captureWorkspaceMutationSnapshot(root);
    assert.equal(workspaceMutationDetected(before, after), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace mutation snapshots ignore generated build and tmp activity', async () => {
  const root = await makeScratchDir('swarm-workspace-change-');
  try {
    await writeFile(path.join(root, 'README.md'), 'unchanged\n');
    const before = await captureWorkspaceMutationSnapshot(root);

    await mkdir(path.join(root, 'build'), { recursive: true });
    await writeFile(path.join(root, 'build', 'app.bin'), 'generated\n');
    await mkdir(path.join(root, 'tmp', 'cloudcli', 'run'), { recursive: true });
    await writeFile(path.join(root, 'tmp', 'cloudcli', 'run', 'trace.json'), '{}\n');

    const after = await captureWorkspaceMutationSnapshot(root);
    assert.equal(workspaceMutationDetected(before, after), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace mutation snapshots detect added, removed, and mode-changed source files', async () => {
  const root = await makeScratchDir('swarm-workspace-change-');
  try {
    const first = path.join(root, 'first.sh');
    await writeFile(first, '#!/bin/sh\n');
    const baseline = await captureWorkspaceMutationSnapshot(root);

    await writeFile(path.join(root, 'second.txt'), 'new\n');
    assert.equal(
      workspaceMutationDetected(baseline, await captureWorkspaceMutationSnapshot(root)),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
