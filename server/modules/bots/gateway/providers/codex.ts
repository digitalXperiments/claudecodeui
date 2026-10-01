import { getBotGatewayMcpLaunchSpec } from '../gateway.routes.js';

import type { ProviderGatewayAdapter } from './types.js';

/**
 * Codex: enforced when the run carries the built-in tool gate.
 *
 * Mechanism (server/modules/providers/list/codex/codex-gateway-strict.js, applied by openai-codex.js
 * when `options.botGatewayStrict`): the run gets a throwaway CODEX_HOME (no user config.toml), the
 * gateway as the only MCP server (session id and binding secret forwarded to its child), untrusted
 * project config, approval policy `untrusted` with every request answered by
 * `options.builtinToolGate`, and an OS-level read deny on the credential directories.
 * See gateway/providers/codex.md for what was verified and what is still open.
 */
export const codexGatewayAdapter: ProviderGatewayAdapter = {
  applyRunOptions(options) {
    // The launch spec carries the loopback API URL and token; the runtime adds the per-run
    // session id and binding secret (options.appSessionId / options.botGatewaySecret).
    options.codexGatewayMcp = getBotGatewayMcpLaunchSpec();
    options.strictMcpSelection = true;
    options.botGatewayStrict = true;
  },
  enforced: (run) => run.builtinToolGate === true,
  describe: (run) => (run.builtinToolGate === true
    ? 'Only the gateway is loaded (managed CODEX_HOME), Codex asks before every command or patch, and each request goes through the gate.'
    : 'Gateway-only MCP, but built-in tools are not gated for this run.'),
};
