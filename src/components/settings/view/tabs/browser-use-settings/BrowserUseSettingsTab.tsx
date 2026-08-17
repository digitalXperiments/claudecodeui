import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Download,
  Eye,
  Loader2,
  MonitorPlay,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../utils/api';
import SettingsCard from '../../SettingsCard';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';

type BrowserUseSettings = {
  enabled: boolean;
};

type BrowserUseStatus = {
  enabled: boolean;
  runtime: 'cloud' | 'local';
  available: boolean;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  installInProgress: boolean;
  sessionCount: number;
  message: string;
};

function StatusPill({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'neutral';
  children: ReactNode;
}) {
  const toneClasses = {
    success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    warning: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    neutral: 'border-border bg-muted/50 text-muted-foreground',
  };

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${toneClasses[tone]}`}>
      {tone === 'success' ? <CheckCircle2 className="h-3.5 w-3.5" /> : tone === 'warning' ? <CircleAlert className="h-3.5 w-3.5" /> : null}
      {children}
    </span>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.details || `Request failed (${response.status})`);
  }
  return data as T;
}

export default function BrowserUseSettingsTab() {
  const [settings, setSettings] = useState<BrowserUseSettings | null>(null);
  const [status, setStatus] = useState<BrowserUseStatus | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const settingsResponse = await authenticatedFetch('/api/browser-use/settings');
    const settingsData = await readJson<{ data: { settings: BrowserUseSettings } }>(settingsResponse);
    setSettings(settingsData.data.settings);
  }, []);

  const loadStatus = useCallback(async () => {
    const statusResponse = await authenticatedFetch('/api/browser-use/status');
    const statusData = await readJson<{ data: BrowserUseStatus }>(statusResponse);
    setStatus(statusData.data);
  }, []);

  useEffect(() => {
    setError(null);
    setIsSettingsLoading(true);
    setIsStatusLoading(true);

    void loadSettings()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load Browser settings'))
      .finally(() => setIsSettingsLoading(false));

    void loadStatus()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load Browser status'))
      .finally(() => setIsStatusLoading(false));
  }, [loadSettings, loadStatus]);

  const updateSettings = async (nextSettings: Partial<BrowserUseSettings>) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/browser-use/settings', {
        method: 'PUT',
        body: JSON.stringify(nextSettings),
      });
      const data = await readJson<{ data: { settings: BrowserUseSettings } }>(response);
      setSettings(data.data.settings);
      window.dispatchEvent(new Event('browserUseSettingsChanged'));
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Browser settings');
    } finally {
      setIsStatusLoading(false);
      setIsSaving(false);
    }
  };

  const installBrowserBinaries = async () => {
    setIsInstalling(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/browser-use/runtime/install', { method: 'POST' });
      await readJson(response);
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install browser runtime');
    } finally {
      setIsStatusLoading(false);
      setIsInstalling(false);
    }
  };

  const browserEnabled = settings?.enabled === true;
  const needsBrowserBinaries = Boolean(status && (!status.playwrightInstalled || !status.chromiumInstalled));
  const isReady = Boolean(browserEnabled && status?.available);
  const isChecking = isSettingsLoading || isStatusLoading;
  const runtimeLabel = (installed?: boolean) => {
    if (isStatusLoading && !status) {
      return 'checking...';
    }
    return installed ? 'installed' : 'missing';
  };

  const refreshStatus = async () => {
    setIsStatusLoading(true);
    setError(null);
    try {
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh Browser status');
    } finally {
      setIsStatusLoading(false);
    }
  };

  const readinessMessage = isReady
    ? 'Agents can open guarded sessions and you can watch them from the Browser tab.'
    : browserEnabled
      ? 'Finish the runtime setup below before an agent can open a session.'
      : 'Turn this on when you want agents to browse the web with your approval and oversight.';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <SettingsSection
        title="Browser"
        description="Give agents a guarded browser they can use for research and UI tasks, with live sessions you can monitor."
      >
        <div className="overflow-hidden rounded-xl border border-border bg-card/50">
          <div className="border-b border-border bg-gradient-to-br from-primary/[0.08] via-transparent to-transparent p-5 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                  <MonitorPlay className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-base font-semibold text-foreground">Agent browser access</h4>
                    {isReady ? <StatusPill tone="success">Ready</StatusPill> : browserEnabled ? <StatusPill tone="warning">Setup required</StatusPill> : <StatusPill tone="neutral">Off</StatusPill>}
                  </div>
                  <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">{readinessMessage}</p>
                </div>
              </div>
              {isSettingsLoading && !settings ? (
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <SettingsToggle
                  checked={browserEnabled}
                  onChange={(value) => void updateSettings({ enabled: value })}
                  ariaLabel="Enable Browser"
                  disabled={isSaving}
                />
              )}
            </div>
          </div>

          <div className="grid gap-0 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="flex items-center gap-3 p-4">
              <ShieldCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Access</div>
                <div className="mt-0.5 truncate text-sm font-medium text-foreground">{browserEnabled ? 'Agent tools enabled' : 'Not registered'}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4">
              <MonitorPlay className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Runtime</div>
                <div className="mt-0.5 truncate text-sm font-medium text-foreground">{status ? status.runtime === 'cloud' ? 'Cloud' : 'Local' : 'Checking...'}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4">
              <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sessions</div>
                <div className="mt-0.5 truncate text-sm font-medium text-foreground">{status?.sessionCount ?? 0} active now</div>
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Runtime readiness"
        description="Browser sessions need both the automation library and a Chromium binary on the server."
      >
        <SettingsCard divided>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div>
              <div className="text-sm font-medium text-foreground">Installation status</div>
              <p className="mt-0.5 text-sm text-muted-foreground">{status?.message || 'Checking the browser runtime...'}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void refreshStatus()}
              disabled={isChecking || isInstalling}
              className="h-8 shrink-0 gap-1.5"
              title="Refresh Browser status"
            >
              <RefreshCw className={isStatusLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>

          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {[
              { label: 'Playwright', installed: status?.playwrightInstalled, detail: 'Agent automation engine' },
              { label: 'Chromium', installed: status?.chromiumInstalled, detail: 'Headless browser runtime' },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/40 p-3">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${item.installed ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
                  {isStatusLoading && !status ? <Loader2 className="h-4 w-4 animate-spin" /> : item.installed ? <Check className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{item.label}</div>
                  <div className="text-xs text-muted-foreground">{item.installed === undefined ? 'Checking...' : item.installed ? item.detail : 'Not installed'}</div>
                </div>
                <span className="ml-auto text-xs font-medium text-muted-foreground">{runtimeLabel(item.installed)}</span>
              </div>
            ))}
          </div>

          {needsBrowserBinaries && (
            <div className="flex flex-col gap-3 border-t border-border bg-amber-500/[0.06] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 gap-3">
                <Download className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">Complete the browser setup</div>
                  <p className="mt-0.5 text-sm text-muted-foreground">Install the missing runtime components before enabling agent access.</p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => void installBrowserBinaries()}
                disabled={isInstalling || status?.installInProgress}
                className="shrink-0"
              >
                {isInstalling || status?.installInProgress ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {isInstalling || status?.installInProgress ? 'Installing...' : 'Install Runtime'}
              </Button>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="What agents can do" description="Browser access stays scoped to guarded sessions you can observe and stop.">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { icon: Bot, title: 'Research', text: 'Open pages and gather information.' },
            { icon: Eye, title: 'Interact', text: 'Fill forms and test user flows.' },
            { icon: ShieldCheck, title: 'Stay in control', text: 'Watch, stop, or delete sessions.' },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-xl border border-border bg-card/30 p-4">
              <Icon className="h-4 w-4 text-primary" />
              <div className="mt-3 text-sm font-medium text-foreground">{title}</div>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </SettingsSection>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}
