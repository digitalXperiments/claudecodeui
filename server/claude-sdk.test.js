import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRequestId,
  extractPermissionPaths,
  extractTokenBudget,
  resolveApprovalTimeoutMs,
  resolveToolApproval,
  waitForToolApproval,
} from './claude-sdk.js';

const ENV_KEY = 'CLOUDCLI_UNATTENDED_APPROVAL_TIMEOUT_MS';

function withEnv(value, fn) {
  const previous = process.env[ENV_KEY];
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
}

test('resolveApprovalTimeoutMs keeps interactive runs unbounded', () => {
  withEnv(undefined, () => {
    assert.equal(resolveApprovalTimeoutMs(), 0);
    assert.equal(resolveApprovalTimeoutMs({ unattended: false }), 0);
    // Interactive stays 0 even when a budget is configured.
    assert.equal(resolveApprovalTimeoutMs({ unattended: false, approvalTimeoutMs: 5000 }), 0);
  });
});

test('resolveApprovalTimeoutMs bounds unattended runs', () => {
  withEnv(undefined, () => {
    assert.equal(resolveApprovalTimeoutMs({ unattended: true }), 10 * 60_000);
    assert.equal(resolveApprovalTimeoutMs({ unattended: true, approvalTimeoutMs: 5000 }), 5000);
    // Non-positive/unparseable option values fall through to the default so a
    // misconfigured 0 can never reintroduce an infinite headless wait.
    assert.equal(resolveApprovalTimeoutMs({ unattended: true, approvalTimeoutMs: 0 }), 10 * 60_000);
    assert.equal(resolveApprovalTimeoutMs({ unattended: true, approvalTimeoutMs: 'nope' }), 10 * 60_000);
  });

  withEnv('120000', () => {
    assert.equal(resolveApprovalTimeoutMs({ unattended: true }), 120000);
    // Explicit option wins over the env var.
    assert.equal(resolveApprovalTimeoutMs({ unattended: true, approvalTimeoutMs: 5000 }), 5000);
  });

  withEnv('not-a-number', () => {
    assert.equal(resolveApprovalTimeoutMs({ unattended: true }), 10 * 60_000);
  });
});

test('extractPermissionPaths pulls common path shapes from tool input', () => {
  assert.deepEqual(extractPermissionPaths(null), []);
  assert.deepEqual(extractPermissionPaths('git status'), []);
  assert.deepEqual(extractPermissionPaths({ command: 'git status' }), []);
  assert.deepEqual(extractPermissionPaths({ file_path: '/a/b.js' }), ['/a/b.js']);
  assert.deepEqual(extractPermissionPaths({ filePath: '/a/b.js', path: '/c/d.js' }), ['/a/b.js', '/c/d.js']);
  assert.deepEqual(extractPermissionPaths({ paths: ['/a', '/b'], files: ['/c'] }), ['/a', '/b', '/c']);
  // Codex applyPatchApproval shape.
  assert.deepEqual(extractPermissionPaths({ changes: { '/repo/x.ts': { kind: 'update' } } }), ['/repo/x.ts']);
});

test('extractTokenBudget ignores Claude result aggregates after per-response usage', () => {
  assert.equal(
    extractTokenBudget({
      type: 'result',
      usage: { input_tokens: 50_000, output_tokens: 2_000 },
      modelUsage: {},
    }),
    null,
  );

  const perResponse = extractTokenBudget({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
        output_tokens: 25,
      },
    },
  });
  assert.equal(perResponse?.billedInputTokens, 1_050);
  assert.equal(perResponse?.billedOutputTokens, 25);
});

test('bounded waitForToolApproval resolves null on expiry (deny path)', async () => {
  const requestId = createRequestId();
  const decision = await waitForToolApproval(requestId, { timeoutMs: 25 });
  assert.equal(decision, null);
});

test('bounded waitForToolApproval still accepts a broker decision in time', async () => {
  const requestId = createRequestId();
  const pending = waitForToolApproval(requestId, { timeoutMs: 5000 });
  resolveToolApproval(requestId, { allow: true, updatedInput: { ok: true } });
  const decision = await pending;
  assert.deepEqual(decision, { allow: true, updatedInput: { ok: true } });
});
