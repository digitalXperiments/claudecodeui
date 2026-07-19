import type { ObsidianMemorySettings, UpsertProviderMcpServerInput } from '@/shared/types.js';

/**
 * The MCP server name registered into every agent for Obsidian memory. Kept as a
 * single constant so enable/disable and status all agree on the identifier.
 */
export const OBSIDIAN_MCP_SERVER_NAME = 'obsidian';

/**
 * Builds the MCP server definition that agents use to reach Obsidian at runtime.
 *
 * Uses `@fazer-ai/mcp-obsidian` (launched over stdio via `npx`), which talks to
 * the Obsidian Local REST API community plugin. Its env contract is
 * OBSIDIAN_API_KEY / OBSIDIAN_PROTOCOL / OBSIDIAN_HOST / OBSIDIAN_PORT. The exact
 * package/env is centralized here so it can be swapped without touching the
 * service, routes, or fan-out logic. `scope`/`workspacePath` are filled in by the
 * caller.
 */
export const buildObsidianMcpServerInput = (
  settings: ObsidianMemorySettings,
): Omit<UpsertProviderMcpServerInput, 'scope' | 'workspacePath'> => ({
  name: OBSIDIAN_MCP_SERVER_NAME,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@fazer-ai/mcp-obsidian@latest'],
  env: {
    OBSIDIAN_API_KEY: settings.restApiKey,
    OBSIDIAN_PROTOCOL: settings.restProtocol,
    OBSIDIAN_HOST: settings.restHost,
    OBSIDIAN_PORT: String(settings.restPort),
  },
});
