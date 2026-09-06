import os from 'node:os';
import path from 'node:path';

import {
  listMcpServersFromCli,
  mergeCliMcpEntries,
} from '@/modules/providers/services/mcp-cli-list.service.js';
import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  updateJsonConfig,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * `claude mcp list` stopped enumerating account-managed connectors (e.g. after
 * switching to a long-lived OAuth token) even though they are still connected
 * and Settings' catalog still shows them via a cached/hinted read of the same
 * file. `~/.claude.json` records every claude.ai connector the account has
 * ever linked in `claudeAiMcpEverConnected`, independent of the CLI — use it
 * as a name-only fallback so Mission Control's tool picker isn't silently
 * emptied by a CLI regression. See mcp-catalog.service.ts loadClaudeAccountHints
 * for the sibling read used by Settings.
 */
async function readClaudeAiAccountHintNames(): Promise<string[]> {
  const filePath = path.join(os.homedir(), '.claude.json');
  try {
    const config = await readJsonConfig(filePath) as { claudeAiMcpEverConnected?: unknown };
    if (!Array.isArray(config.claudeAiMcpEverConnected)) return [];
    return config.claudeAiMcpEverConnected.filter(
      (name): name is string => typeof name === 'string' && /^claude\.ai\b/i.test(name),
    );
  } catch {
    return [];
  }
}

export class ClaudeMcpProvider extends McpProvider {
  constructor() {
    super('claude', ['user', 'local', 'project'], ['stdio', 'http', 'sse']);
  }

  /**
   * File-based servers + live `claude mcp list` inventory so claude.ai hosted
   * connectors (Gmail, Slack, Atlassian, …) appear alongside local stdio/http
   * entries. Hosted connectors never live in ~/.claude.json mcpServers.
   */
  override async listServersForScope(
    scope: McpScope,
    options?: { workspacePath?: string },
  ): Promise<ProviderMcpServer[]> {
    const fromFiles = await super.listServersForScope(scope, options);
    // CLI list is global for the machine; merge it into user (and project when
    // cwd-specific .mcp.json servers also appear in the CLI output).
    if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
      return fromFiles;
    }
    let merged = fromFiles;
    try {
      const cliEntries = await listMcpServersFromCli('claude');
      merged = mergeCliMcpEntries('claude', scope, fromFiles, cliEntries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[ClaudeMcp] CLI list failed, using file config only:', message);
    }

    const hasAccountConnectors = merged.some((server) => /^claude\.ai\b/i.test(server.name));
    if (!hasAccountConnectors) {
      const hintNames = await readClaudeAiAccountHintNames();
      for (const name of hintNames) {
        merged.push({ provider: 'claude', name, scope, transport: 'http' });
      }
    }
    return merged;
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    if (scope === 'project') {
      const filePath = path.join(workspacePath, '.mcp.json');
      const config = await readJsonConfig(filePath);
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const filePath = path.join(os.homedir(), '.claude.json');
    const config = await readJsonConfig(filePath);
    if (scope === 'user') {
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const projects = readObjectRecord(config.projects) ?? {};
    const projectConfig = readObjectRecord(projects[workspacePath]) ?? {};
    return readObjectRecord(projectConfig.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    if (scope === 'project') {
      const filePath = path.join(workspacePath, '.mcp.json');
      const config = await readJsonConfig(filePath);
      config.mcpServers = servers;
      await writeJsonConfig(filePath, config);
      return;
    }

    // `~/.claude.json` is owned by the Claude Code CLI, which rewrites it
    // constantly (session metrics, trust flags, `oauthAccount`). Merge under the
    // write lock against a freshly-read copy and touch only the `mcpServers` keys
    // we own, so we never write back a stale snapshot of everything else — a lost
    // update there reverts the user's Claude login state.
    const filePath = path.join(os.homedir(), '.claude.json');
    await updateJsonConfig(filePath, (config) => {
      if (scope === 'user') {
        config.mcpServers = servers;
        return config;
      }

      const projects = readObjectRecord(config.projects) ?? {};
      const projectConfig = readObjectRecord(projects[workspacePath]) ?? {};
      projectConfig.mcpServers = servers;
      projects[workspacePath] = projectConfig;
      config.projects = projects;
      return config;
    });
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        type: 'stdio',
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http/sse MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: input.transport,
      url: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }

    const config = rawConfig as Record<string, unknown>;
    if (typeof config.command === 'string') {
      return {
        provider: 'claude',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    if (typeof config.url === 'string') {
      const transport = readOptionalString(config.type) === 'sse' ? 'sse' : 'http';
      return {
        provider: 'claude',
        name,
        scope,
        transport,
        url: config.url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
