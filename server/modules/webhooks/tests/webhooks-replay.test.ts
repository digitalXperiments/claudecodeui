import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { webhooksDb } from '@/modules/webhooks/webhooks.repository.js';
import {
  configureWebhookRuntimes,
  reconstructPayloadFromDelivery,
  startWebhookDelivery,
} from '@/modules/webhooks/webhooks-runner.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

function sendComplete(writer: unknown, exitCode: number): void {
  (writer as { send: (m: AnyRecord) => void }).send({
    kind: 'complete',
    provider: 'claude' as LLMProvider,
    exitCode,
    success: exitCode === 0,
  });
}

test('replay dispatch reuses the delivery row and bumps the attempt', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webhooks-replay-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'webhooks.db');
  await initializeDatabase();

  try {
    const source = webhooksDb.createSource({
      source: 'replay-src',
      name: 'Replay Source',
      retryMax: 2,
      retryBackoffSeconds: 60,
    });
    const delivery = webhooksDb.createDelivery({
      sourceId: source.source_id,
      request: {
        source: 'replay-src',
        title: 'Replay title',
        text: 'replay body',
        hasPayload: true,
        meta: { test: true },
      },
    });
    webhooksDb.markDeliveryFailed(delivery.delivery_id, { errorMessage: 'boom' });

    let ran = false;
    configureWebhookRuntimes({
      claude: async (_content, _options, writer) => {
        ran = true;
        sendComplete(writer, 0);
      },
    });
    chatRunRegistry.clearAll();

    const existing = webhooksDb.getDeliveryById(delivery.delivery_id);
    assert.ok(existing, 'delivery should exist');
    const payload = reconstructPayloadFromDelivery(existing);
    const started = await startWebhookDelivery({
      source,
      payload,
      deliveryId: delivery.delivery_id,
    });

    assert.equal(ran, true, 'runtime should have been dispatched');
    assert.equal(started.deliveryId, delivery.delivery_id, 'reuses the same delivery row');

    const outcome = await started.completion;
    assert.equal(outcome.success, true);

    const after = webhooksDb.getDeliveryById(delivery.delivery_id);
    assert.equal(after?.status, 'done');
    assert.equal(after?.attempt, 2, 'resetDeliveryForReplay bumped the attempt');
    assert.equal(after?.next_retry_at, null);
    assert.equal(after?.error_message, null);
    assert.notEqual(after?.app_session_id, null, 'app session linked on replay');
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('fresh dispatch creates a new delivery with attempt 1', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webhooks-fresh-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'webhooks.db');
  await initializeDatabase();

  try {
    const source = webhooksDb.createSource({
      source: 'fresh-src',
      name: 'Fresh Source',
      retryMax: 1,
    });
    let ran = false;
    configureWebhookRuntimes({
      claude: async (_content, _options, writer) => {
        ran = true;
        sendComplete(writer, 1);
      },
    });
    chatRunRegistry.clearAll();

    const started = await startWebhookDelivery({
      source,
      payload: {
        source: 'fresh-src',
        text: 'hello',
        title: 'T',
        payload: {},
        meta: {},
        raw: {},
      },
    });
    const outcome = await started.completion;
    assert.equal(outcome.success, false, 'exit 1 run is failed');

    const created = webhooksDb.getDeliveryById(started.deliveryId);
    assert.equal(created?.status, 'failed');
    assert.equal(created?.attempt, 1, 'fresh deliveries start at attempt 1');
    assert.ok(
      created?.next_retry_at,
      'failed delivery with retry_max > 0 schedules a retry',
    );
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
