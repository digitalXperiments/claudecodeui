import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { verifyWebhookSignature } from '@/modules/webhooks/webhooks-ingest.util.js';

const SECRET = 'whsec_test_secret';
const BODY = Buffer.from('{"source":"xspeech","text":"hello"}');

function sign(secret: string, body: Buffer, prefix = false): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  return prefix ? `sha256=${hex}` : hex;
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature', () => {
    assert.equal(verifyWebhookSignature(SECRET, BODY, sign(SECRET, BODY)), true);
  });

  it('accepts a sha256= prefixed signature (GitHub-style)', () => {
    assert.equal(verifyWebhookSignature(SECRET, BODY, sign(SECRET, BODY, true)), true);
  });

  it('rejects a signature produced with the wrong key', () => {
    assert.equal(verifyWebhookSignature(SECRET, BODY, sign('wrong_key', BODY)), false);
  });

  it('rejects a truncated signature (length mismatch)', () => {
    assert.equal(verifyWebhookSignature(SECRET, BODY, sign(SECRET, BODY).slice(0, 32)), false);
  });

  it('rejects a non-hex signature header', () => {
    assert.equal(verifyWebhookSignature(SECRET, BODY, 'sha256=not-hex!!'), false);
    assert.equal(verifyWebhookSignature(SECRET, BODY, 'zzz'), false);
  });

  it('rejects when the signature header is missing', () => {
    assert.equal(verifyWebhookSignature(SECRET, BODY, undefined), false);
    assert.equal(verifyWebhookSignature(SECRET, BODY, ''), false);
  });

  it('verifies a signature computed over an empty body when raw body is missing', () => {
    const emptySig = sign(SECRET, Buffer.alloc(0));
    assert.equal(verifyWebhookSignature(SECRET, undefined, emptySig), true);
  });

  it('rejects a signature over the real body when raw body is missing', () => {
    assert.equal(verifyWebhookSignature(SECRET, undefined, sign(SECRET, BODY)), false);
  });

  it('rejects when the secret is empty', () => {
    assert.equal(verifyWebhookSignature('', BODY, sign(SECRET, BODY)), false);
  });
});
