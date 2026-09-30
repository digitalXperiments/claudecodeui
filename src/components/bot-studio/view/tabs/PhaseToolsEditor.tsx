import { useEffect, useState } from 'react';
import { Loader2, Plus, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';

import type { ToolPolicy, ToolPolicyDecision } from '../../types';
import { botStudioApi, type McpTool } from '../../api/botStudioApi';
import { useMcpCatalog } from '../../../mcp/hooks/useMcpCatalog';
import ToolPolicyGrid from '../../ui/ToolPolicyGrid';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';

const WRITE_LIKE = /create|send|update|delete|put|post|transition|merge|trash|click|fill/i;

function presetPolicy(tools: McpTool[], readOnly: boolean): Record<string, ToolPolicyDecision> {
  return Object.fromEntries(tools.map((tool) => [tool.name, readOnly && WRITE_LIKE.test(tool.name) ? 'ask' : 'allow']));
}

function toolsWithPolicyEntries(tools: McpTool[], policy: Record<string, ToolPolicyDecision>): McpTool[] {
  const catalogNames = new Set(tools.map((tool) => tool.name));
  return [...tools, ...Object.keys(policy).filter((name) => !catalogNames.has(name)).map((name) => ({ name, description: 'Saved policy entry', fromPolicy: true }))];
}

function connectionStatus(entry?: { connected?: boolean | null; needsAuth?: boolean }): { label: string; className: string } {
  if (!entry) return { label: 'Not connected', className: 'bg-muted text-muted-foreground' };
  if (entry.needsAuth) return { label: 'Needs auth', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' };
  if (entry.connected) return { label: 'Connected', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
  return { label: 'Not connected', className: 'bg-muted text-muted-foreground' };
}

/**
 * MCP servers for one pipeline phase plus their per-tool allow/ask/deny policy.
 * Controlled: the stage card owns `servers` and `policy` and saves them.
 */
export default function PhaseToolsEditor({ phaseLabel, servers, policy, onServersChange, onPolicyChange }: {
  phaseLabel: string;
  servers: string[];
  policy: ToolPolicy;
  onServersChange: (servers: string[]) => void;
  onPolicyChange: (policy: ToolPolicy) => void;
}) {
  const inventory = useMcpCatalog();
  const [tools, setTools] = useState<Record<string, McpTool[]>>({});
  const [toolErrors, setToolErrors] = useState<Record<string, string>>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const serverKey = servers.join('\n');
  useEffect(() => {
    let cancelled = false;
    const missing = serverKey ? serverKey.split('\n').filter((server) => !tools[server]) : [];
    void Promise.all(missing.map(async (server) => {
      try {
        const result = await botStudioApi.listMcpTools(server);
        if (!cancelled) setToolErrors((current) => { const next = { ...current }; if (result.error) next[server] = result.error; else delete next[server]; return next; });
        return [server, result] as const;
      } catch (error) {
        if (!cancelled) setToolErrors((current) => ({ ...current, [server]: error instanceof Error ? error.message : 'Unable to load tools.' }));
        return [server, [] as McpTool[]] as const;
      }
    })).then((entries) => { if (!cancelled && entries.length) setTools((current) => ({ ...current, ...Object.fromEntries(entries) })); });
    return () => { cancelled = true; };
  }, [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps -- load each server's tools once
  const changePolicy = (server: string, tool: string, value: 'allow' | 'ask' | 'deny' | 'default') => { const serverPolicy = { ...(policy[server] ?? {}) }; if (value === 'default') delete serverPolicy[tool]; else serverPolicy[tool] = value; onPolicyChange({ ...policy, [server]: serverPolicy }); };
  const applyPreset = (server: string, readOnly: boolean) => onPolicyChange({ ...policy, [server]: presetPolicy(toolsWithPolicyEntries(tools[server] ?? [], policy[server] ?? {}), readOnly) });
  const available = inventory.items.filter((item) => !servers.includes(item.name));
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 flex-1 text-xs font-semibold">MCP tools <span className="font-normal text-muted-foreground">· {servers.length ? `${servers.length} attached` : 'none'}</span></p><Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}><Plus className="h-3.5 w-3.5" />Add server</Button></div>
    {inventory.loadError ? <p className="text-xs text-destructive" role="alert">{inventory.loadError}</p> : null}
    {servers.map((server) => { const entry = inventory.items.find((item) => item.name === server); const status = connectionStatus(entry); const serverTools = toolsWithPolicyEntries(tools[server] ?? [], policy[server] ?? {}); return <div key={server} className="rounded-lg border border-border/70 bg-background/50 p-3"><div className="flex flex-wrap items-center gap-2"><ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" /><span className="min-w-0 truncate text-xs font-semibold">{entry?.cloudLabel || server}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${status.className}`}>{status.label}</span><div className="ml-auto flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={() => applyPreset(server, false)} title="Allow all tools"><SlidersHorizontal className="h-3 w-3" />Allow all</Button><Button size="sm" variant="ghost" onClick={() => applyPreset(server, true)} title="Allow read-only tools and ask for writes">Read-only</Button><Button size="sm" variant="ghost" onClick={() => onServersChange(servers.filter((name) => name !== server))} aria-label={`Remove ${server} from ${phaseLabel}`}><X className="h-3 w-3" /></Button></div></div>{toolErrors[server] ? <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300" role="alert">Not in the MCP catalog — connect it in Settings → MCP.</p> : tools[server] ? <div className="mt-2"><ToolPolicyGrid server={server} tools={serverTools} policy={policy[server] ?? {}} onChange={(tool, value) => changePolicy(server, tool, value)} /></div> : <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading tools…</p>}</div>; })}
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent className="max-h-[80vh] overflow-y-auto p-5"><DialogTitle>Add MCP server to {phaseLabel}</DialogTitle><p className="mt-1 text-xs text-muted-foreground">Bots reference catalog servers; credentials stay in the catalog.</p><div className="mt-4 space-y-2">{available.map((item) => <button key={item.name} type="button" onClick={() => { onServersChange([...servers, item.name]); setDialogOpen(false); }} className="flex w-full items-center gap-3 rounded-xl border border-border/70 bg-card p-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="min-w-0 flex-1"><span className="block text-xs font-semibold">{item.cloudLabel || item.name}</span><span className="mt-1 block text-[10px] text-muted-foreground">{item.needsAuth || item.connected === false ? 'Needs auth · connect in MCP catalog' : 'Connected and ready'}</span></span><Plus className="h-4 w-4 text-primary" /></button>)}{available.length === 0 ? <p className="rounded-lg border border-dashed border-border p-5 text-center text-xs text-muted-foreground">All inventory servers are attached.</p> : null}</div></DialogContent></Dialog>
  </div>;
}
