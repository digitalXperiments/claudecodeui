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
 * Content-Type ... (40012)"). It also caps `simple_search` results, which the
 * Local REST API returns unbounded — broad queries otherwise exceed MCP client
 * token limits. Not published to npm — run from source instead of `npx`.
 * Rebuild after pulling changes with `cd ~/Development/mcp-obsidian &&
 * npx bun run build` (the repo's `build` script writes the shebang, then
 * appends the bundle).
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

/**
 * Builds the per-process Codex app-server override for the managed Obsidian
 * server.
 *
 * Codex serializes `config` as `--config key=value` arguments. Keep
 * the credential out of that argument list: pass all runtime values through
 * the child environment and ask Codex to forward the named variables to the
 * MCP process via `env_vars`.
 */
export const buildObsidianCodexRuntimeConfig = (
  settings: ObsidianMemorySettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): {
  config: {
    mcp_servers: Record<string, {
      command: string;
      args: string[];
      env_vars: string[];
      default_tools_approval_mode: 'auto';
    }>;
  };
  env: Record<string, string>;
} => {
  const input = buildObsidianMcpServerInput(settings);
  const env = Object.fromEntries(
    Object.entries(baseEnvironment).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    )),
  );
  const obsidianEnvironment = input.env ?? {};

  return {
    config: {
      mcp_servers: {
        [OBSIDIAN_MCP_SERVER_NAME]: {
          command: input.command ?? 'node',
          args: input.args ?? [],
          env_vars: Object.keys(obsidianEnvironment),
          // Obsidian is a managed CloudCLI server. Let its tools run without
          // a second MCP approval prompt; command/file permissions still use
          // the Codex app-server bridge above.
          default_tools_approval_mode: 'auto',
        },
      },
    },
    env: {
      ...env,
      ...obsidianEnvironment,
    },
  };
};
