import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRoster } from '@/modules/swarm/swarm.service.js';
import type { StartSwarmInput } from '@/modules/swarm/swarm.types.js';

function baseInput(overrides: Partial<StartSwarmInput> = {}): StartSwarmInput {
  return {
    projectId: 'proj-1',
    goal: 'test goal',
    ...overrides,
  };
}

test('resolveRoster defaults the orchestrator to bypassPermissions when nothing is specified', () => {
  const { orchestrator } = resolveRoster(baseInput());
  assert.equal(orchestrator.kind, 'orchestrator');
  assert.equal(orchestrator.permissionMode, 'bypassPermissions');
});

test('resolveRoster respects an explicit swarm-level permissionMode with no agents specified at all', () => {
  // This is the exact path that used the DEFAULT_ROSTER template directly
  // (no agents/roles/orchestrator supplied) — hardcoding permissionMode onto
  // that template made it act like an explicit per-seat value and wrongly
  // outrank this swarm-level default.
  const { orchestrator, config } = resolveRoster(baseInput({ permissionMode: 'default' }));
  assert.equal(orchestrator.permissionMode, 'default');
  assert.equal(config.orchestrator.permissionMode, 'default');
});

test('resolveRoster preserves an explicit orchestrator permissionMode', () => {
  const { orchestrator } = resolveRoster(
    baseInput({
      orchestrator: {
        kind: 'orchestrator',
        label: 'Orchestrator',
        permissionMode: 'default',
      },
    }),
  );
  assert.equal(orchestrator.permissionMode, 'default');
});

test('resolveRoster preserves an explicit orchestrator seat inside agents[]', () => {
  const { orchestrator } = resolveRoster(
    baseInput({
      agents: [
        { kind: 'orchestrator', label: 'Orchestrator', permissionMode: 'plan' },
        { kind: 'implementer', label: 'Implementer' },
      ],
    }),
  );
  assert.equal(orchestrator.permissionMode, 'plan');
});

test('resolveRoster respects an explicit swarm-level permissionMode fallback for the orchestrator', () => {
  const { orchestrator } = resolveRoster(
    baseInput({
      permissionMode: 'acceptEdits',
      agents: [{ kind: 'orchestrator', label: 'Orchestrator' }],
    }),
  );
  assert.equal(orchestrator.permissionMode, 'acceptEdits');
});

test('resolveRoster does not default non-orchestrator seats to bypassPermissions', () => {
  const { config } = resolveRoster(
    baseInput({
      agents: [
        { kind: 'orchestrator', label: 'Orchestrator' },
        { kind: 'implementer', label: 'Implementer' },
      ],
    }),
  );
  const implementer = config.agents.find((a) => a.kind === 'implementer');
  assert.ok(implementer);
  assert.equal(implementer!.permissionMode, null);
});
