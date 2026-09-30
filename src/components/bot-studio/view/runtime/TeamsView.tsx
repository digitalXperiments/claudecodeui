import { Crown, MessageSquareShare, Plus, Trash2, UserMinus, UserPlus, Users } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { botRuntimeApi } from '../../api/botRuntimeApi';
import type { Bot } from '../../types';
import type { BotPeers, BotTeam } from '../../types/botRuntime';
import SegmentedControl from '../../ui/SegmentedControl';
import { botTabPath } from '../botStudioRoute';

import { titleLookup } from './briefModel';
import { EmptyLine, ErrorBanner, Field, LoadingLine, Pill, RuntimeCard, RuntimePage } from './RuntimePage';
import SpacesPanel from './SpacesPanel';
import {
  MAX_ROLE,
  MAX_TEAM_MEMBERS,
  MAX_WAKE_NOTE,
  addableBots,
  canAddMember,
  memberRows,
  peerRows,
  validateTeamDraft,
  wakeBlockedReason,
} from './teamsModel';
import { errorText, useLoad } from './useLoad';

type Notice = (message: string, tone: 'default' | 'error' | 'success') => void;

function MemberRow({ team, botId, title, role, isCoordinator, onTeam, onNavigate, setError }: {
  team: BotTeam;
  botId: string;
  title: string;
  role: string;
  isCoordinator: boolean;
  onTeam: (team: BotTeam) => void;
  onNavigate: (path: string) => void;
  setError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState(role);
  const dirty = draft.trim() !== role && draft.trim() !== '';
  const run = async (action: () => Promise<BotTeam>) => {
    setError(null);
    try { onTeam(await action()); } catch (caught) { setError(errorText(caught)); }
  };
  return <li className="flex flex-wrap items-center gap-2 px-4 py-2.5">
    <button type="button" onClick={() => onNavigate(botTabPath(botId))} className="min-w-0 max-w-48 truncate text-left text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{title}</button>
    {isCoordinator ? <Pill tone="info"><Crown className="mr-1 h-2.5 w-2.5" />Coordinator</Pill> : null}
    <input aria-label={`Role for ${title}`} className="field h-8 min-w-32 flex-1 py-0 text-xs" value={draft} maxLength={MAX_ROLE} placeholder="Role (what this bot does on the team)" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && dirty) void run(() => botRuntimeApi.collab.addMember(team.team_id, botId, draft.trim())); }} />
    {dirty ? <button type="button" className="button h-8 min-h-8" onClick={() => void run(() => botRuntimeApi.collab.addMember(team.team_id, botId, draft.trim()))}>Save role</button> : null}
    <button type="button" className="icon-button hover:text-destructive" aria-label={`Remove ${title} from ${team.name}`} onClick={() => void run(() => botRuntimeApi.collab.removeMember(team.team_id, botId))}><UserMinus className="h-3.5 w-3.5" /></button>
  </li>;
}

function TeamCard({ team, bots, titleOf, otherNames, onTeam, onDeleted, onNavigate, onNotice }: {
  team: BotTeam;
  bots: Bot[];
  titleOf: (botId: string | null | undefined) => string;
  otherNames: string[];
  onTeam: (team: BotTeam) => void;
  onDeleted: (teamId: string) => void;
  onNavigate: (path: string) => void;
  onNotice?: Notice;
}) {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [goal, setGoal] = useState(team.goal);
  const [addBotId, setAddBotId] = useState('');
  const [addRole, setAddRole] = useState('');
  const [note, setNote] = useState('');
  const [waking, setWaking] = useState(false);
  const rows = useMemo(() => memberRows(team, (id) => titleOf(id)), [team, titleOf]);
  const options = useMemo(() => addableBots(bots, team), [bots, team]);
  const wakeBlocked = wakeBlockedReason(team);
  const full = !canAddMember(team);

  const guarded = async <T,>(action: () => Promise<T>, then: (value: T) => void) => {
    setError(null);
    try { then(await action()); } catch (caught) { setError(errorText(caught)); }
  };

  const saveDetails = () => {
    const problem = validateTeamDraft({ name, goal }, otherNames);
    if (problem) { setError(problem); return; }
    void guarded(() => botRuntimeApi.collab.updateTeam(team.team_id, { name: name.trim(), goal: goal.trim() }), (updated) => { onTeam(updated); setEditing(false); });
  };
  const wake = async () => {
    setWaking(true);
    setError(null);
    try {
      await botRuntimeApi.collab.wakeTeam(team.team_id, note.trim() || undefined);
      setNote('');
      onNotice?.(`Woke ${titleOf(team.coordinator_bot_id)} for ${team.name}. Its reply arrives in its Thread.`, 'success');
    } catch (caught) { setError(errorText(caught)); } finally { setWaking(false); }
  };

  return <RuntimeCard title={team.name} subtitle={team.goal || 'No goal set'} action={<div className="flex items-center gap-1">
    <button type="button" className="button" onClick={() => { setEditing((open) => !open); setName(team.name); setGoal(team.goal); setError(null); }}>{editing ? 'Close' : 'Edit'}</button>
    <button type="button" className="icon-button hover:text-destructive" aria-label={`Delete team ${team.name}`} onClick={() => { if (window.confirm(`Delete the team "${team.name}"? The bots are not deleted.`)) void guarded(() => botRuntimeApi.collab.deleteTeam(team.team_id), () => onDeleted(team.team_id)); }}><Trash2 className="h-3.5 w-3.5" /></button>
  </div>}>
    {error ? <div className="p-3 pb-0"><ErrorBanner message={error} /></div> : null}
    {editing ? <div className="space-y-3 border-b border-border/70 bg-muted/20 p-4">
      <Field label="Name"><input className="field" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="Goal"><textarea className="field min-h-16" value={goal} maxLength={1000} onChange={(event) => setGoal(event.target.value)} /></Field>
      <div className="flex justify-end"><button type="button" className="button button-primary" onClick={saveDetails}>Save team</button></div>
    </div> : null}

    {rows.length ? <ul className="divide-y divide-border/50">{rows.map((row) => <MemberRow key={`${row.botId}:${row.role}`} team={team} botId={row.botId} title={row.title} role={row.role} isCoordinator={row.isCoordinator} onTeam={onTeam} onNavigate={onNavigate} setError={setError} />)}</ul> : <EmptyLine>No members yet. Add up to {MAX_TEAM_MEMBERS} bots.</EmptyLine>}

    <div className="grid gap-3 border-t border-border/70 p-4 md:grid-cols-2">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold">Add a member <span className="font-normal text-muted-foreground">({team.members.length}/{MAX_TEAM_MEMBERS})</span></p>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Bot to add" className="field h-9 min-w-32 flex-1 py-0 text-xs" value={addBotId} onChange={(event) => setAddBotId(event.target.value)} disabled={full || !options.length}>
            <option value="">{full ? 'Team is full' : options.length ? 'Choose a bot…' : 'Every bot is already a member'}</option>
            {options.map((bot) => <option key={bot.section_id} value={bot.section_id}>{bot.title}</option>)}
          </select>
          <input aria-label="Role for the new member" className="field h-9 min-w-32 flex-1 py-0 text-xs" value={addRole} maxLength={MAX_ROLE} placeholder="Role (optional)" onChange={(event) => setAddRole(event.target.value)} disabled={full} />
          <button type="button" className="button" disabled={!addBotId || full} onClick={() => void guarded(() => botRuntimeApi.collab.addMember(team.team_id, addBotId, addRole.trim() || undefined), (updated) => { onTeam(updated); setAddBotId(''); setAddRole(''); })}><UserPlus className="h-3.5 w-3.5" />Add</button>
        </div>
        <Field label="Coordinator" hint="The coordinator is the bot a team wake goes to. Removing it clears the slot.">
          <select className="field h-9 py-0 text-xs" value={team.coordinator_bot_id ?? ''} disabled={!team.members.length} onChange={(event) => { if (event.target.value) void guarded(() => botRuntimeApi.collab.setCoordinator(team.team_id, event.target.value), onTeam); }}>
            <option value="" disabled>{team.members.length ? 'Choose a coordinator…' : 'Add a member first'}</option>
            {rows.map((row) => <option key={row.botId} value={row.botId}>{row.title}</option>)}
          </select>
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-[11px] font-semibold">Wake team</p>
        <textarea aria-label="Note for the coordinator" className="field min-h-16 text-xs" value={note} maxLength={MAX_WAKE_NOTE} placeholder="Optional note for the coordinator" onChange={(event) => setNote(event.target.value)} />
        <div className="flex items-center justify-between gap-2"><p className="text-[10px] text-muted-foreground">{wakeBlocked ?? `Sends the goal and your note to ${titleOf(team.coordinator_bot_id)}.`}</p><button type="button" className="button button-primary" disabled={Boolean(wakeBlocked) || waking} onClick={() => void wake()}><MessageSquareShare className="h-3.5 w-3.5" />{waking ? 'Waking…' : 'Wake team'}</button></div>
      </div>
    </div>
  </RuntimeCard>;
}

function NewTeamForm({ names, onCreated, onCancel }: { names: string[]; onCreated: (team: BotTeam) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const create = async () => {
    const problem = validateTeamDraft({ name, goal }, names);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try { onCreated(await botRuntimeApi.collab.createTeam({ name: name.trim(), goal: goal.trim() })); } catch (caught) { setError(errorText(caught)); } finally { setSaving(false); }
  };
  return <RuntimeCard title="New team" subtitle="Give it a name and a shared goal, then add members">
    <div className="space-y-3 p-4">
      {error ? <ErrorBanner message={error} /> : null}
      <Field label="Name"><input className="field" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Growth squad" /></Field>
      <Field label="Goal"><textarea className="field min-h-16" value={goal} maxLength={1000} onChange={(event) => setGoal(event.target.value)} placeholder="What should this team accomplish together?" /></Field>
      <div className="flex justify-end gap-2"><button type="button" className="button" onClick={onCancel} disabled={saving}>Cancel</button><button type="button" className="button button-primary" onClick={() => void create()} disabled={saving}>{saving ? 'Creating…' : 'Create team'}</button></div>
    </div>
  </RuntimeCard>;
}

function PeerTraffic({ botId, bots }: { botId: string; bots: Bot[] }) {
  const titleOf = useMemo(() => titleLookup(bots), [bots]);
  const fetchPeers = useCallback((): Promise<BotPeers> => botRuntimeApi.collab.peers(botId, 50), [botId]);
  const { data, error, loading, reload } = useLoad(fetchPeers, botId);
  const rows = useMemo(() => peerRows(data?.traffic ?? [], (id) => titleOf(id)), [data, titleOf]);
  return <RuntimeCard title="Peer traffic" subtitle="Messages this bot exchanged with other bots (last 50)">
    {error ? <div className="p-3"><ErrorBanner message={error} onRetry={() => void reload()} /></div> : null}
    {!data && loading ? <LoadingLine label="Loading peer traffic…" /> : null}
    {data?.teams.length ? <p className="border-b border-border/70 px-4 py-2 text-[11px] text-muted-foreground">Teams: {data.teams.map((team) => team.name).join(', ')}</p> : null}
    {data && !rows.length ? <EmptyLine>No peer messages yet.</EmptyLine> : null}
    {rows.length ? <ul className="divide-y divide-border/50">{rows.map((row) => <li key={row.event_id} className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2"><Pill tone={row.direction === 'out' ? 'info' : 'default'}>{row.directionLabel}</Pill><span className="text-xs font-medium">{row.otherTitle}</span><Pill>{row.type || row.kind}</Pill><Pill tone={row.status === 'consumed' ? 'success' : 'warning'}>{row.status}</Pill><span className="ml-auto text-[10px] text-muted-foreground">{new Date(row.received_at).toLocaleString()}</span></div>
      {row.preview ? <p className="mt-1 truncate text-[11px] text-muted-foreground" title={row.preview}>{row.preview}</p> : null}
    </li>)}</ul> : null}
  </RuntimeCard>;
}

type TeamsTab = 'teams' | 'spaces' | 'peers';

export default function TeamsView({ bots, onNavigate, onNotice }: { bots: Bot[]; onNavigate: (path: string) => void; onNotice?: Notice }) {
  const [tab, setTab] = useState<TeamsTab>('teams');
  const [botId, setBotId] = useState('');
  const [creating, setCreating] = useState(false);
  const titleOf = useMemo(() => titleLookup(bots), [bots]);
  const fetchTeams = useCallback(() => botRuntimeApi.collab.listTeams(), []);
  const { data: teams, setData, error, loading, reload } = useLoad(fetchTeams, 'teams');
  const selectedBotId = bots.some((bot) => bot.section_id === botId) ? botId : (bots[0]?.section_id ?? '');
  const list = useMemo(() => teams ?? [], [teams]);

  const replaceTeam = (next: BotTeam) => setData((current) => (current ?? []).map((team) => (team.team_id === next.team_id ? next : team)));

  const actions = <SegmentedControl<TeamsTab> label="Teams sections" value={tab} options={[{ value: 'teams', label: 'Teams', count: list.length }, { value: 'spaces', label: 'Spaces' }, { value: 'peers', label: 'Peer traffic' }]} onChange={setTab} />;

  return <RuntimePage icon={Users} eyebrow="Bot runtime" title="Teams" description="Group bots under a shared goal and a coordinator, share markdown spaces with a bot, and watch how bots talk to each other." actions={actions}>
    {tab === 'teams' ? <div className="space-y-4">
      {error ? <ErrorBanner message={error} onRetry={() => void reload()} /> : null}
      <div className="flex justify-end"><button type="button" className="button button-primary" onClick={() => setCreating(true)} disabled={creating}><Plus className="h-3.5 w-3.5" />New team</button></div>
      {creating ? <NewTeamForm names={list.map((team) => team.name)} onCancel={() => setCreating(false)} onCreated={(team) => { setData((current) => [...(current ?? []), team]); setCreating(false); onNotice?.(`Team "${team.name}" created.`, 'success'); }} /> : null}
      {!teams && loading ? <LoadingLine label="Loading teams…" /> : null}
      {teams && !list.length && !creating ? <RuntimeCard title="No teams yet" subtitle="Teams let a coordinator bot work with others toward one goal"><EmptyLine>Create a team to get started.</EmptyLine></RuntimeCard> : null}
      {list.map((team) => <TeamCard key={team.team_id} team={team} bots={bots} titleOf={titleOf} otherNames={list.filter((entry) => entry.team_id !== team.team_id).map((entry) => entry.name)} onTeam={replaceTeam} onDeleted={(teamId) => setData((current) => (current ?? []).filter((entry) => entry.team_id !== teamId))} onNavigate={onNavigate} onNotice={onNotice} />)}
    </div> : <div className="space-y-4">
      {bots.length ? <Field label="Bot" className="max-w-xs"><select className="field" value={selectedBotId} onChange={(event) => setBotId(event.target.value)}>{bots.map((bot) => <option key={bot.section_id} value={bot.section_id}>{bot.title}</option>)}</select></Field> : <RuntimeCard title="No bots" subtitle="Create a bot first"><EmptyLine>Spaces and peer traffic belong to a bot.</EmptyLine></RuntimeCard>}
      {selectedBotId && tab === 'spaces' ? <SpacesPanel key={selectedBotId} botId={selectedBotId} onNotice={onNotice} /> : null}
      {selectedBotId && tab === 'peers' ? <PeerTraffic key={selectedBotId} botId={selectedBotId} bots={bots} /> : null}
    </div>}
  </RuntimePage>;
}
