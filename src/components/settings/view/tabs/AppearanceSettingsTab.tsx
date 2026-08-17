import { useTranslation } from 'react-i18next';

import { useTheme } from '../../../../contexts/ThemeContext';
import { useAppFeatures } from '../../../../hooks/useAppFeatures';
import type { CodeEditorSettingsState, ProjectSortOrder } from '../../types/types';
import LanguageSelector from '../../../../shared/view/ui/LanguageSelector';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import {
  PROVIDER_USAGE_PROVIDERS,
  type ProviderUsageProviderId,
  type ProviderUsageVisibility,
} from '../../../../utils/providerUsagePreferences';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
  providerUsageLegendCollapsed: boolean;
  providerUsageVisibility: ProviderUsageVisibility;
  onProviderUsageLegendCollapsedChange: (value: boolean) => void;
  onProviderUsageVisibilityChange: (providerId: ProviderUsageProviderId, value: boolean) => void;
};

export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
  providerUsageLegendCollapsed,
  providerUsageVisibility,
  onProviderUsageLegendCollapsedChange,
  onProviderUsageVisibilityChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { features, update } = useAppFeatures();
  const { themeMode, setThemeMode } = useTheme() as {
    themeMode: string;
    setThemeMode: (mode: string) => void;
  };

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.theme.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.theme.label')}
            description={t('appearanceSettings.theme.description')}
          >
            <select
              value={themeMode}
              onChange={(event) => setThemeMode(event.target.value)}
              aria-label={t('appearanceSettings.theme.label')}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground touch-manipulation focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="light">{t('appearanceSettings.theme.light')}</option>
              <option value="dark">{t('appearanceSettings.theme.dark')}</option>
              <option value="system">{t('appearanceSettings.theme.system')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground touch-manipulation focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('appearanceSettings.providerUsage.title', { defaultValue: 'Provider usage' })}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.providerUsage.collapsedLabel', { defaultValue: 'Minimize provider usage widget' })}
            description={t('appearanceSettings.providerUsage.collapsedDescription', {
              defaultValue: 'Keep provider usage as a small floating button until you open it.',
            })}
          >
            <SettingsToggle
              checked={providerUsageLegendCollapsed}
              onChange={onProviderUsageLegendCollapsedChange}
              ariaLabel={t('appearanceSettings.providerUsage.collapsedLabel', { defaultValue: 'Minimize provider usage widget' })}
            />
          </SettingsRow>
          {PROVIDER_USAGE_PROVIDERS.map(({ id, label }) => (
            <SettingsRow
              key={id}
              label={label}
              description={`Show ${label} in the provider usage rail when signed in.`}
            >
              <SettingsToggle
                checked={providerUsageVisibility[id]}
                onChange={(value) => onProviderUsageVisibilityChange(id, value)}
                ariaLabel={`Show ${label} usage`}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground touch-manipulation focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
            >
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.surfaces.title', { defaultValue: 'Surfaces' })}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.surfaces.kanban.label', { defaultValue: 'Kanban board' })}
            description={t('appearanceSettings.surfaces.kanban.description', {
              defaultValue: 'Show the Kanban rail button, panel, and Mission Control → board bridge. Off hides it completely.',
            })}
          >
            <SettingsToggle
              checked={features.kanbanEnabled}
              onChange={(value) => {
                void update({ kanbanEnabled: value });
              }}
              ariaLabel={t('appearanceSettings.surfaces.kanban.label', { defaultValue: 'Kanban board' })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.spend.title', { defaultValue: 'Live spend governor' })}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.spend.soft.label', { defaultValue: 'Soft cap (USD)' })}
            description={t('appearanceSettings.spend.soft.description', {
              defaultValue: 'Downgrade the next swarm seat (Opus → Sonnet → Haiku) once this swarm or chat crosses the cap. Empty = off.',
            })}
          >
            <input
              type="number"
              min={1}
              step={10}
              value={features.spendSoftCostUsd ?? ''}
              placeholder="off"
              onChange={(event) => {
                const raw = event.target.value.trim();
                void update({ spendSoftCostUsd: raw === '' ? null : Number(raw) });
              }}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground sm:w-28"
            />
          </SettingsRow>
          <SettingsRow
            label={t('appearanceSettings.spend.hard.label', { defaultValue: 'Hard cap (USD)' })}
            description={t('appearanceSettings.spend.hard.description', {
              defaultValue: 'Pause the swarm and put a Needs you card up. Empty = off.',
            })}
          >
            <input
              type="number"
              min={1}
              step={10}
              value={features.spendHardCostUsd ?? ''}
              placeholder="off"
              onChange={(event) => {
                const raw = event.target.value.trim();
                void update({ spendHardCostUsd: raw === '' ? null : Number(raw) });
              }}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground sm:w-28"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
