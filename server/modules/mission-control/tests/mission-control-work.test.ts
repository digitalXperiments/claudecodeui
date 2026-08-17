import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { makeScratchDir } from '@/shared/scratch.js';
import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  buildWorkThisPrompt,
  matchProjectsForItem,
} from '@/modules/mission-control/mission-control-work.service.js';
import type { McItem } from '@/modules/mission-control/mission-control.types.js';

async function withTempDb(fn: () => Promise<void> | void): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await makeScratchDir('mc-work-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    await fn();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeItem(body: Record<string, unknown>, title = 'Draft'): McItem {
  return {
    item_id: 'item_1',
    section_id: 'sec_1',
    status: 'pending',
    title,
    summary: 'summary',
    body,
    source: {},
    actions: [],
    confidence: 0.8,
    provider: 'grok',
    model: 'grok-4.6',
    dedupe_key: 'k',
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    resolved_at: null,
  };
}

test('matchProjectsForItem prefers suggestedProjectPath', async () => {
  await withTempDb(() => {
    const created = projectsDb.createProjectPath('/Users/test/Work/Leong_Associates/Palo_Alto', 'Palo Alto');
    assert.ok(created.project);
    const matches = matchProjectsForItem(
      fakeItem({ suggestedProjectPath: '/Users/test/Work/Leong_Associates/Palo_Alto' }),
      null,
    );
    assert.equal(matches[0]?.projectPath, '/Users/test/Work/Leong_Associates/Palo_Alto');
    assert.equal(matches[0]?.reason, 'suggestedProjectPath');
  });
});

test('matchProjectsForItem uses a Jira ticket prefix', async () => {
  await withTempDb(() => {
    projectsDb.createProjectPath('/Users/test/Work/Eyewa/DE-Warehouse', 'DE-Warehouse');
    projectsDb.createProjectPath('/Users/test/Work/Unrelated', 'Unrelated');
    const matches = matchProjectsForItem(
      fakeItem({ ticket: 'DE-1512' }, 'Review DE-1512'),
      null,
    );
    assert.equal(matches[0]?.name, 'DE-Warehouse');
  });
});

test('buildWorkThisPrompt includes ticket and brief', () => {
  const prompt = buildWorkThisPrompt(
    fakeItem({
      ticket: 'DE-9',
      prompt: 'Ship the inventory fix',
      url: 'https://example.test/DE-9',
    }, 'Inventory'),
    { title: 'Jira Drafts' } as never,
  );
  assert.match(prompt, /Jira Drafts/);
  assert.match(prompt, /DE-9/);
  assert.match(prompt, /Ship the inventory fix/);
});
