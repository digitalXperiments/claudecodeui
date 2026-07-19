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
  claudePermissions,
  onClaudePermissionsChange,
  cursorPermissions,
  onCursorPermissionsChange,
  grokPermissions,
  onGrokPermissionsChange,
  codexPermissionMode,
  onCodexPermissionModeChange,
  agyPermissionMode,
  onAgyPermissionModeChange,
  projects,
}: AgentsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { enabledProviders, isAgentEnabled, setAgentEnabled } = useAgentVisibility();
  const [selectedAgent, setSelectedAgent] = useState<AgentProvider>('claude');
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>('account');
  const visibleCategories = useMemo<AgentCategory[]>(() => {
    // Kimi has no fine-grained allow/deny rule mechanism (its ACP approval
    // flow is per-session mode, not per-rule settings), so there's nothing
    // real to show here - hide the tab rather than render it blank.
    if (selectedAgent === 'kimi') {
      return ['account', 'mcp', 'skills'];
    }
    // Antigravity exposes a run-mode permission model (plan / accept-edits /
    // skip) but no MCP or skills integration, so show account + permissions.
    if (selectedAgent === 'agy') {
      return ['account', 'permissions'];
    }
    return selectedAgent === 'opencode'
      ? ['account', 'permissions', 'mcp']
      : ['account', 'permissions', 'mcp', 'skills'];
  }, [selectedAgent]);

  const visibleAgents = useMemo<AgentProvider[]>(() => {
    return ['claude', 'cursor', 'codex', 'opencode', 'grok', 'kimi', 'agy'];
  }, []);

  const agentContextById = useMemo<Record<AgentProvider, AgentContext>>(() => ({
    claude: {
      authStatus: providerAuthStatus.claude,
      onLogin: () => onProviderLogin('claude'),
    },
    cursor: {
      authStatus: providerAuthStatus.cursor,
      onLogin: () => onProviderLogin('cursor'),
    },
    codex: {
      authStatus: providerAuthStatus.codex,
      onLogin: () => onProviderLogin('codex'),
    },
    opencode: {
      authStatus: providerAuthStatus.opencode,
      onLogin: () => onProviderLogin('opencode'),
    },
    grok: {
      authStatus: providerAuthStatus.grok,
      onLogin: () => onProviderLogin('grok'),
    },
    kimi: {
      authStatus: providerAuthStatus.kimi,
      onLogin: () => onProviderLogin('kimi'),
    },
    agy: {
      authStatus: providerAuthStatus.agy,
      onLogin: () => onProviderLogin('agy'),
    },
  }), [
    onProviderLogin,
    providerAuthStatus.claude,
    providerAuthStatus.codex,
    providerAuthStatus.cursor,
    providerAuthStatus.opencode,
    providerAuthStatus.grok,
    providerAuthStatus.kimi,
    providerAuthStatus.agy,
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
    <div className="-mx-4 -mb-4 -mt-2 flex min-h-[300px] min-w-0 flex-col overflow-hidden md:-mx-6 md:-mb-6 md:-mt-2 md:min-h-[500px]">
      <AgentSelectorSection
        agents={visibleAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        agentContextById={agentContextById}
        isAgentEnabled={isAgentEnabled}
      />

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

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
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
          agyPermissionMode={agyPermissionMode}
          onAgyPermissionModeChange={onAgyPermissionModeChange}
          projects={projects}
        />
      </div>
    </div>
  );
}
