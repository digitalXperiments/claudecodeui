import { antigravityGatewayAdapter } from './antigravity.js';
import { claudeGatewayAdapter } from './claude.js';
import { codexGatewayAdapter } from './codex.js';
import { grokGatewayAdapter } from './grok.js';
import type { ProviderGatewayAdapter } from './types.js';

export type { ProviderGatewayAdapter } from './types.js';

const ADAPTERS: Record<string, ProviderGatewayAdapter> = {
  claude: claudeGatewayAdapter,
  codex: codexGatewayAdapter,
  grok: grokGatewayAdapter,
  antigravity: antigravityGatewayAdapter,
};

export function getProviderGatewayAdapter(provider: string): ProviderGatewayAdapter | null {
  return ADAPTERS[provider] ?? null;
}

/** Applies the provider's gateway run options, if it has an adapter. */
export function applyProviderGatewayRunOptions(provider: string, options: Record<string, unknown>): void {
  ADAPTERS[provider]?.applyRunOptions?.(options);
}
