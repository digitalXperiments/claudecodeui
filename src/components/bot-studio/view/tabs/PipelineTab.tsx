import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronDown, RotateCcw, Save, Sparkles, X } from 'lucide-react';

import type { CreateMcSectionInput, McAction, McProvider, McWorkProfile } from '../../../mission-control/api/missionControlApi';
import { Button } from '../../../../shared/view/ui';
import { autoApproveLabel, type Bot, type ToolPolicy } from '../../types';
import Toggle from '../../ui/Toggle';
import { presetForCron, validateCron } from '../detail/cron';
import type { DetailFocus } from '../detail/detailTabs';

import ActionSetEditor from './ActionSetEditor';
import AgentModelEffortFields, { type AgentChoice } from './AgentModelEffortFields';
import IterateTab from './IterateTab';
import PhaseToolsEditor from './PhaseToolsEditor';
import ScheduleEditor from './ScheduleEditor';
import WorkProfileFields from './WorkProfileEditor';
import { loadWorkProfile, prepareWorkProfile } from './workProfile';

type SaveFn = (patch: Partial<CreateMcSectionInput>) => Promise<void>;
type StageKey = 'agent' | 'propose' | 'resolve' | 'work';
type Tone = 'auto' | 'manual' | 'off';

const textareaClass = 'w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-6 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const toneClass: Record<Tone, string> = {
  auto: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  manual: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  off: 'bg-muted text-muted-foreground',
};

/** Local draft of a stage's fields; resets whenever the saved value changes. */
function useDraft<T>(saved: T): [T, (next: T | ((current: T) => T)) => void, boolean, () => void] {
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<T>(saved);
  useEffect(() => { setDraft(JSON.parse(savedKey) as T); }, [savedKey]);
  return [draft, setDraft, JSON.stringify(draft) !== savedKey, () => setDraft(JSON.parse(savedKey) as T)];
}

/** Policy entries for the given servers, so each stage only saves its own servers. */
function pickPolicy(policy: ToolPolicy | undefined, servers: string[]): ToolPolicy {
  return Object.fromEntries(servers.filter((server) => policy?.[server]).map((server) => [server, policy![server]]));
}

function useStageSave(onSave: SaveFn, success: string) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (patch: Partial<CreateMcSectionInput> | string) => {
    if (typeof patch === 'string') { setNote(patch); return; }
    setBusy(true); setNote(null);
    try { await onSave(patch); setNote(success); } catch (error) { setNote(error instanceof Error ? error.message : 'Unable to save.'); } finally { setBusy(false); }
  };
  return { busy, note, run };
}

function StageFooter({ dirty, busy, note, disabled, label, onSave, onDiscard }: { dirty: boolean; busy: boolean; note: string | null; disabled?: boolean; label: string; onSave: () => void; onDiscard: () => void }) {
  return <footer className="sticky bottom-0 z-[1] flex flex-wrap items-center gap-2 rounded-b-2xl border-t border-border/70 bg-card/95 px-4 py-2.5 backdrop-blur">
    <Button size="sm" onClick={onSave} disabled={busy || !dirty || disabled}><Save className="h-3.5 w-3.5" />{busy ? 'Saving…' : label}</Button>
    {dirty ? <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy}><RotateCcw className="h-3.5 w-3.5" />Discard</Button> : null}
    {note ? <span className="min-w-0 truncate text-xs text-muted-foreground" role="status">{note}</span> : null}
  </footer>;
}

function StageCard({ number, title, helper, chip, tone, dirty, control, sectionRef, children, footer }: { number: string; title: string; helper: string; chip: string; tone: Tone; dirty: boolean; control?: ReactNode; sectionRef: RefObject<HTMLElement>; children: ReactNode; footer: ReactNode }) {
  return <section ref={sectionRef} aria-label={`${title} stage`} className="scroll-mt-4 rounded-2xl border border-border/70 bg-card shadow-sm">
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-4 py-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{number}</span>
      <div className="min-w-0 flex-[1_1_12rem]"><h3 className="flex items-center gap-1.5 text-sm font-semibold">{title}{dirty ? <span className="h-2 w-2 rounded-full bg-amber-500" role="img" aria-label="Unsaved changes" title="Unsaved changes" /> : null}</h3><p className="truncate text-[11px] text-muted-foreground" title={helper}>{helper}</p></div>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize ${toneClass[tone]}`}>{chip}</span>
      {control}
    </header>
    <div className="space-y-4 p-4">{children}</div>
    {footer}
  </section>;
}

function Connector() {
  return <div aria-hidden="true" className="ml-[1.9rem] flex h-5 flex-col items-center"><span className="w-px flex-1 bg-border" /><ChevronDown className="-mt-1 h-3 w-3 text-muted-foreground/60" /></div>;
}

function PermissionsBar({ bot, onSave, onDirty, onArchitect }: { bot: Bot; onSave: SaveFn; onDirty: (dirty: boolean) => void; onArchitect: () => void }) {
  const [draft, setDraft, dirty, reset] = useDraft({ permission_mode: bot.permission_mode || 'default' });
  const save = useStageSave(onSave, 'Permissions saved.');
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return <section aria-label="Bot permissions" className="rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-sm">
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-[1_1_14rem] text-[11px] text-muted-foreground"><span className="flex items-center gap-1.5">Permissions · all stages{dirty ? <span className="inline-block h-2 w-2 rounded-full bg-amber-500" role="img" aria-label="Unsaved changes" /> : null}</span><select aria-label="Permission mode" className="field mt-1 h-9 w-full" value={draft.permission_mode} onChange={(event) => setDraft({ permission_mode: event.target.value })}><option value="default">Default · ask when needed</option><option value="acceptEdits">Accept edits</option><option value="bypassPermissions">Bypass permissions</option></select></label>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {dirty ? <><Button size="sm" onClick={() => void save.run({ permission_mode: draft.permission_mode })} disabled={save.busy}><Save className="h-3.5 w-3.5" />Save</Button><Button size="sm" variant="ghost" onClick={reset} disabled={save.busy} aria-label="Discard permission changes"><RotateCcw className="h-3.5 w-3.5" /></Button></> : null}
        <Button size="sm" variant="outline" onClick={onArchitect}><Sparkles className="h-3.5 w-3.5" />Improve with Architect</Button>
      </div>
    </div>
    {save.note ? <p className="mt-2 text-xs text-muted-foreground" role="status">{save.note}</p> : null}
  </section>;
}

function ProposeStage({ bot, onSave, onDirty, sectionRef }: { bot: Bot; onSave: SaveFn; onDirty: (dirty: boolean) => void; sectionRef: RefObject<HTMLElement> }) {
  const [draft, setDraft, dirty, reset] = useDraft({ prompt: bot.produce_prompt, servers: bot.produce_tools, policy: pickPolicy(bot.tool_policy, bot.produce_tools), cron: bot.schedule_cron ?? '', agent: { provider: bot.provider, model: bot.model ?? null, effort: bot.effort ?? null } as AgentChoice });
  const save = useStageSave(onSave, 'Propose saved.');
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const cronError = validateCron(draft.cron);
  const chip = draft.cron.trim() ? presetForCron(draft.cron)?.label ?? draft.cron.trim() : 'Manual';
  return <StageCard number="1" title="Propose" helper="Each tick finds new items with this prompt and these tools." chip={chip} tone={draft.cron.trim() ? 'auto' : 'off'} dirty={dirty} sectionRef={sectionRef}
    footer={<StageFooter dirty={dirty} busy={save.busy} note={save.note} disabled={Boolean(cronError)} label="Save Propose" onDiscard={reset} onSave={() => void save.run({ produce_prompt: draft.prompt, produce_tools: draft.servers, schedule_cron: draft.cron.trim() || null, provider: draft.agent.provider ?? bot.provider, model: draft.agent.model, effort: draft.agent.effort, tool_policy: { ...(bot.tool_policy ?? {}), ...pickPolicy(draft.policy, draft.servers) } })} />}>
    <AgentModelEffortFields label="Propose agent" value={draft.agent} onChange={(agent) => setDraft({ ...draft, agent })} />
    <label className="block"><span className="text-xs font-semibold">Propose prompt</span><textarea aria-label="Propose prompt" value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} className={`${textareaClass} mt-1.5 min-h-36`} /></label>
    <PhaseToolsEditor phaseLabel="Propose" servers={draft.servers} policy={draft.policy} onServersChange={(servers) => setDraft({ ...draft, servers })} onPolicyChange={(policy) => setDraft({ ...draft, policy })} />
    <ScheduleEditor cron={draft.cron} onChange={(cron) => setDraft({ ...draft, cron })} />
  </StageCard>;
}

function ResolveStage({ bot, onSave, onDirty, sectionRef }: { bot: Bot; onSave: SaveFn; onDirty: (dirty: boolean) => void; sectionRef: RefObject<HTMLElement> }) {
  const [draft, setDraft, dirty, reset] = useDraft({ prompt: bot.resolve_prompt, servers: bot.resolve_tools, policy: pickPolicy(bot.tool_policy, bot.resolve_tools), actions: bot.actions as McAction[], auto: bot.auto_approve, agent: { provider: bot.resolve_provider ?? null, model: bot.resolve_provider ? bot.resolve_model ?? null : null, effort: bot.resolve_provider ? bot.resolve_effort ?? null : null } as AgentChoice });
  const save = useStageSave(onSave, 'Resolve saved.');
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const skipped = !draft.prompt.trim();
  const autoLabel = autoApproveLabel({ resolve_prompt: draft.prompt, auto_approve: draft.auto, work_profile: bot.work_profile });
  const tone: Tone = skipped ? 'off' : draft.auto ? 'auto' : 'manual';
  return <StageCard number="2" title="Resolve" helper="Acts on an approved item. Leave the prompt empty to skip this stage." chip={skipped ? 'skipped' : tone} tone={tone} dirty={dirty} sectionRef={sectionRef}
    control={autoLabel ? <label className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground" title={autoLabel.description}><Toggle checked={draft.auto} onChange={(auto) => setDraft({ ...draft, auto })} label={autoLabel.label} />{autoLabel.label}</label> : null}
    footer={<StageFooter dirty={dirty} busy={save.busy} note={save.note} label="Save Resolve" onDiscard={reset} onSave={() => void save.run({ resolve_prompt: draft.prompt, resolve_tools: draft.servers, actions: draft.actions, auto_approve: draft.auto, resolve_provider: (draft.agent.provider as McProvider | null) ?? null, resolve_model: draft.agent.provider ? draft.agent.model : null, resolve_effort: draft.agent.provider ? draft.agent.effort : null, tool_policy: { ...(bot.tool_policy ?? {}), ...pickPolicy(draft.policy, draft.servers) } })} />}>
    <AgentModelEffortFields label="Resolve agent" value={draft.agent} onChange={(agent) => setDraft({ ...draft, agent })} sameOption={`Same as Propose (${[bot.provider, bot.model].filter(Boolean).join(' · ')})`} disabled={skipped} />
    <label className="block"><span className="text-xs font-semibold">Resolve prompt</span><textarea aria-label="Resolve prompt" value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="Empty: approved items skip Resolve" className={`${textareaClass} mt-1.5 min-h-28`} />{skipped ? <span className="mt-1 block text-[11px] text-muted-foreground">Stage skipped — approved items {bot.work_profile ? 'go straight to Work' : 'are recorded as done'}.</span> : null}</label>
    {autoLabel && draft.auto ? <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">{autoLabel.description}</p> : null}
    <PhaseToolsEditor phaseLabel="Resolve" servers={draft.servers} policy={draft.policy} onServersChange={(servers) => setDraft({ ...draft, servers })} onPolicyChange={(policy) => setDraft({ ...draft, policy })} />
    <ActionSetEditor actions={draft.actions} onChange={(actions) => setDraft({ ...draft, actions })} />
  </StageCard>;
}

function WorkStage({ bot, projects, onSave, onDirty, sectionRef }: { bot: Bot; projects: Array<{ projectId: string; displayName: string }>; onSave: SaveFn; onDirty: (dirty: boolean) => void; sectionRef: RefObject<HTMLElement> }) {
  const [draft, setDraft, dirty, reset] = useDraft<{ enabled: boolean; profile: McWorkProfile }>({ enabled: Boolean(bot.work_profile), profile: loadWorkProfile(bot) });
  const save = useStageSave(onSave, 'Work saved.');
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const tone: Tone = !draft.enabled ? 'off' : draft.profile.auto_start ? 'auto' : 'manual';
  const submit = () => {
    if (!draft.enabled) { void save.run({ work_profile: null }); return; }
    const prepared = prepareWorkProfile(draft.profile);
    void save.run(prepared.error ?? { work_profile: prepared.profile });
  };
  return <StageCard number="3" title="Work" helper="Hands the item and its resolve result to a work session in a project." chip={tone} tone={tone} dirty={dirty} sectionRef={sectionRef}
    control={draft.enabled ? <label className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground" title="One automatic session runs at a time per bot; dry run starts no work."><Toggle checked={draft.profile.auto_start} onChange={(auto_start) => setDraft({ ...draft, profile: { ...draft.profile, auto_start } })} label="Start work automatically" />Start work automatically</label> : null}
    footer={<StageFooter dirty={dirty} busy={save.busy} note={save.note} label="Save Work" onDiscard={reset} onSave={submit} />}>
    <label className="flex items-center gap-3"><Toggle checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="Work sessions" /><span><span className="block text-xs font-semibold">Work sessions</span><span className="block text-[11px] text-muted-foreground">{draft.enabled ? 'Results wait for your QA; when off, Start work stays manual.' : 'Off — items end after Resolve.'}</span></span></label>
    {draft.enabled ? <>
      <label className="block"><span className="text-xs font-semibold">Work prompt</span><textarea aria-label="Work prompt" value={draft.profile.context} onChange={(event) => setDraft({ ...draft, profile: { ...draft.profile, context: event.target.value } })} placeholder="Instructions that apply to every work session" className={`${textareaClass} mt-1.5 min-h-28`} /></label>
      <WorkProfileFields profile={draft.profile} projects={projects} onChange={(profile) => setDraft({ ...draft, profile })} />
    </> : null}
  </StageCard>;
}

function ArchitectDrawer({ bot, onSave, onClose }: { bot: Bot; onSave: SaveFn; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Improve with Architect">
    <button type="button" className="absolute inset-0 bg-background/60 backdrop-blur-[1px]" onClick={onClose} aria-label="Close Architect" />
    <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-border bg-background shadow-xl">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3"><Sparkles className="h-4 w-4 text-primary" /><p className="flex-1 text-sm font-semibold">Improve with Architect</p><Button size="icon" variant="ghost" onClick={onClose} aria-label="Close Architect"><X className="h-4 w-4" /></Button></div>
      <div className="min-h-0 flex-1 overflow-y-auto"><IterateTab key={bot.section_id} bot={bot} onSave={onSave} /></div>
    </aside>
  </div>;
}

export default function PipelineTab({ bot, projects, onSave, onDirtyChange, focus }: { bot: Bot; projects: Array<{ projectId: string; displayName: string }>; onSave: SaveFn; onDirtyChange?: (dirty: boolean) => void; focus?: DetailFocus }) {
  const [dirty, setDirty] = useState<Record<StageKey, boolean>>({ agent: false, propose: false, resolve: false, work: false });
  const [architectOpen, setArchitectOpen] = useState(focus === 'architect');
  const proposeRef = useRef<HTMLElement>(null);
  const resolveRef = useRef<HTMLElement>(null);
  const workRef = useRef<HTMLElement>(null);
  const markers = useMemo(() => {
    const marker = (key: StageKey) => (value: boolean) => setDirty((current) => (current[key] === value ? current : { ...current, [key]: value }));
    return { agent: marker('agent'), propose: marker('propose'), resolve: marker('resolve'), work: marker('work') };
  }, []);
  const anyDirty = Object.values(dirty).some(Boolean);
  useEffect(() => onDirtyChange?.(anyDirty), [anyDirty, onDirtyChange]);
  useEffect(() => {
    if (focus === 'architect') { setArchitectOpen(true); return; }
    const ref = focus === 'propose' ? proposeRef : focus === 'resolve' ? resolveRef : focus === 'work' ? workRef : null;
    ref?.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focus]);
  return <div className="bot-studio-controls max-w-4xl p-4 sm:p-6">
    <PermissionsBar bot={bot} onSave={onSave} onDirty={markers.agent} onArchitect={() => setArchitectOpen(true)} />
    <div className="h-4" />
    <ProposeStage bot={bot} onSave={onSave} onDirty={markers.propose} sectionRef={proposeRef} />
    <Connector />
    <ResolveStage bot={bot} onSave={onSave} onDirty={markers.resolve} sectionRef={resolveRef} />
    <Connector />
    <WorkStage bot={bot} projects={projects} onSave={onSave} onDirty={markers.work} sectionRef={workRef} />
    {architectOpen ? <ArchitectDrawer bot={bot} onSave={onSave} onClose={() => setArchitectOpen(false)} /> : null}
  </div>;
}
