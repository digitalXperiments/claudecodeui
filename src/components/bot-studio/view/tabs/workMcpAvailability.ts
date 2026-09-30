import type { McpInventoryItem } from '../../../mcp/types';
import type { McProvider } from '../../../mission-control/api/missionControlApi';

/** Match the work-session preflight: native discovery alone is not a catalog binding. */
export function workMcpUnavailableReason(item: McpInventoryItem | undefined, provider: McProvider): string | null {
  if (!item) return 'Not found in MCP inventory';
  if (provider === 'claude' && /^claude\.ai\b/i.test(item.name.trim())) return null;
  if (item.source === 'provider_cloud') return `Account connector belongs to ${item.originProvider ?? item.providers[0] ?? 'another agent'}`;
  if (item.source !== 'cloudcli') return 'Add to the shared catalog in Settings → MCP';
  if (!item.bindings?.[provider]?.enabled) return `Enable for ${provider} in Settings → MCP`;
  return null;
}
