import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useTheme } from '../../../contexts/ThemeContext';
import {
  PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT,
  PROVIDER_USAGE_DISABLED_PROVIDERS_KEY,
  PROVIDER_USAGE_LEGEND_COLLAPSED_KEY,
  PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT,
  readProviderUsageLegendCollapsed,
  readProviderUsageVisibility,
  writeProviderUsageLegendCollapsed,
  writeProviderUsageVisible,
  type ProviderUsageProviderId,
} from '../../../utils/providerUsagePreferences';
import { useQuickSettingsDrag } from '../hooks/useQuickSettingsDrag';
import type { PreferenceToggleKey, QuickSettingsPreferences } from '../types';

import QuickSettingsContent from './QuickSettingsContent';
import QuickSettingsHandle from './QuickSettingsHandle';
import QuickSettingsPanelHeader from './QuickSettingsPanelHeader';

export default function QuickSettingsPanelView() {
  const [isOpen, setIsOpen] = useState(false);
  const [providerUsageLegendCollapsed, setProviderUsageLegendCollapsed] = useState(
    readProviderUsageLegendCollapsed,
  );
  const [providerUsageVisibility, setProviderUsageVisibility] = useState(readProviderUsageVisibility);
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { isDarkMode } = useTheme();
  const { preferences, setPreference } = useUiPreferences();
  const {
    isDragging,
    handleStyle,
    startDrag,
    consumeSuppressedClick,
  } = useQuickSettingsDrag({ isMobile });

  const quickSettingsPreferences = useMemo<QuickSettingsPreferences>(() => ({
    showRawParameters: preferences.showRawParameters,
    showThinking: preferences.showThinking,
    sendByCtrlEnter: preferences.sendByCtrlEnter,
    voiceEnabled: preferences.voiceEnabled,
  }), [
    preferences.sendByCtrlEnter,
    preferences.showRawParameters,
    preferences.showThinking,
    preferences.voiceEnabled,
  ]);

  useEffect(() => {
    const syncCollapsed = () => {
      setProviderUsageLegendCollapsed(readProviderUsageLegendCollapsed());
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === PROVIDER_USAGE_LEGEND_COLLAPSED_KEY) syncCollapsed();
    };
    window.addEventListener(PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT, syncCollapsed);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(PROVIDER_USAGE_COLLAPSE_CHANGED_EVENT, syncCollapsed);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);

  useEffect(() => {
    const syncVisibility = () => setProviderUsageVisibility(readProviderUsageVisibility());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === PROVIDER_USAGE_DISABLED_PROVIDERS_KEY) syncVisibility();
    };
    window.addEventListener(PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT, syncVisibility);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(PROVIDER_USAGE_VISIBILITY_CHANGED_EVENT, syncVisibility);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);

  const handlePreferenceChange = useCallback(
    (key: PreferenceToggleKey, value: boolean) => {
      setPreference(key, value);
    },
    [setPreference],
  );

  const handleProviderUsageLegendCollapsedChange = useCallback((value: boolean) => {
    setProviderUsageLegendCollapsed(value);
    writeProviderUsageLegendCollapsed(value);
  }, []);

  const handleProviderUsageVisibilityChange = useCallback((providerId: ProviderUsageProviderId, value: boolean) => {
    setProviderUsageVisibility((current) => ({ ...current, [providerId]: value }));
    writeProviderUsageVisible(providerId, value);
  }, []);

  const handleToggleFromHandle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // A drag releases a click event as well; this guard prevents accidental toggles.
      if (consumeSuppressedClick()) {
        event.preventDefault();
        return;
      }

      setIsOpen((previous) => !previous);
    },
    [consumeSuppressedClick],
  );

  return (
    <>
      <QuickSettingsHandle
        isOpen={isOpen}
        isDragging={isDragging}
        style={handleStyle}
        onClick={handleToggleFromHandle}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
      />

      <div
        className={`fixed right-0 top-0 z-40 h-full w-64 transform border-l border-border bg-background shadow-xl transition-transform duration-150 ease-out ${isOpen ? 'translate-x-0' : 'translate-x-full'} ${isMobile ? 'h-screen' : ''}`}
      >
        <div className="flex h-full flex-col">
          <QuickSettingsPanelHeader />
          <QuickSettingsContent
            isDarkMode={isDarkMode}
            preferences={quickSettingsPreferences}
            providerUsageLegendCollapsed={providerUsageLegendCollapsed}
            providerUsageVisibility={providerUsageVisibility}
            onPreferenceChange={handlePreferenceChange}
            onProviderUsageLegendCollapsedChange={handleProviderUsageLegendCollapsedChange}
            onProviderUsageVisibilityChange={handleProviderUsageVisibilityChange}
          />
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-background/80 backdrop-blur-sm transition-opacity duration-150 ease-out"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
