export type GatewayEnforcement = 'enforced' | 'advisory';

/**
 * Whether a run on this provider can reach MCP tools ONLY through the gateway.
 * 'advisory' means the gateway is attached, but the provider can still load its own
 * MCP servers (native config, cloud connectors), so a call may bypass the gate.
 * Keep in sync with ENFORCEMENT.md.
 */
const ENFORCEMENT: Record<string, GatewayEnforcement> = {
  claude: 'enforced',
  opencode: 'enforced',
  codex: 'advisory',
  grok: 'advisory',
  kimi: 'advisory',
  cursor: 'advisory',
  kilo: 'advisory',
  cline: 'advisory',
  qwencode: 'advisory',
  pi: 'advisory',
  omp: 'advisory',
  antigravity: 'advisory',
};

export function getGatewayEnforcement(provider: string): GatewayEnforcement {
  return ENFORCEMENT[provider] ?? 'advisory';
}
