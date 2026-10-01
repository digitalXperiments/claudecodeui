import type { ProviderGatewayAdapter } from './types.js';

/** codex: not yet enforced — native MCP config and built-in tools can bypass the gate. */
export const codexGatewayAdapter: ProviderGatewayAdapter = {
  enforced: () => false,
  describe: () => 'Gateway attached, but codex can still load its own MCP servers and use built-in tools outside the gate.',
};
