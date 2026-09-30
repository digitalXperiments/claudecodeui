import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/mission-control.repository.js';
import {
  normalizeTrelloDraftFields,
  pickCanonicalTrelloId,
  shortLinkFromTrelloUrl,
} from '@/modules/mission-control/trello-dedupe.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'trello-dedupe-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('normalize prefers full id over shortLink', () => {
  const n = normalizeTrelloDraftFields({
    dedupeKey: 'trello:card:qRPZkLzF',
    body: {
      trelloCardId: '6a4e90ea4a3d62fac5682ab9',
      trelloUrl: 'https://trello.com/c/qRPZkLzF/123-arm',
    },
  });
  assert.equal(n.dedupeKey, 'trello:card:6a4e90ea4a3d62fac5682ab9');
  assert.equal(n.body.trelloCardId, '6a4e90ea4a3d62fac5682ab9');
  assert.equal(n.body.trelloShortLink, 'qRPZkLzF');
  assert.equal(pickCanonicalTrelloId(['qRPZkLzF', '6a4e90ea4a3d62fac5682ab9']), '6a4e90ea4a3d62fac5682ab9');
  assert.equal(shortLinkFromTrelloUrl('https://trello.com/c/qRPZkLzF/foo'), 'qRPZkLzF');
});

test('findItemByTrelloRefs matches shortLink item when full id draft shares URL', async () => {
  await withIsolatedDatabase(async () => {
    const section = missionControlDb.createSection({
      title: 'Trello Tasks',
      mode: 'review',
      provider: 'grok',
      resolve_prompt: '',
    });
    const short = 'ia1CR9R9';
    const full = '6a605d83703921bdf6c17681';
    missionControlDb.insertItemIfNew(section, {
      title: 'Lifetime audit',
      summary: '',
      body: { trelloCardId: short, trelloUrl: `https://trello.com/c/${short}/x` },
      dedupeKey: `trello:card:${short}`,
    });
    const hit = missionControlDb.findItemByTrelloRefs(section.section_id, [
      full,
      short,
      `https://trello.com/c/${short}`,
    ]);
    assert.ok(hit);
    assert.equal(hit.dedupe_key, `trello:card:${short}`);
  });
});
