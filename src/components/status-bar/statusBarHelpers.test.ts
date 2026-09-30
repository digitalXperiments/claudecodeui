import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatCurrency,
  formatVelocity,
  formatTokenCount,
  computeContextPressure,
  evaluateStallState,
} from './statusBarHelpers';

test('formatCurrency formats zero, sub-cent, standard, and large values', () => {
  assert.equal(formatCurrency(0), '$0.00');
  assert.equal(formatCurrency(-5), '$0.00');
  assert.equal(formatCurrency(0.004), '<$0.01');
  assert.equal(formatCurrency(0.42), '$0.42');
  assert.equal(formatCurrency(1.156), '$1.16');
  assert.equal(formatCurrency(124.56), '$124.6');
});

test('formatVelocity formats dollar-per-minute burn rate', () => {
  assert.equal(formatVelocity(0), '$0.00');
  assert.equal(formatVelocity(0.003), '<$0.01');
  assert.equal(formatVelocity(0.08), '$0.08');
  assert.equal(formatVelocity(1.45), '$1.45');
});

test('formatTokenCount renders compact readable token numbers', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(450), '450');
  assert.equal(formatTokenCount(1200), '1.2k');
  assert.equal(formatTokenCount(48500), '49k');
  assert.equal(formatTokenCount(1500000), '1.5M');
  assert.equal(formatTokenCount(2000000000), '2.0B');
});

test('computeContextPressure correctly calculates context percentage and token counts', () => {
  // Empty / null budget
  const empty = computeContextPressure(null);
  assert.equal(empty.usedTokens, 0);
  assert.equal(empty.contextWindow, 0);
  assert.equal(empty.percent, null);

  // Standard budget with contextUsed and contextWindow
  const standard = computeContextPressure({
    contextUsed: 50000,
    contextWindow: 200000,
    billedInputTokens: 30000,
    billedOutputTokens: 2000,
  });
  assert.equal(standard.usedTokens, 50000);
  assert.equal(standard.contextWindow, 200000);
  assert.equal(standard.percent, 25);
  assert.equal(standard.inputTokens, 30000);
  assert.equal(standard.outputTokens, 2000);

  // Budget using total and cumulative breakdown
  const altBudget = computeContextPressure({
    used: 160000,
    total: 200000,
  });
  assert.equal(altBudget.usedTokens, 160000);
  assert.equal(altBudget.contextWindow, 200000);
  assert.equal(altBudget.percent, 80);
});

test('evaluateStallState detects stall when silent for at or over threshold', () => {
  // Idle state
  const idle = evaluateStallState({
    isProcessing: false,
    elapsedSeconds: 0,
    idleSeconds: 0,
  });
  assert.equal(idle.isStalled, false);
  assert.equal(idle.phase, 'idle');

  // Processing normally under threshold
  const activeNormal = evaluateStallState({
    isProcessing: true,
    elapsedSeconds: 10,
    idleSeconds: 4,
    thresholdSeconds: 18,
    currentPhase: 'tool',
  });
  assert.equal(activeNormal.isStalled, false);
  assert.equal(activeNormal.phase, 'tool');

  // Stalled when idle exceeds threshold
  const stalled = evaluateStallState({
    isProcessing: true,
    elapsedSeconds: 25,
    idleSeconds: 20,
    thresholdSeconds: 18,
    currentPhase: 'tool',
  });
  assert.equal(stalled.isStalled, true);
  assert.equal(stalled.phase, 'stalled');

  // Recovers once activity arrives
  const recovered = evaluateStallState({
    isProcessing: true,
    elapsedSeconds: 26,
    idleSeconds: 1,
    thresholdSeconds: 18,
    currentPhase: 'streaming',
  });
  assert.equal(recovered.isStalled, false);
  assert.equal(recovered.phase, 'streaming');
});
