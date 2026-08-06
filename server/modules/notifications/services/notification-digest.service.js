import { systemNotificationsDb } from '@/modules/database/index.js';
import { notifyDigest } from '@/modules/notifications/services/notification-orchestrator.service.js';

const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DIGEST_CHANNELS = ['webPush', 'desktop'];

function dateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveDigestChannels(preferences) {
  const channels = preferences?.digest?.channels;
  if (Array.isArray(channels) && channels.length > 0) {
    return channels;
  }
  return DEFAULT_DIGEST_CHANNELS;
}

function collectDigestStats(rows) {
  const bySource = new Map();
  let count = 0;

  for (const row of rows) {
    count += 1;
    let entry = bySource.get(row.source);
    if (!entry) {
      entry = { source: row.source, count: 0, unread: 0, bySeverity: {} };
      bySource.set(row.source, entry);
    }
    entry.count += 1;
    if (!row.read_at) {
      entry.unread += 1;
    }
    const severity = row.severity || 'info';
    entry.bySeverity[severity] = (entry.bySeverity[severity] || 0) + 1;
  }

  return {
    count,
    sourceCount: bySource.size,
    sources: [...bySource.values()].sort((a, b) => b.count - a.count)
  };
}

function formatDigestBody(stats) {
  const lines = stats.sources.map((entry) => (
    `- ${entry.source}: ${entry.count} ${entry.count === 1 ? 'item' : 'items'} (${entry.unread} unread)`
  ));
  return `You had ${stats.count} ${stats.count === 1 ? 'notification' : 'notifications'} across ${stats.sourceCount} ${stats.sourceCount === 1 ? 'source' : 'sources'}:\n${lines.join('\n')}`;
}

function listRecentNotifications(sinceIso) {
  const rows = systemNotificationsDb.list({ limit: 200 });
  return rows.filter((row) => new Date(row.created_at).getTime() >= new Date(sinceIso).getTime());
}

/**
 * Builds and delivers a user's daily digest. Queries inbox rows created in the
 * last 24h, groups them by source, writes a single "Daily digest" summary row
 * (dedupeKey guarantees one per user per day) and pushes it through the user's
 * configured digest channels.
 *
 * Returns `{ created, count }` where created is the summary inbox row and
 * count is the number of events summarized.
 */
export async function runDailyDigest(userId, preferences) {
  const since = new Date(Date.now() - DIGEST_WINDOW_MS).toISOString();
  const recent = listRecentNotifications(since);
  const stats = collectDigestStats(recent);

  if (stats.count === 0) {
    return { created: null, count: 0, sources: [] };
  }

  const body = formatDigestBody(stats);
  const created = systemNotificationsDb.create({
    kind: 'info',
    severity: 'info',
    title: 'Daily digest',
    body,
    source: 'digest',
    href: '/notifications',
    meta: {
      counts: Object.fromEntries(stats.sources.map((entry) => [entry.source, entry.count]))
    },
    dedupeKey: `digest-${dateStamp()}-${userId}`
  });

  notifyDigest({
    userId,
    title: 'Daily digest',
    body,
    channels: resolveDigestChannels(preferences)
  });

  return { created, count: stats.count, sources: stats.sources };
}

/**
 * Preview of today's digest summary without writing or pushing anything.
 * Cheap read-only helper that reflects what a digest run would summarize.
 */
export function getDigestSummaryForUser(userId) {
  const since = new Date(Date.now() - DIGEST_WINDOW_MS).toISOString();
  const recent = listRecentNotifications(since);
  const stats = collectDigestStats(recent);
  return {
    count: stats.count,
    sourceCount: stats.sourceCount,
    sources: stats.sources.map((entry) => ({
      source: entry.source,
      count: entry.count,
      unread: entry.unread,
      bySeverity: entry.bySeverity
    }))
  };
}
