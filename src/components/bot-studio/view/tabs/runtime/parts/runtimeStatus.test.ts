import test from 'node:test';
import assert from 'node:assert/strict';

import { describeRuntimeStatus } from './runtimeStatus';

const base = { enabled: true, running: [] as string[], queuedWakes: 0, queuedEvents: 0 };

test('describeRuntimeStatus covers unknown, disabled, running, queued and idle', () => {
  assert.equal(describeRuntimeStatus(null, 'b1').tone, 'unknown');
  assert.equal(describeRuntimeStatus({ ...base, enabled: false }, 'b1').tone, 'disabled');
  assert.deepEqual(describeRuntimeStatus({ ...base, running: ['b1'] }, 'b1'), { tone: 'running', label: 'Running now' });
  assert.equal(describeRuntimeStatus({ ...base, running: ['b1'], queuedWakes: 2 }, 'b1').label, 'Running now · 2 queued across all bots');
  assert.equal(describeRuntimeStatus({ ...base, running: ['other'] }, 'b1').tone, 'idle');
  const queued = describeRuntimeStatus({ ...base, queuedWakes: 1, queuedEvents: 3 }, 'b1');
  assert.equal(queued.tone, 'queued');
  assert.match(queued.label, /4 queued across all bots \(1 wake, 3 events\)/);
  assert.deepEqual(describeRuntimeStatus(base, 'b1'), { tone: 'idle', label: 'Idle · nothing queued' });
});

test('describeRuntimeStatus surfaces a forced-off or stopped runtime', () => {
  const base = { enabled: true, running: [], queuedWakes: 0, queuedEvents: 0 };
  assert.match(describeRuntimeStatus({ ...base, runtime_running: false, forced_off: true }, 'b').label, /forced off/);
  assert.match(describeRuntimeStatus({ ...base, runtime_running: false }, 'b').label, /not running/);
  assert.equal(describeRuntimeStatus({ ...base, runtime_running: true }, 'b').tone, 'idle');
});
