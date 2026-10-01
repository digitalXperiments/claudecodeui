import type { ProviderGatewayAdapter } from './types.js';

/** Claude: strict MCP config (claude-sdk honours botGatewayStrict) + canUseTool built-in gate. */
export const claudeGatewayAdapter: ProviderGatewayAdapter = {
  enforced: (run) => run.builtinToolGate === true,
  describe: (run) => (run.builtinToolGate === true
    ? 'Only the gateway is loaded (--strict-mcp-config) and built-in tools go through the gate.'
    : 'Gateway attached, but built-in tools are not gated for this run.'),
};
