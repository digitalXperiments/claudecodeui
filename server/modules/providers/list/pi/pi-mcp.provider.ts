import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Pi deliberately ships without built-in MCP (skills/CLI tools instead).
 * We still register an MCP facet so global MCP add/list APIs don't break,
 * but all scoped reads return empty and writes are rejected with a clear
 * error so the UI can explain Pi's design choice.
 */
export class PiMcpProvider extends McpProvider {
  constructor() {
    // Report empty scopes so the frontend treats Pi as MCP-unsupported
    // (mirrors providers that cannot store MCP config).
    super('pi', [], []);
  }

  protected async readScopedServers(_scope: McpScope, _workspacePath: string): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(
    _scope: McpScope,
    _workspacePath: string,
    _servers: Record<string, unknown>,
  ): Promise<void> {
    throw new AppError(
      'Pi does not support built-in MCP servers. Use Pi skills or extensions instead.',
      {
        code: 'MCP_NOT_SUPPORTED',
        statusCode: 400,
      },
    );
  }

  protected buildServerConfig(_input: UpsertProviderMcpServerInput): Record<string, unknown> {
    throw new AppError(
      'Pi does not support built-in MCP servers. Use Pi skills or extensions instead.',
      {
        code: 'MCP_NOT_SUPPORTED',
        statusCode: 400,
      },
    );
  }

  protected normalizeServerConfig(
    _scope: McpScope,
    _name: string,
    _rawConfig: unknown,
  ): ProviderMcpServer | null {
    return null;
  }
}
