import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Antigravity CLI MCP integration is not wired up (its MCP configuration path
 * and format are not part of this lean provider). Declaring no supported scopes
 * or transports disables the MCP UI for `agy` cleanly — `listServers` returns
 * empty groups and any upsert/remove is rejected by the base class's scope
 * guard before these stubs are ever reached.
 */
export class AgyMcpProvider extends McpProvider {
  constructor() {
    super('agy', [], []);
  }

  protected async readScopedServers(): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(): Promise<void> {
    throw new AppError('Antigravity does not support MCP configuration.', {
      code: 'MCP_UNSUPPORTED',
      statusCode: 400,
    });
  }

  protected buildServerConfig(_input: UpsertProviderMcpServerInput): Record<string, unknown> {
    throw new AppError('Antigravity does not support MCP configuration.', {
      code: 'MCP_UNSUPPORTED',
      statusCode: 400,
    });
  }

  protected normalizeServerConfig(
    _scope: McpScope,
    _name: string,
    _rawConfig: unknown,
  ): ProviderMcpServer | null {
    return null;
  }
}
