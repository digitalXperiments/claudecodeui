import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Antigravity has no CloudCLI-writable MCP config file that has been verified to
 * exist, so this facet is deliberately empty rather than pointed at a guessed
 * path (`~/.gemini/settings.json` would be a guess, and writing MCP servers into
 * a file another tool owns is worse than not supporting MCP).
 *
 * Reporting zero scopes makes the frontend render Antigravity as MCP-unsupported
 * — the same honest treatment Pi and Oh My Pi get — while keeping the facet
 * present so the global MCP APIs still resolve every provider.
 *
 * Antigravity's ACP `session/new` does accept an `mcpServers` array, and the
 * chat runtime passes the resolved catalog through there for providers that
 * support it. If a native config file is confirmed later, implement
 * `readScopedServers`/`writeScopedServers` against it and widen the scope list;
 * nothing else in this provider needs to change.
 */
const UNSUPPORTED = 'Antigravity does not expose a CloudCLI-writable MCP config file. Attach MCP servers per session instead.';

export class AntigravityMcpProvider extends McpProvider {
  constructor() {
    super('antigravity', [], []);
  }

  protected async readScopedServers(_scope: McpScope, _workspacePath: string): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(
    _scope: McpScope,
    _workspacePath: string,
    _servers: Record<string, unknown>,
  ): Promise<void> {
    throw new AppError(UNSUPPORTED, { code: 'MCP_NOT_SUPPORTED', statusCode: 400 });
  }

  protected buildServerConfig(_input: UpsertProviderMcpServerInput): Record<string, unknown> {
    throw new AppError(UNSUPPORTED, { code: 'MCP_NOT_SUPPORTED', statusCode: 400 });
  }

  protected normalizeServerConfig(
    _scope: McpScope,
    _name: string,
    _rawConfig: unknown,
  ): ProviderMcpServer | null {
    return null;
  }
}
