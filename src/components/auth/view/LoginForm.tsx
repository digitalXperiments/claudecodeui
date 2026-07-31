import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, ShieldCheck, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

/**
 * Login form component.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 * When the account has two-factor authentication enabled, the form switches
 * to a second step asking for the 6-digit authenticator code.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { login } = useAuth();

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [awaitingTotp, setAwaitingTotp] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleBackToPassword = useCallback(() => {
    setAwaitingTotp(false);
    setTotpCode('');
    setErrorMessage('');
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      if (awaitingTotp && totpCode.trim().length !== 6) {
        setErrorMessage(t('login.totp.errors.invalidCode'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(
        formState.username.trim(),
        formState.password,
        awaitingTotp ? totpCode.trim() : undefined,
      );
      if (!result.success) {
        if ('requiresTotp' in result && result.requiresTotp) {
          setAwaitingTotp(true);
          setTotpCode('');
        } else if ('error' in result) {
          setErrorMessage(result.error);
        }
      }
      setIsSubmitting(false);
    },
    [awaitingTotp, formState.password, formState.username, login, t, totpCode],
  );

  return (
    <AuthScreenLayout
      title={awaitingTotp ? t('login.totp.title') : t('login.title')}
      description={awaitingTotp ? t('login.totp.description') : t('login.description')}
      footerText="Enter your credentials to access CloudCLI"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {!awaitingTotp && (
          <>
            <AuthInputField
              id="username"
              label={t('login.username')}
              value={formState.username}
              onChange={(value) => updateField('username', value)}
              placeholder={t('login.placeholders.username')}
              isDisabled={isSubmitting}
              autoComplete="username"
              icon={User}
            />

            <AuthInputField
              id="password"
              label={t('login.password')}
              value={formState.password}
              onChange={(value) => updateField('password', value)}
              placeholder={t('login.placeholders.password')}
              isDisabled={isSubmitting}
              type="password"
              autoComplete="current-password"
              icon={Lock}
            />
          </>
        )}

        {awaitingTotp && (
          <AuthInputField
            id="totp-code"
            label={t('login.totp.code')}
            value={totpCode}
            onChange={(value) => setTotpCode(value.replace(/\D/g, '').slice(0, 6))}
            placeholder={t('login.totp.placeholder')}
            isDisabled={isSubmitting}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            icon={ShieldCheck}
          />
        )}

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:brightness-110 hover:shadow-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('login.loading')}
            </>
          ) : awaitingTotp ? (
            t('login.totp.submit')
          ) : (
            t('login.submit')
          )}
        </button>

        {awaitingTotp && (
          <button
            type="button"
            onClick={handleBackToPassword}
            disabled={isSubmitting}
            className="w-full rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('login.totp.back')}
          </button>
        )}
      </form>
    </AuthScreenLayout>
  );
}
