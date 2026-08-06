/**
 * Auth health: probe every provider's auth status on demand or on a schedule,
 * and surface broken credentials (expired / logged out) as inbox notifications
 * so headless runs (Mission Control, Kanban) stop failing silently.
 */

import { appConfigDb, systemNotificationsDb } from '@/modules/database/index.js';
import type { CreateSystemNotificationInput } from '@/modules/database/index.js';
import { providerAuthService, providerRegistry } from '@/modules/providers/index.js';
import {
  checkMcpServerHealth,
  MCP_HEALTH_DEDUPE_PREFIX,
  type McpServerHealthReport,
} from '@/modules/auth-health/mcp-health.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';

export type AuthHealthProviderReport = {
  provider: string;
  installed: boolean;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
};

export type AuthHealthReport = {
  /** ISO timestamp of when the probe ran. */
  checkedAt: string;
  providers: AuthHealthProviderReport[];
  /** Per-provider MCP server health, probed alongside provider auth. */
  mcpServers?: McpServerHealthReport[];
};

/** Re-login command hint shown in the notification body, per provider. */
export const REAUTH_HINTS: Record<string, string> = {
  claude: 'claude auth login',
  cursor: 'cursor-agent login',
  codex: 'codex login',
  opencode: 'opencode auth login',
  grok: 'grok login',
  kimi: 'kimi login',
  agy: 'agy',
  pi: 'pi (then /login)',
};

export const AUTH_HEALTH_DEDUPE_PREFIX = 'auth-health:';
/** After alerting for a provider, wait this long before alerting again (e.g. the user dismissed the notification without fixing auth). */
export const RENOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const NOTIFICATION_HREF = 'settings:agents';

/** app_config key holding the providers the user turned off in Settings → Agents (synced from the frontend's `disabledAgents` localStorage list). */
export const DISABLED_AGENTS_CONFIG_KEY = 'disabledAgents';

function knownProviderIds(): Set<string> {
  return new Set(providerRegistry.listProviders().map((p) => p.id));
}

/** Providers the user turned off; the watchdog never probes these. */
export function getDisabledProviders(): Set<string> {
  try {
    const raw = appConfigDb.get(DISABLED_AGENTS_CONFIG_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    const known = knownProviderIds();
    return new Set(parsed.filter((v): v is string => typeof v === 'string' && known.has(v)));
  } catch {
    return new Set();
  }
}

/** Persists the disabled-provider list (sanitized to known provider ids). Returns the sanitized list. */
export function setDisabledProviders(disabled: unknown): string[] {
  const known = knownProviderIds();
  const sanitized = Array.isArray(disabled)
    ? [...new Set(disabled.filter((v): v is string => typeof v === 'string' && known.has(v)))]
    : [];
  appConfigDb.set(DISABLED_AGENTS_CONFIG_KEY, JSON.stringify(sanitized));
  return sanitized;
}

let lastReport: AuthHealthReport | null = null;

/** Per-provider epoch ms of the last alert we created; backs the 24h anti-spam cooldown. */
const lastNotifiedAt = new Map<string, number>();

/** Per-(provider, mcp server) epoch ms of the last alert; backs the same cooldown. */
const lastMcpNotifiedAt = new Map<string, number>();

export function getLastAuthHealthReport(): AuthHealthReport | null {
  return lastReport;
}

/**
 * Best-effort invalidation of the Claude auth status cache so user-triggered
 * checks bypass the 30s memoisation. Duck-typed: only runs when the resolved
 * provider's auth object (or its class) exposes `invalidateStatusCache()`.
 */
function invalidateClaudeStatusCache(): void {
  try {
    const auth = providerRegistry.resolveProvider('claude').auth as unknown as {
      invalidateStatusCache?: () => void;
      constructor?: { invalidateStatusCache?: () => void };
    };
    if (typeof auth.invalidateStatusCache === 'function') {
      auth.invalidateStatusCache();
    } else if (typeof auth.constructor?.invalidateStatusCache === 'function') {
      auth.constructor.invalidateStatusCache();
    }
  } catch (error) {
    console.warn('[auth-health] failed to invalidate claude status cache:', error);
  }
}

/**
 * Probes every registered provider sequentially (codex/cursor spawn CLIs with
 * 5s caps; sequential avoids spawn storms). Per-provider failures are captured
 * into the report instead of throwing.
 */
export async function checkAuthHealth(options?: { fresh?: boolean }): Promise<AuthHealthReport> {
  if (options?.fresh) {
    invalidateClaudeStatusCache();
  }

  const disabled = getDisabledProviders();
  const providers: AuthHealthProviderReport[] = [];
  for (const provider of providerRegistry.listProviders()) {
    if (disabled.has(provider.id)) {
      continue; // turned off by the user — never probed
    }
    try {
      const status = await providerAuthService.getProviderAuthStatus(provider.id);
      providers.push({
        provider: status.provider,
        installed: status.installed,
        authenticated: status.authenticated,
        email: status.email ?? null,
        method: status.method ?? null,
        error: status.error ?? null,
      });
    } catch (error) {
      providers.push({
        provider: provider.id,
        installed: false,
        authenticated: false,
        email: null,
        method: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report: AuthHealthReport = { checkedAt: new Date().toISOString(), providers };

  // MCP server health for the same enabled provider set, so broken tool
  // servers surface in the same report (and watchdog pass) as broken auth.
  const enabledProviderIds = new Set(
    providerRegistry.listProviders().map((p) => p.id).filter((id) => !disabled.has(id)),
  );
  report.mcpServers = await checkMcpServerHealth({ providerIds: enabledProviderIds });

  lastReport = report;
  return report;
}

/** Minimal view of an inbox notification needed to plan notify/recover actions. */
export type AuthHealthOpenNotification = {
  notification_id: string;
  meta?: Record<string, unknown>;
};

export type AuthHealthPlanAction =
  | { type: 'create'; provider: string; input: CreateSystemNotificationInput }
  | { type: 'dismiss'; provider: string; dedupeKey: string; notificationId: string };

function displayName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

const mcpDedupeKey = (provider: string, name: string): string => `${MCP_HEALTH_DEDUPE_PREFIX}${provider}:${name}`;

/**
 * Pure notify/recover decision pass over MCP server health reports.
 *
 * - unhealthy with no open alert, outside the cooldown → create an alert.
 * - unhealthy with an open alert, or inside the cooldown → no-op.
 * - healthy again with an open alert → dismiss it (silent recovery).
 */
export function planMcpHealthNotifications(
  reports: readonly McpServerHealthReport[],
  openNotifications: readonly AuthHealthOpenNotification[],
  lastNotified: ReadonlyMap<string, number>,
  now: number,
): AuthHealthPlanAction[] {
  const actions: AuthHealthPlanAction[] = [];

  for (const entry of reports) {
    const dedupeKey = mcpDedupeKey(entry.provider, entry.name);
    const open = openNotifications.find((n) => n.meta?.dedupeKey === dedupeKey);

    if (entry.healthy) {
      if (open) {
        actions.push({
          type: 'dismiss',
          provider: entry.provider,
          dedupeKey,
          notificationId: open.notification_id,
        });
      }
      continue;
    }

    if (open) {
      continue;
    }
    const last = lastNotified.get(dedupeKey);
    if (last !== undefined && now - last < RENOTIFY_COOLDOWN_MS) {
      continue;
    }

    actions.push({
      type: 'create',
      provider: entry.provider,
      input: {
        kind: 'action_required',
        severity: 'warning',
        source: 'auth-health',
        title: `MCP server "${entry.name}" is unhealthy (${entry.provider})`,
        body: `${entry.error ?? 'Health probe failed.'} Open Settings → Agents to review the server config.`,
        href: NOTIFICATION_HREF,
        meta: { provider: entry.provider, mcpServer: entry.name },
        dedupeKey,
      },
    });
  }

  return actions;
}

/**
 * Pure notify/recover decision pass over a report.
 *
 * - broken (`installed && !authenticated`), no open alert, outside the 24h
 *   cooldown → create an alert.
 * - broken with an open alert, or inside the cooldown → no-op.
 * - authenticated again with an open alert → dismiss it (silent recovery).
 * - not installed → no-op.
 * - disabled by the user → never alerted; any stale open alert is dismissed.
 */
export function planAuthHealthNotifications(
  report: AuthHealthReport,
  openNotifications: readonly AuthHealthOpenNotification[],
  lastNotified: ReadonlyMap<string, number>,
  now: number,
  disabledProviders: ReadonlySet<string> = new Set(),
): AuthHealthPlanAction[] {
  const actions: AuthHealthPlanAction[] = [];

  // Disabled providers: clear any stale open alert and never alert again.
  for (const provider of disabledProviders) {
    const dedupeKey = `${AUTH_HEALTH_DEDUPE_PREFIX}${provider}`;
    const open = openNotifications.find((n) => n.meta?.dedupeKey === dedupeKey);
    if (open) {
      actions.push({
        type: 'dismiss',
        provider,
        dedupeKey,
        notificationId: open.notification_id,
      });
    }
  }

  for (const entry of report.providers) {
    if (disabledProviders.has(entry.provider)) {
      continue;
    }

    const dedupeKey = `${AUTH_HEALTH_DEDUPE_PREFIX}${entry.provider}`;
    const open = openNotifications.find((n) => n.meta?.dedupeKey === dedupeKey);

    if (!entry.installed) {
      continue;
    }

    if (entry.authenticated) {
      if (open) {
        actions.push({
          type: 'dismiss',
          provider: entry.provider,
          dedupeKey,
          notificationId: open.notification_id,
        });
      }
      continue;
    }

    // Broken: installed but not authenticated.
    if (open) {
      continue;
    }
    const last = lastNotified.get(entry.provider);
    if (last !== undefined && now - last < RENOTIFY_COOLDOWN_MS) {
      continue;
    }

    const hint = REAUTH_HINTS[entry.provider] ?? `${entry.provider} login`;
    const errorDetail = entry.error ? `${entry.error} ` : '';
    actions.push({
      type: 'create',
      provider: entry.provider,
      input: {
        kind: 'action_required',
        severity: 'error',
        source: 'auth-health',
        title: `${displayName(entry.provider)} authentication expired`,
        body: `${errorDetail}Re-authenticate: run \`${hint}\` or open Settings → Agents.`,
        href: NOTIFICATION_HREF,
        meta: { provider: entry.provider },
        dedupeKey,
      },
    });
  }

  return actions;
}

function broadcastNotificationCreated(): void {
  try {
    const frame = JSON.stringify({
      kind: 'notification_created',
      timestamp: new Date().toISOString(),
    });
    connectedClients.forEach((client) => {
      if (client.readyState === WS_OPEN_STATE) {
        client.send(frame);
      }
    });
  } catch {
    // WS broadcast is best-effort
  }
}

/**
 * Executes the notify/recover plan for a report against the inbox. Every DB/WS
 * side effect is wrapped in try/catch — a notification failure must never
 * break the check loop.
 */
export async function applyAuthHealthOutcomes(report: AuthHealthReport): Promise<void> {
  let openNotifications: AuthHealthOpenNotification[];
  try {
    openNotifications = systemNotificationsDb.list({ limit: 200 });
  } catch (error) {
    // Without the open list we cannot dedupe safely; skip the whole pass.
    console.warn('[auth-health] failed to list open notifications, skipping outcomes:', error);
    return;
  }

  const now = Date.now();
  const actions = planAuthHealthNotifications(report, openNotifications, lastNotifiedAt, now, getDisabledProviders());

  for (const action of actions) {
    if (action.type === 'create') {
      try {
        systemNotificationsDb.create(action.input);
        lastNotifiedAt.set(action.provider, now);
      } catch (error) {
        console.warn(`[auth-health] failed to create alert for ${action.provider}:`, error);
        continue;
      }
      broadcastNotificationCreated();
    } else {
      try {
        systemNotificationsDb.dismiss(action.notificationId);
      } catch (error) {
        console.warn(`[auth-health] failed to dismiss recovered alert for ${action.provider}:`, error);
      }
    }
  }

  // MCP server health pass shares the same inbox/dedupe machinery with its own
  // per-(provider, server) cooldown map.
  if (report.mcpServers && report.mcpServers.length > 0) {
    const mcpActions = planMcpHealthNotifications(report.mcpServers, openNotifications, lastMcpNotifiedAt, now);
    for (const action of mcpActions) {
      if (action.type === 'create') {
        const dedupeKey = action.input.dedupeKey ?? `${MCP_HEALTH_DEDUPE_PREFIX}${action.provider}`;
        try {
          systemNotificationsDb.create(action.input);
          lastMcpNotifiedAt.set(dedupeKey, now);
        } catch (error) {
          console.warn(`[auth-health] failed to create MCP alert for ${dedupeKey}:`, error);
          continue;
        }
        broadcastNotificationCreated();
      } else {
        try {
          systemNotificationsDb.dismiss(action.notificationId);
        } catch (error) {
          console.warn(`[auth-health] failed to dismiss recovered MCP alert for ${action.dedupeKey}:`, error);
        }
      }
    }
  }
}
