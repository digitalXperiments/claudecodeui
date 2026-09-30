import { Bell, BellRing, Hash, Info, Mail, Pencil, Plus, Radio, RefreshCw, Send, Trash2, type LucideIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { botRuntimeApi } from '../../api/botRuntimeApi';
import type { Bot } from '../../types';
import type { BotChannel, BotOutboundLogEntry } from '../../types/botRuntime';
import Toggle from '../../ui/Toggle';

import ChannelEditor from './ChannelEditor';
import { CHANNEL_KIND_META, channelMeta, groupChannels, outboundReasonLabel, policySummary, publicUrlStatus } from './channelsModel';
import { titleLookup } from './briefModel';
import { mapLimit } from './concurrency';
import { EmptyLine, ErrorBanner, LoadingLine, Pill, RuntimeCard, RuntimePage } from './RuntimePage';
import { errorText, useLoad } from './useLoad';

const KIND_ICONS: Record<string, LucideIcon> = { inapp: Bell, webpush: BellRing, slack: Hash, telegram: Send, email: Mail };
const FETCH_CONCURRENCY = 4;

type TestResult = { success: boolean; detail?: string };

function KindIcon({ kind, className = 'h-4 w-4' }: { kind: string; className?: string }) {
  const Icon = KIND_ICONS[kind] ?? Radio;
  return <Icon className={className} />;
}

function ChannelRow({ channel, bots, existing, editing, testing, result, onEdit, onCancelEdit, onSaved, onToggle, onTest, onDelete }: {
  channel: BotChannel;
  bots: Bot[];
  existing: BotChannel[];
  editing: boolean;
  testing: boolean;
  result?: TestResult;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (channel: BotChannel) => void;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const meta = channelMeta(channel.kind);
  return <li>
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><KindIcon kind={channel.kind} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">{meta.label}</p>
        <p className="truncate text-[10px] text-muted-foreground" title={policySummary(channel.policy)}>{policySummary(channel.policy)}</p>
      </div>
      <Toggle checked={channel.enabled} onChange={onToggle} label={`${meta.label} enabled`} />
      <div className="flex items-center gap-1">
        <button type="button" className="button" onClick={onTest} disabled={testing || !channel.enabled} title={channel.enabled ? 'Sends a real test message' : 'Enable the channel to send a test'}><Send className="h-3.5 w-3.5" />{testing ? 'Sending…' : 'Send test'}</button>
        <button type="button" className="icon-button" onClick={onEdit} aria-label={`Edit ${meta.label} channel`}><Pencil className="h-3.5 w-3.5" /></button>
        <button type="button" className="icon-button hover:text-destructive" onClick={onDelete} aria-label={`Delete ${meta.label} channel`}><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
    </div>
    {result ? <p role="status" className={`px-4 pb-3 text-[11px] ${result.success ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'}`}>{result.success ? 'Test delivered.' : `Test failed${result.detail ? `: ${result.detail}` : '.'}`}{result.success && result.detail ? ` ${result.detail}` : ''}</p> : null}
    {editing ? <ChannelEditor channel={channel} bots={bots} existing={existing} onSaved={onSaved} onCancel={onCancelEdit} /> : null}
  </li>;
}

function OutboundLog({ bots }: { bots: Bot[] }) {
  const [botId, setBotId] = useState('');
  const titleOf = useMemo(() => titleLookup(bots), [bots]);
  const fetchLog = useCallback(() => botRuntimeApi.channels.outboundLog({ botId: botId || undefined, limit: 50 }), [botId]);
  const { data, error, loading, reload } = useLoad<BotOutboundLogEntry[]>(fetchLog, `log:${botId}`);
  return <RuntimeCard title="Outbound log" subtitle="The last 50 messages the runtime tried to send" action={<div className="flex items-center gap-2">
    <select aria-label="Filter log by bot" className="field h-8 py-0 text-xs" value={botId} onChange={(event) => setBotId(event.target.value)}><option value="">All bots</option>{bots.map((bot) => <option key={bot.section_id} value={bot.section_id}>{bot.title}</option>)}</select>
    <button type="button" className="icon-button" onClick={() => void reload()} aria-label="Refresh outbound log"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
  </div>}>
    {error ? <div className="p-3"><ErrorBanner message={error} onRetry={() => void reload()} /></div> : null}
    {!data && loading ? <LoadingLine label="Loading the outbound log…" /> : null}
    {data && !data.length ? <EmptyLine>Nothing has been sent yet.</EmptyLine> : null}
    {data?.length ? <div className="overflow-x-auto"><table className="w-full text-left text-[11px]">
      <thead className="border-b border-border/70 text-[10px] uppercase tracking-widest text-muted-foreground"><tr><th className="px-4 py-2 font-semibold">When</th><th className="px-2 py-2 font-semibold">Bot</th><th className="px-2 py-2 font-semibold">Channel</th><th className="px-2 py-2 font-semibold">Urgency</th><th className="px-2 py-2 font-semibold">Result</th><th className="px-4 py-2 font-semibold">Detail</th></tr></thead>
      <tbody className="divide-y divide-border/50">{data.map((entry, index) => <tr key={`${entry.created_at}-${index}`}>
        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</td>
        <td className="px-2 py-2">{entry.bot_id ? titleOf(entry.bot_id) : 'Brief / system'}</td>
        <td className="px-2 py-2"><span className="inline-flex items-center gap-1"><KindIcon kind={entry.channel_kind} className="h-3 w-3" />{channelMeta(entry.channel_kind).label}</span></td>
        <td className="px-2 py-2 tabular-nums">{Math.round(entry.urgency * 100)}%</td>
        <td className="px-2 py-2"><Pill tone={entry.delivered ? 'success' : entry.reason && /^(quiet_hours|digest|min_urgency|max_pings_per_day)/.test(entry.reason) ? 'warning' : 'error'}>{entry.delivered ? 'Delivered' : 'Not delivered'}</Pill></td>
        <td className="max-w-72 truncate px-4 py-2 text-muted-foreground" title={outboundReasonLabel(entry.delivered, entry.reason)}>{outboundReasonLabel(entry.delivered, entry.reason)}</td>
      </tr>)}</tbody>
    </table></div> : null}
  </RuntimeCard>;
}

export default function ChannelsView({ bots, onNotice }: {
  bots: Bot[];
  onNotice?: (message: string, tone: 'default' | 'error' | 'success') => void;
}) {
  const titleOf = useMemo(() => titleLookup(bots), [bots]);
  const botKey = bots.map((bot) => bot.section_id).join(',');
  const fetchAll = useCallback(async (): Promise<BotChannel[]> => {
    const global = await botRuntimeApi.channels.list();
    const perBot = await mapLimit(bots, FETCH_CONCURRENCY, async (bot) => {
      try { return (await botRuntimeApi.channels.list(bot.section_id)).channels; } catch { return []; }
    });
    return [...global.channels, ...perBot.flat()];
  // `bots` identity changes on refresh; the id list is the real dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botKey]);
  const { data: channels, setData, error, loading, reload } = useLoad(fetchAll, `channels:${botKey}`);
  const fetchHost = useCallback(() => botRuntimeApi.exec.host().catch(() => null), []);
  const { data: host } = useLoad(fetchHost, 'host');
  const urlStatus = publicUrlStatus(host);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useMemo(() => channels ?? [], [channels]);
  const groups = useMemo(() => groupChannels(list, titleOf), [list, titleOf]);

  const upsertLocal = (saved: BotChannel) => setData((current) => {
    const rows = current ?? [];
    return rows.some((row) => row.channel_id === saved.channel_id) ? rows.map((row) => (row.channel_id === saved.channel_id ? saved : row)) : [...rows, saved];
  });

  const toggle = async (channel: BotChannel, enabled: boolean) => {
    setActionError(null);
    try { upsertLocal(await botRuntimeApi.channels.update(channel.channel_id, { enabled })); } catch (caught) { setActionError(errorText(caught)); }
  };
  const test = async (channel: BotChannel) => {
    setTestingId(channel.channel_id);
    setActionError(null);
    try {
      const result = await botRuntimeApi.channels.test(channel.channel_id);
      setResults((current) => ({ ...current, [channel.channel_id]: result }));
      onNotice?.(result.success ? `${channelMeta(channel.kind).label} test delivered.` : `${channelMeta(channel.kind).label} test failed${result.detail ? `: ${result.detail}` : '.'}`, result.success ? 'success' : 'error');
    } catch (caught) { setActionError(errorText(caught)); } finally { setTestingId(null); }
  };
  const remove = async (channel: BotChannel) => {
    if (!window.confirm(`Delete the ${channelMeta(channel.kind).label} channel${channel.bot_id ? ` for ${titleOf(channel.bot_id)}` : ''}?`)) return;
    setActionError(null);
    try {
      await botRuntimeApi.channels.remove(channel.channel_id);
      setData((current) => (current ?? []).filter((row) => row.channel_id !== channel.channel_id));
    } catch (caught) { setActionError(errorText(caught)); }
  };

  return <RuntimePage icon={Radio} eyebrow="Bot runtime" title="Channels" description="Where your bots reach you. Global channels apply to every bot; a bot can override a kind with its own channel." actions={<>
    <button type="button" className="button" onClick={() => void reload()} disabled={loading} aria-label="Refresh channels"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
    <button type="button" className="button button-primary" onClick={() => { setAdding(true); setEditingId(null); }}><Plus className="h-3.5 w-3.5" />Add channel</button>
  </>}>
    {error ? <ErrorBanner message={error} onRetry={() => void reload()} /> : null}
    {actionError ? <ErrorBanner message={actionError} /> : null}
    <div className="space-y-4">
      <RuntimeCard title="In-app" subtitle="Always on">
        <div className="flex items-start gap-3 px-4 py-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><Bell className="h-4 w-4" /></span><p className="text-[11px] text-muted-foreground">Every notification lands in the CloudCLI notifications inbox whatever the policies below say, so nothing is ever lost. Nothing to configure.</p></div>
      </RuntimeCard>

      {adding ? <RuntimeCard title="Add a channel" subtitle="Choose a scope and a kind"><ChannelEditor bots={bots} existing={list} onSaved={(saved) => { upsertLocal(saved); setAdding(false); }} onCancel={() => setAdding(false)} /></RuntimeCard> : null}

      {!channels && loading ? <LoadingLine label="Loading channels…" /> : null}
      {channels ? groups.map((group) => group.channels.length || group.botId === null ? <RuntimeCard key={group.botId ?? 'global'} title={group.title} subtitle={group.botId === null ? 'Used by every bot unless it has its own channel of the same kind' : 'Overrides the global channel of the same kind for this bot'}>
        {group.channels.length ? <ul className="divide-y divide-border/50">{group.channels.map((channel) => <ChannelRow key={channel.channel_id} channel={channel} bots={bots} existing={list} editing={editingId === channel.channel_id} testing={testingId === channel.channel_id} result={results[channel.channel_id]} onEdit={() => { setEditingId(channel.channel_id); setAdding(false); }} onCancelEdit={() => setEditingId(null)} onSaved={(saved) => { upsertLocal(saved); setEditingId(null); }} onToggle={(enabled) => void toggle(channel, enabled)} onTest={() => void test(channel)} onDelete={() => void remove(channel)} />)}</ul> : <EmptyLine>No global channels yet. Add Web push, Slack or Telegram to be reached outside CloudCLI.</EmptyLine>}
      </RuntimeCard> : null) : null}

      <RuntimeCard title="Channel kinds" subtitle="What each kind does">
        <ul className="divide-y divide-border/50">{CHANNEL_KIND_META.map((meta) => <li key={meta.kind} className={`flex items-start gap-3 px-4 py-2.5 ${meta.deferred ? 'opacity-60' : ''}`}><KindIcon kind={meta.kind} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><div className="min-w-0"><p className="text-xs font-medium">{meta.label}{meta.deferred ? <span className="ml-2 align-middle"><Pill>Not available</Pill></span> : null}</p><p className="text-[11px] text-muted-foreground">{meta.description}</p></div></li>)}</ul>
      </RuntimeCard>

      <RuntimeCard title="Public base URL for action links" subtitle="Approve and reject buttons in Slack and Telegram are signed links back to this server">
        <div className="flex items-start gap-3 px-4 py-3"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><div className="space-y-1.5 text-[11px] text-muted-foreground">
          <p className="flex flex-wrap items-center gap-2"><Pill tone={urlStatus.tone}>{urlStatus.label}</Pill><span>{urlStatus.detail}</span></p>
          <p>The server reports only whether an app-wide URL is set, not which one. Links use the first of these that is set:</p>
          <ol className="list-decimal space-y-0.5 pl-4"><li>The channel&apos;s own <code>action_base_url</code> (set it in a Slack or Telegram channel&apos;s editor).</li><li>The app setting <code>bots.public_base_url</code>.</li><li>The <code>CLOUDCLI_PUBLIC_URL</code> environment variable.</li><li>Otherwise <code>http://localhost:&lt;port&gt;</code>.</li></ol>
          <p>If links open &quot;localhost&quot; on your phone, set one of the first three to the address you reach CloudCLI at.</p>
        </div></div>
      </RuntimeCard>

      <OutboundLog bots={bots} />
    </div>
  </RuntimePage>;
}
