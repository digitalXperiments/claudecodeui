import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, ShieldCheck, SlidersHorizontal } from 'lucide-react';

import type { CreateMcSectionInput } from '../../../mission-control/api/missionControlApi';
import type { Bot, BotToolPhase, ToolPolicyDecision } from '../../types';
import { botStudioApi, type McpTool } from '../../api/botStudioApi';
import { useMcpCatalog } from '../../../mcp/hooks/useMcpCatalog';
import ToolPolicyGrid from '../../ui/ToolPolicyGrid';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';

const PHASES: Array<{ key: BotToolPhase; label: string; field: keyof Pick<CreateMcSectionInput, 'produce_tools' | 'resolve_tools' | 'kanban_mcp_tools'> }> = [
  { key: 'produce', label: 'Produce', field: 'produce_tools' },
  { key: 'resolve', label: 'Resolve', field: 'resolve_tools' },
  { key: 'kanban', label: 'Kanban', field: 'kanban_mcp_tools' },
];
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

export default function ToolsTab({ bot, onSave }: { bot: Bot; onSave: (patch: Partial<CreateMcSectionInput>) => Promise<void> }) {
  const attached = useMemo(() => [...new Set([...bot.produce_tools, ...bot.resolve_tools, ...bot.kanban_mcp_tools])], [bot.kanban_mcp_tools, bot.produce_tools, bot.resolve_tools]);
  const [tools, setTools] = useState<Record<string, McpTool[]>>({});
  const [policy, setPolicy] = useState(bot.tool_policy ?? {});
  const [phaseServers, setPhaseServers] = useState<Record<BotToolPhase, string[]>>({ produce: bot.produce_tools, resolve: bot.resolve_tools, kanban: bot.kanban_mcp_tools });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [toolErrors, setToolErrors] = useState<Record<string, string>>({});
  const [toolRefreshNonce, setToolRefreshNonce] = useState(0);
  const inventory = useMcpCatalog();
  useEffect(() => { setPolicy(bot.tool_policy ?? {}); setPhaseServers({ produce: bot.produce_tools, resolve: bot.resolve_tools, kanban: bot.kanban_mcp_tools }); }, [bot.kanban_mcp_tools, bot.produce_tools, bot.resolve_tools, bot.tool_policy]);
  useEffect(() => { let cancelled = false; void Promise.all(attached.map(async (server) => { try { const result = await botStudioApi.listMcpTools(server); if (!cancelled) setToolErrors((current) => { const next = { ...current }; if (result.error) next[server] = result.error; else delete next[server]; return next; }); return [server, result] as const; } catch (error) { if (!cancelled) setToolErrors((current) => ({ ...current, [server]: error instanceof Error ? error.message : 'Unable to load tools.' })); return [server, [] as McpTool[]] as const; } })).then((entries) => { if (!cancelled) setTools(Object.fromEntries(entries)); }); return () => { cancelled = true; }; }, [attached, toolRefreshNonce]);
  const setPhase = (phase: BotToolPhase, server: string, enabled: boolean) => setPhaseServers((current) => ({ ...current, [phase]: enabled ? [...new Set([...current[phase], server])] : current[phase].filter((entry) => entry !== server) }));
  const addServer = (server: string) => { setPhaseServers((current) => ({ ...current, produce: [...new Set([...current.produce, server])] })); setDialogOpen(false); setNote(`${server} added to Produce. Set its phase and policy, then save.`); };
  const save = async () => { setBusy(true); setNote(null); try { await onSave({ produce_tools: phaseServers.produce, resolve_tools: phaseServers.resolve, kanban_mcp_tools: phaseServers.kanban, tool_policy: policy }); setNote('Tool policy saved.'); } catch (error) { setNote(error instanceof Error ? error.message : 'Unable to save tool policy.'); } finally { setBusy(false); } };
  const applyPreset = (server: string, readOnly: boolean) => { const serverTools = toolsWithPolicyEntries(tools[server] ?? [], policy[server] ?? {}); setPolicy((current) => ({ ...current, [server]: presetPolicy(serverTools, readOnly) })); };
  const holdAllWrites = async () => {
    const nextPolicy = Object.fromEntries(Object.entries(tools).map(([server, serverTools]) => [server, { ...(policy[server] ?? {}), ...Object.fromEntries(serverTools.filter((tool) => WRITE_LIKE.test(tool.name)).map((tool) => [tool.name, 'ask' as const])) }]));
    setPolicy(nextPolicy);
    setBusy(true);
    setNote(null);
    try {
      await onSave({ produce_tools: phaseServers.produce, resolve_tools: phaseServers.resolve, kanban_mcp_tools: phaseServers.kanban, tool_policy: nextPolicy });
      setNote('Write-like tools are now held for approval.');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Unable to hold write-like tools.');
    } finally {
      setBusy(false);
    }
  };
  const changePolicy = (server: string, tool: string, value: 'allow' | 'ask' | 'deny' | 'default') => setPolicy((current) => { const serverPolicy = { ...(current[server] ?? {}) }; if (value === 'default') delete serverPolicy[tool]; else serverPolicy[tool] = value; return { ...current, [server]: serverPolicy }; });
  return <div className="max-w-4xl space-y-5 p-4 sm:p-6">
    <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">MCP tools</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Capabilities are MCP servers. Choose where each server is used, then decide what each tool may do.</p></div><Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}><Plus className="h-3.5 w-3.5" />Add MCP server</Button></div>
    {inventory.loadError ? <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert"><span>{inventory.loadError}</span><Button size="sm" variant="ghost" onClick={() => void inventory.refresh({ full: true })}>Retry inventory</Button></div> : null}
    {attached.length === 0 ? <div className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-muted-foreground">No MCP servers attached. Add one from the catalog to give this bot capabilities.</div> : attached.map((server) => { const entry = inventory.items.find((item) => item.name === server); const status = connectionStatus(entry); const serverTools = toolsWithPolicyEntries(tools[server] ?? [], policy[server] ?? {}); return <section key={server} className="rounded-xl border border-border/70 bg-card p-4"><div className="flex flex-wrap items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">{entry?.cloudLabel || server}</h3><span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${status.className}`}>{status.label}</span><div className="ml-auto flex gap-1"><Button size="sm" variant="ghost" onClick={() => applyPreset(server, false)} title="Allow all tools"><SlidersHorizontal className="h-3 w-3" />Allow all</Button><Button size="sm" variant="ghost" onClick={() => applyPreset(server, true)} title="Allow read-only tools and ask for writes">Read-only</Button></div></div><div className="mt-3 flex flex-wrap gap-2">{PHASES.map(({ key, label }) => <label key={key} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-[10px] text-muted-foreground"><input type="checkbox" checked={phaseServers[key].includes(server)} onChange={(event) => setPhase(key, server, event.target.checked)} className="accent-primary" />{label}</label>)}</div>{entry?.needsAuth || !entry?.connected ? <p className="mt-2 text-[10px] text-muted-foreground">Connect this server in the MCP catalog before enabling live ticks.</p> : null}{toolErrors[server] ? <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200" role="alert"><span>Not in the MCP catalog — connect it in Settings → MCP</span><button type="button" className="rounded underline" onClick={() => { setToolErrors((current) => { const next = { ...current }; delete next[server]; return next; }); setTools((current) => { const next = { ...current }; delete next[server]; return next; }); setToolRefreshNonce((value) => value + 1); }}>Retry</button></div> : null}{tools[server] ? <div className="mt-3"><ToolPolicyGrid server={server} tools={serverTools} policy={policy[server] ?? {}} onChange={(tool, value) => changePolicy(server, tool, value)} /></div> : <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading tools…</p>}</section>; })}
    <div className="flex flex-wrap items-center gap-3"><Button size="sm" variant="outline" onClick={() => void holdAllWrites()} disabled={busy || !Object.values(tools).some((serverTools) => serverTools.some((tool) => WRITE_LIKE.test(tool.name)))}><ShieldCheck className="h-3.5 w-3.5" />Hold all writes</Button><Button onClick={() => void save()} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Save tool policy</Button>{note ? <span className="text-xs text-muted-foreground" role="status">{note}</span> : null}</div>
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent className="max-h-[80vh] overflow-y-auto p-5"><DialogTitle>Add MCP server</DialogTitle><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold">Add MCP server</p><p className="mt-1 text-xs text-muted-foreground">Bots reference catalog servers; credentials stay in the catalog.</p></div><Button size="sm" variant="ghost" onClick={() => setDialogOpen(false)} aria-label="Close add MCP dialog">Close</Button></div><div className="mt-4 space-y-2">{inventory.items.filter((item) => !attached.includes(item.name)).map((item) => <button key={item.name} type="button" onClick={() => addServer(item.name)} className="flex w-full items-center gap-3 rounded-xl border border-border/70 bg-card p-3 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="min-w-0 flex-1"><span className="block text-xs font-semibold">{item.cloudLabel || item.name}</span><span className="mt-1 block text-[10px] text-muted-foreground">{item.needsAuth || item.connected === false ? 'Needs auth · connect in MCP catalog' : 'Connected and ready'}</span></span><Plus className="h-4 w-4 text-primary" /></button>)}{inventory.items.filter((item) => !attached.includes(item.name)).length === 0 ? <p className="rounded-lg border border-dashed border-border p-5 text-center text-xs text-muted-foreground">All inventory servers are attached.</p> : null}</div></DialogContent></Dialog>
  </div>;
}
