import type { ProviderGatewayAdapter } from './types.js';

/**
 * grok: enforced when the run carries the built-in tool gate.
 *
 * grok-cli.js (options.botGatewayStrict) gives the run a one-run GROK_HOME with no MCP servers,
 * turns off the Claude/Cursor/Codex MCP imports and grok.com connectors, passes only the gateway
 * over ACP (stamped with the run's session id and binding secret), and asks the built-in tool gate
 * about every `session/request_permission`. See gateway/providers/grok.md.
 */
export const grokGatewayAdapter: ProviderGatewayAdapter = {
  applyRunOptions(options) {
    // Never always-approve: with `permission_mode = default` and `ask = ["*"]` grok asks for every
    // tool call and the gate answers. (grok-cli.js enforces this again.)
    options.permissionMode = 'default';
  },
  enforced: (run) => run.builtinToolGate === true,
  describe: (run) => (run.builtinToolGate === true
    ? 'Only the gateway is attached over ACP (own and imported MCP config and grok.com connectors are switched off in a per-run GROK_HOME) and every built-in tool call is decided by the gate.'
    : 'Gateway attached, but built-in tools are not gated for this run.'),
};
