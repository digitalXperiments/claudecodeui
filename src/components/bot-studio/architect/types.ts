export type McAction = {
  id: string;
  label: string;
  kind: string;
  style: 'primary' | 'secondary' | 'destructive';
  terminal?: boolean;
};

export type ToolPolicyDecision = 'allow' | 'ask' | 'deny';
export type ToolPolicy = Record<string, Record<string, ToolPolicyDecision>>;

export type McSection = {
  section_id: string;
  title: string;
  icon: string;
  sort_order: number;
  enabled: boolean;
  scope: 'global' | 'project';
  project_id: string | null;
  mode: 'review' | 'fire_and_forget';
  schedule_cron: string | null;
  provider: string;
  model: string | null;
  permission_mode: string;
  dry_run: boolean;
  auto_approve: boolean;
  produce_prompt: string;
  produce_tools: string[];
  resolve_prompt: string;
  resolve_tools: string[];
  actions: McAction[];
  create_kanban_task: boolean;
  create_swarm_on_approve: boolean;
  kanban_assignee_provider: string | null;
  kanban_review_provider: string | null;
  kanban_mcp_tools: string[];
  tool_policy?: ToolPolicy;
  last_run_at: string | null;
  last_run_error: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateMcSectionInput = {
  title: string;
  icon?: string;
  sort_order?: number;
  enabled?: boolean;
  scope?: 'global' | 'project';
  project_id?: string | null;
  mode?: 'review' | 'fire_and_forget';
  schedule_cron?: string | null;
  provider?: string;
  model?: string | null;
  permission_mode?: string;
  dry_run?: boolean;
  auto_approve?: boolean;
  produce_prompt?: string;
  produce_tools?: string[];
  resolve_prompt?: string;
  resolve_tools?: string[];
  actions?: McAction[];
  create_kanban_task?: boolean;
  create_swarm_on_approve?: boolean;
  kanban_assignee_provider?: string | null;
  kanban_review_provider?: string | null;
  kanban_mcp_tools?: string[];
  tool_policy?: ToolPolicy;
  /** Wizard-only local state; stripped before sending the section payload. */
  read_only_preset?: boolean;
  /** Wizard-only local state; distinguishes manual-only from an invalid blank cron. */
  manual_schedule?: boolean;
};

export type McSectionWorkshopDraft = {
  title: string;
  scope: 'global' | 'project';
  mode: 'review' | 'fire_and_forget';
  scheduleCron: string | null;
  producePrompt: string;
  resolvePrompt: string;
  createKanbanTask: boolean;
  recommendedMcpServers: string[];
};

export type Autonomy = 'dry_run' | 'propose' | 'act';

export const AUTONOMY_OPTIONS: Array<{ value: Autonomy; label: string; description: string }> = [
  { value: 'dry_run', label: 'Dry run', description: 'Observe and preview; no changes are made.' },
  { value: 'propose', label: 'Propose', description: 'Create inbox items for approval.' },
  { value: 'act', label: 'Act', description: 'Resolve approved work automatically.' },
];

export function autonomyFromSection(section: Pick<McSection, 'mode' | 'dry_run'>): Autonomy {
  if (section.dry_run) return 'dry_run';
  return section.mode === 'fire_and_forget' ? 'act' : 'propose';
}

export function sectionFieldsForAutonomy(autonomy: Autonomy): Pick<CreateMcSectionInput, 'mode' | 'dry_run'> {
  if (autonomy === 'dry_run') return { mode: 'review', dry_run: true };
  if (autonomy === 'act') return { mode: 'fire_and_forget', dry_run: false };
  return { mode: 'review', dry_run: false };
}

export function applyWorkshopDraft(
  current: CreateMcSectionInput,
  draft: McSectionWorkshopDraft,
  availableMcpServers?: string[],
): CreateMcSectionInput {
  const recommended = !availableMcpServers || availableMcpServers.length === 0
    ? draft.recommendedMcpServers
    : draft.recommendedMcpServers.filter((name) => availableMcpServers.includes(name));
  const toolsForResolve = draft.mode === 'review' ? recommended : [];
  return {
    ...current,
    title: draft.title,
    scope: draft.scope,
    mode: draft.mode,
    schedule_cron: draft.scheduleCron,
    produce_prompt: draft.producePrompt,
    resolve_prompt: draft.resolvePrompt,
    create_kanban_task: draft.createKanbanTask,
    produce_tools: recommended,
    resolve_tools: toolsForResolve,
    kanban_mcp_tools: draft.createKanbanTask ? recommended : current.kanban_mcp_tools ?? [],
  };
}

export function isValidCron(cron: string | null | undefined, manualOnly = false): boolean {
  if (!cron?.trim()) return manualOnly;
  return cron.trim().split(/\s+/).length === 5;
}

export const CRON_PRESETS = [
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Workdays, 09:00–19:00', value: '0 9-19 * * 1-5' },
  { label: 'Daily at 09:00', value: '0 9 * * *' },
  { label: 'Weekly on Monday', value: '0 10 * * 1' },
] as const;

export function cronSummary(cron: string | null | undefined): string {
  const value = cron?.trim();
  if (!value) return 'Manual only';
  return CRON_PRESETS.find((preset) => preset.value === value)?.label ?? `Cron · ${value}`;
}

export const READ_ONLY_WRITE_PATTERN = /create|send|update|delete|put|post|transition|merge|trash|click|fill/i;

export function applyReadOnlyPreset(policy: ToolPolicy, toolsByServer: Record<string, string[]> = {}): ToolPolicy {
  const servers = new Set([...Object.keys(policy), ...Object.keys(toolsByServer)]);
  return Object.fromEntries(
    Array.from(servers).map((server) => [
      server,
      Object.fromEntries(Array.from(new Set([
        ...Object.keys(policy[server] ?? {}),
        ...(toolsByServer[server] ?? []),
      ])).map((tool) => [
        tool,
        READ_ONLY_WRITE_PATTERN.test(tool) ? 'ask' : policy[server]?.[tool] ?? 'allow',
      ])),
    ]),
  );
}

export function defaultToolDecision(toolName: string, readOnlyPreset = false): ToolPolicyDecision {
  return readOnlyPreset && READ_ONLY_WRITE_PATTERN.test(toolName) ? 'ask' : 'allow';
}
