import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Loader2,
  MessageSquareText,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';

import { missionControlApi } from '../../mission-control/api/missionControlApi';
import { useMcpCatalog } from '../../mcp/hooks/useMcpCatalog';
import type { McpInventoryItem } from '../../mcp/types';
import { authenticatedFetch } from '../../../utils/api';
import { botStudioApi } from '../api/botStudioApi';
import BotIcon from '../ui/BotIcon';

import {
  applyReadOnlyPreset,
  applyWorkshopDraft,
  autonomyFromSection,
  AUTONOMY_OPTIONS,
  cronSummary,
  CRON_PRESETS,
  defaultToolDecision,
  isValidCron,
  sectionFieldsForAutonomy,
  type Autonomy,
  type CreateMcSectionInput,
  type McSection,
  type McSectionWorkshopDraft,
  type McAction,
  type ToolPolicy,
  type ToolPolicyDecision,
} from './types';

export interface BotArchitectProps {
  mode: 'create' | 'edit';
  initialSection?: Partial<CreateMcSectionInput> & { section_id?: string };
  projects: Array<{ id: string; name: string; path: string }>;
  onSaved: (section: McSection) => void;
  onCancel: () => void;
}

type Step = { title: string; hint: string };
type ChatTurn = { role: 'user' | 'assistant'; content: string };
type ToolInfo = { name: string; description?: string; fromPolicy?: boolean };
type ModelOption = { value: string; label: string };

// Keep this exhaustive list in lockstep with server/modules/mission-control/mission-control.types.ts:MC_PROVIDERS.
const MC_PROVIDERS = ['claude', 'codex', 'cursor', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'qwencode', 'pi', 'omp', 'antigravity'] as const;
const ICONS = ['🤖', '✨', '📬', '🧭', '🛠️', '📝', '🔎', '📚', '🎯', '⚡', '🌱', '🧠', '🗂️', '🧪', '🛰️', '🧹'];
const STEPS: Step[] = [
  { title: 'Purpose', hint: 'Name, scope, and outcome' },
  { title: 'Agent', hint: 'Provider and safety' },
  { title: 'Brief', hint: 'What to look for and resolve' },
  { title: 'Tools', hint: 'MCP servers and policies' },
  { title: 'Triggers', hint: 'When a tick runs' },
  { title: 'Outputs & actions', hint: 'Autonomy and handoffs' },
  { title: 'Guardrails', hint: 'Safety recap' },
  { title: 'Review', hint: 'Check and create' },
];

const DEFAULT_ACTIONS: McAction[] = [
  { id: 'approve', label: 'Approve', kind: 'approve', style: 'primary', terminal: true },
  { id: 'dismiss', label: 'Dismiss', kind: 'dismiss', style: 'secondary', terminal: true },
];

const EMPTY_FORM: CreateMcSectionInput = {
  title: '',
  icon: '🤖',
  enabled: false,
  scope: 'global',
  project_id: null,
  mode: 'review',
  schedule_cron: '*/30 * * * *',
  provider: 'claude',
  model: null,
  permission_mode: 'bypassPermissions',
  dry_run: false,
  auto_approve: false,
  produce_prompt: '',
  produce_tools: [],
  resolve_prompt: '',
  resolve_tools: [],
  actions: DEFAULT_ACTIONS,
  create_kanban_task: false,
  create_swarm_on_approve: false,
  kanban_assignee_provider: null,
  kanban_review_provider: null,
  kanban_mcp_tools: [],
  tool_policy: {},
  read_only_preset: false,
  manual_schedule: false,
};

function sectionInput(initial?: BotArchitectProps['initialSection']): CreateMcSectionInput {
  return {
    ...EMPTY_FORM,
    ...initial,
    actions: initial?.actions?.length ? initial.actions : DEFAULT_ACTIONS,
    produce_tools: initial?.produce_tools ?? [],
    resolve_tools: initial?.resolve_tools ?? [],
    kanban_mcp_tools: initial?.kanban_mcp_tools ?? [],
    tool_policy: initial?.tool_policy ?? {},
    project_id: initial?.project_id ?? null,
    schedule_cron: initial?.schedule_cron ?? EMPTY_FORM.schedule_cron,
    read_only_preset: initial?.read_only_preset ?? false,
    manual_schedule: initial?.manual_schedule ?? initial?.schedule_cron === null,
  };
}

function inputToDraft(input: CreateMcSectionInput): Partial<McSectionWorkshopDraft> {
  return {
    title: input.title,
    scope: input.scope,
    mode: input.mode,
    scheduleCron: input.schedule_cron,
    producePrompt: input.produce_prompt,
    resolvePrompt: input.resolve_prompt,
    createKanbanTask: input.create_kanban_task,
    recommendedMcpServers: input.produce_tools ?? [],
  };
}

function prettyServerName(name: string): string {
  return name.replace(/^claude\.ai\s+/i, '').replace(/[-_]/g, ' ');
}

function getServerTools(policy: ToolPolicy, server: string): Record<string, ToolPolicyDecision> {
  return policy[server] ?? {};
}

function updateToolPolicy(policy: ToolPolicy, server: string, tool: string, decision: ToolPolicyDecision): ToolPolicy {
  return { ...policy, [server]: { ...policy[server], [tool]: decision } };
}

function toolsWithPolicyEntries(tools: ToolInfo[], policy: Record<string, ToolPolicyDecision>): ToolInfo[] {
  const catalogNames = new Set(tools.map((tool) => tool.name));
  return [...tools, ...Object.keys(policy).filter((name) => !catalogNames.has(name)).map((name) => ({ name, description: 'Saved policy entry', fromPolicy: true }))];
}

function statusForInventory(item: McpInventoryItem): { label: string; className: string } {
  if (item.needsAuth) return { label: 'Needs auth', className: 'text-amber-700 dark:text-amber-300' };
  if (item.connected) return { label: 'Connected', className: 'text-emerald-700 dark:text-emerald-300' };
  return { label: 'Not connected', className: 'text-muted-foreground' };
}

function FieldLabel({ children, detail }: { children: ReactNode; detail?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{children}</label>
      {detail ? <span className="text-[10px] text-muted-foreground/75">{detail}</span> : null}
    </div>
  );
}

function ArchitectCard({ form, autonomy }: { form: CreateMcSectionInput; autonomy: Autonomy }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      <div className="border-b border-border/60 bg-gradient-to-br from-primary/[0.10] via-card to-violet-500/[0.07] p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-background text-2xl shadow-sm"><BotIcon icon={form.icon} size={26} /></div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{form.title || 'Untitled bot'}</p>
            <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{form.produce_prompt || 'Your bot purpose and brief will appear here as you shape it.'}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <span className="rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] font-medium text-foreground">{autonomy === 'dry_run' ? 'Dry run' : autonomy === 'act' ? 'Act' : 'Propose'}</span>
          <span className="rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">{cronSummary(form.schedule_cron)}</span>
          <span className="rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">{form.scope === 'project' ? 'Project' : 'Global'}</span>
        </div>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground"><span>Agent</span><span className="font-medium text-foreground">{form.provider || 'claude'}{form.model ? ` · ${form.model}` : ''}</span></div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground"><span>Tools attached</span><span className="font-medium text-foreground">{form.produce_tools?.length ?? 0} MCP servers</span></div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground"><span>Enabled after save</span><span className="font-medium text-foreground">{form.enabled ? 'Yes' : 'No — review first'}</span></div>
      </div>
    </div>
  );
}

export default function BotArchitect({ mode, initialSection, projects, onSaved, onCancel }: BotArchitectProps): JSX.Element {
  const storageKey = `bot-studio:architect:${mode}:${initialSection?.section_id ?? 'new'}`;
  const [form, setForm] = useState<CreateMcSectionInput>(() => sectionInput(initialSection));
  const [step, setStep] = useState(1);
  const [showRestore, setShowRestore] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [inventory, setInventory] = useState<McpInventoryItem[]>([]);
  const [toolLists, setToolLists] = useState<Record<string, ToolInfo[]>>({});
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({});
  const [toolLoading, setToolLoading] = useState<Record<string, boolean>>({});
  const [toolErrors, setToolErrors] = useState<Record<string, string>>({});
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [changed, setChanged] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [createdSection, setCreatedSection] = useState<McSection | null>(null);
  const [runResult, setRunResult] = useState<{ created: number; skipped?: number; message?: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const initialFormRef = useRef(form);
  const restorePendingRef = useRef(false);
  const { items: catalogItems } = useMcpCatalog();

  useEffect(() => {
    setInventory(catalogItems);
  }, [catalogItems]);

  // Check for a recoverable draft once per wizard/storage key. Dismissing or
  // restoring clears the pending ref so the debounced writer can resume.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved && saved !== JSON.stringify(initialFormRef.current)) {
        setSavedSnapshot(saved);
        setShowRestore(true);
        restorePendingRef.current = true;
      }
    } catch {
      // localStorage is optional in private browsing and embedded previews.
    }
  }, [storageKey]);

  useEffect(() => {
    if (restorePendingRef.current) return undefined;
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(form));
      } catch {
        // Keep the wizard usable when storage is unavailable.
      }
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [form, storageKey]);

  /* istanbul ignore next -- kept separate from the restore check for clarity */
  useEffect(() => {
    try {
      if (createdSection) window.localStorage.removeItem(storageKey);
    } catch {
      // localStorage is optional in private browsing and embedded previews.
    }
  }, [createdSection, storageKey]);

  useEffect(() => () => activeRequest.current?.abort(), []);

  useEffect(() => {
    const provider = form.provider;
    if (!provider) return;
    let cancelled = false;
    setModelsLoading(true);
    authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/models`)
      .then((response) => response.json() as Promise<{ data?: { models?: { OPTIONS?: Array<{ value: string; label?: string }>; DEFAULT?: string } } }>)
      .then((body) => {
        if (cancelled) return;
        const options = body.data?.models?.OPTIONS?.map((modelOption) => ({ value: modelOption.value, label: modelOption.label || modelOption.value })) ?? [];
        setModels(options);
        setForm((current) => {
          if (current.provider !== provider || (current.model && options.some((option) => option.value === current.model))) return current;
          const defaultModel = body.data?.models?.DEFAULT;
          return { ...current, model: options.find((option) => option.value === defaultModel)?.value ?? options[0]?.value ?? null };
        });
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => { cancelled = true; };
  }, [form.provider]);

  const autonomy = autonomyFromSection({ mode: form.mode ?? 'review', dry_run: Boolean(form.dry_run) });
  const attachedServers = useMemo(() => Array.from(new Set([...(form.produce_tools ?? []), ...(form.resolve_tools ?? []), ...(form.kanban_mcp_tools ?? [])])), [form]);
  const inventoryByName = useMemo(() => new Map(inventory.map((item) => [item.name, item])), [inventory]);
  const project = projects.find((candidate) => candidate.id === form.project_id);

  const updateForm = useCallback((patch: Partial<CreateMcSectionInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  }, []);

  const applyDraft = useCallback((draft: McSectionWorkshopDraft) => {
    const next = applyWorkshopDraft(form, draft, inventory.map((item) => item.name));
    const nextChanged = Object.keys(next).filter((key) => JSON.stringify(next[key as keyof CreateMcSectionInput]) !== JSON.stringify(form[key as keyof CreateMcSectionInput]));
    setForm({ ...next, manual_schedule: draft.scheduleCron === null });
    setChanged(nextChanged.map((key) => key.split('_').join(' ')));
    setNotice(`Architect updated ${nextChanged.length || 1} field${nextChanged.length === 1 ? '' : 's'}.`);
    setStep(3);
  }, [form, inventory]);

  const sendToArchitect = useCallback(async (textOverride?: string) => {
    const text = (textOverride ?? chatDraft).trim();
    if (!text || chatBusy) return;
    const nextTurns = [...turns, { role: 'user' as const, content: text }];
    setTurns(nextTurns);
    setChatDraft('');
    setChatBusy(true);
    setChatError(null);
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    try {
      const payload = await missionControlApi.draftSection({
        provider: form.provider ?? 'claude',
        model: form.model ?? null,
        projectId: form.project_id ?? null,
        projectName: project?.name ?? null,
        messages: nextTurns,
        currentDraft: inputToDraft(form),
        availableMcpServers: inventory.map((item) => item.name),
      });
      setTurns([...nextTurns, { role: 'assistant', content: payload.reply.trim() || 'I need a little more detail about the workflow.' }]);
      if (payload.ready && payload.draft) applyDraft(payload.draft);
    } catch (caught) {
      if ((caught as Error)?.name !== 'AbortError') setChatError(caught instanceof Error ? caught.message : 'Architect could not draft this bot.');
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setChatBusy(false);
    }
  }, [applyDraft, chatBusy, chatDraft, form, inventory, project, turns]);

  const draftFromPurpose = () => {
    if (!form.produce_prompt?.trim()) {
      setError('Add a purpose before asking the Architect to draft the brief.');
      setStep(1);
      return;
    }
    void sendToArchitect(`Design this bot from my purpose: ${form.produce_prompt.trim()}`);
  };

  const toggleServer = (server: string) => {
    const attached = attachedServers.includes(server);
    const nextProduce = attached ? (form.produce_tools ?? []).filter((name) => name !== server) : [...(form.produce_tools ?? []), server];
    const nextResolve = attached ? (form.resolve_tools ?? []).filter((name) => name !== server) : [...(form.resolve_tools ?? []), server];
    updateForm({ produce_tools: nextProduce, resolve_tools: nextResolve });
  };

  const loadTools = async (server: string, force = false) => {
    const open = force || !expandedServers[server];
    setExpandedServers((current) => ({ ...current, [server]: open }));
    if (!open || (!force && toolLists[server])) return;
    setToolLoading((current) => ({ ...current, [server]: true }));
    setToolErrors((current) => { const next = { ...current }; delete next[server]; return next; });
    try {
      const serverTools = await botStudioApi.listMcpTools(server);
      setToolLists((current) => ({ ...current, [server]: toolsWithPolicyEntries(serverTools, getServerTools(form.tool_policy ?? {}, server)) }));
      if (serverTools.error) setToolErrors((current) => ({ ...current, [server]: 'Not in the MCP catalog — connect it in Settings → MCP' }));
      setForm((current) => {
        const existing = getServerTools(current.tool_policy ?? {}, server);
        const next = { ...existing, ...Object.fromEntries(serverTools.map((tool) => [tool.name, existing[tool.name] ?? defaultToolDecision(tool.name, Boolean(current.read_only_preset))])) } as Record<string, ToolPolicyDecision>;
        return { ...current, tool_policy: { ...current.tool_policy, [server]: next } };
      });
    } catch {
      setToolLists((current) => ({ ...current, [server]: toolsWithPolicyEntries([], getServerTools(form.tool_policy ?? {}, server)) }));
      setToolErrors((current) => ({ ...current, [server]: 'Not in the MCP catalog — connect it in Settings → MCP' }));
    } finally {
      setToolLoading((current) => ({ ...current, [server]: false }));
    }
  };

  const save = async () => {
    setError(null);
    if (!form.title?.trim()) { setError('Bot name is required.'); setStep(1); return; }
    if (form.scope === 'project' && !form.project_id) { setError('Select a project for a project-scoped bot.'); setStep(1); return; }
    if (!isValidCron(form.schedule_cron, Boolean(form.manual_schedule))) { setError('Choose Manual only (no schedule) or enter exactly five cron fields.'); setStep(5); return; }
    setSaving(true);
    try {
      const sectionFields = { ...form };
      delete sectionFields.read_only_preset;
      delete sectionFields.manual_schedule;
      const payload: CreateMcSectionInput = { ...sectionFields, title: form.title.trim(), schedule_cron: form.schedule_cron?.trim() || null };
      const saved = mode === 'edit' && initialSection?.section_id
        ? await missionControlApi.updateSection(initialSection.section_id, payload)
        : await missionControlApi.createSection(payload);
      try { window.localStorage.removeItem(storageKey); } catch { /* optional */ }
      if (mode === 'edit') {
        onSaved(saved as McSection);
      } else {
        setCreatedSection(saved as McSection);
        setRunResult(null);
        setRunError(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this bot.');
    } finally {
      setSaving(false);
    }
  };

  const runFirstTick = async (sectionId: string) => {
    try {
      setRunError(null);
      const currentSection = createdSection ?? initialSection;
      if (currentSection && !currentSection.enabled) {
        const enabledSection = await missionControlApi.updateSection(sectionId, { enabled: true });
        setCreatedSection((current) => current ? { ...current, ...enabledSection } : current);
      }
      const result = await missionControlApi.runSection(sectionId);
      setRunResult({ created: result.created, skipped: result.skipped, message: result.message });
    } catch (caught) {
      setRunError(caught instanceof Error ? caught.message : 'The first tick could not start.');
    }
  };

  const changeAutonomy = (value: Autonomy) => updateForm(sectionFieldsForAutonomy(value));

  const renderPurpose = () => (
    <StepPanel eyebrow="01 · Purpose" title="What should this bot do?" description="A clear outcome gives the Architect enough signal to draft the rest. You can refine every field later.">
      <div><FieldLabel>Bot name</FieldLabel><input autoFocus className="field" value={form.title ?? ''} onChange={(event) => updateForm({ title: event.target.value })} placeholder="e.g. Jira triage" /></div>
      <div><FieldLabel detail="one sentence is enough">Purpose / what to look for</FieldLabel><textarea className="field min-h-32 resize-y" value={form.produce_prompt ?? ''} onChange={(event) => updateForm({ produce_prompt: event.target.value })} placeholder="Watch new support tickets, classify urgency, and draft the next useful action with evidence." /></div>
      <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
        <div><FieldLabel>Scope</FieldLabel><div className="grid grid-cols-2 gap-2">{(['global', 'project'] as const).map((scope) => <button key={scope} type="button" className={`choice ${form.scope === scope ? 'choice-active' : ''}`} onClick={() => updateForm({ scope, project_id: scope === 'global' ? null : form.project_id })}>{scope === 'global' ? 'Global' : 'Project'}<span>{scope === 'global' ? 'Across workspaces' : 'One workspace'}</span></button>)}</div></div>
        {form.scope === 'project' ? <div><FieldLabel>Project</FieldLabel><select className="field" value={form.project_id ?? ''} onChange={(event) => updateForm({ project_id: event.target.value || null })}><option value="">Select a project…</option>{projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></div> : <div className="rounded-xl border border-border/60 bg-muted/25 p-3 text-xs text-muted-foreground">Global bots can use any connected MCP server. Scope down to a project when the brief depends on local files or a board.</div>}
      </div>
      <div><FieldLabel>Bot icon</FieldLabel><div className="flex flex-wrap gap-2">{ICONS.map((icon) => <button key={icon} type="button" aria-label={`Use ${icon} icon`} className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border text-lg transition ${form.icon === icon ? 'border-primary bg-primary/10 ring-2 ring-primary/20' : 'border-border/70 bg-background hover:bg-muted'}`} onClick={() => updateForm({ icon })}><BotIcon icon={icon} size={20} /></button>)}</div></div>
    </StepPanel>
  );

  const renderAgent = () => (
    <StepPanel eyebrow="02 · Agent" title="Choose the mind and the safety boundary" description="Provider and model are loaded from the same model registry used by Mission Control.">
      <div className="grid gap-4 md:grid-cols-2"><div><FieldLabel>Provider</FieldLabel><select className="field" value={form.provider ?? 'claude'} onChange={(event) => updateForm({ provider: event.target.value, model: null })}>{MC_PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></div><div><FieldLabel detail={modelsLoading ? 'loading…' : undefined}>Model</FieldLabel><select className="field" value={form.model ?? ''} onChange={(event) => updateForm({ model: event.target.value || null })}><option value="">Provider default</option>{models.map((modelOption) => <option key={modelOption.value} value={modelOption.value}>{modelOption.label}</option>)}</select></div></div>
      <div><FieldLabel>Permission mode</FieldLabel><select className="field" value={form.permission_mode ?? 'bypassPermissions'} onChange={(event) => updateForm({ permission_mode: event.target.value })}><option value="default">Default · ask when needed</option><option value="acceptEdits">Accept edits · no destructive approval</option><option value="bypassPermissions">Bypass permissions · MCP policy still applies</option><option value="plan">Plan · read-only agent</option></select><p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />The per-tool policy in Tools is the final boundary. Start with Propose or Dry run while you learn the bot’s behavior.</p></div>
      <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-4"><p className="text-xs font-semibold text-foreground">A useful default</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Use a strong model for ambiguous classification, then keep actions held in Propose mode until the inbox proves the brief.</p></div>
    </StepPanel>
  );

  const renderBrief = () => (
    <StepPanel eyebrow="03 · Brief" title="Give each tick a beginning and an ending" description="The produce brief finds and frames work. The resolve brief explains what an approved item means. Both are editable.">
      <div className="grid gap-4 lg:grid-cols-2"><div><FieldLabel>Brief · what to look for each tick</FieldLabel><textarea className="field min-h-48 resize-y" value={form.produce_prompt ?? ''} onChange={(event) => updateForm({ produce_prompt: event.target.value })} placeholder="Search for… Include evidence… Do not emit when…" /></div><div><FieldLabel>Brief · how to resolve an approved item</FieldLabel><textarea className="field min-h-48 resize-y" value={form.resolve_prompt ?? ''} onChange={(event) => updateForm({ resolve_prompt: event.target.value })} placeholder="Use the approved action… Return a concise result…" /></div></div>
      {changed.length > 0 ? <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3 text-xs text-emerald-700 dark:text-emerald-300"><p className="font-semibold">Architect changed</p><p className="mt-1">{changed.join(' · ')}</p></div> : null}
      <div className="flex flex-wrap gap-2"><button type="button" className="button button-primary" onClick={draftFromPurpose} disabled={chatBusy}><WandSparkles className="h-4 w-4" />Draft it from my purpose</button><button type="button" className="button" onClick={() => { setChanged([]); setNotice('Blank brief ready for your own outline.'); }}>Write it myself</button></div>
    </StepPanel>
  );

  const renderTools = () => {
    const names = Array.from(new Set([...inventory.map((item) => item.name), ...attachedServers]));
    return <StepPanel eyebrow="04 · Tools" title="Attach capabilities with a policy you can explain" description="Servers are capabilities. Every tool can be allowed, held for approval, or denied.">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/25 p-3"><div><p className="text-xs font-semibold">Read-only preset</p><p className="mt-0.5 text-[11px] text-muted-foreground">Write-like names become Ask; reading tools keep their current policy.</p></div><button type="button" className={`button ${form.read_only_preset ? 'button-primary' : ''}`} onClick={() => updateForm({ read_only_preset: true, tool_policy: applyReadOnlyPreset(form.tool_policy ?? {}, Object.fromEntries(Object.entries(toolLists).map(([server, tools]) => [server, tools.map((tool) => tool.name)]))) })}>{form.read_only_preset ? 'Preset applied' : 'Apply preset'}</button></div>
      <div className="space-y-2">{names.length === 0 ? <div className="rounded-xl border border-dashed border-border p-5 text-center text-xs text-muted-foreground">No MCP servers are visible yet. Connect one in the MCP catalog, then return here.<a className="mt-2 inline-flex items-center gap-1 text-primary" href="/settings/mcp">Open MCP catalog <ExternalLink className="h-3 w-3" /></a></div> : names.map((server) => { const item = inventoryByName.get(server); const status = item ? statusForInventory(item) : { label: 'Not connected', className: 'text-muted-foreground' }; const open = expandedServers[server]; const serverTools = toolsWithPolicyEntries(toolLists[server] ?? [], getServerTools(form.tool_policy ?? {}, server)); return <div key={server} className="overflow-hidden rounded-xl border border-border/70 bg-card"><div className="flex flex-wrap items-center gap-3 p-3"><button type="button" aria-label={`${open ? 'Collapse' : 'Expand'} ${server} tools`} className="text-muted-foreground" onClick={() => void loadTools(server)}>{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-foreground">{prettyServerName(server)}</p><p className={`text-[10px] ${status.className}`}>{status.label}{item?.needsAuth ? ' · connect in MCP catalog' : ''}</p></div><button type="button" className={`button min-h-8 px-2.5 text-[11px] ${attachedServers.includes(server) ? 'button-primary' : ''}`} onClick={() => toggleServer(server)}>{attachedServers.includes(server) ? <><Check className="h-3.5 w-3.5" />Attached</> : 'Attach'}</button></div><div className="flex flex-wrap gap-1 border-t border-border/50 px-3 py-2"><label className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"><input type="checkbox" checked={form.produce_tools?.includes(server) ?? false} onChange={() => updateForm({ produce_tools: form.produce_tools?.includes(server) ? form.produce_tools.filter((name) => name !== server) : [...(form.produce_tools ?? []), server] })} />produce</label><label className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"><input type="checkbox" checked={form.resolve_tools?.includes(server) ?? false} onChange={() => updateForm({ resolve_tools: form.resolve_tools?.includes(server) ? form.resolve_tools.filter((name) => name !== server) : [...(form.resolve_tools ?? []), server] })} />resolve</label><label className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"><input type="checkbox" checked={form.kanban_mcp_tools?.includes(server) ?? false} onChange={() => updateForm({ kanban_mcp_tools: form.kanban_mcp_tools?.includes(server) ? form.kanban_mcp_tools.filter((name) => name !== server) : [...(form.kanban_mcp_tools ?? []), server] })} />kanban</label></div>{open ? <div className="border-t border-border/50 bg-muted/15 p-3">{toolLoading[server] ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading tools…</div> : <>{toolErrors[server] ? <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200" role="alert"><span>Not in the MCP catalog — connect it in Settings → MCP</span><button type="button" className="rounded underline" onClick={() => void loadTools(server, true)}>Retry</button></div> : null}{serverTools.length === 0 ? <p className="text-[11px] text-muted-foreground">No catalog tools reported for this server.</p> : <div className="space-y-1.5">{serverTools.map((tool) => { const decision = getServerTools(form.tool_policy ?? {}, server)[tool.name] ?? 'allow'; return <div key={tool.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-background/60 px-2.5 py-2"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate font-mono text-[10px] text-foreground">{tool.name}</p>{tool.fromPolicy ? <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">from policy</span> : null}</div><p className="truncate text-[10px] text-muted-foreground">{tool.description || 'No description provided.'}</p></div><select aria-label={`Policy for ${tool.name}`} className="field h-8 w-24 px-2 text-[10px]" value={decision} onChange={(event) => updateForm({ tool_policy: updateToolPolicy(form.tool_policy ?? {}, server, tool.name, event.target.value as ToolPolicyDecision) })}><option value="allow">Allow</option><option value="ask">Ask</option><option value="deny">Deny</option></select></div>; })}</div>}</>}</div> : null}</div>; })}</div>
      <p className="text-[11px] text-muted-foreground">Need another capability? <a href="/settings/mcp" className="font-medium text-primary">Connect it in the MCP catalog</a>; Bot Studio does not manage accounts here.</p>
    </StepPanel>;
  };

  const renderTriggers = () => <StepPanel eyebrow="05 · Triggers" title="When should this bot tick?" description="A tick is a fresh run. Keep the schedule explicit and easy to inspect.">
    <div><FieldLabel>Schedule</FieldLabel><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{CRON_PRESETS.map((preset) => <button key={preset.value} type="button" className={`choice ${form.schedule_cron === preset.value && !form.manual_schedule ? 'choice-active' : ''}`} onClick={() => updateForm({ schedule_cron: preset.value, manual_schedule: false })}><Clock3 className="h-4 w-4" />{preset.label}<span>{preset.value}</span></button>)}<button type="button" className={`choice ${form.manual_schedule && !form.schedule_cron ? 'choice-active' : ''}`} onClick={() => updateForm({ schedule_cron: null, manual_schedule: true })}><Clock3 className="h-4 w-4" />Manual only<span>No schedule</span></button></div></div>
    <div><FieldLabel detail="five fields unless Manual only">Raw cron</FieldLabel><input className={`field font-mono ${!isValidCron(form.schedule_cron, Boolean(form.manual_schedule)) ? 'border-red-500' : ''}`} value={form.schedule_cron ?? ''} onChange={(event) => updateForm({ schedule_cron: event.target.value, manual_schedule: false })} placeholder="*/30 * * * *" /><p className="mt-1.5 text-[11px] text-muted-foreground">{form.manual_schedule ? 'Manual only (no schedule)' : cronSummary(form.schedule_cron)}</p></div>
    <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/20 p-4"><div><p className="text-xs font-semibold">Enabled after save</p><p className="mt-1 text-[11px] text-muted-foreground">Keep new bots paused while you review their first tick.</p></div><button type="button" role="switch" aria-checked={Boolean(form.enabled)} className={`toggle ${form.enabled ? 'toggle-on' : ''}`} onClick={() => updateForm({ enabled: !form.enabled })}><span /></button></div>
  </StepPanel>;

  const updateAction = (index: number, patch: Partial<McAction>) => updateForm({ actions: (form.actions ?? []).map((action, actionIndex) => actionIndex === index ? { ...action, ...patch } : action) });
  const renderOutputs = () => <StepPanel eyebrow="06 · Outputs & actions" title="Decide what approval means" description="Autonomy maps directly to the existing Mission Control section contract.">
    <div className="grid gap-2 md:grid-cols-3">{AUTONOMY_OPTIONS.map((option) => <button key={option.value} type="button" className={`choice ${autonomy === option.value ? 'choice-active' : ''}`} onClick={() => changeAutonomy(option.value)}><span className="font-semibold">{option.label}</span><span>{option.description}</span></button>)}</div>
    {autonomy === 'act' ? <label className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-3 text-xs"><input type="checkbox" checked={Boolean(form.auto_approve)} onChange={(event) => updateForm({ auto_approve: event.target.checked })} className="mt-0.5" /><span><span className="font-semibold text-foreground">Auto-approve generated items</span><span className="mt-1 block text-muted-foreground">Only expose this in Act mode; use it when the action set is genuinely safe.</span></span></label> : null}
    <div className="space-y-2"><div className="flex items-center justify-between"><FieldLabel>Action set</FieldLabel><button type="button" className="button min-h-8 px-2.5 text-[11px]" onClick={() => updateForm({ actions: [...(form.actions ?? []), { id: `action-${Date.now()}`, label: 'New action', kind: 'approve', style: 'secondary', terminal: true }] })}><Plus className="h-3.5 w-3.5" />Add action</button></div>{(form.actions ?? []).map((action, index) => <div key={action.id} className="grid gap-2 rounded-xl border border-border/60 bg-muted/15 p-3 sm:grid-cols-[1fr_1fr_120px_28px]"><input className="field h-9" value={action.label} aria-label="Action label" onChange={(event) => updateAction(index, { label: event.target.value })} /><input className="field h-9" value={action.kind} aria-label="Action kind" onChange={(event) => updateAction(index, { kind: event.target.value })} /><select className="field h-9" aria-label="Action style" value={action.style} onChange={(event) => updateAction(index, { style: event.target.value as McAction['style'] })}><option value="primary">Primary</option><option value="secondary">Secondary</option><option value="destructive">Destructive</option></select><button type="button" aria-label={`Remove ${action.label}`} className="flex h-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-red-500/10 hover:text-red-600" onClick={() => updateForm({ actions: (form.actions ?? []).filter((_, actionIndex) => actionIndex !== index) })}><Trash2 className="h-4 w-4" /></button><label className="flex items-center gap-2 text-[10px] text-muted-foreground sm:col-span-4"><input type="checkbox" checked={Boolean(action.terminal)} onChange={(event) => updateAction(index, { terminal: event.target.checked })} />Terminal action</label></div>)}</div>
    <label className="flex items-start gap-3 rounded-xl border border-border/60 p-3 text-xs"><input type="checkbox" checked={Boolean(form.create_kanban_task)} onChange={(event) => updateForm({ create_kanban_task: event.target.checked })} className="mt-0.5" /><span><span className="font-semibold">Kanban bridge</span><span className="mt-1 block text-muted-foreground">Create an implementation task when an approved item is ready.</span></span></label>
    {form.create_kanban_task ? <div className="grid gap-3 sm:grid-cols-2"><div><FieldLabel>Assignee provider</FieldLabel><select className="field" value={form.kanban_assignee_provider ?? ''} onChange={(event) => updateForm({ kanban_assignee_provider: event.target.value || null })}><option value="">Default</option>{MC_PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></div><div><FieldLabel>Review provider</FieldLabel><select className="field" value={form.kanban_review_provider ?? ''} onChange={(event) => updateForm({ kanban_review_provider: event.target.value || null })}><option value="">Default</option>{MC_PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></div></div> : null}
    {form.scope === 'project' ? <label className="flex items-start gap-3 rounded-xl border border-border/60 p-3 text-xs"><input type="checkbox" checked={Boolean(form.create_swarm_on_approve)} onChange={(event) => updateForm({ create_swarm_on_approve: event.target.checked })} className="mt-0.5" /><span><span className="font-semibold">Start a swarm on approval</span><span className="mt-1 block text-muted-foreground">Use the project’s implementation context for approved work.</span></span></label> : null}
  </StepPanel>;

  const renderGuardrails = () => <StepPanel eyebrow="07 · Guardrails" title="Make the safe path visible" description="These are the guardrails supported by the section model today; no hidden budgets or phantom controls.">
    <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-border/60 p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Permission mode</p><p className="mt-2 text-sm font-semibold">{form.permission_mode || 'default'}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">The model can only use attached MCP capabilities, each with its own allow / ask / deny policy.</p></div><div className="rounded-xl border border-border/60 p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Dry-run-first recommendation</p><p className="mt-2 text-sm font-semibold">{autonomy === 'dry_run' ? 'Enabled' : 'Recommended before Act'}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Preview a few ticks before widening autonomy. You can switch modes without rewriting the brief.</p></div></div>
    {autonomy === 'act' ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-4"><p className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200"><CircleHelp className="h-4 w-4" />Act mode risks to check</p><ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-amber-800/80 dark:text-amber-100/80"><li>• Write-like tools may change external systems.</li><li>• Auto-approve skips the inbox review gate.</li><li>• A broad brief can create noisy or duplicate items.</li></ul></div> : null}
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4"><p className="text-xs font-semibold">Current policy summary</p><p className="mt-1 text-xs text-muted-foreground">{attachedServers.length} MCP server{attachedServers.length === 1 ? '' : 's'} attached · {Object.values(form.tool_policy ?? {}).reduce((count, server) => count + Object.keys(server).length, 0)} tool decisions loaded · {autonomy === 'dry_run' ? 'no external actions' : autonomy === 'propose' ? 'actions held for approval' : 'actions may execute after approval'}</p></div>
  </StepPanel>;

  const renderReview = () => <StepPanel eyebrow="08 · Review" title="Ready to create this bot?" description="New bots start paused by default in this flow. Create it, inspect the first result, then enable it when it earns trust.">
    <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">{[['Name', form.title || 'Untitled bot'], ['Purpose', form.produce_prompt || 'Not set'], ['Scope', form.scope === 'project' ? project?.name || 'Project not selected' : 'Global'], ['Agent', `${form.provider || 'claude'}${form.model ? ` · ${form.model}` : ''}`], ['Autonomy', autonomy === 'dry_run' ? 'Dry run' : autonomy === 'act' ? 'Act' : 'Propose'], ['Trigger', cronSummary(form.schedule_cron)], ['Tools', attachedServers.length ? attachedServers.join(', ') : 'No MCP servers attached'], ['Actions', `${form.actions?.length ?? 0} action${form.actions?.length === 1 ? '' : 's'}`]].map(([label, value]) => <div key={label} className="grid gap-1 px-4 py-3 sm:grid-cols-[150px_1fr]"><span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span><span className="truncate text-xs text-foreground">{value}</span></div>)}</div>
    {!form.enabled ? <p className="text-xs text-muted-foreground">This bot will be created paused. You can enable it from Bot Studio after reviewing the brief.</p> : <p className="text-xs text-amber-700 dark:text-amber-300">This bot is enabled on save. Consider switching it off until after a dry run.</p>}
    {mode === 'edit' && initialSection?.section_id ? <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/20 p-3"><button type="button" className="button" onClick={() => void runFirstTick(initialSection.section_id!)}><Sparkles className="h-4 w-4" />Run first tick now</button>{runResult ? <span className="text-xs text-muted-foreground">{runResult.created} created{runResult.skipped ? ` · ${runResult.skipped} skipped` : ''}{runResult.message ? ` · ${runResult.message}` : ''}</span> : null}{runError ? <span className="text-xs text-red-600 dark:text-red-300">{runError}</span> : null}</div> : null}
  </StepPanel>;

  const currentStep = [renderPurpose, renderAgent, renderBrief, renderTools, renderTriggers, renderOutputs, renderGuardrails, renderReview][step - 1]();
  const createdPanel = createdSection ? <StepPanel eyebrow="Bot created" title={createdSection.title} description="Your bot is saved. Run one tick now to inspect what it would create, or finish and let Bot Studio take over.">
    <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.07] p-5"><div className="flex items-center gap-2"><BotIcon icon={createdSection.icon} size={20} className="text-emerald-700 dark:text-emerald-300" /><p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">Created successfully</p></div><p className="mt-1 text-xs leading-relaxed text-muted-foreground">The bot is {createdSection.enabled ? 'enabled' : 'paused'} and its tool policy was saved with the section.</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" className="button button-primary" onClick={() => void runFirstTick(createdSection.section_id)}><Sparkles className="h-4 w-4" />{createdSection.enabled ? 'Run first tick now' : 'Enable and run first tick'}</button><button type="button" className="button" onClick={() => onSaved(createdSection)}>Done</button></div>{runResult ? <p className="mt-3 text-xs text-foreground">{runResult.created} created · {runResult.skipped ?? 0} skipped{runResult.message ? ` · ${runResult.message}` : ''}</p> : null}{runError ? <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-300">{runError}</p> : null}</div>
  </StepPanel> : null;

  return <div className="flex min-h-[min(900px,calc(100vh-2rem))] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background text-foreground shadow-sm lg:flex-row">
    <aside className="w-full shrink-0 border-b border-border/70 bg-card/60 p-4 lg:w-[220px] lg:border-b-0 lg:border-r"><div className="flex items-center justify-between gap-2 lg:block"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Bot Studio</p><h1 className="mt-1 text-lg font-semibold">Bot Architect</h1><p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{mode === 'edit' ? 'Edit and save a new version.' : 'Shape a bot in eight small decisions.'}</p></div><button type="button" aria-label="Close architect" className="icon-button lg:hidden" onClick={onCancel}><X className="h-4 w-4" /></button></div><nav className="mt-5 flex flex-col gap-1.5">{STEPS.map((item, index) => <button key={item.title} type="button" className={`step-button ${step === index + 1 ? 'step-active' : ''}`} onClick={() => setStep(index + 1)}><span className="step-number">{index + 1}</span><span className="min-w-0 text-left"><span className="block truncate text-xs font-semibold">{item.title}</span><span className="hidden truncate text-[10px] text-muted-foreground lg:block">{item.hint}</span></span>{index + 1 < step ? <Check className="ml-auto h-3.5 w-3.5 text-emerald-600" /> : null}</button>)}</nav><div className="mt-5 hidden rounded-xl border border-border/60 bg-background/60 p-3 text-[10px] leading-relaxed text-muted-foreground lg:block"><p className="font-semibold text-foreground">Autosaved</p><p className="mt-1">Your in-progress draft is stored in this browser.</p></div></aside>
    <main className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-[820px] px-5 py-6 pb-28 sm:px-8 lg:px-10">{showRestore && savedSnapshot ? <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/[0.06] p-3 text-xs"><span><span className="font-semibold">Restore your in-progress draft?</span><span className="ml-1 text-muted-foreground">A newer local draft was found for this bot.</span></span><span className="flex gap-2"><button type="button" className="button min-h-8 px-2.5 text-[11px]" onClick={() => { try { setForm(JSON.parse(savedSnapshot) as CreateMcSectionInput); } catch { /* ignore invalid local state */ } restorePendingRef.current = false; setShowRestore(false); }}>Restore</button><button type="button" className="button min-h-8 px-2.5 text-[11px]" onClick={() => { restorePendingRef.current = false; setShowRestore(false); setSavedSnapshot(null); try { window.localStorage.removeItem(storageKey); } catch { /* optional */ } }}>Dismiss</button></span></div> : null}{notice ? <div className="mb-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</div> : null}{error ? <div role="alert" className="mb-4 rounded-xl border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div> : null}{createdPanel ?? currentStep}</div><footer className="sticky bottom-0 z-10 border-t border-border/70 bg-background/95 px-5 py-3 backdrop-blur sm:px-8 lg:px-10"><div className="mx-auto flex max-w-[820px] items-center justify-between gap-3"><button type="button" className="button" onClick={() => step > 1 ? setStep(step - 1) : onCancel()}>{step > 1 ? 'Back' : 'Cancel'}</button><div className="flex gap-2">{createdSection ? <button type="button" className="button button-primary" onClick={() => onSaved(createdSection)}>Done</button> : <>{<button type="button" className="button hidden sm:inline-flex" onClick={() => setStep(Math.min(8, step + 1))}>{step < 8 ? 'Skip' : 'Review again'}</button>}{step < 8 ? <button type="button" className="button button-primary" onClick={() => setStep(step + 1)}>Continue <ChevronRight className="h-4 w-4" /></button> : <button type="button" className="button button-primary" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}{saving ? 'Creating…' : mode === 'edit' ? 'Save bot' : 'Create bot'}</button>}</>}</div></div></footer></main>
    <aside className="hidden w-[360px] shrink-0 flex-col border-l border-border/70 bg-card/40 lg:flex"><div className="border-b border-border/70 px-5 py-4"><p className="flex items-center gap-2 text-xs font-semibold"><Sparkles className="h-4 w-4 text-primary" />Architect</p><p className="mt-1 text-[11px] text-muted-foreground">A live preview and a conversation that keeps your draft moving.</p></div><div className="space-y-4 overflow-y-auto p-5"><ArchitectCard form={form} autonomy={autonomy} /><div className="rounded-2xl border border-border/70 bg-card p-4"><div className="flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-primary" /><p className="text-xs font-semibold">Talk to the Architect</p></div><div className="mt-3 max-h-64 space-y-2 overflow-y-auto">{turns.length === 0 ? <div className="space-y-2"><p className="text-[11px] leading-relaxed text-muted-foreground">Start with the purpose, then ask for a brief, a stricter rule, or a safer default.</p><button type="button" className="w-full rounded-xl border border-border/60 bg-muted/25 p-2 text-left text-[10px] text-muted-foreground hover:bg-muted" onClick={draftFromPurpose}>✨ Draft from my purpose</button></div> : turns.map((turn, index) => <div key={`${turn.role}-${index}`} className={`whitespace-pre-wrap rounded-xl px-3 py-2 text-[11px] leading-relaxed ${turn.role === 'user' ? 'ml-5 bg-foreground text-background' : 'mr-2 border border-primary/15 bg-primary/[0.07]'}`}>{turn.content.replace(/```mission-section[\s\S]*?```/i, '').trim()}</div>)}</div><div className="mt-3 rounded-xl border border-border/70 bg-background p-2 focus-within:ring-2 focus-within:ring-primary/20"><textarea className="min-h-16 w-full resize-y bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void sendToArchitect(); } }} disabled={chatBusy} placeholder="Refine the bot…" /><div className="flex items-center justify-between border-t border-border/50 pt-2"><span className="text-[9px] text-muted-foreground">⌘/Ctrl + Enter</span><button type="button" aria-label="Send to Architect" className="button button-primary min-h-8 px-2.5 text-[11px]" onClick={() => void sendToArchitect()} disabled={chatBusy || !chatDraft.trim()}>{chatBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}Send</button></div></div>{chatError ? <p role="alert" className="mt-2 text-[10px] text-red-600 dark:text-red-300">{chatError}</p> : null}</div></div></aside>
  </div>;
}

function StepPanel({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return <section className="space-y-6"><div><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p></div><div className="space-y-5">{children}</div></section>;
}
