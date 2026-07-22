import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import {
  listMcpServersFromCli,
  mergeCliMcpEntries,
} from '@/modules/providers/services/mcp-cli-list.service.js';
import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

const readTomlConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = TOML.parse(content) as Record<string, unknown>;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

const writeTomlConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const toml = TOML.stringify(data as never);
  await writeFile(filePath, toml, 'utf8');
};

/**
 * Grok stores some connector tool descriptors under
 * ~/.grok/projects/<encoded-cwd>/mcps/<name>/ — including grok.com-linked
 * servers that never appear in config.toml. Directory names are server names.
 */
async function listGrokProjectMcpDirNames(workspacePath: string): Promise<string[]> {
  const encoded = workspacePath.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-|-$/g, '');
  // Grok uses path-with-dashes encoding: /Users/foo -> Users-foo
  const alt = workspacePath
    .replace(/^\//, '')
    .replace(/\//g, '-');
  const candidates = [
    path.join(os.homedir(), '.grok', 'projects', encoded, 'mcps'),
    path.join(os.homedir(), '.grok', 'projects', alt, 'mcps'),
  ];
  const names = new Set<string>();
  for (const dir of candidates) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          names.add(entry.name);
        }
      }
    } catch {
      // missing dir is fine
    }
  }
  return [...names];
}

export class GrokMcpProvider extends McpProvider {
  constructor() {
    super('grok', ['user', 'project'], ['stdio', 'http']);
  }

  /**
   * File config + project mcps dirs + live `grok mcp list` so grok.com-linked
   * and project servers show up (they often never land in config.toml).
   */
  override async listServersForScope(
    scope: McpScope,
    options?: { workspacePath?: string },
  ): Promise<ProviderMcpServer[]> {
    const fromFiles = await super.listServersForScope(scope, options);
    let merged = fromFiles;

    // Surface project MCP directory names when listing project/user scopes.
    const workspacePath = path.resolve(options?.workspacePath ?? os.homedir());
    try {
      const dirNames = await listGrokProjectMcpDirNames(workspacePath);
      // Also scan the home project (common for global / home workspaces).
      const homeNames = await listGrokProjectMcpDirNames(os.homedir());
      const allNames = new Set([...dirNames, ...homeNames]);
      const byName = new Map(merged.map((s) => [s.name, s]));
      for (const name of allNames) {
        if (byName.has(name)) continue;
        byName.set(name, {
          provider: 'grok',
          name,
          scope: scope === 'user' ? 'user' : 'project',
          transport: 'http',
          // Placeholder — actual connection is managed by the Grok CLI.
          url: `grok-project-mcp://${name}`,
        });
      }
      merged = [...byName.values()];
    } catch {
      // ignore
    }

    try {
      const cliEntries = await listMcpServersFromCli('grok');
      return mergeCliMcpEntries('grok', scope, merged, cliEntries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[GrokMcp] CLI list failed, using file/project config only:', message);
      return merged.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const filePath = scope === 'user'
      ? path.join(os.homedir(), '.grok', 'config.toml')
      : path.join(workspacePath, '.grok', 'config.toml');
    const config = await readTomlConfig(filePath);
    return readObjectRecord(config.mcp_servers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = scope === 'user'
      ? path.join(os.homedir(), '.grok', 'config.toml')
      : path.join(workspacePath, '.grok', 'config.toml');
    const config = await readTomlConfig(filePath);
    config.mcp_servers = servers;
    await writeTomlConfig(filePath, config);
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
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        cwd: input.cwd,
        // Grok treats a server as active only when `enabled` is truthy in
        // practice; every server the CLI writes itself sets it explicitly.
        // Although the docs say it defaults to true, we emit it to match the
        // working entries and avoid a silently-skipped server.
        enabled: true,
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      url: input.url,
      headers: input.headers ?? {},
      enabled: true,
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
        provider: 'grok',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
      };
    }

    if (typeof config.url === 'string') {
      return {
        provider: 'grok',
        name,
        scope,
        transport: 'http',
        url: config.url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
