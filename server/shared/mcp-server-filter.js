/**
 * Narrows the loaded MCP servers for a run. Relay workers and bot-gateway runs see only
 * the servers named in `options.mcpServers`; everything else keeps the full set.
 * (`strictMcpSelection` alone is not enough: work sessions already pass it for OpenCode,
 * and Claude must keep its full set for those while the runtime v2 flag is off.)
 * Relay workers never get the relay MCP itself. Returns null when nothing remains.
 */
export function filterMcpServersForRun(mcpServers, options = {}) {
  if (!mcpServers || !(options.relayWorker || options.botGatewayStrict)) return mcpServers;
  const allowed = Array.isArray(options.mcpServers)
    ? new Set(options.mcpServers.filter((name) => typeof name === 'string' && name.trim()))
    : new Set();
  const filtered = {};
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (options.relayWorker && name === 'cloudcli-agent-relay') continue;
    if (!allowed.has(name)) continue;
    filtered[name] = entry;
  }
  return Object.keys(filtered).length > 0 ? filtered : null;
}
