import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  Clipboard,
  ClipboardCheck,
  CircleAlert,
  Loader2,
  Pin,
  RefreshCw,
  Search,
  Server,
  Wrench,
} from 'lucide-react';

import { Badge, Button, Input } from '../../../shared/view/ui';
import { mcpToolsApi, type McpToolInfo, type McpToolsResult } from '../api/mcpToolsApi';
import type { McpCatalogEntry } from '../../mcp/types';

/** Mirrors server/agent-relay-mcp-tools.ts AGENT_RELAY_MCP_SERVER_NAME — client and server bundles are built separately. */
const AGENT_RELAY_MCP_SERVER_NAME = 'cloudcli-agent-relay';

/**
 * The catalog only carries this entry once Agent Relay has synced its MCP
 * projection. The tools probe answers this name from a static list either
 * way, so synthesize a placeholder row when the catalog hasn't caught up —
 * relay tools should never look "missing" just because sync hasn't run yet.
 */
const buildFallbackAgentRelayEntry = (): McpCatalogEntry => ({
  name: AGENT_RELAY_MCP_SERVER_NAME,
  transport: 'stdio',
  scope: 'user',
  command: 'cloudcli',
  args: ['agent-relay-mcp'],
  bindings: {},
  source: 'cloudcli',
  kind: 'agent-relay',
});

type ToolsByServer = Record<string, McpToolsResult | undefined>;

const isPinned = (entry: McpCatalogEntry): boolean => (
  entry.kind === 'agent-relay' || entry.name === AGENT_RELAY_MCP_SERVER_NAME
);

const serverSummary = (entry: McpCatalogEntry): string => (
  entry.command
    ? `${entry.command} ${(entry.args || []).join(' ')}`.trim()
    : entry.url || 'No connection details'
);

const toolMatches = (tool: McpToolInfo, query: string): boolean => (
  `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query)
);

const schemaPreview = (schema: Record<string, unknown> | undefined): string => {
  if (!schema) return '{}';
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return '{}';
  }
};

const buildMarkdown = (entries: McpCatalogEntry[], toolsByServer: ToolsByServer): string => {
  const lines: string[] = ['# MCP Tool Catalog', ''];
  for (const entry of entries) {
    lines.push(`## ${entry.name}${isPinned(entry) ? ' (pinned)' : ''}`, '');
    const result = toolsByServer[entry.name];
    if (!result || result.tools.length === 0) {
      lines.push(result?.error ? `_${result.error}_` : '_No tools reported._', '');
      continue;
    }
    for (const tool of result.tools) {
      lines.push(`- **${tool.name}** — ${tool.description || 'No description.'}`);
      if (tool.inputSchema && Object.keys(tool.inputSchema).length > 0) {
        lines.push('  ```json', `  ${schemaPreview(tool.inputSchema).split('\n').join('\n  ')}`, '  ```');
      }
    }
    lines.push('');
  }
  return lines.join('\n');
};

function ToolRow({ tool }: { tool: McpToolInfo }) {
  const [expanded, setExpanded] = useState(false);
  const hasSchema = Boolean(tool.inputSchema && Object.keys(tool.inputSchema).length > 0);
  return (
    <div className="rounded-lg border border-border/60 bg-background/50 p-2.5">
      <button
        type="button"
        onClick={() => hasSchema && setExpanded((v) => !v)}
        className={`flex w-full items-start gap-2 text-left ${hasSchema ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="text-xs font-semibold text-foreground">{tool.name}</code>
            {hasSchema && (
              <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`} />
            )}
          </div>
          {tool.description && (
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{tool.description}</p>
          )}
        </div>
      </button>
      {expanded && hasSchema && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted/50 p-2 text-[10px] leading-4 text-muted-foreground">
          {schemaPreview(tool.inputSchema)}
        </pre>
      )}
    </div>
  );
}

function ServerCard({
  entry,
  result,
  expanded,
  onToggleExpand,
  searchQuery,
}: {
  entry: McpCatalogEntry;
  result: McpToolsResult | undefined;
  expanded: boolean;
  onToggleExpand: () => void;
  searchQuery: string;
}) {
  const pinned = isPinned(entry);
  const query = searchQuery.trim().toLowerCase();
  const tools = result?.tools ?? [];
  const visibleTools = query ? tools.filter((tool) => toolMatches(tool, query)) : tools;

  return (
    <article className={`overflow-hidden rounded-xl border bg-card/40 transition-colors ${pinned ? 'border-primary/40 bg-primary/[0.03]' : 'border-border hover:border-border/80'}`}>
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-start gap-2.5 p-3 text-left sm:p-4"
      >
        <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-words font-medium text-foreground">{entry.name}</span>
            {pinned && (
              <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 text-[10px] text-primary">
                <Pin className="h-2.5 w-2.5" /> Agent Relay
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px] text-muted-foreground">{entry.transport}</Badge>
            {result?.cached && <Badge variant="outline" className="text-[10px] text-muted-foreground">cached</Badge>}
          </div>
          <code className="mt-1 block max-w-full truncate text-[11px] text-muted-foreground">
            {serverSummary(entry)}
          </code>
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            {result === undefined
              ? 'Loading tools…'
              : result.error
                ? <span className="text-amber-600 dark:text-amber-400">{result.error}</span>
                : `${tools.length} tool${tools.length === 1 ? '' : 's'}`}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/70 bg-muted/10 px-3 py-3 sm:px-4">
          {result === undefined ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Listing tools…
            </div>
          ) : visibleTools.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              {result.error ? result.error : query ? 'No tools match that search.' : 'No tools reported.'}
            </p>
          ) : (
            <div className="space-y-1.5">
              {visibleTools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function AgentRelayMcpToolsPanel() {
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [toolsByServer, setToolsByServer] = useState<ToolsByServer>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const loadTools = useCallback((servers: McpCatalogEntry[]) => {
    setToolsByServer((prev) => {
      const next = { ...prev };
      for (const entry of servers) delete next[entry.name];
      return next;
    });
    for (const entry of servers) {
      void mcpToolsApi.listTools(entry.name)
        .then((result) => setToolsByServer((prev) => ({ ...prev, [entry.name]: result })))
        .catch((caught) => setToolsByServer((prev) => ({
          ...prev,
          [entry.name]: { tools: [], error: caught instanceof Error ? caught.message : 'Failed to list tools.' },
        })));
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const servers = await mcpToolsApi.listCatalog();
      const withRelay = servers.some((entry) => entry.name === AGENT_RELAY_MCP_SERVER_NAME)
        ? servers
        : [...servers, buildFallbackAgentRelayEntry()];
      const sorted = [...withRelay].sort((a, b) => {
        if (isPinned(a) !== isPinned(b)) return isPinned(a) ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setCatalog(sorted);
      setExpanded((prev) => (prev.size > 0 ? prev : new Set(sorted.filter(isPinned).map((s) => s.name))));
      loadTools(sorted);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the MCP catalog.');
    } finally {
      setLoading(false);
    }
  }, [loadTools]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const query = searchQuery.trim().toLowerCase();
  const visibleCatalog = useMemo(() => {
    if (!query) return catalog;
    return catalog.filter((entry) => {
      if (entry.name.toLowerCase().includes(query)) return true;
      const result = toolsByServer[entry.name];
      return (result?.tools ?? []).some((tool) => toolMatches(tool, query));
    });
  }, [catalog, query, toolsByServer]);

  const totalTools = useMemo(
    () => Object.values(toolsByServer).reduce((sum, result) => sum + (result?.tools.length ?? 0), 0),
    [toolsByServer],
  );

  const copyMarkdown = async () => {
    const markdown = buildMarkdown(visibleCatalog, toolsByServer);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy to clipboard.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Server className="mt-0.5 h-5 w-5 flex-shrink-0 text-purple-500" />
          <div className="min-w-0 space-y-1">
            <h3 className="text-lg font-medium text-foreground">MCP Tools</h3>
            <p className="text-sm text-muted-foreground">
              Every catalog server and the tools it exposes, with descriptions and input schemas.
              {' '}<span className="font-medium text-foreground">{AGENT_RELAY_MCP_SERVER_NAME}</span> is pinned so relay tools are always at the top.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => void copyMarkdown()} disabled={visibleCatalog.length === 0}>
            {copied ? <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" /> : <Clipboard className="mr-1.5 h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy as markdown'}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        Codex workers do not honor per-task <code className="rounded bg-muted px-1">mcpServers</code> grants — only providers reporting <code className="rounded bg-muted px-1">honorsMcpGrants</code> in <code className="rounded bg-muted px-1">relay_capabilities</code> (Claude, Grok) apply them.
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search tools and servers…"
          className="bg-background pl-8"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && catalog.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading MCP catalog…
        </div>
      ) : visibleCatalog.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {catalog.length === 0 ? 'No MCP servers in the catalog yet. Add one under Settings → MCP.' : 'No tools or servers match that search.'}
        </div>
      ) : (
        <div className="space-y-2.5">
          {visibleCatalog.map((entry) => (
            <ServerCard
              key={entry.name}
              entry={entry}
              result={toolsByServer[entry.name]}
              expanded={expanded.has(entry.name)}
              searchQuery={searchQuery}
              onToggleExpand={() => setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(entry.name)) next.delete(entry.name);
                else next.add(entry.name);
                return next;
              })}
            />
          ))}
        </div>
      )}

      {!loading && catalog.length > 0 && (
        <p className="text-right text-[11px] text-muted-foreground">
          {catalog.length} server{catalog.length === 1 ? '' : 's'} · {totalTools} tool{totalTools === 1 ? '' : 's'} loaded
        </p>
      )}
    </div>
  );
}
