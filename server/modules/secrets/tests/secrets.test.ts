import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { configureSecretsKeyDir } from '@/modules/secrets/secrets-key.service.js';
import { secretsService } from '@/modules/secrets/secrets.service.js';

async function withDatabase(fn: () => void): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousKey = process.env.CLOUDCLI_SECRETS_KEY;
  const directory = await mkdtemp(path.resolve('tmp/cloudcli/secrets-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'secrets.db');
  process.env.CLOUDCLI_SECRETS_KEY = randomBytes(32).toString('base64');
  configureSecretsKeyDir(path.join(directory, 'key')); 
  await initializeDatabase();
  try {
    fn();
  } finally {
    closeConnection();
    configureSecretsKeyDir(null);
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousKey === undefined) delete process.env.CLOUDCLI_SECRETS_KEY;
    else process.env.CLOUDCLI_SECRETS_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
}

test('vault stores metadata only, resolves refs, deep-resolves objects, and redacts values', async () => {
  await withDatabase(() => {
    const meta = secretsService.put({ name: 'GITHUB_TOKEN', value: 'ghp_super_secret_123', scope: 'user' });
    assert.match(meta.secret_id, /^sec_/);
    assert.equal('ciphertext' in meta, false);
    assert.equal(secretsService.resolve('${secret:GITHUB_TOKEN}'), 'ghp_super_secret_123');
    assert.deepEqual(
      secretsService.resolveInObject({ env: { TOKEN: '${secret:GITHUB_TOKEN}' }, args: ['x'] }),
      { env: { TOKEN: 'ghp_super_secret_123' }, args: ['x'] },
    );
    assert.equal(secretsService.redact('Authorization: Bearer ghp_super_secret_123'), 'Authorization: Bearer ***REDACTED***');
    secretsService.delete(meta.secret_id);
    assert.throws(() => secretsService.resolve(meta.secret_id), /Secret not found/);
  });
});

test('rotating a secret keeps its stable id and retires the previous value', async () => {
  await withDatabase(() => {
    const first = secretsService.put({ name: 'ROTATE_ME', value: 'first-value' });
    const second = secretsService.put({ name: 'ROTATE_ME', value: 'second-value' });
    assert.equal(second.secret_id, first.secret_id);
    assert.equal(secretsService.resolve(first.secret_id), 'second-value');
    assert.match(secretsService.redact('old=first-value new=second-value'), /old=\*\*\*REDACTED\*\*\* new=\*\*\*REDACTED\*\*\*/);
  });
});

