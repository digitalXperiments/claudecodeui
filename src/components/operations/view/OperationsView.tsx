import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bell,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Download,
  ExternalLink,
  Info,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  Users,
  Wrench,
  XCircle,
} from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';
import { Button } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import SecretRefPicker from '../../secrets/view/SecretRefPicker';

type OperationsSection = 'automation' | 'failover' | 'stack';

type ActionFormFields = {
  type?: string;
  name?: string;
  message?: string;
  provider?: string;
  prompt?: string;
  title?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  kind?: string;
  severity?: string;
};

type WorkflowStepForm = {
  localId: string;
  name: string;
  kind: 'action' | 'parallel' | 'branch';
  actionType: 'notify' | 'start_agent_run' | 'http_webhook_out' | 'create_interrupt' | 'noop';
  notifyTitle: string;
  notifyMessage: string;
  agentProvider: string;
  agentPrompt: string;
  agentTitle: string;
  webhookUrl: string;
  webhookMethod: string;
  webhookAuthHeader: string;
  interruptTitle: string;
  interruptBody: string;
  /** for parallel: localIds of steps that run together (or use next two action cards) */
  parallelOf: string[];
  branchPath: string;
  branchEquals: string;
  branchNextLocalId: string;
};

type AutomationRecipe = {
  recipe_id: string;
  name: string;
  enabled: boolean;
  project_id: string | null;
  trigger: { type: string; event?: string; cron?: string };
  conditions: unknown[];
  actions: ActionFormFields[];
  graph?: {
    version: 1;
    entry: string;
    steps: Array<{
      id: string;
      name: string;
      kind: 'action' | 'parallel' | 'branch';
      action?: ActionFormFields;
      parallel?: string[];
      branch?: Array<{ when: Array<{ path: string; equals?: unknown }>; next: string }>;
      next?: string | null;
      dependsOn?: string[];
    }>;
  } | null;
  retry?: { max?: number; backoffMs?: number };
  timeout_ms?: number | null;
};

type AutomationRunSummary = {
  automation_run_id: string;
  status: string | null;
  step_states?: Record<string, { status?: string; error?: string | null }>;
  started_at?: string | null;
  finished_at?: string | null;
};

type SwarmMember = {
  member_id: string;
  role: string;
  label: string | null;
  status: string;
  findings_summary: string | null;
  error?: string | null;
  run_id: string | null;
  provider?: string | null;
};

type SwarmRun = {
  swarm_id: string;
  goal: string;
  status: string;
  approval_status: string | null;
  findings: Array<{ role: string; summary: string }>;
  synthesis: {
    summary?: string;
    recommendations?: string[];
    risks?: string[];
    actionItems?: Array<{ title: string; prompt: string; priority?: string }>;
    createdTaskIds?: string[];
    tasksCreated?: number;
  } | null;
  members?: SwarmMember[];
  parent_run_id?: string | null;
  created_at?: string;
};

type FailoverPlaybook = {
  playbook_id: string;
  name: string;
  enabled: boolean;
  project_id: string | null;
  match: { providers?: string[]; errors?: string[] };
  strategy: {
    candidates: Array<{ provider: string; model?: string | null; profileId?: string | null }>;
    handoffMode: 'summary' | 'full' | 'fresh';
    attachContextPack?: boolean;
    maxFailovers: number;
  };
  approval: 'auto' | 'interrupt';
};

type StackCheck = {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
  fix?: string;
};

type StackDoctorReport = {
  ok: boolean;
  stackPath: string;
  generatedAt: string;
  checks: StackCheck[];
  interruptIds: string[];
};

type JsonRecord = Record<string, unknown>;

type RecipeFormState = {
  name: string;
  enabled: boolean;
  triggerType: 'manual' | 'cron' | 'kanban_event' | 'run_completed' | 'webhook_inbound' | 'interrupt_created';
  cron: string;
  schedulePreset: 'weekdays' | 'daily' | 'weekly' | 'custom';
  scheduleTime: string;
  triggerEvent: string;
  /** When false, only the first step is used as a single linear action (compat). */
  multiStep: boolean;
  steps: WorkflowStepForm[];
};

type PlaybookFormState = {
  name: string;
  enabled: boolean;
  matchProviders: string;
  matchErrors: string[];
  candidates: string;
  handoffMode: 'summary' | 'full' | 'fresh';
  attachContextPack: boolean;
  maxFailovers: number;
  approval: 'auto' | 'interrupt';
};

type StackFormState = {
  project: string;
  requiredProviders: string;
  optionalProviders: string;
  mcpNames: string;
  globalSkills: string;
  projectSkills: string;
};

const PROVIDER_OPTIONS = ['claude', 'codex', 'cursor', 'grok', 'opencode', 'kilo', 'cline', 'kimi', 'pi', 'omp'] as const;
const ERROR_OPTIONS = [
  { id: 'auth', label: 'Auth failure' },
  { id: 'rate_limit', label: 'Rate limit' },
  { id: 'timeout', label: 'Timeout' },
  { id: 'mcp_unhealthy', label: 'MCP unhealthy' },
  { id: 'any', label: 'Any error' },
] as const;

const fieldClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const textareaClass =
  'min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const labelClass = 'text-xs font-medium text-foreground';
const helpClass = 'text-[11px] text-muted-foreground';

let stepSeq = 0;
function newStepLocalId(): string {
  stepSeq += 1;
  return `step_${stepSeq}_${Date.now().toString(36)}`;
}

function defaultStepForm(partial?: Partial<WorkflowStepForm>): WorkflowStepForm {
  return {
    localId: newStepLocalId(),
    name: 'Do something',
    kind: 'action',
    actionType: 'notify',
    notifyTitle: 'Automation ran',
    notifyMessage: 'Recipe fired from CloudCLI',
    agentProvider: 'claude',
    agentPrompt: 'Summarize recent project activity.',
    agentTitle: 'Automated agent run',
    webhookUrl: '',
    webhookMethod: 'POST',
    webhookAuthHeader: '',
    interruptTitle: 'Needs attention',
    interruptBody: 'An automation recipe raised this interrupt.',
    parallelOf: [],
    branchPath: 'payload.ready',
    branchEquals: 'true',
    branchNextLocalId: '',
    ...partial,
  };
}

function defaultRecipeForm(): RecipeFormState {
  return {
    name: 'Project reminder',
    enabled: true,
    triggerType: 'manual',
    cron: '0 9 * * 1-5',
    schedulePreset: 'weekdays',
    scheduleTime: '09:00',
    triggerEvent: '',
    multiStep: false,
    steps: [defaultStepForm({ name: 'Notify' })],
  };
}

type AutomationStarter = {
  id: 'reminder' | 'ai_check' | 'send_to_app' | 'approval';
  label: string;
  description: string;
  icon: typeof Bell;
  name: string;
  actionType: WorkflowStepForm['actionType'];
};

const AUTOMATION_STARTERS: AutomationStarter[] = [
  {
    id: 'reminder',
    label: 'Remind me',
    description: 'Show me a notification at a time I choose.',
    icon: Bell,
    name: 'Regular reminder',
    actionType: 'notify',
  },
  {
    id: 'ai_check',
    label: 'Ask AI to help',
    description: 'Have an agent review or summarize this project.',
    icon: Bot,
    name: 'Project check-in',
    actionType: 'start_agent_run',
  },
  {
    id: 'send_to_app',
    label: 'Send to another app',
    description: 'Pass an update to a service outside CloudCLI.',
    icon: ExternalLink,
    name: 'Send project update',
    actionType: 'http_webhook_out',
  },
  {
    id: 'approval',
    label: 'Ask me first',
    description: 'Pause and ask for my attention before continuing.',
    icon: Info,
    name: 'Needs my attention',
    actionType: 'create_interrupt',
  },
];

function scheduleParts(cron: string): { preset: RecipeFormState['schedulePreset']; time: string } {
  const match = cron.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1|1-5)$/);
  if (!match) return { preset: 'custom', time: '09:00' };
  const minute = match[1].padStart(2, '0');
  const hour = match[2].padStart(2, '0');
  return {
    preset: match[3] === '1' ? 'weekly' : match[3] === '1-5' ? 'weekdays' : 'daily',
    time: `${hour}:${minute}`,
  };
}

function scheduleCron(form: RecipeFormState): string {
  if (form.schedulePreset === 'custom') return form.cron.trim();
  const [hour, minute] = form.scheduleTime.split(':').map(Number);
  const safeHour = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 9;
  const safeMinute = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  const days = form.schedulePreset === 'weekdays' ? '1-5' : form.schedulePreset === 'weekly' ? '1' : '*';
  return `${safeMinute} ${safeHour} * * ${days}`;
}

function triggerSummary(trigger: AutomationRecipe['trigger']): string {
  if (trigger.type === 'manual') return 'When you press “Try it now”';
  if (trigger.type === 'cron') {
    const parts = scheduleParts(trigger.cron ?? '');
    const label = parts.preset === 'weekdays' ? 'Every weekday' : parts.preset === 'daily' ? 'Every day' : parts.preset === 'weekly' ? 'Every Monday' : 'On a schedule';
    return `${label} at ${parts.time}`;
  }
  if (trigger.type === 'run_completed') return 'When an AI run finishes';
  if (trigger.type === 'webhook_inbound') return 'When an outside service sends an update';
  if (trigger.type === 'interrupt_created') return 'When CloudCLI needs your attention';
  if (trigger.type === 'kanban_event') return 'When something changes on the task board';
  return 'When this automation is triggered';
}

function actionSummary(action: ActionFormFields | undefined): string {
  switch (action?.type) {
    case 'start_agent_run': return 'Ask an AI agent to work on it';
    case 'http_webhook_out': return 'Send the update to another app';
    case 'create_interrupt': return 'Ask you to review it';
    case 'noop': return 'Do nothing';
    case 'notify':
    default: return 'Show you a notification';
  }
}

function stepActionPayload(step: WorkflowStepForm): ActionFormFields {
  switch (step.actionType) {
    case 'start_agent_run':
      return {
        type: 'start_agent_run',
        provider: step.agentProvider.trim() || 'claude',
        title: step.agentTitle.trim() || step.name,
        prompt: step.agentPrompt,
      };
    case 'http_webhook_out':
      return {
        type: 'http_webhook_out',
        url: step.webhookUrl.trim(),
        method: step.webhookMethod.trim() || 'POST',
        headers: step.webhookAuthHeader.trim()
          ? { Authorization: step.webhookAuthHeader.trim() }
          : {},
      };
    case 'create_interrupt':
      return {
        type: 'create_interrupt',
        name: step.interruptTitle.trim() || step.name,
        message: step.interruptBody,
        kind: 'automation',
        severity: 'warning',
      };
    case 'noop':
      return { type: 'noop' };
    case 'notify':
    default:
      return {
        type: 'notify',
        name: step.notifyTitle.trim() || step.name,
        message: step.notifyMessage,
      };
  }
}

function actionToStepFields(action: ActionFormFields, name: string): Partial<WorkflowStepForm> {
  const base: Partial<WorkflowStepForm> = {
    name,
    kind: 'action',
    actionType: (action.type as WorkflowStepForm['actionType']) || 'notify',
  };
  if (action.type === 'notify') {
    base.notifyTitle = typeof action.name === 'string' ? action.name : name;
    base.notifyMessage = typeof action.message === 'string' ? action.message : '';
  }
  if (action.type === 'start_agent_run') {
    base.agentProvider = typeof action.provider === 'string' ? action.provider : 'claude';
    base.agentPrompt = typeof action.prompt === 'string' ? action.prompt : '';
    base.agentTitle = typeof action.title === 'string' ? action.title : name;
  }
  if (action.type === 'http_webhook_out') {
    base.webhookUrl = typeof action.url === 'string' ? action.url : '';
    base.webhookMethod = typeof action.method === 'string' ? action.method : 'POST';
    if (action.headers && typeof action.headers === 'object') {
      base.webhookAuthHeader = String(
        action.headers.Authorization ?? action.headers.authorization ?? '',
      );
    }
  }
  if (action.type === 'create_interrupt') {
    base.interruptTitle = typeof action.name === 'string' ? action.name : name;
    base.interruptBody = typeof action.message === 'string' ? action.message : '';
  }
  return base;
}

function defaultPlaybookForm(): PlaybookFormState {
  return {
    name: 'Claude → Codex fallback',
    enabled: true,
    matchProviders: 'claude',
    matchErrors: ['auth', 'rate_limit', 'timeout'],
    candidates: 'codex',
    handoffMode: 'summary',
    attachContextPack: true,
    maxFailovers: 1,
    approval: 'interrupt',
  };
}

function defaultStackForm(projectName: string): StackFormState {
  return {
    project: projectName || 'project',
    requiredProviders: 'claude',
    optionalProviders: '',
    mcpNames: '',
    globalSkills: '',
    projectSkills: '',
  };
}

function parseCsv(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function recipeToForm(recipe: AutomationRecipe): RecipeFormState {
  const form = defaultRecipeForm();
  form.name = recipe.name;
  form.enabled = recipe.enabled;
  form.triggerType = (recipe.trigger?.type as RecipeFormState['triggerType']) || 'manual';
  form.cron = recipe.trigger?.cron || form.cron;
  if (recipe.trigger?.cron) {
    const schedule = scheduleParts(recipe.trigger.cron);
    form.schedulePreset = schedule.preset;
    form.scheduleTime = schedule.time;
  }
  form.triggerEvent = recipe.trigger?.event || form.triggerEvent;

  if (recipe.graph?.steps?.length) {
    form.multiStep = recipe.graph.steps.length > 1 || recipe.graph.steps.some((s) => s.kind !== 'action');
    const idToLocal = new Map<string, string>();
    form.steps = recipe.graph.steps.map((step) => {
      const localId = newStepLocalId();
      idToLocal.set(step.id, localId);
      const fields = step.action
        ? actionToStepFields(step.action, step.name)
        : { name: step.name, kind: step.kind };
      return defaultStepForm({
        localId,
        name: step.name,
        kind: step.kind,
        parallelOf: step.parallel ?? [],
        branchPath: step.branch?.[0]?.when?.[0]?.path ?? 'payload.ready',
        branchEquals: String(step.branch?.[0]?.when?.[0]?.equals ?? 'true'),
        branchNextLocalId: step.branch?.[0]?.next ?? '',
        ...fields,
      });
    });
    // rewrite parallel/branch refs to local ids when possible
    form.steps = form.steps.map((step) => ({
      ...step,
      parallelOf: step.parallelOf.map((id) => idToLocal.get(id) ?? id),
      branchNextLocalId: idToLocal.get(step.branchNextLocalId) ?? step.branchNextLocalId,
    }));
  } else {
    const action = recipe.actions?.[0] ?? {};
    form.multiStep = false;
    form.steps = [
      defaultStepForm({
        ...actionToStepFields(action, recipe.name),
        name: 'Step 1',
      }),
    ];
  }
  return form;
}

function formToRecipePayload(form: RecipeFormState, projectId: string): JsonRecord {
  const trigger: JsonRecord = { type: form.triggerType };
  if (form.triggerType === 'cron') trigger.cron = scheduleCron(form);
  if (form.triggerType === 'kanban_event' || form.triggerType === 'run_completed' || form.triggerType === 'interrupt_created') {
    trigger.event = form.triggerEvent.trim() || undefined;
  }

  const steps = form.steps.length > 0 ? form.steps : [defaultStepForm()];
  const linearActions = steps
    .filter((s) => s.kind === 'action')
    .map((s) => stepActionPayload(s));

  // Sequential multi-step: auto-wire next + dependsOn from card order
  if (form.multiStep && steps.length > 0) {
    const stableIds = steps.map((s, index) => `s${index + 1}`);
    const localToStable = new Map(steps.map((s, i) => [s.localId, stableIds[i]]));
    const graphSteps = steps.map((step, index) => {
      const id = stableIds[index];
      const nextId = index < steps.length - 1 ? stableIds[index + 1] : null;
      const base: JsonRecord = {
        id,
        name: step.name.trim() || `Step ${index + 1}`,
        kind: step.kind,
        next: step.kind === 'branch' ? null : nextId,
        dependsOn: index === 0 ? [] : [stableIds[index - 1]],
      };
      if (step.kind === 'action') {
        base.action = stepActionPayload(step);
      } else if (step.kind === 'parallel') {
        const children = step.parallelOf
          .map((localId) => localToStable.get(localId))
          .filter(Boolean) as string[];
        // fallback: next two action steps after this card are not siblings in list —
        // use explicitly picked; if empty, no-op children from following action cards named
        base.parallel = children.length > 0 ? children : [];
        if ((base.parallel as string[]).length === 0) {
          // pick following action steps until non-action or end (min 2 if available)
          const following = steps
            .slice(index + 1)
            .filter((s) => s.kind === 'action')
            .slice(0, 2)
            .map((s) => localToStable.get(s.localId)!)
            .filter(Boolean);
          base.parallel = following;
        }
      } else if (step.kind === 'branch') {
        let equals: unknown = step.branchEquals;
        if (step.branchEquals === 'true') equals = true;
        else if (step.branchEquals === 'false') equals = false;
        else if (/^-?\d+(\.\d+)?$/.test(step.branchEquals.trim())) equals = Number(step.branchEquals);
        const next =
          localToStable.get(step.branchNextLocalId) ||
          (index < steps.length - 1 ? stableIds[index + 1] : id);
        base.branch = [{ when: [{ path: step.branchPath || 'payload.ready', equals }], next }];
        base.next = nextId;
      }
      return base;
    });

    return {
      name: form.name.trim(),
      enabled: form.enabled,
      projectId,
      trigger,
      conditions: [],
      actions: linearActions.length > 0 ? linearActions : [{ type: 'noop' }],
      graph: {
        version: 1,
        entry: stableIds[0],
        steps: graphSteps,
      },
      retry: { max: 0 },
    };
  }

  const action = stepActionPayload(steps[0]);
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    projectId,
    trigger,
    conditions: [],
    actions: [action],
    graph: null,
    retry: { max: 0 },
  };
}

function playbookToForm(playbook: FailoverPlaybook): PlaybookFormState {
  return {
    name: playbook.name,
    enabled: playbook.enabled,
    matchProviders: (playbook.match.providers ?? []).join(', '),
    matchErrors: playbook.match.errors ?? [],
    candidates: (playbook.strategy.candidates ?? []).map((c) => c.provider).join(', '),
    handoffMode: playbook.strategy.handoffMode ?? 'summary',
    attachContextPack: Boolean(playbook.strategy.attachContextPack),
    maxFailovers: playbook.strategy.maxFailovers ?? 1,
    approval: playbook.approval ?? 'interrupt',
  };
}

function formToPlaybookPayload(form: PlaybookFormState, projectId: string): JsonRecord {
  const candidates = parseCsv(form.candidates).map((provider) => ({ provider }));
  if (candidates.length === 0) {
    throw new Error('Add at least one fallback provider (e.g. codex).');
  }
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    projectId,
    match: {
      providers: parseCsv(form.matchProviders),
      errors: form.matchErrors,
    },
    strategy: {
      candidates,
      handoffMode: form.handoffMode,
      attachContextPack: form.attachContextPack,
      maxFailovers: Math.max(1, Number(form.maxFailovers) || 1),
    },
    approval: form.approval,
  };
}

function stackToForm(config: JsonRecord, fallbackName: string): StackFormState {
  const providers = (config.providers ?? {}) as { required?: string[]; optional?: string[] };
  const mcp = Array.isArray(config.mcp) ? config.mcp as Array<{ name?: string }> : [];
  const skills = (config.skills ?? {}) as { global?: string[]; project?: string[] };
  return {
    project: typeof config.project === 'string' && config.project ? config.project : fallbackName,
    requiredProviders: (providers.required ?? []).join(', '),
    optionalProviders: (providers.optional ?? []).join(', '),
    mcpNames: mcp.map((entry) => entry.name).filter(Boolean).join(', '),
    globalSkills: (skills.global ?? []).join(', '),
    projectSkills: (skills.project ?? []).join(', '),
  };
}

function formToStackConfig(form: StackFormState): JsonRecord {
  return {
    version: 1,
    project: form.project.trim() || 'project',
    providers: {
      required: parseCsv(form.requiredProviders),
      optional: parseCsv(form.optionalProviders),
    },
    mcp: parseCsv(form.mcpNames).map((name) => ({ name, enabledFor: ['*'] })),
    skills: {
      global: parseCsv(form.globalSkills),
      project: parseCsv(form.projectSkills),
    },
  };
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, options);
  let payload: JsonRecord = {};
  try {
    payload = (await response.json()) as JsonRecord;
  } catch {
    // status below still useful
  }

  if (!response.ok) {
    const error = payload.error;
    const message = typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : typeof payload.message === 'string' ? payload.message : '';
    throw new Error(message || `Request failed (${response.status})`);
  }

  return payload as T;
}

function Feedback({ message, error = false }: { message: string | null; error?: boolean }) {
  if (!message) return null;
  return (
    <div className={`rounded-md border p-2 text-xs ${error ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'}`}>
      {message}
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className={labelClass}>{label}</span>
      {children}
      {help ? <span className={helpClass}>{help}</span> : null}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-input"
      />
      {label}
    </label>
  );
}

function StepActionFields({
  step,
  onChange,
}: {
  step: WorkflowStepForm;
  onChange: (patch: Partial<WorkflowStepForm>) => void;
}) {
  if (step.kind !== 'action') return null;
  return (
    <div className="space-y-2">
      <Field label="Choose what to do">
        <select
          className={fieldClass}
          value={step.actionType}
          onChange={(e) => onChange({ actionType: e.target.value as WorkflowStepForm['actionType'] })}
        >
          <option value="notify">Send a notification</option>
          <option value="start_agent_run">Ask an AI agent to help</option>
          <option value="http_webhook_out">Send an update to another app</option>
          <option value="create_interrupt">Ask me to review something</option>
          <option value="noop">Just test the trigger</option>
        </select>
      </Field>
      {step.actionType === 'notify' ? (
        <>
          <Field label="Title">
            <input className={fieldClass} value={step.notifyTitle} onChange={(e) => onChange({ notifyTitle: e.target.value })} />
          </Field>
          <Field label="What should it say?">
            <textarea className={textareaClass} value={step.notifyMessage} onChange={(e) => onChange({ notifyMessage: e.target.value })} />
          </Field>
        </>
      ) : null}
      {step.actionType === 'start_agent_run' ? (
        <>
          <Field label="Which AI should help?">
            <select className={fieldClass} value={step.agentProvider} onChange={(e) => onChange({ agentProvider: e.target.value })}>
              {PROVIDER_OPTIONS.map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
          </Field>
          <Field label="What should the AI call this?">
            <input className={fieldClass} value={step.agentTitle} onChange={(e) => onChange({ agentTitle: e.target.value })} />
          </Field>
          <Field label="What should the AI do?" help="Describe the task in everyday language.">
            <textarea className={textareaClass} value={step.agentPrompt} onChange={(e) => onChange({ agentPrompt: e.target.value })} />
          </Field>
        </>
      ) : null}
      {step.actionType === 'http_webhook_out' ? (
        <>
          <Field label="Where should the update go?" help="Paste the link provided by the other app.">
            <input className={fieldClass} value={step.webhookUrl} onChange={(e) => onChange({ webhookUrl: e.target.value })} placeholder="https://…" />
          </Field>
          <Field label="Connection type">
            <select className={fieldClass} value={step.webhookMethod} onChange={(e) => onChange({ webhookMethod: e.target.value })}>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="GET">GET</option>
            </select>
          </Field>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className={labelClass}>Extra access key (optional)</span>
              <SecretRefPicker label="Use secret" onPick={(ref) => onChange({ webhookAuthHeader: `Bearer ${ref}` })} />
            </div>
            <input
              className={fieldClass}
              value={step.webhookAuthHeader}
              onChange={(e) => onChange({ webhookAuthHeader: e.target.value })}
              placeholder={'Bearer ${secret:WEBHOOK_TOKEN}'}
            />
          </div>
        </>
      ) : null}
      {step.actionType === 'create_interrupt' ? (
        <>
          <Field label="Title">
            <input className={fieldClass} value={step.interruptTitle} onChange={(e) => onChange({ interruptTitle: e.target.value })} />
          </Field>
          <Field label="Details">
            <textarea className={textareaClass} value={step.interruptBody} onChange={(e) => onChange({ interruptBody: e.target.value })} />
          </Field>
        </>
      ) : null}
    </div>
  );
}

function AutomationPanel({ projectId }: { projectId: string }) {
  const [recipes, setRecipes] = useState<AutomationRecipe[]>([]);
  const [form, setForm] = useState<RecipeFormState>(() => defaultRecipeForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRuns, setLastRuns] = useState<Record<string, AutomationRunSummary | null>>({});

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await requestJson<{ recipes?: AutomationRecipe[] }>(`/api/automation/recipes?projectId=${encodeURIComponent(projectId)}`);
      const list = Array.isArray(payload.recipes) ? payload.recipes : [];
      setRecipes(list);
      const runsEntries = await Promise.all(
        list.slice(0, 12).map(async (recipe) => {
          try {
            const runsPayload = await requestJson<{ runs?: AutomationRunSummary[] }>(
              `/api/automation/recipes/${encodeURIComponent(recipe.recipe_id)}/runs?limit=1`,
            );
            return [recipe.recipe_id, runsPayload.runs?.[0] ?? null] as const;
          } catch {
            return [recipe.recipe_id, null] as const;
          }
        }),
      );
      setLastRuns(Object.fromEntries(runsEntries));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load automations.');
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const patch = <K extends keyof RecipeFormState>(key: K, value: RecipeFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const patchStep = (localId: string, partial: Partial<WorkflowStepForm>) => {
    setForm((prev) => ({
      ...prev,
      steps: prev.steps.map((step) => (step.localId === localId ? { ...step, ...partial } : step)),
    }));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setForm((prev) => {
      const next = [...prev.steps];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...prev, steps: next };
    });
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      if (!form.name.trim()) throw new Error('Give this automation a name.');
      for (const step of form.steps) {
        if (step.kind === 'action' && step.actionType === 'http_webhook_out' && !step.webhookUrl.trim()) {
          throw new Error(`Webhook URL is required for step “${step.name}”.`);
        }
      }
      const input = formToRecipePayload(form, projectId);
      const payload = await requestJson<{ recipe?: AutomationRecipe }>(
        editingId ? `/api/automation/recipes/${encodeURIComponent(editingId)}` : '/api/automation/recipes',
        { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(input) },
      );
      setMessage(`${editingId ? 'Updated' : 'Created'} “${payload.recipe?.name ?? form.name}”.`);
      setEditingId(null);
      setForm(defaultRecipeForm());
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the automation.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (recipe: AutomationRecipe) => {
    if (!window.confirm(`Delete automation “${recipe.name}”?`)) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await requestJson(`/api/automation/recipes/${encodeURIComponent(recipe.recipe_id)}`, { method: 'DELETE' });
      if (editingId === recipe.recipe_id) {
        setEditingId(null);
        setForm(defaultRecipeForm());
      }
      setMessage(`Deleted “${recipe.name}”.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the automation.');
    } finally {
      setBusy(false);
    }
  };

  const run = async (recipe: AutomationRecipe) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = await requestJson<{ results?: unknown[] }>(`/api/automation/recipes/${encodeURIComponent(recipe.recipe_id)}/run`, {
        method: 'POST',
        body: JSON.stringify({ projectId, payload: { source: 'operations-ui', firedAt: new Date().toISOString(), ready: true } }),
      });
      setMessage(`Tried “${recipe.name}”. ${payload.results?.length ?? 0} action${payload.results?.length === 1 ? '' : 's'} completed.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not run the automation.');
    } finally {
      setBusy(false);
    }
  };

  const applyStarter = (starter: AutomationStarter) => {
    const triggerType: RecipeFormState['triggerType'] =
      starter.id === 'reminder'
        ? 'cron'
        : starter.id === 'approval'
            ? 'run_completed'
            : 'manual';
    setEditingId(null);
    setMessage(null);
    setError(null);
    setForm({
      ...defaultRecipeForm(),
      name: starter.name,
      triggerType,
      steps: [defaultStepForm({
        name: starter.label,
        actionType: starter.actionType,
      })],
      multiStep: false,
    });
  };

  const addAction = () => {
    setForm((prev) => ({
      ...prev,
      multiStep: true,
      steps: [...prev.steps, defaultStepForm({ name: `Action ${prev.steps.length + 1}` })],
    }));
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(300px,0.85fr)_minmax(0,1.15fr)]">
      <div className="border-b border-border/60 p-4 lg:border-b-0 lg:border-r">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Your automations</h3>
            <p className={helpClass}>Saved instructions that make this project do routine work for you.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={busy} aria-label="Refresh automations">
            <RefreshCw className={busy ? 'animate-spin' : ''} />
          </Button>
        </div>
        {recipes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-5 text-center">
            <Sparkles className="mx-auto mb-2 h-5 w-5 text-primary" />
            <p className="text-sm font-medium text-foreground">Nothing automated yet</p>
            <p className={`${helpClass} mt-1`}>Pick a starting point on the right. You can change it later.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {recipes.map((recipe) => {
              const last = lastRuns[recipe.recipe_id];
              const firstAction = recipe.graph?.steps.find((step) => step.kind === 'action')?.action ?? recipe.actions?.[0];
              const stepCount = recipe.graph?.steps?.length ?? recipe.actions?.length ?? 0;
              const lastStatus = last?.status === 'succeeded' ? 'Completed' : last?.status === 'failed' ? 'Needs attention' : last?.status === 'running' ? 'Running' : last?.status;
              return (
                <div key={recipe.recipe_id} className="rounded-lg border border-border/60 p-3 transition-colors hover:border-primary/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{recipe.name}</div>
                      <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                        <div className="flex items-start gap-1.5"><CalendarDays className="mt-0.5 h-3 w-3 shrink-0" /><span>{triggerSummary(recipe.trigger)}</span></div>
                        <div className="flex items-start gap-1.5"><ChevronRight className="mt-0.5 h-3 w-3 shrink-0" /><span>{actionSummary(firstAction)}{stepCount > 1 ? `, then ${stepCount - 1} more` : ''}</span></div>
                      </div>
                      {lastStatus ? <div className={`mt-2 text-[10px] ${last?.status === 'failed' ? 'text-red-400' : 'text-muted-foreground'}`}>Last try: {lastStatus}</div> : null}
                    </div>
                    <span className={`shrink-0 text-[11px] ${recipe.enabled ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                      {recipe.enabled ? 'Active' : 'Paused'}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => void run(recipe)} disabled={busy}><Play />Try it now</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditingId(recipe.recipe_id); setForm(recipeToForm(recipe)); setMessage(null); setError(null); }} disabled={busy}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(recipe)} disabled={busy} aria-label={`Delete ${recipe.name}`}><Trash2 /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-4 p-4">
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <div>
              <h3 className="text-base font-semibold text-foreground">Make this project do things for you</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Choose what you want to happen. We’ll take care of the technical setup.</p>
            </div>
          </div>
        </div>

        {!editingId ? (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-foreground">Start with a common task</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {AUTOMATION_STARTERS.map((starter) => {
                const Icon = starter.icon;
                return (
                  <button
                    key={starter.id}
                    type="button"
                    onClick={() => applyStarter(starter)}
                    className="flex items-start gap-3 rounded-lg border border-border/70 bg-background p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-foreground">{starter.label}</span>
                      <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{starter.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">1</span>
              <h3 className="text-sm font-semibold text-foreground">When should this happen?</h3>
            </div>
            <p className={`${helpClass} mt-1 pl-7`}>Choose the event that should start this automation.</p>
          </div>
          {editingId ? (
            <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setForm(defaultRecipeForm()); }}>
              <Plus className="h-3.5 w-3.5" /> New
            </Button>
          ) : null}
        </div>

        <div className="rounded-lg border border-border/60 p-4 space-y-3">
          <Field label="Start it…">
            <select className={fieldClass} value={form.triggerType} onChange={(e) => patch('triggerType', e.target.value as RecipeFormState['triggerType'])}>
              <option value="manual">When I press “Try it now”</option>
              <option value="cron">On a regular schedule</option>
              <option value="kanban_event">When a task changes on the board</option>
              <option value="run_completed">When an AI run finishes</option>
              <option value="webhook_inbound">When another app sends an update</option>
              <option value="interrupt_created">When CloudCLI needs my attention</option>
            </select>
          </Field>
          {form.triggerType === 'cron' ? (
            <div className="grid gap-3 sm:grid-cols-[1.3fr_0.7fr]">
              <Field label="How often">
                <select className={fieldClass} value={form.schedulePreset} onChange={(e) => patch('schedulePreset', e.target.value as RecipeFormState['schedulePreset'])}>
                  <option value="weekdays">Every weekday</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every Monday</option>
                  <option value="custom">A custom schedule</option>
                </select>
              </Field>
              {form.schedulePreset === 'custom' ? (
                <Field label="Schedule code" help="For advanced users">
                  <input className={`${fieldClass} font-mono text-xs`} value={form.cron} onChange={(e) => patch('cron', e.target.value)} placeholder="0 9 * * 1-5" />
                </Field>
              ) : (
                <Field label="At what time">
                  <input className={fieldClass} type="time" value={form.scheduleTime} onChange={(e) => patch('scheduleTime', e.target.value)} />
                </Field>
              )}
            </div>
          ) : null}
          {form.triggerType === 'kanban_event' ? (
            <Field label="Which change?" help="Choose the board event that should start this automation.">
              <select className={fieldClass} value={form.triggerEvent} onChange={(e) => patch('triggerEvent', e.target.value)}>
                <option value="">Any task change</option>
                <option value="task.done">When a task is completed</option>
                <option value="task.failed">When a task fails</option>
                <option value="task.aborted">When a task is stopped</option>
              </select>
            </Field>
          ) : null}
        </div>

        <div className="rounded-lg border border-border/60 p-4 space-y-3">
          <div className="flex items-start gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">2</span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">What should CloudCLI do?</h3>
              <p className={`${helpClass} mt-1`}>Start with one action. You can add more later if you need them.</p>
            </div>
          </div>

          {form.steps.map((step, index) => (
            <div key={step.localId} className="rounded-lg border border-border/50 bg-muted/10 p-3 space-y-3">
              {form.multiStep ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold text-muted-foreground">Action {index + 1}</span>
                  <input
                    className={`${fieldClass} min-w-[10rem] flex-1`}
                    value={step.name}
                    onChange={(e) => patchStep(step.localId, { name: e.target.value })}
                    placeholder="Name this action"
                  />
                  <select
                    className={fieldClass}
                    value={step.kind}
                    onChange={(e) => patchStep(step.localId, { kind: e.target.value as WorkflowStepForm['kind'] })}
                    aria-label="Action type"
                  >
                    <option value="action">Do this</option>
                    <option value="parallel">Run several together</option>
                    <option value="branch">Choose based on a condition</option>
                  </select>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={index === 0 || busy} onClick={() => moveStep(index, -1)} aria-label="Move action up"><ArrowUp className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" disabled={index === form.steps.length - 1 || busy} onClick={() => moveStep(index, 1)} aria-label="Move action down"><ArrowDown className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" disabled={form.steps.length <= 1 || busy} onClick={() => setForm((prev) => ({ ...prev, steps: prev.steps.filter((s) => s.localId !== step.localId) }))} aria-label="Remove action"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              ) : null}

              {step.kind === 'action' ? <StepActionFields step={step} onChange={(partial) => patchStep(step.localId, partial)} /> : null}
              {step.kind === 'parallel' ? (
                <div className="space-y-2">
                  <p className={helpClass}>Choose the actions that should happen at the same time.</p>
                  <div className="flex flex-wrap gap-2">
                    {form.steps.filter((s) => s.localId !== step.localId && s.kind === 'action').map((candidate) => {
                      const checked = step.parallelOf.includes(candidate.localId);
                      return <label key={candidate.localId} className="flex items-center gap-1.5 rounded border border-border/60 px-2 py-1 text-xs"><input type="checkbox" checked={checked} onChange={() => patchStep(step.localId, { parallelOf: checked ? step.parallelOf.filter((id) => id !== candidate.localId) : [...step.parallelOf, candidate.localId] })} />{candidate.name}</label>;
                    })}
                  </div>
                </div>
              ) : null}
              {step.kind === 'branch' ? (
                <div className="grid gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 sm:grid-cols-3">
                  <Field label="Advanced: check this value"><input className={fieldClass} value={step.branchPath} onChange={(e) => patchStep(step.localId, { branchPath: e.target.value })} placeholder="payload.ready" /></Field>
                  <Field label="It should equal"><input className={fieldClass} value={step.branchEquals} onChange={(e) => patchStep(step.localId, { branchEquals: e.target.value })} placeholder="true" /></Field>
                  <Field label="Then continue with"><select className={fieldClass} value={step.branchNextLocalId} onChange={(e) => patchStep(step.localId, { branchNextLocalId: e.target.value })}><option value="">The next action</option>{form.steps.filter((s) => s.localId !== step.localId).map((s) => <option key={s.localId} value={s.localId}>{s.name}</option>)}</select></Field>
                </div>
              ) : null}
            </div>
          ))}

          {!form.multiStep ? (
            <button type="button" onClick={addAction} className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"><Plus className="h-3.5 w-3.5" /> Add another action</button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setForm((prev) => ({ ...prev, steps: [...prev.steps, defaultStepForm({ name: `Action ${prev.steps.length + 1}` })] }))}><Plus className="h-3.5 w-3.5" /> Add action</Button>
          )}
        </div>

        <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
          <Field label="Give this automation a name" help="Use words you’ll recognize later, like “Morning project check”.">
            <input className={fieldClass} value={form.name} onChange={(e) => patch('name', e.target.value)} placeholder="Morning project check" />
          </Field>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <Toggle checked={form.enabled} onChange={(value) => patch('enabled', value)} label="Turn it on immediately" />
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Sparkles className="h-3.5 w-3.5" />{triggerSummary({ type: form.triggerType, cron: form.triggerType === 'cron' ? scheduleCron(form) : undefined })} → {actionSummary(stepActionPayload(form.steps[0]))}</div>
          </div>
        </div>

        <Feedback message={error} error />
        <Feedback message={message} />
        <Button onClick={() => void save()} disabled={busy} className="w-full sm:w-auto">
          <Save />{busy ? 'Saving…' : editingId ? 'Save changes' : 'Save automation'}
        </Button>
      </div>
    </div>
  );
}

function SwarmPanel({ projectId }: { projectId: string }) {
  const ROLE_OPTIONS = [
    { id: 'planner', label: 'Planner' },
    { id: 'implementer', label: 'Implementer' },
    { id: 'tester', label: 'Tester' },
    { id: 'security', label: 'Security' },
    { id: 'docs', label: 'Docs' },
  ] as const;

  const PROVIDER_OPTIONS = ['claude', 'codex', 'cursor', 'grok', 'opencode', 'kilo', 'cline', 'kimi', 'pi', 'omp'] as const;

  const [goal, setGoal] = useState('Review recent changes for safety and completeness');
  const [roles, setRoles] = useState<string[]>(ROLE_OPTIONS.map((r) => r.id));
  const [provider, setProvider] = useState('claude');
  const [requireApproval, setRequireApproval] = useState(true);
  const [swarms, setSwarms] = useState<SwarmRun[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasActive = useMemo(
    () =>
      swarms.some((s) =>
        ['queued', 'running', 'synthesizing'].includes(s.status),
      ),
    [swarms],
  );

  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setRefreshing(true);
    try {
      const payload = await requestJson<{ swarms?: SwarmRun[] }>(
        `/api/swarm?projectId=${encodeURIComponent(projectId)}`,
      );
      setSwarms(Array.isArray(payload.swarms) ? payload.swarms : []);
    } catch (caught) {
      if (!opts?.quiet) {
        setError(caught instanceof Error ? caught.message : 'Could not load swarms.');
      }
    } finally {
      if (!opts?.quiet) setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live poll while any swarm is still running agents / synthesizing.
  useEffect(() => {
    if (!hasActive) return;
    const id = window.setInterval(() => {
      void refresh({ quiet: true });
    }, 2500);
    return () => window.clearInterval(id);
  }, [hasActive, refresh]);

  const toggleRole = (id: string) => {
    setRoles((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
  };

  const start = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      if (!goal.trim()) throw new Error('Describe the review goal.');
      if (roles.length === 0) throw new Error('Pick at least one role.');
      if (!provider.trim()) throw new Error('Pick a provider — each role runs a real agent.');
      const payload = await requestJson<{ swarm?: SwarmRun }>('/api/swarm', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          goal: goal.trim(),
          requireApproval,
          provider: provider.trim(),
          roles: roles.map((role) => ({
            role,
            label: ROLE_OPTIONS.find((r) => r.id === role)?.label ?? role,
            provider: provider.trim(),
          })),
        }),
      });
      setMessage(
        `Started real multi-agent review — ${roles.length} role run(s) via ${provider}. Watch progress below (and in Run Observatory).`,
      );
      setExpanded(payload.swarm?.swarm_id ?? null);
      await refresh({ quiet: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start swarm.');
    } finally {
      setBusy(false);
    }
  };

  const act = async (swarmId: string, action: 'approve' | 'reject') => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = await requestJson<{ swarm?: SwarmRun }>(
        `/api/swarm/${encodeURIComponent(swarmId)}/${action}`,
        { method: 'POST', body: '{}' },
      );
      if (action === 'approve') {
        const n = payload.swarm?.synthesis?.tasksCreated
          ?? payload.swarm?.synthesis?.createdTaskIds?.length
          ?? 0;
        setMessage(
          n > 0
            ? `Approved. Created ${n} Kanban backlog task${n === 1 ? '' : 's'} from the review.`
            : 'Approved. No action items to turn into tasks.',
        );
      } else {
        setMessage('Rejected — no tasks created.');
      }
      await refresh({ quiet: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${action} swarm.`);
    } finally {
      setBusy(false);
    }
  };

  const statusTone = (status: string) => {
    if (status === 'succeeded' || status === 'approved') return 'text-emerald-600 dark:text-emerald-400';
    if (status === 'failed' || status === 'rejected') return 'text-destructive';
    if (status === 'awaiting_approval') return 'text-amber-600 dark:text-amber-400';
    if (status === 'running' || status === 'synthesizing' || status === 'queued') {
      return 'text-sky-600 dark:text-sky-400';
    }
    return 'text-muted-foreground';
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
      <div className="space-y-4 border-b border-border/60 p-4 lg:border-b-0 lg:border-r">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Start review swarm</h3>
          <p className={helpClass}>
            Launches real headless agent runs (one per role) against this project. They inspect git/code,
            return findings, then a synthesis agent merges them. Approve creates Kanban backlog tasks.
          </p>
        </div>
        <Field label="Goal">
          <textarea className={textareaClass} value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} />
        </Field>
        <div className="space-y-1">
          <span className={labelClass}>Roles</span>
          <div className="flex flex-wrap gap-2">
            {ROLE_OPTIONS.map((option) => (
              <label key={option.id} className="flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs">
                <input type="checkbox" checked={roles.includes(option.id)} onChange={() => toggleRole(option.id)} />
                {option.label}
              </label>
            ))}
          </div>
        </div>
        <Field label="Provider">
          <select className={fieldClass} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <p className={`${helpClass} mt-1`}>Each role uses this agent. Must be authenticated in Settings.</p>
        </Field>
        <Toggle
          checked={requireApproval}
          onChange={setRequireApproval}
          label="Require approval before creating Kanban tasks"
        />
        <Feedback message={error} error />
        <Feedback message={message} />
        <Button onClick={() => void start()} disabled={busy}>
          <Users />{busy ? 'Starting…' : 'Start swarm'}
        </Button>
      </div>

      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Recent swarms</h3>
            <p className={helpClass}>
              Live agent progress · parent runs in Observatory (source: Review swarm)
              {hasActive ? ' · auto-refreshing…' : ''}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh swarms">
            <RefreshCw className={refreshing || hasActive ? 'animate-spin' : ''} />
          </Button>
        </div>
        {swarms.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No review swarms yet. Start one — agents will actually run.
          </div>
        ) : (
          <div className="space-y-2">
            {swarms.map((swarm) => {
              const open = expanded === swarm.swarm_id;
              const tasksCreated = swarm.synthesis?.tasksCreated
                ?? swarm.synthesis?.createdTaskIds?.length
                ?? 0;
              return (
                <div key={swarm.swarm_id} className="rounded-md border border-border/60 p-3">
                  <button
                    type="button"
                    className="flex w-full items-start justify-between gap-2 text-left"
                    onClick={() => setExpanded(open ? null : swarm.swarm_id)}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{swarm.goal}</div>
                      <div className={`mt-1 text-[11px] ${statusTone(swarm.status)}`}>
                        {swarm.status}
                        {swarm.approval_status ? ` · approval: ${swarm.approval_status}` : ''}
                        {tasksCreated > 0 ? ` · ${tasksCreated} task(s) created` : ''}
                        {swarm.parent_run_id ? ` · ${swarm.parent_run_id}` : ''}
                      </div>
                    </div>
                    <span className="text-[11px] text-muted-foreground">{open ? 'Hide' : 'Show'}</span>
                  </button>
                  {open ? (
                    <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                      {(swarm.members ?? []).map((member) => (
                        <div key={member.member_id} className="rounded border border-border/40 p-2">
                          <div className="flex items-center justify-between gap-2 text-xs font-medium">
                            <span>
                              {member.label || member.role}
                              {member.provider ? (
                                <span className="ml-1 font-normal text-muted-foreground">({member.provider})</span>
                              ) : null}
                            </span>
                            <span className={statusTone(member.status)}>
                              {member.status === 'running' || member.status === 'queued' ? (
                                <span className="inline-flex items-center gap-1">
                                  <RefreshCw className="h-3 w-3 animate-spin" />
                                  {member.status}
                                </span>
                              ) : (
                                member.status
                              )}
                            </span>
                          </div>
                          {member.error ? (
                            <p className="mt-1 text-[11px] leading-relaxed text-destructive">{member.error}</p>
                          ) : null}
                          {member.findings_summary ? (
                            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
                              {member.findings_summary}
                            </p>
                          ) : member.status === 'running' || member.status === 'queued' ? (
                            <p className="mt-1 text-[11px] text-muted-foreground">Agent is working on this role…</p>
                          ) : null}
                        </div>
                      ))}
                      {swarm.status === 'synthesizing' ? (
                        <div className="rounded border border-sky-500/20 bg-sky-500/5 p-2 text-[11px] text-sky-700 dark:text-sky-300">
                          <span className="inline-flex items-center gap-1.5">
                            <RefreshCw className="h-3 w-3 animate-spin" />
                            Synthesis agent is combining role findings…
                          </span>
                        </div>
                      ) : null}
                      {swarm.synthesis?.summary ? (
                        <div className="rounded border border-emerald-500/20 bg-emerald-500/5 p-2 text-[11px] text-foreground">
                          <div className="font-medium">Synthesis</div>
                          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{swarm.synthesis.summary}</p>
                          {swarm.synthesis.risks?.length ? (
                            <div className="mt-2">
                              <div className="font-medium text-amber-700 dark:text-amber-400">Risks</div>
                              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                                {swarm.synthesis.risks.map((item) => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {swarm.synthesis.recommendations?.length ? (
                            <div className="mt-2">
                              <div className="font-medium">Recommendations</div>
                              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                                {swarm.synthesis.recommendations.map((item) => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {swarm.synthesis.actionItems?.length ? (
                            <div className="mt-2">
                              <div className="font-medium">Action items (become Kanban tasks on approve)</div>
                              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                                {swarm.synthesis.actionItems.map((item) => (
                                  <li key={item.title}>
                                    <span className="font-medium text-foreground">{item.title}</span>
                                    {item.priority ? (
                                      <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                                        {item.priority}
                                      </span>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {tasksCreated > 0 ? (
                            <p className="mt-2 text-emerald-700 dark:text-emerald-400">
                              {tasksCreated} Kanban backlog task{tasksCreated === 1 ? '' : 's'} created.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      {swarm.status === 'awaiting_approval' ? (
                        <div className="space-y-2">
                          <p className={helpClass}>
                            Approve creates backlog tasks from the action items above. Reject discards them.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" onClick={() => void act(swarm.swarm_id, 'approve')} disabled={busy}>
                              <CheckCircle2 /> Approve & create tasks
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void act(swarm.swarm_id, 'reject')} disabled={busy}>
                              <XCircle /> Reject
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FailoverPanel({ projectId }: { projectId: string }) {
  const [playbooks, setPlaybooks] = useState<FailoverPlaybook[]>([]);
  const [form, setForm] = useState<PlaybookFormState>(() => defaultPlaybookForm());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runId, setRunId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await requestJson<{ playbooks?: FailoverPlaybook[] }>(`/api/failover-playbooks?projectId=${encodeURIComponent(projectId)}`);
      setPlaybooks(Array.isArray(payload.playbooks) ? payload.playbooks : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load failover rules.');
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const patch = <K extends keyof PlaybookFormState>(key: K, value: PlaybookFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleError = (id: string) => {
    setForm((prev) => ({
      ...prev,
      matchErrors: prev.matchErrors.includes(id)
        ? prev.matchErrors.filter((entry) => entry !== id)
        : [...prev.matchErrors, id],
    }));
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      if (!form.name.trim()) throw new Error('Give this failover rule a name.');
      const input = formToPlaybookPayload(form, projectId);
      const payload = await requestJson<{ playbook?: FailoverPlaybook }>(
        editingId ? `/api/failover-playbooks/${encodeURIComponent(editingId)}` : '/api/failover-playbooks',
        { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(input) },
      );
      setMessage(`${editingId ? 'Updated' : 'Created'} “${payload.playbook?.name ?? form.name}”.`);
      setEditingId(null);
      setForm(defaultPlaybookForm());
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the failover rule.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (playbook: FailoverPlaybook) => {
    if (!window.confirm(`Delete failover rule “${playbook.name}”?`)) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await requestJson(`/api/failover-playbooks/${encodeURIComponent(playbook.playbook_id)}`, { method: 'DELETE' });
      if (editingId === playbook.playbook_id) {
        setEditingId(null);
        setForm(defaultPlaybookForm());
      }
      setMessage(`Deleted “${playbook.name}”.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the failover rule.');
    } finally {
      setBusy(false);
    }
  };

  const trigger = async (playbook: FailoverPlaybook) => {
    const targetRunId = runId.trim();
    if (!targetRunId) {
      setError('Enter a failed run ID first (Source Control → Runs).');
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = await requestJson<{ status?: string; childRunId?: string; interruptId?: string }>(`/api/runs/${encodeURIComponent(targetRunId)}/failover`, {
        method: 'POST',
        body: JSON.stringify({ playbookId: playbook.playbook_id }),
      });
      setMessage(payload.status === 'approval_pending'
        ? `Waiting for your approval${payload.interruptId ? ` (${payload.interruptId})` : ''}.`
        : `Failover started${payload.childRunId ? ` as ${payload.childRunId}` : ''}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not trigger failover.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
      <div className="border-b border-border/60 p-4 lg:border-b-0 lg:border-r">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Failover rules</h3>
            <p className={helpClass}>If a provider fails, try the next one in order.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={busy} aria-label="Refresh failover rules">
            <RefreshCw className={busy ? 'animate-spin' : ''} />
          </Button>
        </div>
        {playbooks.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No failover rules yet.
          </div>
        ) : (
          <div className="space-y-2">
            {playbooks.map((playbook) => (
              <div key={playbook.playbook_id} className="rounded-md border border-border/60 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">{playbook.name}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {(playbook.strategy.candidates ?? []).map((c) => c.provider).join(' → ') || 'No fallback'}
                      {' · '}
                      {playbook.approval === 'auto' ? 'automatic' : 'ask first'}
                    </div>
                  </div>
                  <span className={`text-[11px] ${playbook.enabled ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                    {playbook.enabled ? 'On' : 'Off'}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => void trigger(playbook)} disabled={busy}><ShieldAlert />Try now</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditingId(playbook.playbook_id); setForm(playbookToForm(playbook)); setMessage(null); setError(null); }} disabled={busy}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(playbook)} disabled={busy}><Trash2 /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 space-y-1">
          <label className={labelClass} htmlFor="failover-run-id">Failed run ID (for “Try now”)</label>
          <input id="failover-run-id" value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="run_…" className={`${fieldClass} font-mono text-xs`} />
          <p className={helpClass}>Copy from Source Control → Runs after a failed agent run.</p>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{editingId ? 'Edit failover rule' : 'New failover rule'}</h3>
            <p className={helpClass}>Pick which failures match and which providers to try next.</p>
          </div>
          {editingId ? (
            <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setForm(defaultPlaybookForm()); }}>
              <Plus className="h-3.5 w-3.5" /> New
            </Button>
          ) : null}
        </div>

        <Field label="Name">
          <input className={fieldClass} value={form.name} onChange={(e) => patch('name', e.target.value)} />
        </Field>
        <Toggle checked={form.enabled} onChange={(value) => patch('enabled', value)} label="Enabled" />

        <div className="rounded-md border border-border/60 p-3 space-y-3">
          <h4 className="text-xs font-semibold text-foreground">When a run fails…</h4>
          <Field label="Primary providers to watch" help="Comma-separated, e.g. claude, cursor. Leave blank for any.">
            <input className={fieldClass} value={form.matchProviders} onChange={(e) => patch('matchProviders', e.target.value)} placeholder="claude" />
          </Field>
          <div className="space-y-1">
            <span className={labelClass}>Error types</span>
            <div className="flex flex-wrap gap-2">
              {ERROR_OPTIONS.map((option) => (
                <label key={option.id} className="flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs">
                  <input
                    type="checkbox"
                    checked={form.matchErrors.includes(option.id)}
                    onChange={() => toggleError(option.id)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-md border border-border/60 p-3 space-y-3">
          <h4 className="text-xs font-semibold text-foreground">…then try these providers</h4>
          <Field label="Fallback order" help="Comma-separated, first different provider wins. Example: codex, cursor">
            <input className={fieldClass} value={form.candidates} onChange={(e) => patch('candidates', e.target.value)} placeholder="codex" />
          </Field>
          <Field label="How much context to hand off">
            <select className={fieldClass} value={form.handoffMode} onChange={(e) => patch('handoffMode', e.target.value as PlaybookFormState['handoffMode'])}>
              <option value="summary">Summary of the failed run</option>
              <option value="full">Full conversation</option>
              <option value="fresh">Fresh start (no handoff)</option>
            </select>
          </Field>
          <Field label="Max failovers">
            <input
              type="number"
              min={1}
              max={5}
              className={fieldClass}
              value={form.maxFailovers}
              onChange={(e) => patch('maxFailovers', Number(e.target.value) || 1)}
            />
          </Field>
          <Toggle checked={form.attachContextPack} onChange={(value) => patch('attachContextPack', value)} label="Attach project context pack" />
          <Field label="Approval">
            <select className={fieldClass} value={form.approval} onChange={(e) => patch('approval', e.target.value as PlaybookFormState['approval'])}>
              <option value="interrupt">Ask me first (Needs you)</option>
              <option value="auto">Switch automatically</option>
            </select>
          </Field>
        </div>

        <Feedback message={error} error />
        <Feedback message={message} />
        <Button onClick={() => void save()} disabled={busy}>
          <Save />{busy ? 'Saving…' : editingId ? 'Update rule' : 'Create rule'}
        </Button>
      </div>
    </div>
  );
}

function StackPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [form, setForm] = useState<StackFormState>(() => defaultStackForm(projectName));
  const [stackPath, setStackPath] = useState<string | null>(null);
  const [report, setReport] = useState<StackDoctorReport | null>(null);
  const [exportedYaml, setExportedYaml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await requestJson<{ config?: JsonRecord; path?: string }>(`/api/projects/${encodeURIComponent(projectId)}/stack`);
      setForm(stackToForm(payload.config ?? {}, projectName));
      setStackPath(payload.path ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load project health profile.');
    } finally {
      setBusy(false);
    }
  }, [projectId, projectName]);

  useEffect(() => { void load(); }, [load]);

  const patch = <K extends keyof StackFormState>(key: K, value: StackFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = await requestJson<{ path?: string }>(`/api/projects/${encodeURIComponent(projectId)}/stack`, {
        method: 'PUT',
        body: JSON.stringify({ config: formToStackConfig(form) }),
      });
      setStackPath(payload.path ?? stackPath);
      setMessage('Saved project health profile.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = await requestJson<{ warnings?: string[]; document?: { path?: string } }>(`/api/projects/${encodeURIComponent(projectId)}/stack/apply`, {
        method: 'POST',
        body: JSON.stringify({ config: formToStackConfig(form) }),
      });
      setStackPath(payload.document?.path ?? stackPath);
      setMessage(payload.warnings?.length ? `Applied with ${payload.warnings.length} warning(s).` : 'Applied profile and workspace ignore rules.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not apply profile.');
    } finally {
      setBusy(false);
    }
  };

  const doctor = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/stack/doctor`, {
        method: 'POST',
        body: JSON.stringify({ createInterrupts: true }),
      });
      let payload: JsonRecord = {};
      try { payload = (await response.json()) as JsonRecord; } catch { /* handled below */ }
      if (!response.ok && !Array.isArray(payload.checks)) {
        throw new Error(`Health check failed (${response.status})`);
      }
      const nextReport = payload as unknown as StackDoctorReport;
      setReport(nextReport);
      setMessage(nextReport.ok ? 'Everything looks healthy.' : `${nextReport.checks.filter((check) => check.status === 'fail').length} check(s) need attention.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not run health check.');
    } finally {
      setBusy(false);
    }
  };

  const exportStack = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = await requestJson<{ yaml?: string }>(`/api/projects/${encodeURIComponent(projectId)}/stack/export`, { method: 'POST' });
      setExportedYaml(payload.yaml ?? '');
      setMessage('Export ready (secrets redacted).');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not export.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Project health profile</h3>
          <p className={helpClass}>
            Tell CloudCLI which providers, MCP servers, and skills this project expects. Run a check anytime.
          </p>
          {stackPath ? <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{stackPath}</p> : null}
        </div>
        <Button variant="ghost" size="icon" onClick={() => void load()} disabled={busy} aria-label="Reload profile">
          <RefreshCw className={busy ? 'animate-spin' : ''} />
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
        <div className="space-y-3">
          <Field label="Project label">
            <input className={fieldClass} value={form.project} onChange={(e) => patch('project', e.target.value)} />
          </Field>
          <Field label="Required providers" help="Comma-separated. Doctor fails if these are missing or logged out.">
            <input className={fieldClass} value={form.requiredProviders} onChange={(e) => patch('requiredProviders', e.target.value)} placeholder="claude, codex" />
          </Field>
          <Field label="Optional providers">
            <input className={fieldClass} value={form.optionalProviders} onChange={(e) => patch('optionalProviders', e.target.value)} placeholder="cursor" />
          </Field>
          <Field label="Expected MCP servers" help="Names from Settings → MCP, comma-separated.">
            <input className={fieldClass} value={form.mcpNames} onChange={(e) => patch('mcpNames', e.target.value)} placeholder="obsidian, github" />
          </Field>
          <Field label="Global skills">
            <input className={fieldClass} value={form.globalSkills} onChange={(e) => patch('globalSkills', e.target.value)} />
          </Field>
          <Field label="Project skills">
            <input className={fieldClass} value={form.projectSkills} onChange={(e) => patch('projectSkills', e.target.value)} />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={busy}><Save />Save</Button>
            <Button variant="outline" onClick={() => void apply()} disabled={busy}><Wrench />Apply</Button>
            <Button variant="outline" onClick={() => void doctor()} disabled={busy}><ShieldAlert />Run health check</Button>
            <Button variant="ghost" onClick={() => void exportStack()} disabled={busy}><Download />Export</Button>
          </div>
          {exportedYaml ? (
            <pre className="max-h-48 overflow-auto rounded-md border border-border/60 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
              {exportedYaml}
            </pre>
          ) : null}
          <Feedback message={error} error />
          <Feedback message={message} />
        </div>

        <div className="space-y-3">
          <div>
            <h4 className="text-xs font-semibold text-foreground">Health check results</h4>
            <p className={helpClass}>Providers, auth, MCP, secrets, worktrees, and skills.</p>
          </div>
          {!report ? (
            <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
              Run a health check to inspect this project.
            </div>
          ) : (
            <div className="space-y-2">
              {report.checks.map((check) => (
                <div key={check.id} className="rounded-md border border-border/60 p-3">
                  <div className="flex items-start gap-2">
                    {check.status === 'pass' ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    ) : check.status === 'fail' ? (
                      <XCircle className="h-4 w-4 shrink-0 text-red-400" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                    )}
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{check.label}</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">{check.message}</div>
                      {check.fix ? <div className="mt-1 text-[11px] text-amber-500">Fix: {check.fix}</div> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OperationsView({ selectedProject }: { selectedProject: Project | null }) {
  const [section, setSection] = useState<OperationsSection>('automation');

  const projectName = useMemo(
    () => selectedProject?.displayName || selectedProject?.projectId || 'project',
    [selectedProject],
  );

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to manage automations and health checks
      </div>
    );
  }

  const sections: Array<{ id: OperationsSection; label: string; description: string; Icon: typeof Play }> = [
    { id: 'automation', label: 'Automations', description: 'Scheduled & event actions', Icon: Play },
    { id: 'failover', label: 'Failover', description: 'Provider backups', Icon: ShieldAlert },
    { id: 'stack', label: 'Health check', description: 'Project expectations', Icon: Wrench },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Project operations</h2>
            <p className="text-xs text-muted-foreground">
              Automate work, recover from provider failures, and check that this project is set up correctly.
            </p>
          </div>
          <div className="flex flex-wrap gap-1 rounded-md border border-border/60 p-1">
            {sections.map(({ id, label, description, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={`flex items-center gap-2 rounded px-2.5 py-1.5 text-left transition-colors ${section === id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'}`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>
                  <span className="block text-xs font-medium">{label}</span>
                  <span className="hidden text-[10px] sm:block">{description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {section === 'automation' && <AutomationPanel projectId={selectedProject.projectId} />}
      {section === 'failover' && <FailoverPanel projectId={selectedProject.projectId} />}
      {section === 'stack' && <StackPanel projectId={selectedProject.projectId} projectName={projectName} />}
    </div>
  );
}
