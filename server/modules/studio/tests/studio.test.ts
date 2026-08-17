import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  buildIdeatePrompt,
  designStudioRoster,
  promotePrototypeFromWorkspace,
  studioService,
} from '@/modules/studio/studio.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withTempDb(fn: (projectId: string, root: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('studio-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const created = projectsDb.createProjectPath(workspace);
  const projectId = created.project!.project_id;
  try {
    await fn(projectId, workspace);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('creates a clickable prototype with starter html and skill', async () => {
  await withTempDb(async (projectId) => {
    const proto = await studioService.create({
      projectId,
      brief: 'A coffee shop loyalty app with punch card and rewards.',
      skills: ['brand-voice'],
    });
    assert.match(proto.id, /^proto_/);
    assert.match(proto.html, /data-go="signup"/);
    assert.match(proto.html, /coffee/i);
    assert.ok(proto.notes.includes('coffee shop'));
    assert.equal(proto.skills[0], 'brand-voice');
    const listed = await studioService.list(projectId);
    assert.equal(listed.length, 1);
    const prompt = buildIdeatePrompt(proto);
    assert.match(prompt, /prototype\.html/);
    assert.match(prompt, /clickable-prototype/);
  });
});

test('design roster is architect, builder, reviewer by default', () => {
  const seats = designStudioRoster();
  assert.deepEqual(seats.map((seat) => seat.id), ['architect', 'builder', 'reviewer']);
  assert.deepEqual(seats.map((seat) => seat.kind), ['orchestrator', 'implementer', 'reviewer']);
  assert.equal(seats.find((seat) => seat.id === 'builder')?.permissionMode, 'bypassPermissions');
});

test('studio seats persist through settings', async () => {
  await withTempDb(async () => {
    const saved = studioService.saveSeats([
      {
        id: 'builder',
        provider: 'grok',
        model: 'grok-4-1-fast-reasoning',
        effort: 'high',
        permissionMode: 'bypassPermissions',
      },
    ]);
    const savedBuilder = saved.find((seat) => seat.id === 'builder');
    assert.equal(savedBuilder?.provider, 'grok');
    assert.equal(savedBuilder?.model, 'grok-4-1-fast-reasoning');
    assert.equal(savedBuilder?.effort, 'high');

    const persistedBuilder = studioService.getSeats().find((seat) => seat.id === 'builder');
    assert.equal(persistedBuilder?.provider, 'grok');
    assert.equal(persistedBuilder?.model, 'grok-4-1-fast-reasoning');
    assert.equal(persistedBuilder?.effort, 'high');

    const rosterBuilder = designStudioRoster().find((seat) => seat.id === 'builder');
    assert.equal(rosterBuilder?.model, 'grok-4-1-fast-reasoning');
    assert.equal(rosterBuilder?.effort, 'high');
  });
});

test('promotes swarm worktree prototype over the starter stub', async () => {
  await withTempDb(async (projectId, workspace) => {
    const proto = await studioService.create({
      projectId,
      brief: 'A simple landing page for my business on Prawns farm monitor using IoT & AI',
    });
    assert.match(proto.html, /See how it works/i);

    const worktree = path.join(workspace, '..', 'swarm-worktree');
    const srcDir = path.join(worktree, '.cloudcli', 'studio', proto.id);
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, 'prototype.html'),
      '<!doctype html><html><body><h1>PondPilot</h1><button>Request a walkthrough</button></body></html>',
      'utf8',
    );
    await writeFile(path.join(srcDir, 'notes.md'), 'Real prototype notes', 'utf8');

    const copied = await promotePrototypeFromWorkspace(
      path.join(workspace, '.cloudcli', 'studio', proto.id),
      worktree,
      proto.id,
    );
    assert.equal(copied, true);
    const updated = await studioService.get(projectId, proto.id);
    assert.match(updated.html, /PondPilot/);
    assert.doesNotMatch(updated.html, /See how it works/i);
    assert.match(updated.notes, /Real prototype notes/);
  });
});

test('update replaces html and remove deletes the folder', async () => {
  await withTempDb(async (projectId) => {
    const proto = await studioService.create({ projectId, brief: 'Notes app' });
    const updated = await studioService.update(projectId, proto.id, {
      html: '<html><body>Hello</body></html>',
    });
    assert.match(updated.html, /Hello/);
    await studioService.remove(projectId, proto.id);
    const listed = await studioService.list(projectId);
    assert.equal(listed.length, 0);
  });
});
