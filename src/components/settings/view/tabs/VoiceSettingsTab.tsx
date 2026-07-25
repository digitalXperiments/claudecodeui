import type { InputHTMLAttributes } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import {
  browserSpeechSupported,
  type SttProvider,
  useVoiceConfig,
} from '../../../../hooks/useVoiceConfig';
import { authenticatedFetch } from '../../../../utils/api';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function Field({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input className={inputClass} {...props} />
    </label>
  );
}

type LocalSttHealth = {
  available: boolean;
  engine: string | null;
  model: string;
  hasFfmpeg: boolean;
};

export default function VoiceSettingsTab() {
  const { t } = useTranslation('settings');
  const { preferences, setPreference } = useUiPreferences();
  const { config, update } = useVoiceConfig();
  const voiceEnabled = preferences.voiceEnabled;
  const [localStt, setLocalStt] = useState<LocalSttHealth | null>(null);

  useEffect(() => {
    let active = true;
    authenticatedFetch('/api/voice/health')
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (!active || !data?.localStt) return;
        setLocalStt({
          available: Boolean(data.localStt.available),
          engine: data.localStt.engine ?? null,
          model: data.localStt.model || 'base',
          hasFfmpeg: Boolean(data.localStt.hasFfmpeg),
        });
      })
      .catch(() => {
        if (active) setLocalStt(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const showApiFields =
    config.sttProvider === 'api' ||
    config.sttProvider === 'auto' ||
    Boolean(config.baseUrl.trim());

  return (
    <div className="space-y-8">
      <SettingsSection title={t('voiceSettings.title')} description={t('voiceSettings.description')}>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="pr-3">
            <div className="text-sm font-medium text-foreground">{t('voiceSettings.enable')}</div>
            <div className="text-xs text-muted-foreground">{t('voiceSettings.enableDescription')}</div>
          </div>
          <SettingsToggle
            checked={voiceEnabled}
            onChange={(v) => setPreference('voiceEnabled', v)}
            ariaLabel={t('voiceSettings.enable')}
          />
        </div>
      </SettingsSection>

      {voiceEnabled && (
        <>
          <SettingsSection
            title={t('voiceSettings.sttTitle')}
            description={t('voiceSettings.sttDescription')}
          >
            <div className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-medium text-foreground">{t('voiceSettings.sttProvider')}</span>
                <select
                  className={inputClass}
                  value={config.sttProvider}
                  onChange={(e) => update({ sttProvider: e.target.value as SttProvider })}
                >
                  <option value="auto">{t('voiceSettings.sttProviderAuto')}</option>
                  <option value="local">{t('voiceSettings.sttProviderLocal')}</option>
                  <option value="browser">{t('voiceSettings.sttProviderBrowser')}</option>
                  <option value="api">{t('voiceSettings.sttProviderApi')}</option>
                </select>
              </label>

              {localStt && (
                <div
                  className={`rounded-lg border p-3 text-xs ${
                    localStt.available
                      ? 'border-emerald-500/40 bg-emerald-500/5 text-foreground'
                      : 'border-border bg-muted/30 text-muted-foreground'
                  }`}
                >
                  {localStt.available ? (
                    <>
                      <div className="font-medium text-sm text-foreground">
                        {t('voiceSettings.localReady', {
                          engine: localStt.engine === 'whisperkit' ? 'WhisperKit' : localStt.engine || 'local',
                        })}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {t('voiceSettings.localReadyDetail', { model: localStt.model })}
                        {!localStt.hasFfmpeg
                          ? ` ${t('voiceSettings.localMissingFfmpeg')}`
                          : ''}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="font-medium text-sm text-foreground">
                        {t('voiceSettings.localMissing')}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        brew install whisperkit-cli ffmpeg
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {t('voiceSettings.localMissingHint')}
                      </div>
                    </>
                  )}
                </div>
              )}

              {config.sttProvider === 'browser' && (
                <p className="text-xs text-muted-foreground">
                  {browserSpeechSupported()
                    ? t('voiceSettings.browserOk')
                    : t('voiceSettings.browserMissing')}
                </p>
              )}

              {(config.sttProvider === 'local' || config.sttProvider === 'auto') && (
                <Field
                  label={t('voiceSettings.localModel')}
                  placeholder="base"
                  value={config.sttModel}
                  onChange={(e) => update({ sttModel: e.target.value })}
                />
              )}
              <p className="text-xs text-muted-foreground">{t('voiceSettings.localModelHint')}</p>
            </div>
          </SettingsSection>

          {showApiFields && (
            <SettingsSection
              title={t('voiceSettings.backendTitle')}
              description={t('voiceSettings.backendDescription')}
            >
              <div className="space-y-4">
                <Field
                  label={t('voiceSettings.baseUrl')}
                  placeholder="https://api.openai.com/v1"
                  value={config.baseUrl}
                  onChange={(e) => update({ baseUrl: e.target.value })}
                />
                <Field
                  label={t('voiceSettings.apiKey')}
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…"
                  value={config.apiKey}
                  onChange={(e) => update({ apiKey: e.target.value })}
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field
                    label={t('voiceSettings.ttsModel')}
                    placeholder="tts-1"
                    value={config.ttsModel}
                    onChange={(e) => update({ ttsModel: e.target.value })}
                  />
                  <Field
                    label={t('voiceSettings.voice')}
                    placeholder="alloy"
                    value={config.ttsVoice}
                    onChange={(e) => update({ ttsVoice: e.target.value })}
                  />
                  <Field
                    label={t('voiceSettings.format')}
                    placeholder="mp3"
                    value={config.ttsFormat}
                    onChange={(e) => update({ ttsFormat: e.target.value })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t('voiceSettings.note')}</p>
              </div>
            </SettingsSection>
          )}
        </>
      )}
    </div>
  );
}
