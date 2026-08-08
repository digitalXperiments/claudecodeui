import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeNetworkRequests,
  assembleHar,
  filterNetworkRequests,
  parseHar,
  type CapturedNetworkRequest,
} from '@/modules/browser-use/browser-use.network.js';

const fixtureRequests: CapturedNetworkRequest[] = [
  {
    id: 'r1',
    url: 'https://api.example.test/data',
    method: 'GET',
    resourceType: 'xhr',
    startedAt: '2026-08-08T00:00:00.000Z',
    startedAtMs: Date.parse('2026-08-08T00:00:00.000Z'),
    status: 200,
    requestHeaders: { Authorization: 'Bearer secret', Accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: {
      size: 1_200,
      capturedBytes: 20,
      mimeType: 'application/json',
      text: '{"ok":true}',
      truncated: false,
    },
    responseBodySize: 1_200,
    timing: { blockedMs: 250, ttfbMs: 700, durationMs: 1_200 },
  },
  {
    id: 'r2',
    url: 'https://api.example.test/data',
    method: 'GET',
    resourceType: 'xhr',
    startedAt: '2026-08-08T00:00:02.000Z',
    startedAtMs: Date.parse('2026-08-08T00:00:02.000Z'),
    status: 200,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'application/json' },
    responseBodySize: 1_200,
    timing: { durationMs: 100 },
  },
  {
    id: 'r3',
    url: 'https://cdn.example.test/app.js',
    method: 'GET',
    resourceType: 'script',
    startedAt: '2026-08-08T00:00:03.000Z',
    startedAtMs: Date.parse('2026-08-08T00:00:03.000Z'),
    status: 404,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'text/javascript' },
    responseBodySize: 2 * 1024 * 1024,
    timing: { durationMs: 900 },
  },
];

test('network filters match URL, method, status, type, duration, and since timestamp', () => {
  assert.deepEqual(
    filterNetworkRequests(fixtureRequests, {
      url: '/data',
      method: 'get',
      status: 200,
      resourceType: 'xhr',
      minDurationMs: 500,
      since: '2026-08-08T00:00:00.000Z',
    }).map((request) => request.id),
    ['r1'],
  );

  assert.deepEqual(
    filterNetworkRequests(fixtureRequests, {
      urlRegex: 'cdn\\.example',
      status: 404,
    }).map((request) => request.id),
    ['r3'],
  );
});

test('HAR assembly emits HAR 1.2 entries and redacts sensitive headers by default', () => {
  const har = assembleHar(fixtureRequests);
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 3);
  const headers = har.log.entries[0].request.headers;
  assert.deepEqual(headers.find((header) => header.name === 'Authorization'), {
    name: 'Authorization',
    value: '[REDACTED]',
  });
  const firstEntry = har.log.entries[0];
  const timingTotal = Object.values(firstEntry.timings)
    .filter((value) => typeof value === 'number' && value >= 0)
    .reduce((sum, value) => sum + Number(value), 0);
  assert.equal(timingTotal, firstEntry.time);

  const imported = parseHar(har);
  assert.equal(imported.length, 3);
  assert.equal(imported[0].url, fixtureRequests[0].url);
  assert.equal(imported[0].timing.durationMs, 1_200);
});

test('HAR parser tolerates missing timings and gives clear errors for malformed entries', () => {
  const partial = parseHar({
    log: {
      version: '1.2',
      entries: [{
        startedDateTime: '2026-08-08T00:00:00.000Z',
        request: { method: 'GET', url: 'https://example.test/' },
        response: { status: 204, headers: [] },
      }],
    },
  });
  assert.equal(partial[0].status, 204);
  assert.deepEqual(partial[0].timing, {});

  assert.throws(
    () => parseHar({ log: { entries: [{ request: { method: 'GET' } }] } }),
    /Invalid HAR entry 0: request\.url is required/,
  );
});

test('network analyzer reports failures, duplicates, domains, slow TTFB, and large uncompressed responses', () => {
  const analysis = analyzeNetworkRequests(fixtureRequests, { topN: 2 });
  assert.equal(analysis.totalRequests, 3);
  assert.equal(analysis.totalBytes, 2 * 1024 * 1024 + 2_400);
  assert.equal(analysis.failedCount, 1);
  assert.equal(analysis.slowestRequests[0].id, 'r1');
  assert.equal(analysis.largestPayloads[0].id, 'r3');
  assert.equal(analysis.duplicateRequests[0].count, 2);
  assert.equal(analysis.domains[0].domain, 'cdn.example.test');
  assert.deepEqual(analysis.blockingRequests.map((request) => request.id), ['r1']);
  assert.deepEqual(analysis.longTtfbRequests.map((request) => request.id), ['r1']);
  assert.ok(analysis.findings.some((finding) => finding.startsWith('uncompressed >1MB response')));
  assert.ok(analysis.findings.some((finding) => finding.startsWith('404s')));
});
