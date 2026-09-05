import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrowserCapture, CaptureValidationError, buildCaptureDescription, isCaptureBodyWithinLimit } from '../browser-capture.service.js';

const valid = { projectId: 'project-1', title: 'Fix button', url: 'https://example.test/page' };

test('validates a bounded capture and removes input values from recording events', () => {
  const capture = validateBrowserCapture({ ...valid, reproduction: { events: [{ type: 'input', at: 2, target: '#email', value: 'secret', valueLength: 6 }] } });
  assert.equal(capture.reproduction?.events?.[0].valueLength, 6);
  assert.equal('value' in capture.reproduction!.events![0], false);
});

test('rejects credentials, non-web URLs, and oversized screenshots', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.test/']) {
    assert.throws(() => validateBrowserCapture({ ...valid, url }), CaptureValidationError);
  }
  const screenshotDataUrl = `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')}`;
  assert.throws(() => validateBrowserCapture({ ...valid, screenshotDataUrl }), /Screenshot exceeds/);
});

test('rejects malformed payloads and preserves evidence references as plain text', () => {
  assert.throws(() => validateBrowserCapture({ ...valid, projectId: '' }), /projectId is required/);
  assert.throws(() => validateBrowserCapture({ ...valid, reproduction: { events: [{ type: 'keydown' }] } }), /Invalid reproduction event type/);
  const description = buildCaptureDescription(validateBrowserCapture({ ...valid, expectedBehavior: '<script>alert(1)</script>' }), { filename: 'generated.png' });
  assert.match(description, /generated\.png/);
  assert.match(description, /<script>/);
});

test('enforces the capture body limit even when Content-Length is unavailable', () => {
  assert.equal(isCaptureBodyWithinLimit({ ...valid, extra: 'x'.repeat(12 * 1024 * 1024) }), false);
  assert.equal(isCaptureBodyWithinLimit({ ...valid, extra: 'x'.repeat(1024) }), true);
});
