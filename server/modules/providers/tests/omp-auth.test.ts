import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  OmpProviderAuth,
  probeOmpCredentialDatabase,
} from '@/modules/providers/list/omp/omp-auth.provider.js';
import {
  ompProfileDir,
} from '@/modules/providers/list/omp/omp-paths.js';
import { findOmpSessionFile } from '@/modules/providers/list/omp/omp-sessions.provider.js';
import { makeScratchDir } from '@/shared/scratch.js';

const createCredentialDatabase = (
  databasePath: string,
  disabledCauses: Array<string | null>,
): void => {
  const database = new Database(databasePath);
  try {
    database.exec('CREATE TABLE auth_credentials (disabled_cause TEXT, credential_payload TEXT)');
    const insert = database.prepare('INSERT INTO auth_credentials (disabled_cause, credential_payload) VALUES (?, ?)');
    for (const disabledCause of disabledCauses) {
      insert.run(disabledCause, 'synthetic-test-payload');
    }
  } finally {
    database.close();
  }
};

test('Oh My Pi auth accepts environment and legacy auth paths without exposing identifiers', async () => {
  const root = await makeScratchDir('omp-auth-compat-');
  try {
    const envAuth = await new OmpProviderAuth({
      checkInstalled: () => true,
      env: { OPENAI_API_KEY: 'synthetic-test-key' },
      credentialDbPath: path.join(root, 'missing.db'),
      authPath: path.join(root, 'missing.json'),
    }).getStatus();
    assert.equal(envAuth.authenticated, true);
    assert.equal(envAuth.method, 'api_key_env');

    const legacyPath = path.join(root, 'auth.json');
    await writeFile(legacyPath, JSON.stringify({ provider: { marker: true } }), 'utf8');
    const legacyAuth = await new OmpProviderAuth({
      checkInstalled: () => true,
      env: {},
      credentialDbPath: path.join(root, 'missing.db'),
      authPath: legacyPath,
    }).getStatus();
    assert.equal(legacyAuth.authenticated, true);
    assert.equal(legacyAuth.method, 'auth_file');
    assert.equal(legacyAuth.email, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Oh My Pi SQLite probe distinguishes active, disabled, absent, and malformed stores', async () => {
  const root = await makeScratchDir('omp-auth-probe-');
  try {
    const activePath = path.join(root, 'active.db');
    const disabledPath = path.join(root, 'disabled.db');
    const emptyPath = path.join(root, 'empty.db');
    const malformedPath = path.join(root, 'malformed.db');
    createCredentialDatabase(activePath, [null]);
    createCredentialDatabase(disabledPath, ['revoked']);
    createCredentialDatabase(emptyPath, []);
    await writeFile(malformedPath, 'not a sqlite database', 'utf8');

    assert.equal(probeOmpCredentialDatabase(activePath), 'active');
    assert.equal(probeOmpCredentialDatabase(disabledPath), 'disabled');
    assert.equal(probeOmpCredentialDatabase(emptyPath), 'absent');
    assert.equal(probeOmpCredentialDatabase(path.join(root, 'missing.db')), 'absent');
    assert.equal(probeOmpCredentialDatabase(malformedPath), 'malformed');

    const status = await new OmpProviderAuth({
      checkInstalled: () => true,
      env: {},
      credentialDbPath: activePath,
      authPath: path.join(root, 'missing.json'),
    }).getStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credential_store');
    assert.equal(status.email, null);

    const disabled = await new OmpProviderAuth({
      checkInstalled: () => true,
      env: {},
      credentialDbPath: disabledPath,
      authPath: path.join(root, 'missing.json'),
    }).getStatus();
    assert.equal(disabled.authenticated, false);
    assert.match(disabled.error || '', /all are disabled/i);

    const malformed = await new OmpProviderAuth({
      checkInstalled: () => true,
      env: {},
      credentialDbPath: malformedPath,
      authPath: path.join(root, 'missing.json'),
    }).getStatus();
    assert.equal(malformed.authenticated, false);
    assert.match(malformed.error || '', /credential store is malformed/i);

    const absent = await new OmpProviderAuth({
      checkInstalled: () => true,
      env: {},
      credentialDbPath: path.join(root, 'missing.db'),
      authPath: path.join(root, 'missing.json'),
    }).getStatus();
    assert.equal(absent.authenticated, false);
    assert.match(absent.error || '', /not logged in/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Oh My Pi SQLite probe reports a locked credential store distinctly', async () => {
  const root = await makeScratchDir('omp-auth-locked-');
  const databasePath = path.join(root, 'locked.db');
  createCredentialDatabase(databasePath, [null]);
  const locker = new Database(databasePath);
  try {
    locker.pragma('journal_mode = DELETE');
    locker.exec('BEGIN EXCLUSIVE');
    assert.equal(probeOmpCredentialDatabase(databasePath), 'locked');

    const status = await new OmpProviderAuth({
      checkInstalled: () => true,
      env: {},
      credentialDbPath: databasePath,
      authPath: path.join(root, 'missing.json'),
    }).getStatus();
    assert.equal(status.authenticated, false);
    assert.match(status.error || '', /locked/i);
  } finally {
    try {
      locker.exec('ROLLBACK');
    } catch {
      // The lock may already have been released by SQLite.
    }
    locker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Oh My Pi path resolution honors documented profile variables and ignores OMP_HOME', () => {
  const explicit = ompProfileDir({
    PI_CODING_AGENT_DIR: './tmp/cloudcli/explicit-omp-state',
    OMP_PROFILE: 'ignored-profile',
    OMP_HOME: '/ignored/legacy/home',
  });
  assert.equal(explicit, path.resolve('tmp/cloudcli/explicit-omp-state'));

  const profiled = ompProfileDir({ OMP_PROFILE: 'review', OMP_HOME: '/ignored/legacy/home' });
  assert.equal(profiled, path.join(path.dirname(path.dirname(profiled)), '.omp', 'review'));
  assert.equal(profiled.includes('/ignored/legacy/home'), false);
});

test('Oh My Pi session discovery follows the profile sessions directory layout', async () => {
  const root = await makeScratchDir('omp-session-layout-');
  const projectDir = path.join(root, 'sessions', '--workspace-demo--');
  const sessionFile = path.join(projectDir, '2026-01-01_native-session.jsonl');
  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionFile, '', 'utf8');
    assert.equal(findOmpSessionFile('native-session', path.join(root, 'sessions')), sessionFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
