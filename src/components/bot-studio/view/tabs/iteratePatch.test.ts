import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIterationPatch } from './iteratePatch';

test('natural-language iteration only applies explicitly selected safe fields', () => {
  const draft = {
    title: 'Changed', scope: 'project' as const, mode: 'fire_and_forget' as const,
    scheduleCron: '0 9 * * *', producePrompt: 'New brief', resolvePrompt: 'New resolve',
    createKanbanTask: true, recommendedMcpServers: ['untrusted-server'],
  };
  assert.deepEqual(buildIterationPatch(draft, ['produce_prompt']), { produce_prompt: 'New brief' });
  assert.deepEqual(buildIterationPatch(draft, []), {});
  assert.deepEqual(buildIterationPatch(draft, ['title', 'schedule_cron']), { title: 'Changed', schedule_cron: '0 9 * * *' });
});
