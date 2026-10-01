import type { ProviderGatewayAdapter } from './types.js';

const GATEWAY_MCP_NAME = 'cloudcli-tool-gateway';

/**
 * Antigravity: enforced when the run carries the built-in tool gate.
 *
 * Mechanism (see providers/list/antigravity/antigravity-gateway.ts, derived from the bundled ACP
 * server source): the run gets a private GEMINI_HOME with an empty config/ (no global MCP, hooks or
 * skills), only the gateway through ACP `session/new` stamped with the session id and binding secret,
 * session mode forced to `default`, and every `session/request_permission` / client `fs/*` request
 * decided by `options.builtinToolGate` (never auto-approved, never "Allow Always").
 *
 * What it still does not cover is spelled out in gateway/providers/antigravity.md.
 */
export const antigravityGatewayAdapter: ProviderGatewayAdapter = {
  applyRunOptions(options) {
    // Never run a gateway-bound Antigravity session in yolo/auto_edit; the runtime forces this too.
    options.permissionMode = 'default';
    options.mcpServers = [GATEWAY_MCP_NAME];
    options.strictMcpSelection = true;
    options.botGatewayStrict = true;
  },
  enforced: (run) => run.builtinToolGate === true,
  describe: (run) => (run.builtinToolGate === true
    ? 'Only the gateway is attached (private GEMINI_HOME, no user MCP/hooks) and every shell, file, web and MCP permission request goes through the built-in gate; read-only workspace tools (list/search/view) are confined by Antigravity itself and are not gated.'
    : 'Only the gateway is attached, but no built-in tool gate is installed: every built-in action is denied.'),
};
