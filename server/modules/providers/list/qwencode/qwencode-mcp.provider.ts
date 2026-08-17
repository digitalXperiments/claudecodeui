import os from 'node:os';
import path from 'node:path';
import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError, readJsonConfig, readObjectRecord, readStringArray, readStringRecord, writeJsonConfig } from '@/shared/utils.js';

export class QwenCodeMcpProvider extends McpProvider {
  constructor() { super('qwencode', ['user', 'project'], ['stdio', 'http', 'sse']); }

  private file(scope: McpScope, workspacePath: string): string {
    return path.join(scope === 'user' ? path.join(os.homedir(), '.qwen') : path.join(workspacePath, '.qwen'), 'settings.json');
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsonConfig(this.file(scope, workspacePath));
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(scope: McpScope, workspacePath: string, servers: Record<string, unknown>): Promise<void> {
    const filePath = this.file(scope, workspacePath);
    const config = await readJsonConfig(filePath);
    config.mcpServers = servers;
    await writeJsonConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new AppError('command is required for stdio MCP servers.', { code: 'MCP_COMMAND_REQUIRED', statusCode: 400 });
      return { command: input.command, args: input.args ?? [], env: input.env ?? {}, cwd: input.cwd };
    }
    if (!input.url?.trim()) throw new AppError('url is required for HTTP MCP servers.', { code: 'MCP_URL_REQUIRED', statusCode: 400 });
    return input.transport === 'sse' ? { url: input.url, headers: input.headers ?? {} } : { httpUrl: input.url, headers: input.headers ?? {} };
  }

  protected normalizeServerConfig(scope: McpScope, name: string, rawConfig: unknown): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) return null;
    if (typeof config.command === 'string') return { provider: 'qwencode', name, scope, transport: 'stdio', command: config.command, args: readStringArray(config.args), env: readStringRecord(config.env), cwd: typeof config.cwd === 'string' ? config.cwd : undefined };
    const url = typeof config.httpUrl === 'string' ? config.httpUrl : config.url;
    if (typeof url === 'string') return { provider: 'qwencode', name, scope, transport: typeof config.httpUrl === 'string' ? 'http' : 'sse', url, headers: readStringRecord(config.headers) };
    return null;
  }
}
