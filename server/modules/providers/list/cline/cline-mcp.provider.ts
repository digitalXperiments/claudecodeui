import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  getClineDataDirectory,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

const fileExists = async (filePath: string): Promise<boolean> => access(filePath).then(() => true).catch(() => false);

export class ClineMcpProvider extends McpProvider {
  private readonly configPath = path.join(getClineDataDirectory(), 'settings', 'cline_mcp_settings.json');

  constructor() {
    super('cline', ['user'], ['stdio', 'http']);
  }

  protected async readScopedServers(_scope: McpScope, _workspacePath: string): Promise<Record<string, unknown>> {
    try {
      const config = readObjectRecord(JSON.parse(await readFile(this.configPath, 'utf8')));
      return readObjectRecord(config?.mcpServers) ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  protected async writeScopedServers(_scope: McpScope, _workspacePath: string, servers: Record<string, unknown>): Promise<void> {
    if (!(await fileExists(this.configPath))) await mkdir(path.dirname(this.configPath), { recursive: true });
    let config: Record<string, unknown> = {};
    try { config = readObjectRecord(JSON.parse(await readFile(this.configPath, 'utf8'))) ?? {}; } catch { /* replace malformed config safely */ }
    config.mcpServers = servers;
    await writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new AppError('command is required for stdio MCP servers.', { code: 'MCP_COMMAND_REQUIRED', statusCode: 400 });
      return { command: input.command, args: input.args ?? [], env: input.env ?? {}, disabled: false, autoApprove: [] };
    }
    if (!input.url?.trim()) throw new AppError('url is required for http MCP servers.', { code: 'MCP_URL_REQUIRED', statusCode: 400 });
    return { url: input.url, type: 'streamableHttp', headers: input.headers ?? {}, disabled: false, autoApprove: [] };
  }

  protected normalizeServerConfig(scope: McpScope, name: string, rawConfig: unknown): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) return null;
    const commandParts = typeof config.command === 'string' ? [config.command, ...(readStringArray(config.args) ?? [])] : readStringArray(config.command);
    if (commandParts?.[0]) return { provider: this.provider, name, scope, transport: 'stdio', command: commandParts[0], args: commandParts.slice(1), env: readStringRecord(config.env) };
    const url = readOptionalString(config.url);
    if (url) return { provider: this.provider, name, scope, transport: 'http', url, headers: readStringRecord(config.headers) };
    return null;
  }
}
