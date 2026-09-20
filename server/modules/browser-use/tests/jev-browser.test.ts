import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { assessPageState, browserPageStateEnabled } from '@/modules/browser-use/jev-browser.service.js';
import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  configureJevTransport,
  updateJevSettings,
  type JevRequest,
} from '@/modules/decisioning/index.js';
import { makeScratchDir } from '@/shared/scratch.js';

/** Records every request and answers with a fixed Jev response. */
function stubTransport(answers: Record<string, unknown>): { bodies: JevRequest[] } {
  const bodies: JevRequest[] = [];
  configureJevTransport(async ({ body }) => {
    bodies.push(body);
    return { model: 'jev-latest', answers } as never;
  });
  return { bodies };
}

async function withDatabase(run: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousKey = process.env.TYPESAFE_API_KEY;
  const root = await makeScratchDir('jev-browser-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.TYPESAFE_API_KEY = 'test-key';
  await initializeDatabase();
  await mkdir(path.join(root, 'work'), { recursive: true });
  try {
    await run();
  } finally {
    configureJevTransport(null);
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
}

const INPUT = {
  action: 'click',
  url: 'https://example.com/checkout',
  title: 'Checkout',
  text: 'Loading your basket…',
  previousText: 'Basket',
};

test('the browser sidecar is inert until its capability is switched on', async () => {
  await withDatabase(async () => {
    const stub = stubTransport({ verdict: { choice: 'ready', confidence: 1 } });

    assert.equal(browserPageStateEnabled(), false);
    assert.equal(await assessPageState(INPUT), null);

    updateJevSettings({ enabled: true, capabilities: { browser_page_state: 'shadow' } });
    assert.equal(browserPageStateEnabled(), true);

    // Master switch off must still disable it, whatever the capability says.
    updateJevSettings({ enabled: false });
    assert.equal(browserPageStateEnabled(), false);
    assert.equal(await assessPageState(INPUT), null);

    assert.equal(stub.bodies.length, 0, 'nothing may be sent while the capability is off');
  });
});

test('a page state comes back with the action-effect signal attached', async () => {
  await withDatabase(async () => {
    const stub = stubTransport({
      verdict: { choice: 'loading', confidence: 0.93 },
      action_took_effect: { noul: 0.88 },
    });
    updateJevSettings({ enabled: true, capabilities: { browser_page_state: 'shadow' } });

    const result = await assessPageState(INPUT);
    assert.equal(result?.state, 'loading');
    assert.equal(result?.confidence, 0.93);
    assert.equal(result?.actionTookEffect, 0.88);
    assert.equal(result?.error, null);

    // The state must carry what just ran and both page texts, so "did anything
    // change" is answerable — and must stay far smaller than a full snapshot.
    const [body] = stub.bodies;
    const state = JSON.parse(body.state) as Record<string, unknown>;
    assert.equal(state.justRan, 'click');
    assert.equal(state.pageTextBefore, 'Basket');
    assert.ok(body.state.length < 6_000, 'the state must stay far below a 30k snapshot');
    assert.deepEqual(Object.keys(body.questions).sort(), ['action_took_effect', 'verdict']);
  });
});

test('an unreachable or nonsensical Jev never blocks the browser tool', async () => {
  await withDatabase(async () => {
    updateJevSettings({ enabled: true, capabilities: { browser_page_state: 'shadow' } });

    configureJevTransport(async () => { throw new Error('ETIMEDOUT'); });
    const failed = await assessPageState(INPUT);
    assert.equal(failed?.state, 'ready', 'the fallback must be the neutral verdict');
    assert.match(failed?.error ?? '', /ETIMEDOUT/);

    // A verdict outside the enumerated set is discarded the same way.
    stubTransport({ verdict: { choice: 'exploded', confidence: 1 } });
    const illegal = await assessPageState(INPUT);
    assert.equal(illegal?.state, 'ready');
    assert.match(illegal?.error ?? '', /no legal verdict/);
  });
});

test('long page text is clipped rather than sent whole', async () => {
  await withDatabase(async () => {
    const stub = stubTransport({ verdict: { choice: 'ready', confidence: 1 } });
    updateJevSettings({ enabled: true, capabilities: { browser_page_state: 'shadow' } });

    await assessPageState({ ...INPUT, text: 'x'.repeat(40_000), previousText: 'y'.repeat(40_000) });
    const state = JSON.parse(stub.bodies[0].state) as { pageTextNow: string; pageTextBefore: string };
    assert.ok(state.pageTextNow.length < 4_200, 'current page text is clipped');
    assert.ok(state.pageTextBefore.length < 700, 'previous page text is clipped harder');
  });
});
