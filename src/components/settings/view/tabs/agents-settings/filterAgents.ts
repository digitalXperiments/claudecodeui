import type { AgentProvider } from '../../../types/types';

export type AgentListFilter = 'all' | 'connected' | 'inChat';

export function filterAgents(
  agents: AgentProvider[],
  options: {
    query: string;
    filter: AgentListFilter;
    names: Record<AgentProvider, string>;
    isConnected: (agent: AgentProvider) => boolean;
    isEnabled: (agent: AgentProvider) => boolean;
  },
): AgentProvider[] {
  const query = options.query.trim().toLowerCase();

  return agents.filter((agent) => {
    if (query && !options.names[agent].toLowerCase().includes(query)) {
      return false;
    }
    if (options.filter === 'connected') {
      return options.isConnected(agent);
    }
    if (options.filter === 'inChat') {
      return options.isEnabled(agent);
    }
    return true;
  });
}
