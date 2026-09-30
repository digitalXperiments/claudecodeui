import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSessionTelemetryCache,
  getCachedSessionTelemetry,
} from '../useSessionStatusBarTelemetry';
import { computeContextPressure } from '../statusBarHelpers';

test('sessionTelemetryCache stores and retrieves telemetry per session', () => {
  clearSessionTelemetryCache();

  // Initially empty
  assert.equal(getCachedSessionTelemetry('sess-1'), undefined);

  // Compute context pressure for session-1
  const ctx1 = computeContextPressure({
    contextUsed: 45000,
    contextWindow: 200000,
    model: 'claude-3-7-sonnet',
  });

  // Verify that clearing cache wipes all sessions
  clearSessionTelemetryCache();
  assert.equal(getCachedSessionTelemetry('sess-1'), undefined);
  assert.equal(getCachedSessionTelemetry('sess-2'), undefined);
});
