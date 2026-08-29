import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyTuiActivity,
  isTuiSubmitInput,
} from '@/modules/websocket/services/shell-tui-activity.js';

test('Grok idle prompt with shortcut chrome is idle, not a live turn', () => {
  const frame = [
    'The follow-up audit found another way Chat could stay blank.',
    'Thought for 1.5s',
    '',
    '> ',
    'Shift+Tab:mode | Ctrl+x:shortcuts',
  ].join('\n');

  assert.equal(classifyTuiActivity(frame), 'idle');
});

test('Claude-style interrupt chrome is busy', () => {
  const frame = [
    '✶ Thinking…',
    'esc to interrupt',
  ].join('\n');

  assert.equal(classifyTuiActivity(frame), 'busy');
});

test('braille spinner without prompt is busy', () => {
  assert.equal(classifyTuiActivity('⠋ Running bash command'), 'busy');
});

test('empty output is unknown so prior state is kept', () => {
  assert.equal(classifyTuiActivity(''), 'unknown');
  assert.equal(classifyTuiActivity('random log line'), 'unknown');
});

test('Enter submits a TUI turn; lone keys do not', () => {
  assert.equal(isTuiSubmitInput('hello\r'), true);
  assert.equal(isTuiSubmitInput('\n'), true);
  assert.equal(isTuiSubmitInput('a'), false);
  assert.equal(isTuiSubmitInput('\x1b[A'), false);
});
