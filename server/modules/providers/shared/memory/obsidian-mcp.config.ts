import os from 'node:os';
import path from 'node:path';

import type { ObsidianMemorySettings, UpsertProviderMcpServerInput } from '@/shared/types.js';

/**
 * The MCP server name registered into every agent for Obsidian memory. Kept as a
 * single constant so enable/disable and status all agree on the identifier.
 */
export const OBSIDIAN_MCP_SERVER_NAME = 'obsidian';

/**
 * Local fork of `@fazer-ai/mcp-obsidian` (branch
 * `fix/204-empty-body-and-patch-content-type`), built to `dist/index.js`.
 * The upstream 1.2.0 package has two bugs: it calls `response.json()` on the
 * Local REST API's 204 No Content write responses (throws "Unexpected end of
 * JSON input" on every successful write), and `patch_file`/`patch_active`/
 * `patch_periodic` omit the `Content-Type` header entirely unless the caller
 * passes one, which the Local REST API rejects outright ("Unknown or invalid
 * Content-Type ... (40012)"). Not published to npm — run from source instead
 * of `npx`. Rebuild after pulling changes: `cd ~/Development/mcp-obsidian &&
 * npx bun build src/index.ts --target node >> dist/index.js` (see that repo's
 * package.json `build` script).
 */
const OBSIDIAN_MCP_FORK_ENTRYPOINT = path.join(
  os.homedir(),
  'Development',
  'mcp-obsidian',
  'dist',
  'index.js',
);

/**
 * Builds the MCP server definition that agents use to reach Obsidian at runtime.
 *
 * Uses our patched fork of `@fazer-ai/mcp-obsidian` (see
 * `OBSIDIAN_MCP_FORK_ENTRYPOINT` above), which talks to the Obsidian Local REST
 * API community plugin. Its env contract is OBSIDIAN_API_KEY /
 * OBSIDIAN_PROTOCOL / OBSIDIAN_HOST / OBSIDIAN_PORT. The exact package/env is
 * centralized here so it can be swapped without touching the service, routes,
 * or fan-out logic. `scope`/`workspacePath` are filled in by the caller.
 */
export const buildObsidianMcpServerInput = (
  settings: ObsidianMemorySettings,
): Omit<UpsertProviderMcpServerInput, 'scope' | 'workspacePath'> => ({
  name: OBSIDIAN_MCP_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [OBSIDIAN_MCP_FORK_ENTRYPOINT],
  env: {
    OBSIDIAN_API_KEY: settings.restApiKey,
    OBSIDIAN_PROTOCOL: settings.restProtocol,
    OBSIDIAN_HOST: settings.restHost,
    OBSIDIAN_PORT: String(settings.restPort),
  },
});
