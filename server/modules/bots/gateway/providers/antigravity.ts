import type { ProviderGatewayAdapter } from './types.js';

/** antigravity: not yet enforced — native MCP config and built-in tools can bypass the gate. */
export const antigravityGatewayAdapter: ProviderGatewayAdapter = {
  enforced: () => false,
  describe: () => 'Gateway attached, but antigravity can still load its own MCP servers and use built-in tools outside the gate.',
};
