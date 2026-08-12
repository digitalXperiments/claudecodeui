import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
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

const PROVIDER_OPTIONS = ['claude', 'codex', 'cursor', 'grok', 'opencode', 'kimi', 'pi'] as const;
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
    name: 'Manual notification',
    enabled: true,
    triggerType: 'manual',
    cron: '0 9 * * 1-5',
    triggerEvent: 'task.done',
    multiStep: false,
    steps: [defaultStepForm({ name: 'Notify' })],
  };
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
  if (form.triggerType === 'cron') trigger.cron = form.cron.trim();
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
      <Field label="Action">
        <select
          className={fieldClass}
          value={step.actionType}
          onChange={(e) => onChange({ actionType: e.target.value as WorkflowStepForm['actionType'] })}
        >
          <option value="notify">Send a notification</option>
          <option value="start_agent_run">Start an agent run</option>
          <option value="http_webhook_out">Call a webhook URL</option>
          <option value="create_interrupt">Create a “Needs you” item</option>
          <option value="noop">Do nothing (test only)</option>
        </select>
      </Field>
      {step.actionType === 'notify' ? (
        <>
          <Field label="Notification title">
            <input className={fieldClass} value={step.notifyTitle} onChange={(e) => onChange({ notifyTitle: e.target.value })} />
          </Field>
          <Field label="Message">
            <textarea className={textareaClass} value={step.notifyMessage} onChange={(e) => onChange({ notifyMessage: e.target.value })} />
          </Field>
        </>
      ) : null}
      {step.actionType === 'start_agent_run' ? (
        <>
          <Field label="Provider">
            <select className={fieldClass} value={step.agentProvider} onChange={(e) => onChange({ agentProvider: e.target.value })}>
              {PROVIDER_OPTIONS.map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
          </Field>
          <Field label="Run title">
            <input className={fieldClass} value={step.agentTitle} onChange={(e) => onChange({ agentTitle: e.target.value })} />
          </Field>
          <Field label="Prompt">
            <textarea className={textareaClass} value={step.agentPrompt} onChange={(e) => onChange({ agentPrompt: e.target.value })} />
          </Field>
        </>
      ) : null}
      {step.actionType === 'http_webhook_out' ? (
        <>
          <Field label="URL">
            <input className={fieldClass} value={step.webhookUrl} onChange={(e) => onChange({ webhookUrl: e.target.value })} placeholder="https://…" />
          </Field>
          <Field label="Method">
            <select className={fieldClass} value={step.webhookMethod} onChange={(e) => onChange({ webhookMethod: e.target.value })}>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="GET">GET</option>
            </select>
          </Field>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className={labelClass}>Authorization header (optional)</span>
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
      setMessage(`Ran “${recipe.name}”. ${payload.results?.length ?? 0} result(s).`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not run the automation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
      <div className="border-b border-border/60 p-4 lg:border-b-0 lg:border-r">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Your automations</h3>
            <p className={helpClass}>Run when you click, on a schedule, or after board/run events.</p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={busy} aria-label="Refresh automations">
            <RefreshCw className={busy ? 'animate-spin' : ''} />
          </Button>
        </div>
        {recipes.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No automations yet. Create one on the right.
          </div>
        ) : (
          <div className="space-y-2">
            {recipes.map((recipe) => {
              const last = lastRuns[recipe.recipe_id];
              const stepCount = recipe.graph?.steps?.length ?? recipe.actions?.length ?? 0;
              return (
                <div key={recipe.recipe_id} className="rounded-md border border-border/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{recipe.name}</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        When: {recipe.trigger?.type ?? 'manual'}
                        {recipe.trigger?.cron ? ` (${recipe.trigger.cron})` : ''}
                        {' · '}
                        {stepCount} step{stepCount === 1 ? '' : 's'}
                        {recipe.graph ? ' (workflow)' : ''}
                      </div>
                      {last?.step_states && Object.keys(last.step_states).length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {Object.entries(last.step_states).map(([id, state]) => (
                            <span
                              key={id}
                              className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] ${
                                state.status === 'succeeded'
                                  ? 'bg-emerald-500/15 text-emerald-400'
                                  : state.status === 'failed'
                                    ? 'bg-red-500/15 text-red-400'
                                    : 'bg-muted text-muted-foreground'
                              }`}
                              title={state.error || state.status || id}
                            >
                              {state.status === 'succeeded' ? <CheckCircle2 className="h-3 w-3" /> : null}
                              {id}
                            </span>
                          ))}
                        </div>
                      ) : last?.status ? (
                        <div className="mt-1 text-[10px] text-muted-foreground">Last run: {last.status}</div>
                      ) : null}
                    </div>
                    <span className={`text-[11px] ${recipe.enabled ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                      {recipe.enabled ? 'On' : 'Off'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => void run(recipe)} disabled={busy}><Play />Run now</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditingId(recipe.recipe_id); setForm(recipeToForm(recipe)); setMessage(null); setError(null); }} disabled={busy}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(recipe)} disabled={busy}><Trash2 /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">{editingId ? 'Edit automation' : 'New automation'}</h3>
            <p className={helpClass}>Describe when it runs and what it should do — no JSON required.</p>
          </div>
          {editingId ? (
            <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setForm(defaultRecipeForm()); }}>
              <Plus className="h-3.5 w-3.5" /> New
            </Button>
          ) : null}
        </div>

        <Field label="Name">
          <input className={fieldClass} value={form.name} onChange={(e) => patch('name', e.target.value)} placeholder="Morning standup ping" />
        </Field>
        <Toggle checked={form.enabled} onChange={(value) => patch('enabled', value)} label="Enabled" />

        <div className="rounded-md border border-border/60 p-3 space-y-3">
          <h4 className="text-xs font-semibold text-foreground">When should this run?</h4>
          <Field label="Trigger">
            <select className={fieldClass} value={form.triggerType} onChange={(e) => patch('triggerType', e.target.value as RecipeFormState['triggerType'])}>
              <option value="manual">Manual (Run now button)</option>
              <option value="cron">Schedule (cron)</option>
              <option value="kanban_event">Kanban board event</option>
              <option value="run_completed">Agent run completed</option>
              <option value="webhook_inbound">Inbound webhook</option>
              <option value="interrupt_created">Needs-you interrupt created</option>
            </select>
          </Field>
          {form.triggerType === 'cron' ? (
            <Field label="Cron expression" help="Example: 0 9 * * 1-5 = weekdays at 9:00">
              <input className={fieldClass} value={form.cron} onChange={(e) => patch('cron', e.target.value)} placeholder="0 9 * * 1-5" />
            </Field>
          ) : null}
          {form.triggerType === 'kanban_event' || form.triggerType === 'run_completed' || form.triggerType === 'interrupt_created' ? (
            <Field label="Event name" help="Optional filter, e.g. task.done or run.failed">
              <input className={fieldClass} value={form.triggerEvent} onChange={(e) => patch('triggerEvent', e.target.value)} />
            </Field>
          ) : null}
        </div>

        <div className="rounded-md border border-border/60 p-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-foreground">Workflow steps</h4>
            <Toggle
              checked={form.multiStep}
              onChange={(value) => {
                patch('multiStep', value);
                if (value && form.steps.length < 2) {
                  setForm((prev) => ({
                    ...prev,
                    multiStep: true,
                    steps: [...prev.steps, defaultStepForm({ name: `Step ${prev.steps.length + 1}` })],
                  }));
                }
              }}
              label="Multi-step workflow"
            />
          </div>
          <p className={helpClass}>
            Cards run top-to-bottom. Order with arrows; multi-step auto-wires dependencies.
          </p>

          {form.steps.map((step, index) => (
            <div key={step.localId} className="rounded-md border border-border/50 bg-muted/10 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">#{index + 1}</span>
                <input
                  className={`${fieldClass} min-w-[8rem] flex-1`}
                  value={step.name}
                  onChange={(e) => patchStep(step.localId, { name: e.target.value })}
                  placeholder="Step name"
                />
                <select
                  className={fieldClass}
                  value={step.kind}
                  onChange={(e) => patchStep(step.localId, { kind: e.target.value as WorkflowStepForm['kind'] })}
                >
                  <option value="action">Do something</option>
                  <option value="parallel">Wait for several</option>
                  <option value="branch">If condition</option>
                </select>
                {form.multiStep ? (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={index === 0 || busy} onClick={() => moveStep(index, -1)} aria-label="Move up">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" disabled={index === form.steps.length - 1 || busy} onClick={() => moveStep(index, 1)} aria-label="Move down">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={form.steps.length <= 1 || busy}
                      onClick={() => setForm((prev) => ({ ...prev, steps: prev.steps.filter((s) => s.localId !== step.localId) }))}
                      aria-label="Remove step"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : null}
              </div>

              {step.kind === 'action' ? (
                <StepActionFields step={step} onChange={(partial) => patchStep(step.localId, partial)} />
              ) : null}

              {step.kind === 'parallel' ? (
                <div className="space-y-1">
                  <span className={labelClass}>Run these steps together</span>
                  <div className="flex flex-wrap gap-2">
                    {form.steps.filter((s) => s.localId !== step.localId && s.kind === 'action').map((candidate) => {
                      const checked = step.parallelOf.includes(candidate.localId);
                      return (
                        <label key={candidate.localId} className="flex items-center gap-1.5 rounded border border-border/60 px-2 py-1 text-xs">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const next = checked
                                ? step.parallelOf.filter((id) => id !== candidate.localId)
                                : [...step.parallelOf, candidate.localId];
                              patchStep(step.localId, { parallelOf: next });
                            }}
                          />
                          {candidate.name}
                        </label>
                      );
                    })}
                  </div>
                  <p className={helpClass}>If none selected, the next two action steps are used.</p>
                </div>
              ) : null}

              {step.kind === 'branch' ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  <Field label="If path">
                    <input className={fieldClass} value={step.branchPath} onChange={(e) => patchStep(step.localId, { branchPath: e.target.value })} placeholder="payload.ready" />
                  </Field>
                  <Field label="Equals">
                    <input className={fieldClass} value={step.branchEquals} onChange={(e) => patchStep(step.localId, { branchEquals: e.target.value })} placeholder="true" />
                  </Field>
                  <Field label="Then go to step">
                    <select
                      className={fieldClass}
                      value={step.branchNextLocalId}
                      onChange={(e) => patchStep(step.localId, { branchNextLocalId: e.target.value })}
                    >
                      <option value="">Next in list</option>
                      {form.steps.filter((s) => s.localId !== step.localId).map((s) => (
                        <option key={s.localId} value={s.localId}>{s.name}</option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : null}
            </div>
          ))}

          {form.multiStep ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setForm((prev) => ({
                ...prev,
                steps: [...prev.steps, defaultStepForm({ name: `Step ${prev.steps.length + 1}` })],
              }))}
            >
              <Plus className="h-3.5 w-3.5" /> Add step
            </Button>
          ) : null}
        </div>

        <Feedback message={error} error />
        <Feedback message={message} />
        <Button onClick={() => void save()} disabled={busy}>
          <Save />{busy ? 'Saving…' : editingId ? 'Update automation' : 'Create automation'}
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

  const PROVIDER_OPTIONS = ['claude', 'codex', 'cursor', 'grok', 'opencode', 'kimi', 'pi'] as const;

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
