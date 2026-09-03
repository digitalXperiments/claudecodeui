import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ProviderLoginModal from '../../provider-auth/view/ProviderLoginModal';
import { Button } from '../../../shared/view/ui';
import SettingsSidebar from '../view/SettingsSidebar';
import AgentsSettingsTab from '../view/tabs/agents-settings/AgentsSettingsTab';
import AgentProfilesSettingsTab from '../view/tabs/AgentProfilesSettingsTab';
import StudioSettingsTab from '../view/tabs/StudioSettingsTab';
import EvalCenterSettingsTab from '../view/tabs/EvalCenterSettingsTab';
import SkillsSettingsTab from '../view/tabs/SkillsSettingsTab';
import McpSettingsTab from '../view/tabs/McpSettingsTab';
import MemorySettingsTab from '../view/tabs/MemorySettingsTab';
import AppearanceSettingsTab from '../view/tabs/AppearanceSettingsTab';
import CredentialsSettingsTab from '../view/tabs/api-settings/CredentialsSettingsTab';
import SecretsSettingsTab from '../view/tabs/SecretsSettingsTab';
import WebhooksSettingsTab from '../view/tabs/webhooks/WebhooksSettingsTab';
import VoiceSettingsTab from '../view/tabs/VoiceSettingsTab';
import GitSettingsTab from '../view/tabs/git-settings/GitSettingsTab';
import BrowserUseSettingsTab from '../view/tabs/browser-use-settings/BrowserUseSettingsTab';
import NotificationsSettingsTab from '../view/tabs/NotificationsSettingsTab';
import TasksSettingsTab from '../view/tabs/tasks-settings/TasksSettingsTab';
import PluginSettingsTab from '../../plugins/view/PluginSettingsTab';
import SecuritySettingsTab from '../view/tabs/security-settings/SecuritySettingsTab';
import AboutTab from '../view/tabs/AboutTab';
import { useSettingsController } from '../hooks/useSettingsController';
import { useWebPush } from '../../../hooks/useWebPush';
import type { SettingsProps } from '../types/types';
import { SETTINGS_MAIN_TABS } from '../constants/constants';
import {
  PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT,
  PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT,
  readProviderUsageLegendCollapsed,
  readProviderUsageVisibility,
  writeProviderUsageLegendCollapsed,
  writeProviderUsageVisible,
  type ProviderUsageProviderId,
} from '../../../utils/providerUsagePreferences';

type DesktopNotificationsState = {
  enabled: boolean;
  supported: boolean;
  connectedCount?: number;
  targetCount?: number;
  lastError?: string | null;
};

function Settings({ isOpen, onClose, projects = [], initialTab = 'agents' }: SettingsProps) {
  const { t } = useTranslation('settings');
  const desktopNotificationsBridge = useMemo(() => (
    typeof window === 'undefined'
      ? null
      : ((window as any).cloudcliDesktopNotifications || null)
  ), []);
  const [desktopNotificationsState, setDesktopNotificationsState] = useState<DesktopNotificationsState | null>(null);
  const [providerUsageLegendCollapsed, setProviderUsageLegendCollapsed] = useState(readProviderUsageLegendCollapsed);
  const [providerUsageVisibility, setProviderUsageVisibility] = useState(readProviderUsageVisibility);

  useEffect(() => {
    const syncCollapsed = () => {
      setProviderUsageLegendCollapsed(readProviderUsageLegendCollapsed());
    };
    const syncVisibility = () => setProviderUsageVisibility(readProviderUsageVisibility());
    window.addEventListener(PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT, syncCollapsed);
    window.addEventListener(PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT, syncVisibility);
    return () => {
      window.removeEventListener(PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT, syncCollapsed);
      window.removeEventListener(PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT, syncVisibility);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);
  const {
    activeTab,
    setActiveTab,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    notificationPreferences,
    setNotificationPreferences,
    cursorPermissions,
    setCursorPermissions,
    grokPermissions,
    setGrokPermissions,
    codexPermissionMode,
    setCodexPermissionMode,
    kiloPermissionMode,
    setKiloPermissionMode,
    piPermissionMode,
    ompPermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    closeLoginModal,
    loginProvider,
    handleLoginComplete,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useSettingsController({
    isOpen,
    initialTab
  });

  const {
    permission: pushPermission,
    isSubscribed: isPushSubscribed,
    isLoading: isPushLoading,
    subscribe: pushSubscribe,
    unsubscribe: pushUnsubscribe,
  } = useWebPush();

  const handleEnablePush = async () => {
    await pushSubscribe();
    // Server sets webPush: true in preferences on subscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: true },
    });
  };

  const handleDisablePush = async () => {
    await pushUnsubscribe();
    // Server sets webPush: false in preferences on unsubscribe; sync local state
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, webPush: false },
    });
  };

  useEffect(() => {
    if (!desktopNotificationsBridge) return undefined;
    let mounted = true;
    desktopNotificationsBridge.getState().then((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    }).catch(() => {});
    const unsubscribe = desktopNotificationsBridge.onStateUpdated?.((state: any) => {
      if (mounted) {
        setDesktopNotificationsState(state?.desktopNotifications || null);
      }
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [desktopNotificationsBridge]);

  const handleProviderUsageLegendCollapsedChange = (collapsed: boolean) => {
    setProviderUsageLegendCollapsed(collapsed);
    writeProviderUsageLegendCollapsed(collapsed);
  };

  const handleProviderUsageVisibilityChange = (providerId: ProviderUsageProviderId, visible: boolean) => {
    setProviderUsageVisibility((current) => ({ ...current, [providerId]: visible }));
    writeProviderUsageVisible(providerId, visible);
  };

  const handleEnableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: true });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: true },
    });
  };

  const handleDisableDesktopNotifications = async () => {
    if (!desktopNotificationsBridge) return;
    const state = await desktopNotificationsBridge.update({ enabled: false });
    setDesktopNotificationsState(state?.desktopNotifications || null);
    setNotificationPreferences({
      ...notificationPreferences,
      channels: { ...notificationPreferences.channels, desktop: false },
    });
  };

  if (!isOpen) {
    return null;
  }

  const isAuthenticated = Boolean(loginProvider && providerAuthStatus[loginProvider].authenticated);
  const activeTabLabel = SETTINGS_MAIN_TABS.find((tab) => tab.id === activeTab)?.label ?? 'Settings';

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[10050] flex items-stretch justify-center bg-background md:items-center md:bg-background/80 md:p-4 md:backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="flex h-dvh max-h-dvh w-full flex-col overflow-hidden border-0 bg-background shadow-none md:h-[94vh] md:max-h-[94vh] md:w-[calc(100vw-2rem)] md:max-w-[1600px] md:rounded-2xl md:border md:border-border/80 md:shadow-2xl"
      >
        {/* Header */}
        <div className="flex min-h-16 flex-shrink-0 items-center justify-between border-b border-border/70 bg-background/95 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-5 md:pt-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 id="settings-dialog-title" className="shrink-0 text-base font-semibold text-foreground">{t('title')}</h2>
            <span className="hidden text-muted-foreground/50 sm:inline">/</span>
            <span className="hidden truncate text-sm text-muted-foreground sm:inline">{activeTabLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            {saveStatus === 'success' && (
              <span className="animate-in fade-in text-xs text-muted-foreground">{t('saveStatus.success')}</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Close settings"
              className="h-10 w-10 touch-manipulation p-0 text-muted-foreground hover:text-foreground active:bg-accent/50"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Body: sidebar + content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <SettingsSidebar activeTab={activeTab} onChange={setActiveTab} />

          {/* Content */}
          <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-background">
            <div key={activeTab} className="settings-content-enter min-w-0 space-y-6 overflow-x-hidden p-4 pb-safe-area-inset-bottom sm:p-5 md:space-y-8 lg:p-8">
              {activeTab === 'appearance' && (
                <AppearanceSettingsTab
                  projectSortOrder={projectSortOrder}
                  onProjectSortOrderChange={setProjectSortOrder}
                  codeEditorSettings={codeEditorSettings}
                  onCodeEditorWordWrapChange={(value) => updateCodeEditorSetting('wordWrap', value)}
                  onCodeEditorShowMinimapChange={(value) => updateCodeEditorSetting('showMinimap', value)}
                  onCodeEditorLineNumbersChange={(value) => updateCodeEditorSetting('lineNumbers', value)}
                  onCodeEditorFontSizeChange={(value) => updateCodeEditorSetting('fontSize', value)}
                  providerUsageLegendCollapsed={providerUsageLegendCollapsed}
                  providerUsageVisibility={providerUsageVisibility}
                  onProviderUsageLegendCollapsedChange={handleProviderUsageLegendCollapsedChange}
                  onProviderUsageVisibilityChange={handleProviderUsageVisibilityChange}
                />
              )}

              {activeTab === 'git' && <GitSettingsTab />}

              {activeTab === 'agents' && (
                <AgentsSettingsTab
                  providerAuthStatus={providerAuthStatus}
                  onProviderLogin={openLoginForProvider}
                  onProviderAuthRefresh={(provider) => {
                    if (provider) {
                      void checkProviderAuthStatus(provider);
                      return;
                    }
                    void refreshProviderAuthStatuses();
                  }}
                  claudePermissions={claudePermissions}
                  onClaudePermissionsChange={setClaudePermissions}
                  cursorPermissions={cursorPermissions}
                  onCursorPermissionsChange={setCursorPermissions}
                  grokPermissions={grokPermissions}
                  onGrokPermissionsChange={setGrokPermissions}
                  codexPermissionMode={codexPermissionMode}
                  onCodexPermissionModeChange={setCodexPermissionMode}
                  kiloPermissionMode={kiloPermissionMode}
                  onKiloPermissionModeChange={setKiloPermissionMode}
                  piPermissionMode={piPermissionMode}
                  ompPermissionMode={ompPermissionMode}
                  onPiPermissionModeChange={setPiPermissionMode}
                  onOmpPermissionModeChange={setOmpPermissionMode}
                  projects={projects}
                />
              )}

              {activeTab === 'agent-profiles' && <AgentProfilesSettingsTab />}

              {activeTab === 'studio' && <StudioSettingsTab />}

              {activeTab === 'evals' && <EvalCenterSettingsTab projects={projects} />}

              {activeTab === 'mcp' && <McpSettingsTab projects={projects} />}

              {activeTab === 'skills' && <SkillsSettingsTab projects={projects} />}

              {activeTab === 'memory' && <MemorySettingsTab projects={projects} />}

              {activeTab === 'tasks' && <TasksSettingsTab />}

              {activeTab === 'browser' && <BrowserUseSettingsTab />}

              {activeTab === 'notifications' && (
                <NotificationsSettingsTab
                  notificationPreferences={notificationPreferences}
                  onNotificationPreferencesChange={setNotificationPreferences}
                  pushPermission={pushPermission}
                  isPushSubscribed={isPushSubscribed}
                  isPushLoading={isPushLoading}
                  onEnablePush={handleEnablePush}
                  onDisablePush={handleDisablePush}
                  isDesktop={Boolean(desktopNotificationsBridge)}
                  desktopNotifications={desktopNotificationsState}
                  onEnableDesktopNotifications={handleEnableDesktopNotifications}
                  onDisableDesktopNotifications={handleDisableDesktopNotifications}
                />
              )}

              {activeTab === 'api' && <CredentialsSettingsTab />}

              {activeTab === 'secrets' && <SecretsSettingsTab />}

              {activeTab === 'webhooks' && <WebhooksSettingsTab />}

              {activeTab === 'voice' && <VoiceSettingsTab />}

              {activeTab === 'plugins' && <PluginSettingsTab />}

              {activeTab === 'security' && <SecuritySettingsTab />}

              {activeTab === 'about' && <AboutTab />}
            </div>
          </main>
        </div>
      </div>

      <ProviderLoginModal
        key={loginProvider || 'claude'}
        isOpen={showLoginModal}
        onClose={closeLoginModal}
        provider={loginProvider || 'claude'}
        onComplete={handleLoginComplete}
        isAuthenticated={isAuthenticated}
      />

    </div>
  );
}

export default Settings;
