import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import type { Bot } from '../../types';
import { botStudioApi, type McpTool } from '../../api/botStudioApi';
import ToolPolicyGrid, { type ToolPolicy } from '../../ui/ToolPolicyGrid';
import { Button } from '../../../../shared/view/ui';

export default function ToolsTab({ bot, onSave }: { bot: Bot; onSave: (patch: { produce_tools: string[]; resolve_tools: string[]; tool_policy: Record<string, Record<string, ToolPolicy>> }) => Promise<void> }) {
  const servers = useMemo(() => [...new Set([...bot.produce_tools, ...bot.resolve_tools])], [bot.produce_tools, bot.resolve_tools]);
  const [tools, setTools] = useState<Record<string, McpTool[]>>({}); const [policy, setPolicy] = useState(bot.tool_policy ?? {}); const [busy, setBusy] = useState(false); const [inventory, setInventory] = useState<string[]>([]);
  useEffect(() => { setPolicy(bot.tool_policy ?? {}); }, [bot.tool_policy]);
  useEffect(() => { let cancelled = false; void Promise.all(servers.map(async (server) => [server, await botStudioApi.listMcpTools(server)] as const)).then((entries) => { if (!cancelled) setTools(Object.fromEntries(entries)); }).catch(() => undefined); return () => { cancelled = true; }; }, [servers]);
  useEffect(() => { void botStudioApi.listMcpInventory().then((entries) => setInventory(entries.map((entry) => entry.name))).catch(() => undefined); }, []);
  const addServer = (server: string) => { if (servers.includes(server)) return; void onSave({ produce_tools: [...bot.produce_tools, server], resolve_tools: bot.resolve_tools, tool_policy: { ...policy, [server]: {} } }); };
  const save = async () => { setBusy(true); try { await onSave({ produce_tools: bot.produce_tools, resolve_tools: bot.resolve_tools, tool_policy: policy }); } finally { setBusy(false); } };
  return <div className="max-w-3xl space-y-4 p-4 sm:p-6"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">MCP tools</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Every capability is a server with an allow / ask / deny policy per tool.</p></div>{servers.map((server) => tools[server] ? <ToolPolicyGrid key={server} server={server} tools={tools[server]} policy={policy[server] ?? {}} onChange={(tool, value) => setPolicy((current) => ({ ...current, [server]: { ...(current[server] ?? {}), [tool]: value } }))} /> : <div key={server} className="flex items-center gap-2 rounded-xl border border-border/70 p-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading {server} tools…</div>)}<div className="flex flex-wrap gap-2">{inventory.filter((server) => !servers.includes(server)).slice(0, 8).map((server) => <Button key={server} size="sm" variant="outline" onClick={() => addServer(server)}><Plus className="h-3 w-3" />{server}</Button>)}</div><Button onClick={() => void save()} disabled={busy}>Save tool policy</Button></div>;
}
