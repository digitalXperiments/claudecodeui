import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_NAMES } from '../../../constants/constants';
import type { AgentProvider } from '../../../types/types';
import { filterAgents } from './filterAgents';

const agents: AgentProvider[] = ['claude', 'cursor', 'codex', 'grok'];

describe('filterAgents', () => {
  it('filters by name query', () => {
    assert.deepEqual(filterAgents(agents, {
      query: 'gro',
      filter: 'all',
      names: AGENT_NAMES,
      isConnected: () => true,
      isEnabled: () => true,
    }), ['grok']);
  });

  it('keeps only connected agents', () => {
    assert.deepEqual(filterAgents(agents, {
      query: '',
      filter: 'connected',
      names: AGENT_NAMES,
      isConnected: (agent) => agent !== 'cursor',
      isEnabled: () => true,
    }), ['claude', 'codex', 'grok']);
  });

  it('keeps only agents shown in chat', () => {
    assert.deepEqual(filterAgents(agents, {
      query: '',
      filter: 'inChat',
      names: AGENT_NAMES,
      isConnected: () => true,
      isEnabled: (agent) => agent === 'claude' || agent === 'codex',
    }), ['claude', 'codex']);
  });
});
