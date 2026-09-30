import { createHash } from 'node:crypto';

export const FIRST_PARTY_PREFIX = 'bot__';
export const MAX_TOOL_NAME_LENGTH = 64;

/** MCP clients accept [a-zA-Z0-9_-]; everything else collapses to `_`. */
export function sanitizeToolPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function toExposedName(server: string, tool: string): string {
  const full = `${sanitizeToolPart(server)}__${sanitizeToolPart(tool)}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
  return `${full.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${shortHash(`${server}\u0000${tool}`)}`;
}

export interface ToolNameEntry {
  server: string;
  tool: string;
}

export interface ToolNameMap {
  exposedName(server: string, tool: string): string | undefined;
  resolve(exposed: string): ToolNameEntry | undefined;
}

/**
 * Builds the exposed-name <-> (server, tool) map for one listing. Sanitizing is lossy, so
 * names are never split on `__`; two upstream tools that sanitize to the same name get a
 * hash suffix instead of shadowing one another.
 */
export function buildToolNameMap(entries: ToolNameEntry[]): ToolNameMap {
  const byExposed = new Map<string, ToolNameEntry>();
  const byOriginal = new Map<string, string>();
  for (const entry of entries) {
    const key = `${entry.server}\u0000${entry.tool}`;
    if (byOriginal.has(key)) continue;
    let exposed = toExposedName(entry.server, entry.tool);
    // An upstream server called "bot" must not be able to pose as a first-party tool.
    if (exposed.startsWith(FIRST_PARTY_PREFIX)) exposed = `ext_${exposed}`.slice(0, MAX_TOOL_NAME_LENGTH);
    if (byExposed.has(exposed)) {
      exposed = `${exposed.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${shortHash(key)}`;
    }
    byExposed.set(exposed, entry);
    byOriginal.set(key, exposed);
  }
  return {
    exposedName: (server, tool) => byOriginal.get(`${server}\u0000${tool}`),
    resolve: (exposed) => byExposed.get(exposed),
  };
}
