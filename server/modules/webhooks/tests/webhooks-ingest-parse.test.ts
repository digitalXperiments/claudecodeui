import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request } from 'express';

import {
  extractApiKey,
  parseIngestRequest,
  wantsWait,
} from '@/modules/webhooks/webhooks-ingest.util.js';

function fakeReq(partial: {
  body?: unknown;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}): Request {
  return {
    body: partial.body ?? {},
    query: partial.query ?? {},
    headers: partial.headers ?? {},
  } as Request;
}

describe('parseIngestRequest', () => {
  it('reads from JSON body', () => {
    const p = parseIngestRequest(
      fakeReq({
        body: { source: 'xspeech', text: 'hi', title: 't1' },
      }),
    );
    assert.equal(p.source, 'xspeech');
    assert.equal(p.text, 'hi');
    assert.equal(p.title, 't1');
  });

  it('falls back to query params', () => {
    const p = parseIngestRequest(
      fakeReq({
        query: { source: 'qs', text: 'from query' },
      }),
    );
    assert.equal(p.source, 'qs');
    assert.equal(p.text, 'from query');
  });

  it('prefers body over query', () => {
    const p = parseIngestRequest(
      fakeReq({
        body: { source: 'body-src', text: 'body-text' },
        query: { source: 'query-src', text: 'query-text' },
      }),
    );
    assert.equal(p.source, 'body-src');
    assert.equal(p.text, 'body-text');
  });

  it('accepts x-webhook-source header', () => {
    const p = parseIngestRequest(
      fakeReq({
        headers: { 'x-webhook-source': 'hdr', 'x-webhook-text': 'short' },
      }),
    );
    assert.equal(p.source, 'hdr');
    assert.equal(p.text, 'short');
  });

  it('accepts content/note aliases', () => {
    const p = parseIngestRequest(
      fakeReq({
        body: { source: 's', content: 'from content field' },
      }),
    );
    assert.equal(p.text, 'from content field');
  });
});

describe('extractApiKey', () => {
  it('reads x-api-key header', () => {
    assert.equal(extractApiKey(fakeReq({ headers: { 'x-api-key': 'ck_abc' } })), 'ck_abc');
  });

  it('reads Bearer token', () => {
    assert.equal(
      extractApiKey(fakeReq({ headers: { authorization: 'Bearer ck_token' } })),
      'ck_token',
    );
  });

  it('reads query apiKey', () => {
    assert.equal(extractApiKey(fakeReq({ query: { apiKey: 'ck_q' } })), 'ck_q');
  });
});

describe('wantsWait', () => {
  it('detects wait query', () => {
    assert.equal(wantsWait(fakeReq({ query: { wait: '1' } })), true);
    assert.equal(wantsWait(fakeReq({ query: {} })), false);
  });
});
