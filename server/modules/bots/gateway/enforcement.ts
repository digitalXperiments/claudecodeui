import type { BotAutonomy } from '../bots-runtime-config.js';

import { getProviderGatewayAdapter } from './providers/index.js';

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
  const adapter = getProviderGatewayAdapter(provider);
  if (adapter) return adapter.enforced(run) ? 'enforced' : 'advisory';
  return ENFORCEMENT[provider] ?? 'advisory';
}

/** Human-readable explanation of a provider's enforcement for the UI. */
export function describeGatewayEnforcement(provider: string, run: { builtinToolGate?: boolean } = {}): string {
  const adapter = getProviderGatewayAdapter(provider);
  if (adapter) return adapter.describe(run);
  return `Gateway attached, but ${provider} can still load its own MCP servers and use built-in tools outside the gate.`;
}

/** 'off' = the bot is Bypass: no gateway, nothing checked. */
export type EnforcementLevel = GatewayEnforcement | 'off';

/** Plain-English reason enforcement is 'off' for a Bypass bot. */
export function describeBypassEnforcement(provider: string, permissionMode?: string | null): string {
  return (
    'Autonomy is Bypass: this bot does not use the CloudCLI tool gateway, so nothing it does is checked or held for approval. ' +
    `${provider} runs it under its own permission mode (${permissionMode?.trim() || 'bypassPermissions'}).`
  );
}

/**
 * How firmly the gate governs a run on `provider` at the given autonomy. Bypass bots skip the
 * gateway entirely, so their level is 'off'; ask and auto both run through the gate.
 */
export function enforcementForAutonomy(
  provider: string,
  autonomy: BotAutonomy,
  options: { permissionMode?: string | null } = {},
): { level: EnforcementLevel; detail: string; builtin_tool_gate: boolean } {
  if (autonomy === 'bypass') {
    return { level: 'off', detail: describeBypassEnforcement(provider, options.permissionMode), builtin_tool_gate: false };
  }
  const run = { builtinToolGate: true } as const;
  const level = getGatewayEnforcement(provider, run);
  return { level, detail: describeGatewayEnforcement(provider, run), builtin_tool_gate: level === 'enforced' };
}
