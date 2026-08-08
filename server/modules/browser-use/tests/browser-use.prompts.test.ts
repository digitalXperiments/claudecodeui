import assert from 'node:assert/strict';
import test from 'node:test';

import { PendingInputStore } from '@/modules/browser-use/browser-use.prompts.js';

test('pending input resolves an ordinary answer and removes the prompt', async () => {
  const store = new PendingInputStore({
    createId: (() => {
      let next = 0;
      return () => `prompt-${++next}`;
    })(),
    defaultTimeoutMs: 1_000,
  });
  const pending = store.create({
    sessionId: 'session-1',
    prompt: 'Continue the login?',
    choices: ['yes', 'no'],
  });

  assert.deepEqual(store.list('session-1').map((item) => item.id), ['prompt-1']);
  assert.deepEqual(store.answer('prompt-1', 'yes'), {
    accepted: true,
    promptId: 'prompt-1',
    secret: false,
  });
  assert.deepEqual(await pending.result, {
    promptId: 'prompt-1',
    secret: false,
    answered: true,
    value: 'yes',
  });
  assert.deepEqual(store.list(), []);
  store.clear();
});

test('pending input resolves with a timeout and does not leave stale prompts', async () => {
  const store = new PendingInputStore({
    createId: () => 'expiring-prompt',
    defaultTimeoutMs: 15,
  });
  const pending = store.create({ prompt: 'Enter the temporary code.' });
  const result = await pending.result;

  assert.deepEqual(result, {
    promptId: 'expiring-prompt',
    secret: false,
    answered: false,
    timedOut: true,
  });
  assert.deepEqual(store.list(), []);
  store.clear();
});

test('secret answers are redacted and can be consumed exactly once by handle', async () => {
  const store = new PendingInputStore({
    createId: (() => {
      let next = 0;
      return () => `secret-id-${++next}`;
    })(),
    defaultTimeoutMs: 1_000,
  });
  const pending = store.create({ prompt: 'Enter the OTP.', secret: true });
  const answer = store.answer('secret-id-1', 'otp-123456');
  const result = await pending.result;

  assert.equal(answer?.accepted, true);
  assert.equal(answer?.secret, true);
  assert.equal(typeof answer?.secretHandle, 'string');
  assert.equal(result.answered, true);
  assert.equal(result.secret, true);
  assert.equal(result.value, undefined);
  assert.equal(JSON.stringify(result).includes('otp-123456'), false);
  assert.equal(JSON.stringify(answer).includes('otp-123456'), false);
  assert.equal(store.consumeSecretHandle(result.secretHandle || ''), 'otp-123456');
  assert.equal(store.consumeSecretHandle(result.secretHandle || ''), null);
  store.clear();
});

