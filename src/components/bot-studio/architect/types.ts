import type { McProvider, McWorkProfile } from '../../mission-control/api/missionControlApi';

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
  work_project_id?: string | null;
  work_profile?: McWorkProfile | null;
  /** Deprecated: the server always returns 'review'. */
  mode?: 'review' | 'fire_and_forget';
  schedule_cron: string | null;
  provider: string;
  model: string | null;
  effort?: string | null;
  resolve_provider?: McProvider | null;
  resolve_model?: string | null;
  resolve_effort?: string | null;
  permission_mode: string;
  dry_run: boolean;
  auto_approve: boolean;
  produce_prompt: string;
  produce_tools: string[];
  resolve_prompt: string;
  resolve_tools: string[];
  actions: McAction[];
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
  work_project_id?: string | null;
  work_profile?: McWorkProfile | null;
  schedule_cron?: string | null;
  provider?: string;
  model?: string | null;
  effort?: string | null;
  resolve_provider?: McProvider | null;
  resolve_model?: string | null;
  resolve_effort?: string | null;
  permission_mode?: string;
  dry_run?: boolean;
  auto_approve?: boolean;
  produce_prompt?: string;
  produce_tools?: string[];
  resolve_prompt?: string;
  resolve_tools?: string[];
  actions?: McAction[];
  tool_policy?: ToolPolicy;
  /** Wizard-only local state; stripped before sending the section payload. */
  read_only_preset?: boolean;
  /** Wizard-only local state; distinguishes manual-only from an invalid blank cron. */
  manual_schedule?: boolean;
};

export type McSectionWorkshopDraft = {
  title: string;
  scope: 'global' | 'project';
  scheduleCron: string | null;
  producePrompt: string;
  resolvePrompt: string;
  recommendedMcpServers: string[];
};

export function applyWorkshopDraft(
  current: CreateMcSectionInput,
  draft: McSectionWorkshopDraft,
  availableMcpServers?: string[],
): CreateMcSectionInput {
  const recommended = !availableMcpServers || availableMcpServers.length === 0
    ? draft.recommendedMcpServers
    : draft.recommendedMcpServers.filter((name) => availableMcpServers.includes(name));
  return {
    ...current,
    title: draft.title,
    scope: draft.scope,
    schedule_cron: draft.scheduleCron,
    produce_prompt: draft.producePrompt,
    resolve_prompt: draft.resolvePrompt,
    produce_tools: recommended,
    resolve_tools: draft.resolvePrompt.trim() ? recommended : [],
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

/**
 * Holds write-like tools for approval. Only explicit operator choices are persisted: write-like names
 * become 'ask' (an existing 'deny' stays 'deny'); every other tool is left exactly as saved, and tools
 * with no saved decision stay unset rather than being written as 'allow'.
 */
export function applyReadOnlyPreset(policy: ToolPolicy, toolsByServer: Record<string, string[]> = {}): ToolPolicy {
  const servers = new Set([...Object.keys(policy), ...Object.keys(toolsByServer)]);
  const next: ToolPolicy = {};
  for (const server of servers) {
    const tools = new Set([...Object.keys(policy[server] ?? {}), ...(toolsByServer[server] ?? [])]);
    const decisions: Record<string, ToolPolicyDecision> = {};
    for (const tool of tools) {
      const saved = policy[server]?.[tool];
      if (READ_ONLY_WRITE_PATTERN.test(tool)) decisions[tool] = saved === 'deny' ? 'deny' : 'ask';
      else if (saved) decisions[tool] = saved;
    }
    if (Object.keys(decisions).length > 0) next[server] = decisions;
  }
  return next;
}

/** What an unset tool is treated as: the gate decides ('default'); the preset only flags write-like names. */
export function defaultToolDecision(toolName: string, readOnlyPreset = false): ToolPolicyDecision | 'default' {
  return readOnlyPreset && READ_ONLY_WRITE_PATTERN.test(toolName) ? 'ask' : 'default';
}

/** Set one explicit decision, or clear it with 'default' (an untouched tool must never be persisted as 'allow'). */
export function setToolDecision(policy: ToolPolicy, server: string, tool: string, decision: ToolPolicyDecision | 'default'): ToolPolicy {
  const { [tool]: _removed, ...rest } = policy[server] ?? {};
  const tools = decision === 'default' ? rest : { ...rest, [tool]: decision };
  const { [server]: _server, ...others } = policy;
  return Object.keys(tools).length > 0 ? { ...others, [server]: tools } : others;
}
