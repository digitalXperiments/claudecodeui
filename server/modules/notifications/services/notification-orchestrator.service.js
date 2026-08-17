import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '@/modules/notifications/services/desktop-notification-clients.service.js';

const KIND_TO_PREF_KEY = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error'
};

// Event kinds that are captured into the daily digest summary. Other kinds
// (e.g. push.enabled confirmations) keep their per-event push behavior even
// when digest mode is on.
const DIGEST_ELIGIBLE_KINDS = new Set(['action_required', 'stop', 'error']);

const PROVIDER_LABELS = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
  kilo: 'Kilo Code',
  cline: 'Cline',
  qwencode: 'Qwen Code',
  system: 'System'
};

const recentEventKeys = new Map();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isNotificationEventEnabled(preferences, event) {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind];
  const eventEnabled = prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;

  return eventEnabled;
}

function isDuplicate(event) {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false,
  source = null
}) {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    source: source || (provider && provider !== 'system' ? provider : 'system'),
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error) {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error.message === 'string') {
    return error.message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName) {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row, provider) {
  return row && (!provider || row.provider === provider);
}

function resolveSessionRow(sessionId, provider) {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId, provider);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession(event) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event) {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

function buildNotificationPayload(event) {
  const normalizedEvent = normalizeNotificationSession(event);
  const CODE_MAP = {
    'permission.required': normalizedEvent.meta?.toolName
      ? `Action Required: Tool "${normalizedEvent.meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': normalizedEvent.meta?.stopReason || 'Run Stopped: The run has stopped',
    'run.failed': normalizedEvent.meta?.error ? `Run Failed: ${normalizedEvent.meta.error}` : 'Run Failed: The run encountered an error',
    'agent.notification': normalizedEvent.meta?.message ? String(normalizedEvent.meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = CODE_MAP[normalizedEvent.code] || 'You have a new notification';

  return {
    title: sessionName || 'CloudCLI',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

function sendWebPushPayload(userId, payload) {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        serializedPayload
      )
    )
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = result.reason?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
        }
      }
    });
  });
}

const notificationChannels = [
  {
    id: 'webPush',
    // TODO: Web push still uses push_subscriptions. Do not remove that table until
    // browser push subscriptions are migrated into notification_channel_endpoints.
    isEnabled: (preferences) => Boolean(preferences?.channels?.webPush),
    send: ({ userId, payload }) => sendWebPushPayload(userId, payload)
  },
  {
    id: 'desktop',
    isEnabled: (preferences) => Boolean(preferences?.channels?.desktop),
    send: ({ userId, payload }) => sendDesktopNotificationToClients(userId, payload)
  }
];

/**
 * Per-channel routing rules from preferences.rules. Each rule targets one
 * channel with optional kinds/sources matchers (empty = match all). A rule
 * with enabled:false BLOCKS matching events; enabled:true FORCE-ALLOWS and
 * overrides any block. Deterministic order:
 *   any force-allow match -> allow
 *   else any block match    -> block
 *   else                    -> allow
 */
function channelAllowedByRules(preferences, channelId, event) {
  const rules = Array.isArray(preferences?.rules) ? preferences.rules : [];
  const channelRules = rules.filter((rule) => rule && rule.channel === channelId);
  if (channelRules.length === 0) {
    return true;
  }

  const eventKind = event?.kind || 'info';
  const prefKey = KIND_TO_PREF_KEY[eventKind] || eventKind;
  const eventSource = event?.source || event?.provider || null;

  const matchesRule = (rule) => {
    const kinds = Array.isArray(rule.kinds) ? rule.kinds : [];
    const sources = Array.isArray(rule.sources) ? rule.sources : [];
    const kindsMatch = kinds.length === 0 || kinds.includes(eventKind) || kinds.includes(prefKey);
    const sourcesMatch = sources.length === 0 || (eventSource !== null && sources.includes(eventSource));
    return kindsMatch && sourcesMatch;
  };

  if (channelRules.some((rule) => rule.enabled === true && matchesRule(rule))) {
    return true;
  }
  if (channelRules.some((rule) => rule.enabled === false && matchesRule(rule))) {
    return false;
  }
  return true;
}

function notifyUserIfEnabled({ userId, event }) {
  if (!userId || !event) {
    return;
  }

  const normalizedEvent = normalizeNotificationSession({
    ...event,
    source: event.source || (event.provider ? event.provider : 'system')
  });
  const preferences = notificationPreferencesDb.getPreferences(userId);
  if (!isNotificationEventEnabled(preferences, normalizedEvent)) {
    return;
  }
  if (isDuplicate(normalizedEvent)) {
    return;
  }

  const payload = buildNotificationPayload(normalizedEvent);
  for (const channel of notificationChannels) {
    if (!channel.isEnabled(preferences)) {
      continue;
    }
    // Digest mode suppresses per-event webPush/desktop for digest-eligible
    // kinds; the daily summary is pushed by the digest scheduler instead.
    if (
      channel.id === 'webPush' || channel.id === 'desktop'
    ) {
      if (preferences?.digest?.enabled === true && DIGEST_ELIGIBLE_KINDS.has(normalizedEvent.kind)) {
        continue;
      }
    }
    if (!channelAllowedByRules(preferences, channel.id, normalizedEvent)) {
      continue;
    }
    Promise.resolve(channel.send({ userId, event: normalizedEvent, payload })).catch((err) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
    });
  }
}

/**
 * Pushes a summary notification through the given channels (default webPush +
 * desktop), honoring the user's channel enablement. Used by the daily digest.
 */
function notifyDigest({ userId, title, body, channels = ['webPush', 'desktop'] }) {
  if (!userId || !title) {
    return;
  }
  const preferences = notificationPreferencesDb.getPreferences(userId);
  const payload = {
    title,
    body,
    data: { tag: 'digest' }
  };
  for (const channelId of channels) {
    const channel = notificationChannels.find((candidate) => candidate.id === channelId);
    if (!channel || !channel.isEnabled(preferences)) {
      continue;
    }
    Promise.resolve(channel.send({ userId, payload })).catch((err) => {
      console.error(`Notification channel "${channel.id}" digest send error:`, err);
    });
  }
}

function notifyRunStopped({ userId, provider, sessionId = null, stopReason = 'completed', sessionName = null }) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null }) {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}

export {
  buildNotificationPayload,
  channelAllowedByRules,
  createNotificationEvent,
  notifyDigest,
  notifyUserIfEnabled,
  notifyRunStopped,
  notifyRunFailed
};
