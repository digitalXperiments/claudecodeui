import { Bell, BellOff, BellRing, Clock, Filter, Loader2, Play, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import { playChatCompletionSound } from '../../../../utils/notificationSound';
import type {
  NotificationChannelRule,
  NotificationDigestPreferences,
  NotificationPreferencesState,
} from '../../types/types';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  pushPermission: NotificationPermission | 'unsupported';
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  onEnablePush: () => void;
  onDisablePush: () => void;
  isDesktop?: boolean;
  desktopNotifications?: {
    enabled: boolean;
    supported: boolean;
    connectedCount?: number;
    targetCount?: number;
    lastError?: string | null;
  } | null;
  onEnableDesktopNotifications?: () => void;
  onDisableDesktopNotifications?: () => void;
};

const DIGEST_CHANNELS = ['webPush', 'desktop'];
const QUIET_CHANNELS = ['webPush', 'desktop'];
const EVENT_KINDS = ['actionRequired', 'error', 'stop'];
const SOURCE_OPTIONS = ['chat', 'kanban', 'mission-control', 'auth-health', 'webhooks', 'system'];

const DEFAULT_DIGEST: NotificationDigestPreferences = {
  enabled: false,
  time: '08:00',
  channels: ['webPush', 'desktop'],
};

export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
  pushPermission,
  isPushSubscribed,
  isPushLoading,
  onEnablePush,
  onDisablePush,
  isDesktop = false,
  desktopNotifications = null,
  onEnableDesktopNotifications,
  onDisableDesktopNotifications,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');

  const pushSupported = pushPermission !== 'unsupported';
  const pushDenied = pushPermission === 'denied';

  const digest = notificationPreferences.digest ?? DEFAULT_DIGEST;

  // --- Daily digest handlers ---
  const updateDigest = (patch: Partial<NotificationDigestPreferences>) => {
    onNotificationPreferencesChange({
      ...notificationPreferences,
      digest: { ...digest, ...patch },
    });
  };

  // --- Channel routing handlers ---
  const quietRulesFor = (channel: string) =>
    notificationPreferences.rules.filter(
      (rule) => rule.channel === channel && rule.enabled === false,
    );

  const isQuietFor = (channel: string) => quietRulesFor(channel).length > 0;

  const setQuietFor = (channel: string, quiet: boolean) => {
    const otherRules = notificationPreferences.rules.filter(
      (rule) => rule.channel !== channel || rule.enabled === true,
    );
    const rules = quiet
      ? [...otherRules, { channel, kinds: [...EVENT_KINDS], sources: [], enabled: false }]
      : otherRules;
    onNotificationPreferencesChange({ ...notificationPreferences, rules });
  };

  const updateQuietRule = (
    channel: string,
    updater: (rule: NotificationChannelRule) => NotificationChannelRule,
  ) => {
    const keptRules = notificationPreferences.rules.filter(
      (rule) => rule.channel !== channel || rule.enabled === true,
    );
    const existing = quietRulesFor(channel)[0];
    const updated = updater(
      existing ?? { channel, kinds: [...EVENT_KINDS], sources: [], enabled: false },
    );
    onNotificationPreferencesChange({
      ...notificationPreferences,
      rules: [...keptRules, updated],
    });
  };

  const toggleQuietKind = (channel: string, kind: string) => {
    updateQuietRule(channel, (rule) => {
      const current = rule.kinds.length > 0 ? rule.kinds : [...EVENT_KINDS];
      const next = current.includes(kind)
        ? current.length === 1
          ? current
          : current.filter((item) => item !== kind)
        : [...current, kind];
      return { ...rule, kinds: next };
    });
  };

  const toggleQuietSource = (channel: string, source: string) => {
    updateQuietRule(channel, (rule) => {
      const current = rule.sources.length > 0 ? rule.sources : [...SOURCE_OPTIONS];
      const next = current.includes(source)
        ? current.length === 1
          ? current
          : current.filter((item) => item !== source)
        : [...current, source];
      return { ...rule, sources: next };
    });
  };

  const isKindQuiet = (channel: string, kind: string) => {
    const rules = quietRulesFor(channel);
    if (rules.length === 0) return false;
    return rules.some((rule) => rule.kinds.length === 0 || rule.kinds.includes(kind));
  };

  const isSourceQuiet = (channel: string, source: string) => {
    const rules = quietRulesFor(channel);
    if (rules.length === 0) return false;
    return rules.some((rule) => rule.sources.length === 0 || rule.sources.includes(source));
  };

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-blue-600" />
          <h3 className="text-lg font-medium text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      {isDesktop ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <h4 className="font-medium text-foreground">
            {t('notifications.desktop.title', { defaultValue: 'Notify this desktop app' })}
          </h4>
          {desktopNotifications?.supported === false ? (
            <p className="text-sm text-muted-foreground">
              {t('notifications.desktop.unsupported', { defaultValue: 'Desktop notifications are not supported on this system.' })}
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (desktopNotifications?.enabled) {
                      onDisableDesktopNotifications?.();
                    } else {
                      onEnableDesktopNotifications?.();
                    }
                  }}
                  className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                    desktopNotifications?.enabled
                      ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                      : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
                  }`}
                >
                  {desktopNotifications?.enabled ? (
                    <BellOff className="h-4 w-4" />
                  ) : (
                    <BellRing className="h-4 w-4" />
                  )}
                  {desktopNotifications?.enabled
                    ? t('notifications.desktop.disable', { defaultValue: 'Disable desktop notifications' })
                    : t('notifications.desktop.enable', { defaultValue: 'Enable desktop notifications' })}
                </button>
                {desktopNotifications?.enabled && (
                  <span className="text-sm text-green-600 dark:text-green-400">
                    {t('notifications.desktop.enabled', { defaultValue: 'Desktop notifications are enabled' })}
                  </span>
                )}
              </div>
              {desktopNotifications?.lastError && (
                <p className="text-sm text-red-600 dark:text-red-400">{desktopNotifications.lastError}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <h4 className="font-medium text-foreground">{t('notifications.webPush.title')}</h4>
          {!pushSupported ? (
            <p className="text-sm text-muted-foreground">{t('notifications.webPush.unsupported')}</p>
          ) : pushDenied ? (
            <p className="text-sm text-muted-foreground">{t('notifications.webPush.denied')}</p>
          ) : (
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={isPushLoading}
                onClick={() => {
                  if (isPushSubscribed) {
                    onDisablePush();
                  } else {
                    onEnablePush();
                  }
                }}
                className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isPushSubscribed
                    ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                    : 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
                }`}
              >
                {isPushLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isPushSubscribed ? (
                  <BellOff className="h-4 w-4" />
                ) : (
                  <BellRing className="h-4 w-4" />
                )}
                {isPushLoading
                  ? t('notifications.webPush.loading')
                  : isPushSubscribed
                    ? t('notifications.webPush.disable')
                    : t('notifications.webPush.enable')}
              </button>
              {isPushSubscribed && (
                <span className="text-sm text-green-600 dark:text-green-400">
                  {t('notifications.webPush.enabled')}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-blue-600" />
              <h4 className="font-medium text-foreground">
                {t('notifications.sound.title', { defaultValue: 'Sound' })}
              </h4>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('notifications.sound.description', {
                defaultValue: 'Play a short tone when a chat run finishes.',
              })}
            </p>
          </div>

          <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.channels.sound}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  channels: {
                    ...notificationPreferences.channels,
                    sound: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.sound.enabled', { defaultValue: 'Enabled' })}
          </label>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void playChatCompletionSound({ force: true });
          }}
        >
          <Play className="h-4 w-4" />
          {t('notifications.sound.test', { defaultValue: 'Test sound' })}
        </Button>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h4 className="font-medium text-foreground">{t('notifications.events.title')}</h4>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.actionRequired}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    actionRequired: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.actionRequired')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.stop}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    stop: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.stop')}
          </label>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={notificationPreferences.events.error}
              onChange={(event) =>
                onNotificationPreferencesChange({
                  ...notificationPreferences,
                  events: {
                    ...notificationPreferences.events,
                    error: event.target.checked,
                  },
                })
              }
              className="h-4 w-4"
            />
            {t('notifications.events.error')}
          </label>
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-blue-600" />
              <h4 className="font-medium text-foreground">
                {t('notifications.digest.title', { defaultValue: 'Daily digest' })}
              </h4>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('notifications.digest.description', {
                defaultValue: 'Replace per-event pushes with a single daily summary.',
              })}
            </p>
          </div>

          <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={digest.enabled}
              onChange={(event) => updateDigest({ enabled: event.target.checked })}
              className="h-4 w-4"
            />
            {t('notifications.digest.enabled', { defaultValue: 'Enabled' })}
          </label>
        </div>

        {digest.enabled && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <label htmlFor="digest-time" className="text-sm text-foreground">
                {t('notifications.digest.time', { defaultValue: 'Delivery time' })}
              </label>
              <input
                id="digest-time"
                type="time"
                value={digest.time}
                onChange={(event) => updateDigest({ time: event.target.value })}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              />
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {t('notifications.digest.channels', { defaultValue: 'Delivery channels' })}
              </p>
              <div className="space-y-1">
                {DIGEST_CHANNELS.map((channel) => (
                  <label key={channel} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={digest.channels.includes(channel)}
                      onChange={(event) =>
                        updateDigest({
                          channels: event.target.checked
                            ? [...digest.channels, channel]
                            : digest.channels.filter((item) => item !== channel),
                        })
                      }
                      className="h-4 w-4"
                    />
                    {channel === 'webPush'
                      ? t('notifications.digest.channelWebPush', { defaultValue: 'Web push' })
                      : t('notifications.digest.channelDesktop', { defaultValue: 'Desktop' })}
                  </label>
                ))}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {t('notifications.digest.hint', {
                defaultValue: 'While enabled, per-event web push and desktop alerts are replaced by this daily summary.',
              })}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-blue-600" />
            <h4 className="font-medium text-foreground">
              {t('notifications.routing.title', { defaultValue: 'Channel routing' })}
            </h4>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('notifications.routing.description', {
              defaultValue: 'Silence specific event types or sources per channel.',
            })}
          </p>
        </div>

        {QUIET_CHANNELS.map((channel) => (
          <div key={channel} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">
                {channel === 'webPush'
                  ? t('notifications.routing.webPush', { defaultValue: 'Web push' })
                  : t('notifications.routing.desktop', { defaultValue: 'Desktop' })}
              </p>
              <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={isQuietFor(channel)}
                  onChange={(event) => setQuietFor(channel, event.target.checked)}
                  className="h-4 w-4"
                />
                {t('notifications.routing.quietMode', { defaultValue: 'Quiet mode' })}
              </label>
            </div>

            {isQuietFor(channel) && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('notifications.routing.kinds', { defaultValue: 'Silence these event types' })}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {EVENT_KINDS.map((kind) => (
                      <label key={kind} className="flex items-center gap-1.5 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={isKindQuiet(channel, kind)}
                          onChange={() => toggleQuietKind(channel, kind)}
                          className="h-4 w-4"
                        />
                        {t(`notifications.events.${kind}`)}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('notifications.routing.sources', { defaultValue: 'Silence these sources' })}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {SOURCE_OPTIONS.map((source) => (
                      <label key={source} className="flex items-center gap-1.5 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={isSourceQuiet(channel, source)}
                          onChange={() => toggleQuietSource(channel, source)}
                          className="h-4 w-4"
                        />
                        {source}
                      </label>
                    ))}
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  {t('notifications.routing.emptyHint', {
                    defaultValue: 'No boxes ticked = silence everything on this channel.',
                  })}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
