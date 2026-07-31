/**
 * Expand selected MCP server names into provider tool allow-list entries.
 * Values that already look like tool patterns (mcp__, Bash(, etc.) are kept as-is.
 */
export function expandMcpSelectionsToTools(selections: string[], provider: string): string[] {
  const out = new Set<string>();
  for (const raw of selections) {
    const entry = raw.trim();
    if (!entry) continue;
    if (
      entry.startsWith('mcp__') ||
      entry.startsWith('Bash(') ||
      entry.includes('*') ||
      entry.includes('(')
    ) {
      out.add(entry);
      continue;
    }
    // Normalize server display names into Claude-style MCP tool prefixes.
    // Claude tool names look like mcp__Server_Name__tool_name.
    const normalized = entry.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!normalized) continue;
    if (provider === 'claude' || provider === 'cursor') {
      out.add(`mcp__${normalized}`);
      out.add(`mcp__${normalized}__*`);
    } else {
      // Other providers typically key MCP by server name or free-form allow list.
      out.add(entry);
      out.add(normalized);
    }
  }
  return [...out];
}

/** Merge two allow-lists, preserving order and uniqueness. */
export function mergeToolAllowLists(...lists: Array<string[] | undefined>): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const trimmed = typeof entry === 'string' ? entry.trim() : '';
      if (trimmed) out.add(trimmed);
    }
  }
  return [...out];
}
