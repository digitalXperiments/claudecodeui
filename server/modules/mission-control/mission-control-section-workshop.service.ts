/**
 * Conversational section architect for Mission Control. It turns a rough
 * automation idea into a safe draft that can be applied to the section form.
 */

import { providerCapabilitiesService } from '@/modules/providers/index.js';
import {
  parseJsonFromAgentText,
  runMissionControlAgent,
  type McAgentRunResult,
} from '@/modules/mission-control/mission-control-agent.service.js';
import {
  isMcProvider,
  type McProvider,
  type McSection,
  type McSectionMode,
  type McSectionScope,
} from '@/modules/mission-control/mission-control.types.js';
import { AppError } from '@/shared/utils.js';

export type SectionWorkshopMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type SectionWorkshopDraft = {
  title: string;
  scope: McSectionScope;
  mode: McSectionMode;
  scheduleCron: string | null;
  producePrompt: string;
  resolvePrompt: string;
  createKanbanTask: boolean;
  recommendedMcpServers: string[];
};

export type SectionWorkshopResult = {
  reply: string;
  draft: SectionWorkshopDraft | null;
  ready: boolean;
};

type WorkshopRunner = (input: {
  section: McSection;
  prompt: string;
  tools: string[];
  sourceRef?: string;
  trigger?: string;
}) => Promise<Pick<McAgentRunResult, 'success' | 'text' | 'errorMessage'>>;

let runnerOverride: WorkshopRunner | null = null;

/** Test hook: skip a live provider turn. */
export function configureSectionWorkshopRunner(runner: WorkshopRunner | null): void {
  runnerOverride = runner;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseSectionWorkshopDraft(text: string): SectionWorkshopDraft | null {
  const fence = text.match(/```mission-section\s*\n([\s\S]*?)```/i);
  if (!fence?.[1]) return null;

  let parsed: unknown;
  try {
    parsed = parseJsonFromAgentText(fence[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const title = cleanString(row.title);
  const producePrompt = cleanString(row.producePrompt ?? row.produce_prompt);
  if (!title || !producePrompt) return null;

  const rawServers = row.recommendedMcpServers ?? row.recommended_mcp_servers;
  const recommendedMcpServers = Array.isArray(rawServers)
    ? rawServers.map(cleanString).filter(Boolean).slice(0, 20)
    : [];

  return {
    title,
    scope: row.scope === 'project' ? 'project' : 'global',
    mode: row.mode === 'fire_and_forget' ? 'fire_and_forget' : 'review',
    scheduleCron: cleanString(row.scheduleCron ?? row.schedule_cron) || null,
    producePrompt,
    resolvePrompt: cleanString(row.resolvePrompt ?? row.resolve_prompt),
    createKanbanTask: row.createKanbanTask === true || row.create_kanban_task === true,
    recommendedMcpServers: [...new Set(recommendedMcpServers)],
  };
}

export function buildSectionWorkshopPrompt(input: {
  messages: SectionWorkshopMessage[];
  currentDraft?: Partial<SectionWorkshopDraft>;
  projectName?: string | null;
  availableMcpServers?: string[];
}): string {
  const transcript = input.messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.trim()}`)
    .filter((line) => line.length > 8)
    .join('\n\n');
  const availableMcp = (input.availableMcpServers ?? []).slice(0, 60);

  return [
    'You are the Mission Control section architect.',
    'Help the user turn a plain-language recurring workflow into one bounded automation section.',
    'Do not run tools or perform the workflow. Ask at most 1–3 short questions when the source, output, review gate, or cadence is unclear.',
    'A review section produces structured queue items for a human to approve, then resolves approved items.',
    'A fire_and_forget section runs one scheduled prompt without creating a review queue.',
    input.projectName ? `Selected project: ${input.projectName}` : 'Scope can remain global unless the user explicitly anchors the workflow to a project.',
    input.currentDraft ? `Current form draft:\n${JSON.stringify(input.currentDraft)}` : '',
    availableMcp.length
      ? `Available MCP servers (recommend only exact names from this list): ${availableMcp.join(', ')}`
      : 'No MCP server inventory was supplied; return an empty recommendedMcpServers array.',
    '',
    'When the workflow is clear, reply with a short confirmation and exactly one fenced JSON block:',
    '```mission-section',
    '{',
    '  "title": "Short section name",',
    '  "scope": "global | project",',
    '  "mode": "review | fire_and_forget",',
    '  "scheduleCron": "valid five-field cron or null",',
    '  "producePrompt": "Complete standalone instructions, including the desired structured output",',
    '  "resolvePrompt": "What to do after approval, or empty for fire_and_forget",',
    '  "createKanbanTask": false,',
    '  "recommendedMcpServers": []',
    '}',
    '```',
    'Use review mode when a human should inspect drafts before an external write or implementation.',
    'Only enable createKanbanTask for approved work that should enter the engineering board.',
    'Never invent credentials, project IDs, MCP server names, or destructive actions.',
    'If you still need information, ask questions and do not emit a mission-section block.',
    '',
    '## Conversation so far',
    transcript || '(No user message yet.)',
    '',
    'Reply next as the Assistant.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runSectionWorkshop(input: {
  provider?: string | null;
  model?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  messages: SectionWorkshopMessage[];
  currentDraft?: Partial<SectionWorkshopDraft>;
  availableMcpServers?: string[];
}): Promise<SectionWorkshopResult> {
  const provider: McProvider = isMcProvider(input.provider) ? input.provider : 'claude';
  const messages = input.messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({ role: message.role, content: String(message.content ?? '').trim() }))
    .filter((message) => message.content)
    .slice(-24);
  if (!messages.some((message) => message.role === 'user')) {
    throw new AppError('Describe the workflow you want Mission Control to run', {
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  const capabilities = providerCapabilitiesService.getProviderCapabilities(provider);
  const permissionMode = capabilities.permissionModes.includes('default')
    ? 'default'
    : capabilities.defaultPermissionMode;
  const now = new Date().toISOString();
  const section: McSection = {
    section_id: `section-workshop:${input.projectId || 'global'}`,
    title: 'Mission Control section architect',
    icon: 'radar',
    sort_order: 0,
    enabled: true,
    scope: input.projectId ? 'project' : 'global',
    project_id: input.projectId || null,
    mode: 'fire_and_forget',
    schedule_cron: null,
    provider,
    model: input.model || null,
    permission_mode: permissionMode,
    dry_run: true,
    auto_approve: false,
    produce_prompt: '',
    produce_tools: [],
    resolve_prompt: '',
    resolve_tools: [],
    actions: [],
    create_kanban_task: false,
    create_swarm_on_approve: false,
    kanban_assignee_provider: null,
    kanban_review_provider: null,
    kanban_mcp_tools: [],
    last_run_at: null,
    last_run_error: null,
    created_at: now,
    updated_at: now,
  };
  const prompt = buildSectionWorkshopPrompt(input);
  const outcome = await (runnerOverride ?? runMissionControlAgent)({
    section,
    prompt,
    tools: [],
    sourceRef: section.section_id,
    trigger: 'section-workshop',
  });
  if (!outcome.success || !outcome.text.trim()) {
    throw new AppError(outcome.errorMessage || 'Section architect produced no reply', {
      code: 'MC_SECTION_WORKSHOP_FAILED',
      statusCode: 502,
    });
  }
  const parsedDraft = parseSectionWorkshopDraft(outcome.text);
  const available = new Set((input.availableMcpServers ?? []).map((name) => name.trim()).filter(Boolean));
  const draft = parsedDraft
    ? {
        ...parsedDraft,
        recommendedMcpServers: parsedDraft.recommendedMcpServers.filter((name) => available.has(name)),
      }
    : null;
  return { reply: outcome.text.trim(), draft, ready: Boolean(draft) };
}
