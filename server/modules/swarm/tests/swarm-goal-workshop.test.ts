import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import {
  buildGoalWorkshopPrompt,
  configureGoalWorkshopRunner,
  parseGoalDraft,
  runGoalWorkshop,
} from '@/modules/swarm/swarm-goal-workshop.service.js';
import { makeScratchDir } from '@/shared/scratch.js';

async function withDatabase(callback: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await makeScratchDir('goal-workshop-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  try {
    await callback();
  } finally {
    configureGoalWorkshopRunner(null);
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(root, { recursive: true, force: true });
  }
}

test('parseGoalDraft extracts the fenced swarm-goal contract', () => {
  const text = [
    'Here is a bounded contract.',
    '```swarm-goal',
    '**Problem**',
    'Workers dump unstructured findings.',
    '',
    '**Goal**',
    'Structured harvest + acceptance checks.',
    '```',
    'Want me to tighten out-of-scope?',
  ].join('\n');
  const parsed = parseGoalDraft(text);
  assert.equal(parsed.ready, true);
  assert.match(parsed.draftGoal ?? '', /Structured harvest/);
  assert.doesNotMatch(parsed.draftGoal ?? '', /Want me to tighten/);
});

test('parseGoalDraft is not ready without a fence', () => {
  const parsed = parseGoalDraft('What is in scope for this swarm?');
  assert.equal(parsed.ready, false);
  assert.equal(parsed.draftGoal, null);
});

test('workshop prompt asks for a fenced contract and includes the conversation', () => {
  const prompt = buildGoalWorkshopPrompt({
    messages: [
      { role: 'user', content: 'Make the harvest structured' },
      { role: 'assistant', content: 'What should be out of scope?' },
      { role: 'user', content: 'No UI chrome rewrite' },
    ],
    currentGoal: 'fix harvest',
    projectName: 'cloudcli-fork',
  });
  assert.match(prompt, /```swarm-goal/);
  assert.match(prompt, /Make the harvest structured/);
  assert.match(prompt, /No UI chrome rewrite/);
  assert.match(prompt, /cloudcli-fork/);
  assert.match(prompt, /fix harvest/);
});

test('runGoalWorkshop returns a parsed contract from the orchestrator reply', async () => {
  await withDatabase(async () => {
    const created = projectsDb.createProjectPath(path.join(process.cwd(), 'tmp/cloudcli/goal-workshop-proj'), 'demo');
    const projectId = created.project!.project_id;
    let receivedPermissionMode: string | null = null;
    configureGoalWorkshopRunner(async (input) => {
      receivedPermissionMode = input.permissionMode;
      return {
        success: true,
        text: [
          'Ready to paste.',
          '```swarm-goal',
          '**Problem** Unstructured harvest.',
          '**Goal** Structured results.',
          '```',
        ].join('\n'),
      };
    });
    const result = await runGoalWorkshop({
      projectId,
      provider: 'claude',
      model: 'opus',
      messages: [{ role: 'user', content: 'Make harvest structured' }],
    });
    assert.equal(result.ready, true);
    assert.match(result.draftGoal ?? '', /Structured results/);
    assert.match(result.reply, /Ready to paste/);
    assert.equal(receivedPermissionMode, 'default', 'text-only workshop must not enter plan mode');
  });
});
