import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

export class AgyMcpProvider extends McpProvider {
  constructor() {
    super('agy', ['user', 'project'], ['stdio', 'http', 'sse']);
  }

  private getUserMcpPath(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp_config.json');
  }

  private getProjectMcpPath(workspacePath: string): string {
    return path.join(workspacePath, '.gemini', 'mcp_config.json');
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const filePath = scope === 'project' ? this.getProjectMcpPath(workspacePath) : this.getUserMcpPath();
    const config = await readJsonConfig(filePath);
    return readObjectRecord(config.mcpServers) ?? readObjectRecord(config.servers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = scope === 'project' ? this.getProjectMcpPath(workspacePath) : this.getUserMcpPath();
    const config = await readJsonConfig(filePath);
    config.mcpServers = servers;
    await writeJsonConfig(filePath, config);
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
        provider: 'agy',
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
        provider: 'agy',
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

