import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { webhooksDb } from '@/modules/webhooks/webhooks.repository.js';
import {
  handleDeliveryFailed,
  reconstructPayloadFromDelivery,
} from '@/modules/webhooks/webhooks-runner.service.js';
import type { WebhookSource } from '@/modules/webhooks/webhooks.types.js';

test('webhook source retry columns persist with defaults', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webhooks-retry-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'webhooks.db');
  await initializeDatabase();

  try {
    const source = webhooksDb.createSource({
      source: 'retry-src',
      name: 'Retry Source',
    });
    assert.equal(source.retryMax, 0, 'retryMax defaults to 0');
    assert.equal(source.retryBackoffSeconds, 60, 'backoff defaults to 60');
    assert.equal(source.secret, null, 'secret defaults to null');

    const configured = webhooksDb.createSource({
      source: 'retry-src-2',
      name: 'Retry Source 2',
      retryMax: 3,
      retryBackoffSeconds: 120,
      secret: 'whsec_abc',
    });
    assert.equal(configured.retryMax, 3);
    assert.equal(configured.retryBackoffSeconds, 120);
    assert.equal(configured.secret, 'whsec_abc');

    const updated = webhooksDb.updateSource(configured.source_id, {
      retryMax: 5,
      secret: null,
    });
    assert.equal(updated?.retryMax, 5);
    assert.equal(updated?.secret, null);
    assert.equal(updated?.retryBackoffSeconds, 120, 'backoff untouched');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('delivery attempt lifecycle: create, fail, reset, retry scheduling', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webhooks-attempt-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'webhooks.db');
  await initializeDatabase();

  try {
    const source = webhooksDb.createSource({
      source: 'attempt-src',
      name: 'Attempt Source',
      retryMax: 2,
      retryBackoffSeconds: 60,
    });
    const delivery = webhooksDb.createDelivery({
      sourceId: source.source_id,
      request: { source: 'attempt-src', title: 'T', text: 'hello' },
    });
    assert.equal(delivery.attempt, 1, 'createDelivery starts at attempt 1');

    // Failure without retry eligibility scheduling (retry not yet triggered).
    handleDeliveryFailed(delivery, source, { errorMessage: 'first failure' });
    let row = webhooksDb.getDeliveryById(delivery.delivery_id);
    assert.equal(row?.status, 'failed');
    assert.equal(row?.attempt, 1);
    assert.ok(row?.next_retry_at, 'retry was scheduled for eligible delivery');
    const firstNextRetryAt = row?.next_retry_at;

    // Double-processing guard: second failure must not reschedule.
    handleDeliveryFailed(delivery, source, { errorMessage: 'second failure' });
    row = webhooksDb.getDeliveryById(delivery.delivery_id);
    assert.equal(row?.next_retry_at, firstNextRetryAt, 'next_retry_at unchanged on repeat');
    assert.equal(row?.error_message, 'second failure');

    // Replay resets the row and bumps the attempt.
    webhooksDb.resetDeliveryForReplay(delivery.delivery_id);
    row = webhooksDb.getDeliveryById(delivery.delivery_id);
    assert.equal(row?.status, 'accepted');
    assert.equal(row?.attempt, 2);
    assert.equal(row?.next_retry_at, null);
    assert.equal(row?.error_message, null);
    assert.equal(row?.result_preview, null);
    assert.equal(row?.finished_at, null);

    // markDeliveryRunning only flips status/session.
    webhooksDb.markDeliveryRunning(delivery.delivery_id, 'app-session-1');
    row = webhooksDb.getDeliveryById(delivery.delivery_id);
    assert.equal(row?.status, 'running');
    assert.equal(row?.app_session_id, 'app-session-1');
    assert.equal(row?.attempt, 2);

    // incrementDeliveryAttempt bumps without touching status.
    webhooksDb.incrementDeliveryAttempt(delivery.delivery_id);
    row = webhooksDb.getDeliveryById(delivery.delivery_id);
    assert.equal(row?.attempt, 3);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('handleDeliveryFailed does not schedule when retry_max is 0', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webhooks-noretry-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'webhooks.db');
  await initializeDatabase();

  try {
    const source = webhooksDb.createSource({
      source: 'noretry-src',
      name: 'No Retry Source',
      retryMax: 0,
    });
    const delivery = webhooksDb.createDelivery({
      sourceId: source.source_id,
      request: { source: 'noretry-src', text: 'x' },
    });
    handleDeliveryFailed(delivery, source, { errorMessage: 'fail' });
    const row = webhooksDb.getDeliveryById(delivery.delivery_id);
    assert.equal(row?.status, 'failed');
    assert.equal(row?.next_retry_at, null, 'no retry scheduled for retry_max=0');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('listRetryableDeliveries returns only due, eligible failures', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webhooks-list-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'webhooks.db');
  await initializeDatabase();

  try {
    const withRetry = webhooksDb.createSource({
      source: 'with-retry',
      name: 'With Retry',
      retryMax: 2,
    });
    const noRetry = webhooksDb.createSource({
      source: 'no-retry',
      name: 'No Retry',
      retryMax: 0,
    });
    const lowMax = webhooksDb.createSource({
      source: 'low-max',
      name: 'Low Max',
      retryMax: 1,
    });

    const due = webhooksDb.createDelivery({
      sourceId: withRetry.source_id,
      request: { source: 'with-retry', text: 'due' },
    });
    webhooksDb.markDeliveryFailed(due.delivery_id, {
      errorMessage: 'fail',
      nextRetryAtIso: new Date(Date.now() - 60_000).toISOString(),
    });

    const future = webhooksDb.createDelivery({
      sourceId: withRetry.source_id,
      request: { source: 'with-retry', text: 'future' },
    });
    webhooksDb.markDeliveryFailed(future.delivery_id, {
      errorMessage: 'fail',
      nextRetryAtIso: new Date(Date.now() + 600_000).toISOString(),
    });

    const noRetryFailed = webhooksDb.createDelivery({
      sourceId: noRetry.source_id,
      request: { source: 'no-retry', text: 'nope' },
    });
    webhooksDb.markDeliveryFailed(noRetryFailed.delivery_id, {
      errorMessage: 'fail',
      nextRetryAtIso: new Date(Date.now() - 60_000).toISOString(),
    });

    const exhausted = webhooksDb.createDelivery({
      sourceId: lowMax.source_id,
      request: { source: 'low-max', text: 'exhausted' },
    });
    webhooksDb.markDeliveryFailed(exhausted.delivery_id, {
      errorMessage: 'fail',
      nextRetryAtIso: new Date(Date.now() - 60_000).toISOString(),
    });
    // attempt 2 > retry_max 1 → not eligible.
    webhooksDb.incrementDeliveryAttempt(exhausted.delivery_id);

    const retryable = webhooksDb.listRetryableDeliveries(new Date().toISOString());
    assert.deepEqual(
      retryable.map((d) => d.delivery_id),
      [due.delivery_id],
      'only the due, eligible delivery is retryable',
    );
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('reconstructPayloadFromDelivery rebuilds an ingest payload', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'webhooks-reconstruct-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'webhooks.db');
  await initializeDatabase();

  try {
    const source: WebhookSource = webhooksDb.createSource({
      source: 'recon-src',
      name: 'Reconstruct',
    });
    const delivery = webhooksDb.createDelivery({
      sourceId: source.source_id,
      request: {
        source: 'recon-src',
        title: 'Replay title',
        text: 'replay body',
        hasPayload: true,
        meta: { source: 'test' },
      },
    });
    const payload = reconstructPayloadFromDelivery(delivery);
    assert.equal(payload.source, 'recon-src');
    assert.equal(payload.title, 'Replay title');
    assert.equal(payload.text, 'replay body');
    assert.deepEqual(payload.meta, { source: 'test' });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
