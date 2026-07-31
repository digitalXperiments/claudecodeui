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
  } as unknown as Request;
}

describe('extractApiKey', () => {
  it('reads x-api-key header first', () => {
    const key = extractApiKey(
      fakeReq({
        headers: { 'x-api-key': 'ck_header', authorization: 'Bearer ck_bearer' },
        query: { apiKey: 'ck_query' },
      }),
    );
    assert.equal(key, 'ck_header');
  });

  it('falls back to Bearer then query', () => {
    assert.equal(
      extractApiKey(fakeReq({ headers: { authorization: 'Bearer ck_bearer' } })),
      'ck_bearer',
    );
    assert.equal(extractApiKey(fakeReq({ query: { apiKey: 'ck_query' } })), 'ck_query');
  });
});

describe('parseIngestRequest', () => {
  it('prefers body over query over headers for source and text', () => {
    const payload = parseIngestRequest(
      fakeReq({
        body: { source: 'body-src', text: 'body-text', title: 'T' },
        query: { source: 'query-src', text: 'query-text' },
        headers: { 'x-webhook-source': 'hdr-src', 'x-webhook-text': 'hdr-text' },
      }),
    );
    assert.equal(payload.source, 'body-src');
    assert.equal(payload.text, 'body-text');
    assert.equal(payload.title, 'T');
  });

  it('uses query and headers when body empty', () => {
    const payload = parseIngestRequest(
      fakeReq({
        query: { source: 'q', text: 'from-query' },
        headers: {},
      }),
    );
    assert.equal(payload.source, 'q');
    assert.equal(payload.text, 'from-query');
  });

  it('accepts content/note aliases', () => {
    const payload = parseIngestRequest(
      fakeReq({ body: { source: 's', content: 'via content' } }),
    );
    assert.equal(payload.text, 'via content');
  });
});

describe('wantsWait', () => {
  it('detects wait query flags', () => {
    assert.equal(wantsWait(fakeReq({ query: { wait: '1' } })), true);
    assert.equal(wantsWait(fakeReq({ query: { wait: 'true' } })), true);
    assert.equal(wantsWait(fakeReq({ query: {} })), false);
  });
});
