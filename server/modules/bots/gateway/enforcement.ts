export type GatewayEnforcement = 'enforced' | 'advisory';

/**
 * Whether a run on this provider is fully governed by the gateway and the built-in tool gate.
 * 'advisory' means the gateway is attached, but the provider can still load its own MCP servers
 * (native config, cloud connectors) or use built-in tools (Bash/Edit/Write) that never reach the
 * gate, so a call may bypass it. Claude is 'enforced' only when the run has the built-in tool gate
 * installed (`getGatewayEnforcement('claude', { builtinToolGate: true })`). Keep in sync with ENFORCEMENT.md.
 */
const ENFORCEMENT: Record<string, GatewayEnforcement> = {
  claude: 'advisory',
  opencode: 'advisory',
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

export function getGatewayEnforcement(
  provider: string,
  run: { builtinToolGate?: boolean } = {},
): GatewayEnforcement {
  if (provider === 'claude' && run.builtinToolGate === true) return 'enforced';
  return ENFORCEMENT[provider] ?? 'advisory';
}
