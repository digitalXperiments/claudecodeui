import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGenerateTaskFieldsPrompt } from '@/modules/kanban/kanban-generate.service.js';

test('buildGenerateTaskFieldsPrompt includes title and JSON contract', () => {
  const prompt = buildGenerateTaskFieldsPrompt({ title: 'Fix checkout bug' });
  assert.match(prompt, /Fix checkout bug/);
  assert.match(prompt, /"description"/);
  assert.match(prompt, /"prompt"/);
  assert.match(prompt, /Do NOT use tools/);
  assert.match(prompt, /Acceptance criteria/i);
});

test('buildGenerateTaskFieldsPrompt carries existing fields for refinement', () => {
  const prompt = buildGenerateTaskFieldsPrompt({
    title: 'Dark mode',
    notes: 'Prefer CSS variables',
    description: 'Short desc',
    prompt: 'Do the thing',
  });
  assert.match(prompt, /Prefer CSS variables/);
  assert.match(prompt, /Short desc/);
  assert.match(prompt, /Do the thing/);
  assert.match(prompt, /refine\/expand/i);
});
