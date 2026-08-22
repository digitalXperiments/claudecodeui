import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  buildGenerationPrompt,
  setStudioGenerateFn,
} from '@/modules/studio/studio.generate.js';
import studioRoutes from '@/modules/studio/studio.routes.js';
import {
  buildIdeatePrompt,
  designStudioRoster,
  promotePrototypeFromWorkspace,
  studioService,
  waitForStudioGeneration,
} from '@/modules/studio/studio.service.js';
import {
  HANDOFF_FILE,
  HTML_FILE,
  MANIFEST,
  NOTES_FILE,
  readManifest,
  setStudioWriteUtf8Fn,
  STUDIO_DIR,
  writeManifest,
  writeUtf8Atomic,
} from '@/modules/studio/studio.storage.js';
import { DEFAULT_STUDIO_TOKENS } from '@/modules/studio/studio.tokens.js';
import type { StudioGenerateRequest, StudioPrototypeDetail } from '@/modules/studio/studio.types.js';
import { makeScratchDir } from '@/shared/scratch.js';
import { AppError } from '@/shared/utils.js';

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
    setStudioGenerateFn(null);
    setStudioWriteUtf8Fn(null);
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function installFakeGenerate(): StudioGenerateRequest[] {
  const calls: StudioGenerateRequest[] = [];
  setStudioGenerateFn(async (input) => {
    calls.push(input);
    const selected = input.selectedElement?.tag ? ` data-selected="${input.selectedElement.tag}"` : '';
    const direction = input.variantDirection ? ` data-variant="${input.variantDirection.label}"` : '';
    return {
      html: [
        '<!doctype html><html><body',
        selected,
        direction,
        `><!-- edit:${input.message} -->`,
        `<span data-accent="${input.tokens.colors.accent}"></span>`,
        input.parentHtml,
        '</body></html>',
      ].join(''),
      notes: `Notes: ${input.message}`,
      handoff: `Handoff: ${input.message}`,
    };
  });
  return calls;
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
    assert.equal(proto.versions.length, 1);
    assert.equal(proto.versions[0].kind, 'initial');
    assert.equal(proto.activeVersionId, proto.versions[0].id);
    assert.ok(proto.tokens.colors.accent);
    const listed = await studioService.list(projectId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].activeVersionId, proto.activeVersionId);
    const prompt = buildIdeatePrompt(proto);
    assert.match(prompt, /prototype\.html/);
    assert.match(prompt, /clickable-prototype/);
    assert.match(prompt, /tokens\.json/);
  });
});

test('legacy flat prototypes migrate to v2 without disappearing', async () => {
  await withTempDb(async (projectId, workspace) => {
    const id = 'proto_legacy';
    const dir = path.join(workspace, STUDIO_DIR, id);
    const relativeDir = path.join(STUDIO_DIR, id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, MANIFEST), `${JSON.stringify({
      id,
      projectId,
      title: 'Legacy prototype',
      brief: 'Keep this prototype visible',
      skills: ['brand-voice'],
      status: 'ready',
      relativeDir,
      htmlRelativePath: path.join(relativeDir, HTML_FILE),
      notesRelativePath: path.join(relativeDir, NOTES_FILE),
      handoffRelativePath: path.join(relativeDir, HANDOFF_FILE),
      swarmId: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T11:00:00.000Z',
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(dir, HTML_FILE), '<!doctype html><html><body>legacy page</body></html>', 'utf8');
    await writeFile(path.join(dir, NOTES_FILE), '# Legacy notes', 'utf8');
    await writeFile(path.join(dir, HANDOFF_FILE), '# Legacy handoff', 'utf8');

    const listed = await studioService.list(projectId);
    assert.equal(listed.some((item) => item.id === id), true);
    const migrated = await studioService.get(projectId, id);
    assert.equal(migrated.format, 'cloudcli.studio.v2');
    assert.equal(migrated.versions.length, 1);
    assert.equal(migrated.activeVersion.kind, 'initial');
    assert.match(migrated.html, /legacy page/);
    assert.equal((await readManifest(dir))?.activeVersionId, migrated.activeVersionId);
  });
});

test('interrupted generation becomes retryable after restart recovery', async () => {
  await withTempDb(async (projectId, workspace) => {
    const proto = await studioService.create({ projectId, brief: 'Recovery test' });
    const dir = path.join(workspace, STUDIO_DIR, proto.id);
    const manifest = await readManifest(dir);
    assert.ok(manifest);
    await writeManifest(dir, {
      ...manifest,
      status: 'generating',
      generation: {
        kind: 'turn',
        startedAt: '2026-08-01T10:00:00.000Z',
        message: 'Interrupted edit',
        error: null,
      },
    });

    const recovered = await studioService.get(projectId, proto.id);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.generation?.error ?? '', /server restart/i);

    installFakeGenerate();
    await studioService.appendTurn(projectId, proto.id, { message: 'Retry safely' });
    await waitForStudioGeneration(projectId, proto.id);
    assert.equal((await studioService.get(projectId, proto.id)).status, 'ready');
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
    assert.ok(updated.versions.length >= 2);
    assert.equal(updated.activeVersion.html.includes('PondPilot'), true);
  });
});

test('update replaces html and remove deletes the folder', async () => {
  await withTempDb(async (projectId) => {
    const proto = await studioService.create({ projectId, brief: 'Notes app' });
    const updated = await studioService.update(projectId, proto.id, {
      html: '<html><body>Hello</body></html>',
    });
    assert.match(updated.html, /Hello/);
    assert.ok(updated.versions.length >= 2);
    await studioService.remove(projectId, proto.id);
    const listed = await studioService.list(projectId);
    assert.equal(listed.length, 0);
  });
});

test('append turn links parent and moves the active version', async () => {
  await withTempDb(async (projectId, workspace) => {
    const calls = installFakeGenerate();
    const proto = await studioService.create({ projectId, brief: 'Loyalty punch card' });
    const initialId = proto.activeVersionId;

    await studioService.appendTurn(projectId, proto.id, { message: 'Make the hero darker' });
    await waitForStudioGeneration(projectId, proto.id);
    const afterFirst = await studioService.get(projectId, proto.id);
    assert.equal(afterFirst.status, 'ready');
    const turn1 = afterFirst.versions.find((version) => version.id === afterFirst.activeVersionId);
    assert.equal(turn1?.kind, 'turn');
    assert.equal(turn1?.parentVersionId, initialId);
    assert.match(afterFirst.html, /Make the hero darker/);
    assert.match(afterFirst.html, /data-go="signup"/);
    assert.equal(calls[0]?.parentHtml.includes('data-go="signup"'), true);
    assert.equal(calls[0]?.projectPath, workspace);

    await studioService.appendTurn(projectId, proto.id, {
      message: 'Enlarge the primary CTA',
      selectedElement: { tag: 'button', classes: ['primary'], text: 'See how it works', path: 'header > nav > button.primary' },
    });
    await waitForStudioGeneration(projectId, proto.id);
    const afterSecond = await studioService.get(projectId, proto.id);
    const turn2 = afterSecond.versions.find((version) => version.id === afterSecond.activeVersionId);
    assert.equal(turn2?.parentVersionId, turn1?.id);
    assert.match(afterSecond.html, /Enlarge the primary CTA/);
    assert.match(afterSecond.html, /Make the hero darker/);
    assert.equal(calls[1]?.selectedElement?.tag, 'button');
    assert.match(buildGenerationPrompt(calls[1]), /EDIT to the parent HTML/i);
    assert.match(buildGenerationPrompt(calls[1]), /button/);
    assert.match(buildGenerationPrompt(calls[1]), /Design tokens/);

    await studioService.appendTurn(projectId, proto.id, { message: 'Add a rewards ticker' });
    await waitForStudioGeneration(projectId, proto.id);
    const afterThird = await studioService.get(projectId, proto.id);
    const turn3 = afterThird.versions.find((version) => version.id === afterThird.activeVersionId);
    assert.equal(turn3?.parentVersionId, turn2?.id);
    assert.match(afterThird.html, /Add a rewards ticker/);
    assert.match(afterThird.html, /Enlarge the primary CTA/);
    assert.equal(calls[2]?.parentHtml.includes('Enlarge the primary CTA'), true);
    assert.match(buildGenerationPrompt(calls[2]), /Enlarge the primary CTA/);
    assert.match(buildGenerationPrompt(calls[2]), /EDIT to the parent HTML/i);
    assert.match(buildGenerationPrompt(calls[2]), /<!doctype html>/i);
  });
});

test('variant generate then promote becomes the next turn parent', async () => {
  await withTempDb(async (projectId) => {
    const calls = installFakeGenerate();
    const proto = await studioService.create({ projectId, brief: 'Farm dashboard' });

    await studioService.appendTurn(projectId, proto.id, { message: 'Add a ponds table' });
    await waitForStudioGeneration(projectId, proto.id);
    const turned = await studioService.get(projectId, proto.id);

    await studioService.generateVariants(projectId, proto.id, { count: 3, message: 'Try three visual directions' });
    await waitForStudioGeneration(projectId, proto.id);
    const withVariants = await studioService.get(projectId, proto.id);
    assert.equal(withVariants.activeVersionId, turned.activeVersionId);
    assert.equal(withVariants.variants.length, 3);
    const labels = new Set(withVariants.variants.map((variant) => variant.label));
    assert.equal(labels.size, 3);
    assert.ok(withVariants.variants.every((variant) => variant.html.includes('data-variant=')));
    assert.ok(calls.some((call) => call.variantDirection?.label === 'Warm editorial'));

    const picked = withVariants.variants[1];
    const promoted = await studioService.promoteVariant(projectId, proto.id, picked.id);
    assert.equal(promoted.activeVersion.kind, 'variant-promotion');
    assert.equal(promoted.activeVersion.parentVersionId, turned.activeVersionId);
    assert.equal(promoted.activeVersion.promotedFromVariantId, picked.id);
    assert.equal(promoted.html, picked.html);

    await studioService.appendTurn(projectId, proto.id, { message: 'Tighten the table spacing' });
    await waitForStudioGeneration(projectId, proto.id);
    const next = await studioService.get(projectId, proto.id);
    assert.equal(next.activeVersion.parentVersionId, promoted.activeVersionId);
    assert.match(next.html, /Tighten the table spacing/);
    assert.match(next.html, /data-variant=/);
    const lastCall = calls[calls.length - 1];
    assert.match(lastCall.parentHtml, /data-variant=/);
  });
});

test('revert restores preview and becomes parent of the next turn', async () => {
  await withTempDb(async (projectId) => {
    installFakeGenerate();
    const proto = await studioService.create({ projectId, brief: 'Notes app home' });
    const initial = proto.activeVersion;

    await studioService.appendTurn(projectId, proto.id, { message: 'Add a sidebar' });
    await waitForStudioGeneration(projectId, proto.id);
    await studioService.appendTurn(projectId, proto.id, { message: 'Add a trash can' });
    await waitForStudioGeneration(projectId, proto.id);
    const latest = await studioService.get(projectId, proto.id);
    assert.match(latest.html, /Add a trash can/);

    const reverted = await studioService.revertToVersion(projectId, proto.id, initial.id);
    assert.equal(reverted.activeVersion.kind, 'revert');
    assert.equal(reverted.activeVersion.parentVersionId, initial.id);
    assert.equal(reverted.activeVersion.revertedFromVersionId, initial.id);
    assert.equal(reverted.html, initial.html);

    await studioService.appendTurn(projectId, proto.id, { message: 'Use a split inbox' });
    await waitForStudioGeneration(projectId, proto.id);
    const next = await studioService.get(projectId, proto.id);
    assert.equal(next.activeVersion.parentVersionId, reverted.activeVersionId);
    assert.match(next.html, /Use a split inbox/);
    assert.equal(next.html.includes(initial.html), true);
  });
});

test('token read/write persists and regenerate honors the new tokens', async () => {
  await withTempDb(async (projectId) => {
    const calls = installFakeGenerate();
    const proto = await studioService.create({ projectId, brief: 'Invoice tracker' });
    const original = await studioService.getTokens(projectId, proto.id);
    assert.equal(original.colors.accent, proto.tokens.colors.accent);

    const persisted = await studioService.updateTokens(projectId, proto.id, {
      tokens: { colors: { accent: '#112233' } },
      regenerate: false,
    });
    assert.equal(persisted.tokens.colors.accent, '#112233');
    assert.equal(persisted.versions.length, proto.versions.length);

    const reloaded = await studioService.get(projectId, proto.id);
    assert.equal(reloaded.tokens.colors.accent, '#112233');
    assert.equal(reloaded.tokens.typography.fontFamily, original.typography.fontFamily);

    await studioService.updateTokens(projectId, proto.id, {
      tokens: { colors: { accent: '#abcdef' } },
      regenerate: true,
    });
    await waitForStudioGeneration(projectId, proto.id);
    const regenerated = await studioService.get(projectId, proto.id);
    assert.equal(regenerated.tokens.colors.accent, '#abcdef');
    assert.equal(regenerated.status, 'ready');
    assert.match(regenerated.html, /#abcdef/);
    assert.match(regenerated.html, /Apply updated design tokens/);
    assert.equal(calls.at(-1)?.tokens.colors.accent, '#abcdef');
  });
});

test('buildGenerationPrompt frames refinements as edits with tokens and history', () => {
  const prompt = buildGenerationPrompt({
    projectPath: '/workspace/project',
    brief: 'Coffee loyalty',
    title: 'Punch',
    message: 'Darken the header',
    history: [
      { kind: 'initial', message: 'Coffee loyalty' },
      { kind: 'turn', message: 'Darken the header' },
    ],
    tokens: {
      ...DEFAULT_STUDIO_TOKENS,
      colors: { ...DEFAULT_STUDIO_TOKENS.colors, accent: '#ff00aa' },
    },
    parentHtml: '<html><body><h1>Keep me</h1></body></html>',
    parentNotes: 'notes',
    parentHandoff: 'handoff',
    selectedElement: { tag: 'h1', path: 'body > h1', text: 'Keep me' },
    skills: ['brand-voice'],
  });
  assert.match(prompt, /do not regenerate from zero/i);
  assert.match(prompt, /EDIT to the parent HTML/i);
  assert.match(prompt, /#ff00aa/);
  assert.match(prompt, /Keep me/);
  assert.match(prompt, /Darken the header/);
  assert.match(prompt, /tag: h1/);
  assert.match(prompt, /brand-voice/);
});

function installGatedGenerate(): {
  calls: StudioGenerateRequest[];
  release: () => void;
  generateCount: () => number;
} {
  const calls: StudioGenerateRequest[] = [];
  let generateCount = 0;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setStudioGenerateFn(async (input) => {
    generateCount += 1;
    calls.push(input);
    await gate;
    return {
      html: `<html><body><!-- edit:${input.message} -->${input.parentHtml}</body></html>`,
      notes: `Notes: ${input.message}`,
      handoff: `Handoff: ${input.message}`,
    };
  });
  return {
    calls,
    release,
    generateCount: () => generateCount,
  };
}

async function withStudioRoutes(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/studio', studioRoutes);
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const anyErr = err as { statusCode?: number; code?: string; message?: string };
      res.status(anyErr.statusCode ?? 500).json({
        success: false,
        error: { code: anyErr.code ?? 'INTERNAL_ERROR', message: anyErr.message },
      });
    },
  );
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}/api/studio`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

type StudioApiBody = {
  success?: boolean;
  prototype?: StudioPrototypeDetail;
  prototypes?: Array<{ id: string }>;
  tokens?: { colors?: { accent?: string } };
  error?: { code?: string; message?: string };
};

async function studioFetch(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: StudioApiBody }> {
  const response = await fetch(url, init);
  return { status: response.status, body: (await response.json()) as StudioApiBody };
}

test('mid-commit artifact write failure leaves the prior active version loadable', async () => {
  await withTempDb(async (projectId, workspace) => {
    const proto = await studioService.create({ projectId, brief: 'Notes app home' });
    const dir = path.join(workspace, STUDIO_DIR, proto.id);
    const rootHtml = path.join(dir, HTML_FILE);

    setStudioWriteUtf8Fn(async (filePath, content) => {
      if (path.resolve(filePath) === path.resolve(rootHtml)) {
        throw new Error('simulated artifact write failure');
      }
      await writeUtf8Atomic(filePath, content);
    });

    await assert.rejects(
      () => studioService.update(projectId, proto.id, {
        html: '<html><body>Should not commit</body></html>',
      }),
      /simulated artifact write failure/,
    );

    const manifest = await readManifest(dir);
    assert.equal(manifest?.activeVersionId, proto.activeVersionId);
    assert.equal(manifest?.status, 'ready');
    const loaded = await studioService.get(projectId, proto.id);
    assert.equal(loaded.activeVersionId, proto.activeVersionId);
    assert.equal(loaded.html, proto.html);
    assert.doesNotMatch(loaded.html, /Should not commit/);
  });
});

test('concurrent refine and variant calls reject the second instead of interleaving', async () => {
  await withTempDb(async (projectId) => {
    const gated = installGatedGenerate();
    const proto = await studioService.create({ projectId, brief: 'Loyalty punch card' });

    const refineResults = await Promise.allSettled([
      studioService.appendTurn(projectId, proto.id, { message: 'Darken the hero' }),
      studioService.appendTurn(projectId, proto.id, { message: 'Lighten the hero' }),
    ]);
    const refineFulfilled = refineResults.filter((result) => result.status === 'fulfilled');
    const refineRejected = refineResults.filter((result) => result.status === 'rejected');
    assert.equal(refineFulfilled.length, 1);
    assert.equal(refineRejected.length, 1);
    const refineError = (refineRejected[0] as PromiseRejectedResult).reason;
    assert.equal(refineError instanceof AppError, true);
    assert.equal((refineError as AppError).code, 'STUDIO_BUSY');
    assert.equal(gated.generateCount(), 1);
    gated.release();
    await waitForStudioGeneration(projectId, proto.id);
    const afterRefine = await studioService.get(projectId, proto.id);
    assert.equal(afterRefine.status, 'ready');
    assert.equal(afterRefine.versions.filter((version) => version.kind === 'turn').length, 1);

    const variantsGated = installGatedGenerate();
    const variantResults = await Promise.allSettled([
      studioService.generateVariants(projectId, proto.id, { count: 2, message: 'Two looks' }),
      studioService.generateVariants(projectId, proto.id, { count: 2, message: 'Other looks' }),
    ]);
    const variantFulfilled = variantResults.filter((result) => result.status === 'fulfilled');
    const variantRejected = variantResults.filter((result) => result.status === 'rejected');
    assert.equal(variantFulfilled.length, 1);
    assert.equal(variantRejected.length, 1);
    const variantError = (variantRejected[0] as PromiseRejectedResult).reason;
    assert.equal((variantError as AppError).code, 'STUDIO_BUSY');
    assert.equal(variantsGated.generateCount(), 1);
    variantsGated.release();
    await waitForStudioGeneration(projectId, proto.id);
    const afterVariants = await studioService.get(projectId, proto.id);
    assert.equal(afterVariants.status, 'ready');
    assert.equal(afterVariants.variants.length, 2);
    assert.equal(variantsGated.generateCount(), 2);
  });
});

test('studio HTTP routes cover create, list/get, refine, variants, promote, revert, tokens, poll, errors', async () => {
  await withTempDb(async (projectId) => {
    installFakeGenerate();
    await withStudioRoutes(async (baseUrl) => {
      const created = await studioFetch(`${baseUrl}/${projectId}/prototypes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief: 'Loyalty punch card' }),
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.success, true);
      const id = created.body.prototype?.id;
      assert.ok(id);
      const initialVersionId = created.body.prototype?.activeVersionId;
      assert.ok(initialVersionId);

      const listed = await studioFetch(`${baseUrl}/${projectId}/prototypes`);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.prototypes?.length, 1);
      assert.equal(listed.body.prototypes?.[0]?.id, id);

      const fetched = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}`);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.prototype?.id, id);
      assert.equal(fetched.body.prototype?.status, 'ready');

      const missing = await studioFetch(`${baseUrl}/${projectId}/prototypes/proto_missing`);
      assert.equal(missing.status, 404);
      assert.equal(missing.body.success, false);
      assert.equal(missing.body.error?.code, 'STUDIO_NOT_FOUND');

      const turn = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Darken the hero' }),
      });
      assert.equal(turn.status, 202);
      assert.equal(turn.body.prototype?.status, 'generating');
      assert.equal(turn.body.prototype?.generation?.kind, 'turn');

      const polling = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}`);
      assert.equal(polling.status, 200);
      assert.ok(
        polling.body.prototype?.status === 'generating'
        || polling.body.prototype?.status === 'ready',
      );
      if (polling.body.prototype?.status === 'generating') {
        assert.equal(polling.body.prototype.generation?.kind, 'turn');
      }

      await waitForStudioGeneration(projectId, id);
      const ready = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}`);
      assert.equal(ready.status, 200);
      assert.equal(ready.body.prototype?.status, 'ready');
      assert.match(ready.body.prototype?.html ?? '', /Darken the hero/);

      const variants = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}/variants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: 2, message: 'Try two looks' }),
      });
      assert.equal(variants.status, 202);
      assert.equal(variants.body.prototype?.status, 'generating');
      await waitForStudioGeneration(projectId, id);
      const withVariants = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}`);
      assert.equal(withVariants.body.prototype?.variants?.length, 2);
      const variantId = withVariants.body.prototype?.variants?.[0]?.id;
      assert.ok(variantId);

      const promoted = await studioFetch(
        `${baseUrl}/${projectId}/prototypes/${id}/variants/${variantId}/promote`,
        { method: 'POST' },
      );
      assert.equal(promoted.status, 201);
      assert.equal(promoted.body.prototype?.activeVersion?.kind, 'variant-promotion');
      assert.equal(promoted.body.prototype?.activeVersion?.promotedFromVariantId, variantId);

      const reverted = await studioFetch(
        `${baseUrl}/${projectId}/prototypes/${id}/versions/${initialVersionId}/revert`,
        { method: 'POST' },
      );
      assert.equal(reverted.status, 200);
      assert.equal(reverted.body.prototype?.activeVersion?.kind, 'revert');
      assert.equal(reverted.body.prototype?.activeVersion?.revertedFromVersionId, initialVersionId);

      const tokensGet = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}/tokens`);
      assert.equal(tokensGet.status, 200);
      assert.ok(tokensGet.body.tokens?.colors?.accent);

      const tokensPut = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}/tokens`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tokens: { colors: { accent: '#112233' } },
          regenerate: false,
        }),
      });
      assert.equal(tokensPut.status, 200);
      assert.equal(tokensPut.body.tokens?.colors?.accent, '#112233');
      assert.equal(tokensPut.body.prototype?.status, 'ready');

      const tokensRegen = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}/tokens`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tokens: { colors: { accent: '#abcdef' } },
          regenerate: true,
        }),
      });
      assert.equal(tokensRegen.status, 202);
      assert.equal(tokensRegen.body.prototype?.status, 'generating');
      await waitForStudioGeneration(projectId, id);
      const afterTokens = await studioFetch(`${baseUrl}/${projectId}/prototypes/${id}`);
      assert.equal(afterTokens.body.prototype?.tokens.colors.accent, '#abcdef');
      assert.equal(afterTokens.body.prototype?.status, 'ready');
    });
  });
});

test('studio HTTP busy path returns 409 while a turn is generating', async () => {
  await withTempDb(async (projectId) => {
    const gated = installGatedGenerate();
    const proto = await studioService.create({ projectId, brief: 'Notes app' });
    await withStudioRoutes(async (baseUrl) => {
      const first = studioFetch(`${baseUrl}/${projectId}/prototypes/${proto.id}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Add a sidebar' }),
      });
      const second = studioFetch(`${baseUrl}/${projectId}/prototypes/${proto.id}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Add a footer' }),
      });
      const [a, b] = await Promise.all([first, second]);
      const statuses = [a.status, b.status].sort((left, right) => left - right);
      assert.deepEqual(statuses, [202, 409]);
      const busy = a.status === 409 ? a : b;
      const accepted = a.status === 202 ? a : b;
      assert.equal(busy.body.error?.code, 'STUDIO_BUSY');
      assert.equal(accepted.body.prototype?.status, 'generating');

      const poll = await studioFetch(`${baseUrl}/${projectId}/prototypes/${proto.id}`);
      assert.equal(poll.status, 200);
      assert.equal(poll.body.prototype?.status, 'generating');
      assert.equal(poll.body.prototype?.generation?.kind, 'turn');
    });
    gated.release();
    await waitForStudioGeneration(projectId, proto.id);
  });
});
