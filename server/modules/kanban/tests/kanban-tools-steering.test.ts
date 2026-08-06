import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRunPrompt,
  buildTaskSteeringPreamble,
  resolveEffectiveToolsForRun,
} from '@/modules/kanban/kanban-runner.service.js';
import type { KanbanTask } from '@/modules/kanban/kanban.types.js';
import { expandMcpSelectionsToTools } from '@/shared/mcp-tool-expand.js';

function baseTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    task_id: 't1',
    board_id: 'b1',
    project_id: 'p1',
    title: 'Do work',
    description: '',
    prompt: 'Implement the feature',
    column_id: 'backlog',
    position: 0,
    assignee_provider: 'claude',
    review_provider: null,
    implement_profile_id: null,
    review_profile_id: null,
    permission_mode: 'default',
    tools: {},
    schedule_cron: null,
    due_date: null,
    feature_branch: null,
    escalated_at: null,
    status: 'todo',
    app_session_id: null,
    last_run_at: null,
    last_exit_code: null,
    dependsOn: [],
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

test('expandMcpSelectionsToTools expands Claude-style prefixes', () => {
  const expanded = expandMcpSelectionsToTools(['leong_associates_mcp', 'Composio'], 'claude');
  assert.ok(expanded.some((e) => e.includes('leong_associates_mcp')));
  assert.ok(expanded.some((e) => e.startsWith('mcp__')));
});

test('resolveEffectiveToolsForRun merges mcpServers into allowedCommands', () => {
  const task = baseTask({
    tools: {
      mcpServers: ['obsidian'],
      allowedCommands: ['Read'],
    },
  });
  const tools = resolveEffectiveToolsForRun(task, 'claude');
  assert.ok(tools.allowedCommands?.includes('Read'));
  assert.ok(tools.allowedCommands?.some((c) => c.includes('obsidian') || c.includes('mcp__')));
  assert.deepEqual(tools.mcpServers, ['obsidian']);
});

test('buildRunPrompt injects skill and MCP steering for implement', () => {
  const task = baseTask({
    tools: {
      skills: ['project-memory'],
      mcpServers: ['Composio'],
    },
  });
  const prompt = buildRunPrompt(task, 'implement');
  assert.match(prompt, /Task steering/);
  assert.match(prompt, /project-memory/);
  assert.match(prompt, /Composio/);
  assert.match(prompt, /Implement the feature/);
});

test('buildTaskSteeringPreamble is empty without selections', () => {
  assert.equal(buildTaskSteeringPreamble(baseTask()), '');
});
