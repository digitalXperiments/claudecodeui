import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeGrokPermissionDenial,
  emitGrokPromptCompletion,
  resolveGrokPromptCompletion,
} from './grok-cli.js';

const createWriter = (messages) => ({
  send(message) {
    messages.push(message);
  },
});

test('provider cancellation after a denied Grok tool is a failed run, not a user abort', () => {
  const messages = [];
  const denial = describeGrokPermissionDenial('run_terminal_command', {
    allow: false,
    message: 'read-only seat may not run an unclassified command',
  });

  const outcome = emitGrokPromptCompletion(createWriter(messages), {
    sessionId: 'grok-session-1',
    explicitlyAborted: false,
    stopReason: 'cancelled',
    permissionDenial: denial,
  });

  assert.deepEqual(outcome, {
    exitCode: 1,
    aborted: false,
    errorContent:
      'Grok tool permission was denied for "run_terminal_command": '
      + 'read-only seat may not run an unclassified command',
  });
  assert.deepEqual(messages.map((message) => message.kind), ['error', 'complete']);
  assert.equal(messages[0].content, outcome.errorContent);
  assert.equal(messages[0].sessionId, 'grok-session-1');
  assert.equal(messages[1].exitCode, 1);
  assert.equal(messages[1].success, false);
  assert.equal(messages[1].aborted, false);
});

test('an explicit CloudCLI Grok abort remains aborted and does not invent a provider error', () => {
  const messages = [];
  const outcome = emitGrokPromptCompletion(createWriter(messages), {
    sessionId: 'grok-session-2',
    explicitlyAborted: true,
    stopReason: 'cancelled',
    permissionDenial: 'an earlier permission was denied',
  });

  assert.deepEqual(outcome, { exitCode: 1, aborted: true, errorContent: null });
  assert.deepEqual(messages.map((message) => message.kind), ['complete']);
  assert.equal(messages[0].exitCode, 1);
  assert.equal(messages[0].success, false);
  assert.equal(messages[0].aborted, true);
});

test('a normal Grok end_turn remains successful', () => {
  assert.deepEqual(
    resolveGrokPromptCompletion({
      explicitlyAborted: false,
      stopReason: 'end_turn',
      permissionDenial: null,
    }),
    { exitCode: 0, aborted: false, errorContent: null },
  );
});

test('unanswered unattended Grok permission produces an actionable timeout cause', () => {
  assert.equal(
    describeGrokPermissionDenial('Bash', null, true),
    'Grok tool permission was denied for "Bash" because no approval arrived before the unattended timeout.',
  );
});

