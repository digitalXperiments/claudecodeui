import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '../../../../../../shared/view/ui';
import { cn } from '../../../../../../lib/utils';
import { AGENT_NAMES } from '../../../../constants/constants';
import AgentListItem from '../AgentListItem';
import { filterAgents, type AgentListFilter } from '../filterAgents';
import type { AgentSelectorSectionProps } from '../types';

const FILTERS: AgentListFilter[] = ['all', 'connected', 'inChat'];

export default function AgentSelectorSection({
  agents,
  selectedAgent,
  onSelectAgent,
  agentContextById,
  isAgentEnabled,
}: AgentSelectorSectionProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AgentListFilter>('all');

  const connectedCount = agents.filter((agent) => agentContextById[agent].authStatus.authenticated).length;
  const inChatCount = agents.filter((agent) => isAgentEnabled(agent)).length;

  const visibleAgents = useMemo(
    () => filterAgents(agents, {
      query,
      filter,
      names: AGENT_NAMES,
      isConnected: (agent) => agentContextById[agent].authStatus.authenticated,
      isEnabled: isAgentEnabled,
    }),
    [agents, query, filter, agentContextById, isAgentEnabled],
  );

  const filterLabel = (id: AgentListFilter) => {
    if (id === 'all') {
      return t('agents.list.filterAll', { count: agents.length, defaultValue: `All ${agents.length}` });
    }
    if (id === 'connected') {
      return t('agents.list.filterConnected', { count: connectedCount, defaultValue: 'Connected' });
    }
    return t('agents.list.filterInChat', { count: inChatCount, defaultValue: 'In chat' });
  };

  return (
    <aside className="flex max-h-52 flex-shrink-0 flex-col border-b border-border bg-muted/20 md:max-h-none md:w-56 md:border-b-0 md:border-r">
      <div className="flex-shrink-0 space-y-2 p-2 md:p-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('agents.list.searchPlaceholder', { defaultValue: 'Search agents' })}
          aria-label={t('agents.list.searchPlaceholder', { defaultValue: 'Search agents' })}
          className="h-8 bg-background px-2 text-sm shadow-none"
        />
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                filter === id
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground',
              )}
            >
              {filterLabel(id)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2 md:px-2">
        {visibleAgents.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {t('agents.list.empty', { defaultValue: 'No agents match this filter.' })}
          </p>
        ) : (
          visibleAgents.map((agent) => (
            <AgentListItem
              key={agent}
              agentId={agent}
              authStatus={agentContextById[agent].authStatus}
              isSelected={selectedAgent === agent}
              isEnabled={isAgentEnabled(agent)}
              inChatLabel={t('agents.list.inChat', { defaultValue: 'In chat' })}
              hiddenLabel={t('agents.list.hidden', { defaultValue: 'Hidden' })}
              connectedLabel={t('agents.list.auth', { defaultValue: 'auth' })}
              offlineLabel={t('agents.list.offline', { defaultValue: 'offline' })}
              onClick={() => onSelectAgent(agent)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
