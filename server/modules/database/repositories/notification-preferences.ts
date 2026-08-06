/**
 * Notification preferences repository.
 *
 * Stores per-user notification channel/event preferences as JSON.
 */

import { getConnection } from '@/modules/database/connection.js';

export type NotificationChannelRule = {
  channel: 'webPush' | 'desktop' | 'inApp' | 'sound';
  kinds?: string[];
  sources?: string[];
  enabled: boolean;
};

export type NotificationDigestPreferences = {
  enabled: boolean;
  time: string;
  channels: string[];
};

type NotificationPreferences = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    desktop: boolean;
    sound: boolean;
    [key: string]: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
  rules: NotificationChannelRule[];
  digest?: NotificationDigestPreferences;
};

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: {
    inApp: false,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
  rules: [],
};

const VALID_RULE_CHANNELS = ['webPush', 'desktop', 'inApp', 'sound'];

function normalizeRules(value: unknown): NotificationChannelRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rules: NotificationChannelRule[] = [];
  for (const rule of value) {
    if (!rule || typeof rule !== 'object') {
      continue;
    }
    const candidate = rule as Record<string, unknown>;
    if (!VALID_RULE_CHANNELS.includes(String(candidate.channel))) {
      continue;
    }
    rules.push({
      channel: String(candidate.channel) as NotificationChannelRule['channel'],
      kinds: Array.isArray(candidate.kinds)
        ? candidate.kinds.filter((kind): kind is string => typeof kind === 'string')
        : undefined,
      sources: Array.isArray(candidate.sources)
        ? candidate.sources.filter((source): source is string => typeof source === 'string')
        : undefined,
      enabled: candidate.enabled !== false,
    });
  }
  return rules;
}

function normalizeDigest(value: unknown): NotificationDigestPreferences | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const time = typeof source.time === 'string' && /^\d{2}:\d{2}$/.test(source.time)
    ? source.time
    : '08:00';
  const channels = Array.isArray(source.channels)
    ? source.channels.filter((channel): channel is string => channel === 'webPush' || channel === 'desktop')
    : ['webPush', 'desktop'];
  return {
    enabled: source.enabled === true,
    time,
    channels,
  };
}

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const source = value && typeof value === 'object' ? (value as Record<string, any>) : {};
  const sourceChannels = source.channels && typeof source.channels === 'object'
    ? source.channels as Record<string, unknown>
    : {};
  const extraChannels = Object.fromEntries(
    Object.entries(sourceChannels)
      .filter(([key, channelValue]) => !['inApp', 'webPush', 'desktop', 'sound'].includes(key) && typeof channelValue === 'boolean')
  ) as Record<string, boolean>;

  const digest = normalizeDigest(source.digest);

  return {
    channels: {
      ...extraChannels,
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true,
      desktop: source.channels?.desktop === true,
      sound: source.channels?.sound !== false,
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      error: source.events?.error !== false,
    },
    rules: normalizeRules(source.rules),
    ...(digest ? { digest } : {}),
  };
}

export const notificationPreferencesDb = {
  /** Returns the normalized preferences for a user, creating defaults on first read. */
  getNotificationPreferences(userId: number): NotificationPreferences {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?'
      )
      .get(userId) as { preferences_json: string } | undefined;

    if (!row) {
      const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
      db.prepare(
        'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
      ).run(userId, JSON.stringify(defaults));
      return defaults;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.preferences_json);
    } catch {
      parsed = DEFAULT_NOTIFICATION_PREFERENCES;
    }
    return normalizeNotificationPreferences(parsed);
  },

  /** Upserts normalized preferences for a user and returns the stored value. */
  updateNotificationPreferences(
    userId: number,
    preferences: unknown
  ): NotificationPreferences {
    const normalized = normalizeNotificationPreferences(preferences);
    const db = getConnection();

    db.prepare(
      `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         preferences_json = excluded.preferences_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, JSON.stringify(normalized));

    return normalized;
  },

  /** Returns every stored user's normalized preferences (used by the digest scheduler). */
  listAll(): Array<{ userId: number; preferences: NotificationPreferences }> {
    const db = getConnection();
    const rows = db
      .prepare('SELECT user_id, preferences_json FROM user_notification_preferences')
      .all() as Array<{ user_id: number; preferences_json: string }>;

    return rows.map((row) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.preferences_json);
      } catch {
        parsed = DEFAULT_NOTIFICATION_PREFERENCES;
      }
      return { userId: row.user_id, preferences: normalizeNotificationPreferences(parsed) };
    });
  },

  // Legacy aliases used by existing services/routes
  getPreferences(userId: number): NotificationPreferences {
    return notificationPreferencesDb.getNotificationPreferences(userId);
  },
  updatePreferences(userId: number, preferences: unknown): NotificationPreferences {
    return notificationPreferencesDb.updateNotificationPreferences(userId, preferences);
  },
};
