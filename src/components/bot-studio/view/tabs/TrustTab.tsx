import { useMemo } from 'react';

import { useMcpCatalog } from '../../../mcp/hooks/useMcpCatalog';
import type { Bot } from '../../types';

export default function TrustTab({ bot, onOpenTools }: { bot: Bot; onOpenTools: () => void }) {
  const inventory = useMcpCatalog();
  const servers = useMemo(() => [...new Set([...bot.produce_tools, ...bot.resolve_tools, ...bot.kanban_mcp_tools])], [bot.produce_tools, bot.resolve_tools, bot.kanban_mcp_tools]);
  const warnings = [
    bot.permission_mode === 'bypassPermissions' ? 'Provider permission mode bypasses ordinary permission prompts.' : null,
    bot.auto_approve && bot.autonomy === 'act' ? 'Eligible actions may be auto-approved.' : null,
    servers.some((server) => Object.keys(bot.tool_policy?.[server] ?? {}).length === 0) ? 'Some attached servers have no explicit per-tool decisions.' : null,
    bot.provider !== 'claude' && Object.values(bot.tool_policy ?? {}).some((policy) => Object.values(policy).some((decision) => decision !== 'allow')) ? 'This provider may treat per-tool policy as advisory; verify its runtime enforcement before unattended use.' : null,
    bot.scope === 'global' ? 'This bot runs in global scope rather than a selected project.' : null,
  ].filter((entry): entry is string => Boolean(entry));
  return <div className="max-w-4xl space-y-5 p-4 sm:p-6">
    <div><h3 className="text-sm font-semibold">Trust & access</h3><p className="mt-1 text-xs text-muted-foreground">A review of configured capabilities and guardrails, not a security certification. Runtime enforcement depends on the provider.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">{[
      ['Autonomy', bot.autonomy], ['Permission mode', bot.permission_mode], ['Scope', bot.scope === 'project' ? `Project · ${bot.project_id || 'not selected'}` : 'Global'],
      ['Schedule', bot.schedule_cron || 'Manual'], ['Auto-approve', bot.auto_approve ? 'On' : 'Off'], ['Enabled', bot.enabled ? 'Yes' : 'Paused'],
    ].map(([label, value]) => <div key={label} className="rounded-xl border border-border bg-card p-3"><p className="text-[11px] text-muted-foreground">{label}</p><p className="mt-1 break-words text-xs font-semibold">{value}</p></div>)}</div>
    <section className="rounded-xl border border-border bg-card p-4"><h4 className="text-xs font-semibold">Attached MCP servers · {servers.length}</h4>{servers.length ? <div className="mt-3 space-y-3">{servers.map((server) => { const entry = inventory.items.find((item) => item.name === server); const policy = bot.tool_policy?.[server] ?? {}; return <div key={server} className="rounded-lg border border-border/70 p-3"><div className="flex flex-wrap justify-between gap-2"><p className="text-xs font-medium">{entry?.cloudLabel || server}</p><span className="text-[11px] text-muted-foreground">{entry?.needsAuth ? 'Needs auth' : entry?.connected ? 'Connected' : 'Connection unverified'}</span></div><p className="mt-1 text-[11px] text-muted-foreground">{bot.produce_tools.includes(server) ? 'Produce · ' : ''}{bot.resolve_tools.includes(server) ? 'Resolve · ' : ''}{bot.kanban_mcp_tools.includes(server) ? 'Kanban' : ''}</p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(policy).length ? Object.entries(policy).map(([tool, decision]) => <span key={tool} className={`rounded px-2 py-1 text-[10px] ${decision === 'deny' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : decision === 'ask' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>{tool} · {decision}</span>) : <span className="text-[11px] text-amber-700 dark:text-amber-300">No explicit tool decisions</span>}</div></div>; })}</div> : <p className="mt-2 text-xs text-muted-foreground">No MCP servers attached.</p>}</section>
    <section className="rounded-xl border border-border bg-card p-4"><h4 className="text-xs font-semibold">Review gates & outputs</h4><p className="mt-2 text-xs text-muted-foreground">{bot.mode === 'review' ? 'Produce ticks create inbox items for review.' : 'Fire-and-forget ticks run without an inbox review gate.'} {bot.dry_run ? 'Dry-run mode is enabled.' : 'Dry-run mode is off.'}</p><div className="mt-3 flex flex-wrap gap-1">{bot.actions.map((action) => <span key={action.id} className="rounded bg-muted px-2 py-1 text-[11px]">{action.label} · {action.kind}</span>)}</div>{bot.create_kanban_task ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Approved items may create Kanban tasks.</p> : null}</section>
    {warnings.length ? <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"><h4 className="text-xs font-semibold">Review before unattended runs</h4><ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section> : <p className="text-xs text-muted-foreground">No configuration warnings detected. Continue to review provider and tool behavior before enabling unattended runs.</p>}
    <button type="button" onClick={onOpenTools} className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-accent">Review tool policy</button>
  </div>;
}
