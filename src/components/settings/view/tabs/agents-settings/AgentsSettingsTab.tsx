import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAgentVisibility } from '../../../../../hooks/useAgentVisibility';
import { AGENT_NAMES } from '../../../constants/constants';
import SettingsToggle from '../../SettingsToggle';
import type { AgentCategory, AgentProvider } from '../../../types/types';

import type { AgentContext, AgentsSettingsTabProps } from './types';
import AgentCategoryContentSection from './sections/AgentCategoryContentSection';
import AgentCategoryTabsSection from './sections/AgentCategoryTabsSection';
import AgentSelectorSection from './sections/AgentSelectorSection';

export default function AgentsSettingsTab({
  providerAuthStatus,
  onProviderLogin,
  onProviderAuthRefresh,
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  grokPermissions,
  onGrokPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  kiloPermissionMode,
  onKiloPermissionModeChange,
  piPermissionMode,
  onPiPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { enabledProviders, isAgentEnabled, setAgentEnabled } = useAgentVisibility();
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const visibleCategories = useMemo<AgentCategory[]>(() => {
    // MCP and Skills are managed in dedicated top-level Settings tabs
    // (catalog + explicit fan-out). Agent settings keep account + permissions.
    // Kimi has no fine-grained allow/deny rule mechanism.
    if (selectedAgent === 'kimi') {
      return ['account', 'models'];
    }
    return ['account', 'models', 'permissions'];
  }, [selectedAgent]);

  useEffect(() => {
    if (!visibleCategories.includes(selectedCategory)) {
      setSelectedCategory(visibleCategories[0] ?? 'account');
    }
  }, [visibleCategories, selectedCategory]);

  const visibleAgents = useMemo<AgentProvider[]>(() => {
    return ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'qwencode', 'pi'];
  }, []);

  const agentContextById = useMemo<Record<AgentProvider, AgentContext>>(() => {
    const refresh = (provider: AgentProvider) => {
      onProviderAuthRefresh?.(provider);
    };
    return {
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
      onRefresh: () => refresh('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
      onRefresh: () => refresh('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
      onRefresh: () => refresh('codex'),
    },
    opencode: {
      authStatus: providerAuthStatus.opencode,
      onLogin: () => onProviderLogin('opencode'),
      onRefresh: () => refresh('opencode'),
    },
    kilo: {
      authStatus: providerAuthStatus.kilo,
      onLogin: () => onProviderLogin('kilo'),
      onRefresh: () => refresh('kilo'),
    },
    cline: {
      authStatus: providerAuthStatus.cline,
      onLogin: () => onProviderLogin('cline'),
      onRefresh: () => refresh('cline'),
    },
    grok: {
      authStatus: providerAuthStatus.grok,
      onLogin: () => onProviderLogin('grok'),
      onRefresh: () => refresh('grok'),
    },
    kimi: {
      authStatus: providerAuthStatus.kimi,
      onLogin: () => onProviderLogin('kimi'),
      onRefresh: () => refresh('kimi'),
    },
    qwencode: {
      authStatus: providerAuthStatus.qwencode,
      onLogin: () => onProviderLogin('qwencode'),
      onRefresh: () => refresh('qwencode'),
    },
    pi: {
      authStatus: providerAuthStatus.pi,
      onLogin: () => onProviderLogin('pi'),
      onRefresh: () => refresh('pi'),
    },
  };
  }, [
    onProviderLogin,
    onProviderAuthRefresh,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.opencode,
    providerAuthStatus.kilo,
    providerAuthStatus.cline,
    providerAuthStatus.grok,
    providerAuthStatus.kimi,
    providerAuthStatus.qwencode,
    providerAuthStatus.pi,
  ]);

  useEffect(() => {
    if (!visibleCategories.includes(selectedCategory)) {
      setSelectedCategory(visibleCategories[0] ?? 'account');
    }
  }, [selectedCategory, visibleCategories]);

  const selectedAgentEnabled = isAgentEnabled(selectedAgent);
  // Chat always needs at least one provider, so the last enabled agent
  // cannot be turned off.
  const isLastEnabledAgent = selectedAgentEnabled && enabledProviders.length === 1;

  return (
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px] md:flex-row">
      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
        isAgentEnabled={isAgentEnabled}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 md:px-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {t('agents.visibility.label', { agent: AGENT_NAMES[selectedAgent] })}
            </p>
            <p className="text-xs text-muted-foreground">
              {isLastEnabledAgent
                ? t('agents.visibility.lastEnabledHint')
                : t('agents.visibility.description', { agent: AGENT_NAMES[selectedAgent] })}
            </p>
          </div>
          <SettingsToggle
            checked={selectedAgentEnabled}
            disabled={isLastEnabledAgent}
            onChange={(enabled) => setAgentEnabled(selectedAgent, enabled)}
            ariaLabel={t('agents.visibility.label', { agent: AGENT_NAMES[selectedAgent] })}
          />
        </div>

        <AgentCategoryTabsSection
          categories={visibleCategories}
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
        />

        <AgentCategoryContentSection
          selectedAgent={selectedAgent}
          selectedCategory={selectedCategory}
          agentContextById={agentContextById}
          claudePermissions={claudePermissions}
          onClaudePermissionsChange={onClaudePermissionsChange}
          cursorPermissions={cursorPermissions}
          onCursorPermissionsChange={onCursorPermissionsChange}
          grokPermissions={grokPermissions}
          onGrokPermissionsChange={onGrokPermissionsChange}
          codexPermissionMode={codexPermissionMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          kiloPermissionMode={kiloPermissionMode}
          onKiloPermissionModeChange={onKiloPermissionModeChange}
          piPermissionMode={piPermissionMode}
          onPiPermissionModeChange={onPiPermissionModeChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
