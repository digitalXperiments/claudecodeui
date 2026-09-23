import assert from 'node:assert/strict';
import test from 'node:test';

import type { BotRunEvent } from '../../api/botStudioApi';

import { selectExplainableRunSteps } from './runTimelineSelectors';

function event(sequence: number, type: string, payload: Record<string, unknown> = {}, severity?: BotRunEvent['severity']): BotRunEvent {
  return {
    event_id: 'event-' + String(sequence),
    run_id: 'run-1',
    seq: sequence,
    ts: '2026-09-22T10:00:0' + String(sequence) + 'Z',
    source: 'mission_control',
    type,
    payload,
    severity,
  };
}

test('turns durable run events into a chronological operator story', () => {
  const steps = selectExplainableRunSteps([
    event(3, 'tool.result', { tool: 'github', content: 'Found two pull requests' }),
    event(1, 'run.queued', { trigger: 'manual' }),
    event(2, 'tool.call', { tool: 'github', input: { query: 'is:pr' } }),
    event(4, 'token.usage', { total: 1234, cost_usd_estimate: 0.0123 }),
    event(5, 'run.completed'),
  ]);

  assert.deepEqual(steps.map((step) => step.title), [
    'Queued',
    'Called github',
    'github completed',
    'Usage recorded',
    'Run completed',
  ]);
  assert.match(steps[1].description, /is:pr/);
  assert.equal(steps[2].tone, 'success');
  assert.match(steps[3].description, /1,234 tokens/);
});

test('makes permission decisions and failures explicit', () => {
  const steps = selectExplainableRunSteps([
    event(1, 'permission.requested', { tool: 'Bash', reason: 'write access' }, 'warn'),
    event(2, 'permission.resolved', { decision: 'denied' }),
    event(3, 'run.failed', { error_summary: 'Permission denied' }, 'error'),
  ]);

  assert.equal(steps[0].tone, 'warning');
  assert.equal(steps[1].tone, 'error');
  assert.equal(steps[2].description, 'Permission denied');
});
