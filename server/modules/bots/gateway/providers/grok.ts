import type { ProviderGatewayAdapter } from './types.js';

/** grok: not yet enforced — native MCP config and built-in tools can bypass the gate. */
export const grokGatewayAdapter: ProviderGatewayAdapter = {
  enforced: () => false,
  describe: () => 'Gateway attached, but grok can still load its own MCP servers and use built-in tools outside the gate.',
};
