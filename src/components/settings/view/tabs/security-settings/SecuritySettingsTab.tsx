import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../../../../../utils/api';
import { Button, Input } from '../../../../../shared/view/ui';
import SettingsCard from '../../SettingsCard';
import SettingsSection from '../../SettingsSection';

type TotpStatus = {
  enabled: boolean;
  pending: boolean;
};

type SetupPayload = {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
};

/**
 * Security settings: manage TOTP-based two-factor authentication.
 * Enable flow: fetch a fresh secret + QR code, then confirm with a valid
 * code from the authenticator app. Disable flow: confirm with the password.
 */
export default function SecuritySettingsTab() {
  const { t } = useTranslation('settings');

  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  // Enable flow state
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const [setupCode, setSetupCode] = useState('');
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);

  // Disable flow state
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [isDisabling, setIsDisabling] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await api.auth.twoFactor.status();
      if (response.ok) {
        setStatus(await response.json());
      }
    } catch (error) {
      console.error('Failed to load 2FA status:', error);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleStartSetup = useCallback(async () => {
    setErrorMessage('');
    setIsSettingUp(true);
    try {
      const response = await api.auth.twoFactor.setup();
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setErrorMessage(payload?.error || t('security.errors.generic'));
        return;
      }
      setSetup(payload);
      setSetupCode('');
    } catch (error) {
      console.error('2FA setup error:', error);
      setErrorMessage(t('security.errors.generic'));
    } finally {
      setIsSettingUp(false);
    }
  }, [t]);

  const handleCancelSetup = useCallback(() => {
    setSetup(null);
    setSetupCode('');
    setErrorMessage('');
  }, []);

  const handleEnable = useCallback(async () => {
    setErrorMessage('');
    setIsEnabling(true);
    try {
      const response = await api.auth.twoFactor.enable(setupCode.trim());
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setErrorMessage(payload?.error || t('security.errors.invalidCode'));
        return;
      }
      setSetup(null);
      setSetupCode('');
      await refreshStatus();
    } catch (error) {
      console.error('2FA enable error:', error);
      setErrorMessage(t('security.errors.generic'));
    } finally {
      setIsEnabling(false);
    }
  }, [refreshStatus, setupCode, t]);

  const handleDisable = useCallback(async () => {
    setErrorMessage('');
    setIsDisabling(true);
    try {
      const response = await api.auth.twoFactor.disable(disablePassword);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setErrorMessage(payload?.error || t('security.errors.invalidPassword'));
        return;
      }
      setShowDisable(false);
      setDisablePassword('');
      await refreshStatus();
    } catch (error) {
      console.error('2FA disable error:', error);
      setErrorMessage(t('security.errors.generic'));
    } finally {
      setIsDisabling(false);
    }
  }, [disablePassword, refreshStatus, t]);

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('security.title')}
        description={t('security.description')}
      >
        <SettingsCard className="p-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                {status?.enabled ? (
                  <ShieldCheck className="h-5 w-5 text-green-600 dark:text-green-400" />
                ) : (
                  <ShieldOff className="h-5 w-5 text-muted-foreground" />
                )}
                <div>
                  <div className="text-sm font-medium text-foreground">
                    {t('security.twofa.label')}
                  </div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    {status?.enabled
                      ? t('security.status.enabled')
                      : t('security.status.disabled')}
                  </div>
                </div>
              </div>

              {status && !status.enabled && !setup && (
                <Button onClick={handleStartSetup} disabled={isSettingUp}>
                  {isSettingUp ? t('security.actions.starting') : t('security.actions.enable')}
                </Button>
              )}
              {status?.enabled && !showDisable && (
                <Button variant="outline" onClick={() => { setShowDisable(true); setErrorMessage(''); }}>
                  {t('security.actions.disable')}
                </Button>
              )}
            </div>

            {setup && (
              <div className="space-y-4 rounded-lg border border-border p-4">
                <p className="text-sm text-muted-foreground">{t('security.setup.scanQr')}</p>
                <div className="flex justify-center">
                  <img
                    src={setup.qrCodeDataUrl}
                    alt={t('security.setup.qrAlt')}
                    className="h-48 w-48 rounded-lg bg-white p-2"
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('security.setup.manualEntry')}
                  </div>
                  <code className="block break-all rounded-md bg-muted px-3 py-2 font-mono text-sm text-foreground">
                    {setup.secret}
                  </code>
                </div>
                <div>
                  <label htmlFor="settings-2fa-code" className="mb-2 block text-sm font-medium text-foreground">
                    {t('security.setup.codeLabel')}
                  </label>
                  <Input
                    id="settings-2fa-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={setupCode}
                    onChange={(event) => setSetupCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    disabled={isEnabling}
                    className="w-full"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleEnable}
                    disabled={isEnabling || setupCode.trim().length !== 6}
                  >
                    {isEnabling ? t('security.actions.verifying') : t('security.actions.verifyAndEnable')}
                  </Button>
                  <Button variant="outline" onClick={handleCancelSetup} disabled={isEnabling}>
                    {t('security.actions.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {showDisable && status?.enabled && (
              <div className="space-y-4 rounded-lg border border-border p-4">
                <p className="text-sm text-muted-foreground">{t('security.disable.confirmHelp')}</p>
                <div>
                  <label htmlFor="settings-2fa-disable-password" className="mb-2 block text-sm font-medium text-foreground">
                    {t('security.disable.passwordLabel')}
                  </label>
                  <Input
                    id="settings-2fa-disable-password"
                    type="password"
                    autoComplete="current-password"
                    value={disablePassword}
                    onChange={(event) => setDisablePassword(event.target.value)}
                    disabled={isDisabling}
                    className="w-full"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="destructive"
                    onClick={handleDisable}
                    disabled={isDisabling || !disablePassword}
                  >
                    {isDisabling ? t('security.actions.disabling') : t('security.actions.confirmDisable')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => { setShowDisable(false); setDisablePassword(''); setErrorMessage(''); }}
                    disabled={isDisabling}
                  >
                    {t('security.actions.cancel')}
                  </Button>
                </div>
              </div>
            )}

            {errorMessage && (
              <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
            )}

            {status?.enabled && !errorMessage && !showDisable && (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <Check className="h-4 w-4" />
                {t('security.status.protected')}
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
