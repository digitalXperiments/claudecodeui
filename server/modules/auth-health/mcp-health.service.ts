/**
 * MCP server health: probe every registered MCP server's configuration so
 * broken tool servers (missing command, command not on PATH, unreachable
 * endpoint) surface in the auth-health report and inbox instead of failing
 * silently during agent runs.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { providerRegistry } from '@/modules/providers/index.js';
import type { McpTransport, ProviderMcpServer } from '@/shared/types.js';

export type McpServerHealthStatus =
  | 'ok'
  | 'missing_command'
  | 'command_not_found'
  | 'missing_url'
  | 'unreachable_url'
  | 'probe_error';

export type McpServerHealthProbe = {
  healthy: boolean;
  status: McpServerHealthStatus;
  error: string | null;
};

export type McpServerHealthReport = {
  provider: string;
  name: string;
  scope: string;
  transport: McpTransport;
  healthy: boolean;
  status: McpServerHealthStatus;
  error: string | null;
  checkedAt: string;
};

export const MCP_HEALTH_DEDUPE_PREFIX = 'mcp-health:';

/** Cap on a single URL reachability probe so the watchdog never hangs. */
const PROBE_TIMEOUT_MS = 5_000;

/** Resolves whether `command` resolves to an executable on PATH (or an absolute/relative path). */
export async function resolveExecutableOnPath(command: string): Promise<boolean> {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.includes(path.sep) || path.isAbsolute(trimmed)) {
    try {
      await fsp.access(trimmed, fsp.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await fsp.access(path.join(dir, trimmed), fsp.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** Best-effort reachability probe: any HTTP response counts as reachable. */
export async function probeUrlReachable(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
  } catch {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    // Any HTTP response (even 4xx/5xx, even a HEAD-method rejection) proves the
    // endpoint is reachable; only transport-level failures are unhealthy.
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure per-server health probe. Exported so tests can exercise each branch
 * without real config files or network access.
 */
export async function probeMcpServerHealth(server: ProviderMcpServer): Promise<McpServerHealthProbe> {
  if (server.transport === 'stdio') {
    const command = server.command?.trim();
    if (!command) {
      return { healthy: false, status: 'missing_command', error: 'No launch command configured for this stdio MCP server.' };
    }
    const found = await resolveExecutableOnPath(command);
    if (!found) {
      return {
        healthy: false,
        status: 'command_not_found',
        error: `Launch command "${command}" was not found on PATH.`,
      };
    }
    return { healthy: true, status: 'ok', error: null };
  }

  // http / sse transports
  const url = server.url?.trim();
  if (!url) {
    return { healthy: false, status: 'missing_url', error: 'No endpoint URL configured for this MCP server.' };
  }
  const reachable = await probeUrlReachable(url);
  if (!reachable) {
    return {
      healthy: false,
      status: 'unreachable_url',
      error: `Endpoint ${url} did not respond within ${PROBE_TIMEOUT_MS}ms.`,
    };
  }
  return { healthy: true, status: 'ok', error: null };
}

/**
 * Probes every MCP server registered for every enabled provider (or a specific
 * provider set). Per-provider listing failures are captured as a single
 * `probe_error` report instead of throwing, mirroring `checkAuthHealth`.
 */
export async function checkMcpServerHealth(options: {
  workspacePath?: string;
  providerIds?: ReadonlySet<string>;
} = {}): Promise<McpServerHealthReport[]> {
  const reports: McpServerHealthReport[] = [];
  const checkedAt = new Date().toISOString();

  for (const provider of providerRegistry.listProviders()) {
    if (options.providerIds && !options.providerIds.has(provider.id)) {
      continue;
    }

    let servers: Record<string, ProviderMcpServer[]>;
    try {
      servers = await provider.mcp.listServers({ workspacePath: options.workspacePath });
    } catch (error) {
      reports.push({
        provider: provider.id,
        name: '(all)',
        scope: 'user',
        transport: 'stdio',
        healthy: false,
        status: 'probe_error',
        error: error instanceof Error ? error.message : String(error),
        checkedAt,
      });
      continue;
    }

    for (const server of Object.values(servers).flat()) {
      let probe: McpServerHealthProbe;
      try {
        probe = await probeMcpServerHealth(server);
      } catch (error) {
        probe = {
          healthy: false,
          status: 'probe_error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      reports.push({
        provider: provider.id,
        name: server.name,
        scope: server.scope,
        transport: server.transport,
        healthy: probe.healthy,
        status: probe.status,
        error: probe.error,
        checkedAt,
      });
    }
  }

  return reports;
}

export type McpServerHealthProbeReport = McpServerHealthProbe;
