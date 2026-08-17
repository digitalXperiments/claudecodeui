import { Gauge, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { DarkModeToggle } from '../../../shared/view/ui';
import LanguageSelector from '../../../shared/view/ui/LanguageSelector';
import SessionProviderLogo from '../../llm-logo-provider/SessionProviderLogo';
import {
  PROVIDER_USAGE_PROVIDERS,
  type ProviderUsageProviderId,
  type ProviderUsageVisibility,
} from '../../../utils/providerUsagePreferences';
import {
  CHECKBOX_CLASS,
  INPUT_SETTING_TOGGLES,
  SETTING_ROW_CLASS,
  TOGGLE_ROW_CLASS,
  TOOL_DISPLAY_TOGGLES,
} from '../constants';
import type {
  PreferenceToggleItem,
  PreferenceToggleKey,
  QuickSettingsPreferences,
} from '../types';

import QuickSettingsSection from './QuickSettingsSection';
import QuickSettingsToggleRow from './QuickSettingsToggleRow';

type QuickSettingsContentProps = {
  isDarkMode: boolean;
  preferences: QuickSettingsPreferences;
  providerUsageLegendCollapsed: boolean;
  providerUsageVisibility: ProviderUsageVisibility;
  onPreferenceChange: (key: PreferenceToggleKey, value: boolean) => void;
  onProviderUsageLegendCollapsedChange: (value: boolean) => void;
  onProviderUsageVisibilityChange: (providerId: ProviderUsageProviderId, value: boolean) => void;
};

export default function QuickSettingsContent({
  isDarkMode,
  preferences,
  providerUsageLegendCollapsed,
  providerUsageVisibility,
  onPreferenceChange,
  onProviderUsageLegendCollapsedChange,
  onProviderUsageVisibilityChange,
}: QuickSettingsContentProps) {
  const { t } = useTranslation('settings');
  const inputSettingToggles = preferences.voiceEnabled
    ? INPUT_SETTING_TOGGLES
    : INPUT_SETTING_TOGGLES.filter(({ key }) => key !== 'voiceEnabled');

  const renderToggleRows = (items: PreferenceToggleItem[]) => (
    items.map(({ key, labelKey, icon }) => (
      <QuickSettingsToggleRow
        key={key}
        label={t(labelKey)}
        icon={icon}
        checked={preferences[key]}
        onCheckedChange={(value) => onPreferenceChange(key, value)}
      />
    ))
  );

  return (
    <div className="flex-1 space-y-6 overflow-y-auto overflow-x-hidden bg-background p-4">
      <QuickSettingsSection title={t('quickSettings.sections.appearance')}>
        <div className={SETTING_ROW_CLASS}>
          <span className="flex items-center gap-2 text-sm text-foreground">
            {isDarkMode ? (
              <Moon className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Sun className="h-4 w-4 text-muted-foreground" />
            )}
            {t('quickSettings.darkMode')}
          </span>
          <DarkModeToggle />
        </div>
        <LanguageSelector compact />
        <QuickSettingsToggleRow
          label={t('quickSettings.collapseProviderUsage', {
            defaultValue: 'Minimize usage widget',
          })}
          icon={Gauge}
          checked={providerUsageLegendCollapsed}
          onCheckedChange={onProviderUsageLegendCollapsedChange}
        />
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.providerUsage', { defaultValue: 'Provider usage' })}>
        {PROVIDER_USAGE_PROVIDERS.map(({ id, label }) => (
          <label key={id} className={TOGGLE_ROW_CLASS}>
            <span className="flex items-center gap-2 text-sm text-foreground">
              <SessionProviderLogo provider={id} className="h-4 w-4" />
              {label}
            </span>
            <input
              type="checkbox"
              checked={providerUsageVisibility[id]}
              onChange={(event) => onProviderUsageVisibilityChange(id, event.target.checked)}
              className={CHECKBOX_CLASS}
              aria-label={`Show ${label} usage`}
            />
          </label>
        ))}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.toolDisplay')}>
        {renderToggleRows(TOOL_DISPLAY_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.inputSettings')}>
        {renderToggleRows(inputSettingToggles)}
        <p className="ml-3 text-xs text-muted-foreground">
          {t('quickSettings.sendByCtrlEnterDescription')}
        </p>
      </QuickSettingsSection>
    </div>
  );
}
