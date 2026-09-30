import type {
  McAction,
  McItem,
  McSection,
  McWorkProfile,
  McWorkSession,
} from '../mission-control/api/missionControlApi';

export type BotToolPhase = 'produce' | 'resolve';
export type ToolPolicyDecision = 'allow' | 'ask' | 'deny';
export type ToolPolicy = Record<string, Record<string, ToolPolicyDecision>>;

/** A single MCP server attached to a bot, including the phases that use it. */
export type BotTool = {
  name: string;
  /** Convenience flags for consumers that render a compact policy table. */
  produce: boolean;
  resolve: boolean;
  phases: Record<BotToolPhase, boolean>;
};

export type BotHealth = 'needs' | 'healthy' | 'paused' | 'failing';

/** Counts and most recent failure information returned by the summary API. */
export type BotSummary = {
  pending?: number;
  failed?: number;
  resolvedToday?: number;
  /** Server-contract spelling accepted by sectionToBot callers. */
  resolved_today?: number;
  lastRunAt?: string | null;
  lastError?: string | null;
  /** Server-contract spellings accepted by sectionToBot callers. */
  last_run_at?: string | null;
  last_error?: string | null;
};

export type Bot = McSection & {
  /** First line of produce_prompt, used as the roster purpose. */
  purpose: string;
  /** Union of produce and resolve MCP server names. */
  tools: BotTool[];
  /** Summary counts merged from /summary rather than stale section fields. */
  summary: Required<Pick<BotSummary, 'pending' | 'failed' | 'resolvedToday'>> & Pick<BotSummary, 'lastRunAt' | 'lastError'>;
  pending: number;
  failed: number;
  resolvedToday: number;
  lastError: string | null;
  health: BotHealth;
};

export type WorkThisSessionRequest = {
  sessionId: string;
  projectId: string;
  projectPath: string;
  provider: string;
  prompt: string;
  title: string;
};

export type BotAction = McAction;

function makeTools(section: Pick<McSection, 'produce_tools' | 'resolve_tools'>): BotTool[] {
  const phases: Record<string, BotToolPhase[]> = {};
  const add = (names: string[] | undefined, phase: BotToolPhase) => {
    for (const name of names ?? []) {
      if (!name) continue;
      phases[name] = [...(phases[name] ?? []), phase];
    }
  };
  add(section.produce_tools, 'produce');
  add(section.resolve_tools, 'resolve');
  return Object.entries(phases).map(([name, usedIn]) => ({
    name,
    produce: usedIn.includes('produce'),
    resolve: usedIn.includes('resolve'),
    phases: {
      produce: usedIn.includes('produce'),
      resolve: usedIn.includes('resolve'),
    },
  }));
}

function healthFor(section: Pick<McSection, 'enabled' | 'last_run_error'>, summary: Required<Pick<BotSummary, 'pending' | 'failed'>>): BotHealth {
  if (summary.pending > 0) return 'needs';
  if (!section.enabled) return 'paused';
  if (Boolean(section.last_run_error) || summary.failed > 0) return 'failing';
  return 'healthy';
}

export function sectionToBot(section: McSection, incomingSummary?: BotSummary): Bot {
  const pending = incomingSummary?.pending ?? 0;
  const failed = incomingSummary?.failed ?? 0;
  const resolvedToday = incomingSummary?.resolvedToday ?? incomingSummary?.resolved_today ?? 0;
  const lastRunAt = incomingSummary?.lastRunAt ?? incomingSummary?.last_run_at ?? section.last_run_at;
  const lastError = incomingSummary?.lastError ?? incomingSummary?.last_error ?? section.last_run_error ?? null;
  const summary = { pending, failed, resolvedToday, lastRunAt, lastError };
  return {
    ...section,
    dry_run: Boolean(section.dry_run),
    purpose: section.produce_prompt.split(/\r?\n/, 1)[0]?.trim() || 'No purpose brief yet.',
    tools: makeTools(section),
    summary,
    pending,
    failed,
    resolvedToday,
    lastError,
    health: healthFor({ enabled: section.enabled, last_run_error: lastError }, { pending, failed }),
    last_run_at: lastRunAt,
  };
}

export type PipelineStage = 'auto' | 'manual' | 'none';
export type BotPipeline = { resolve: PipelineStage; work: PipelineStage };
type PipelineSource = Pick<McSection, 'resolve_prompt' | 'auto_approve'> & { work_profile?: Pick<McWorkProfile, 'auto_start'> | null };

/**
 * Every bot is one pipeline: Propose (produce prompt) → Resolve (optional
 * resolve prompt) → Work (optional work session). auto_approve drives Resolve;
 * work_profile.auto_start drives Work.
 */
export function pipelineStages(bot: PipelineSource): BotPipeline {
  const resolve: PipelineStage = bot.resolve_prompt?.trim() ? (bot.auto_approve ? 'auto' : 'manual') : 'none';
  const work: PipelineStage = bot.work_profile ? (bot.work_profile.auto_start ? 'auto' : 'manual') : 'none';
  return { resolve, work };
}

/** Compact roster/header label, e.g. "Resolve auto · Work manual". */
export function pipelineLabel(bot: PipelineSource): string {
  const stages = pipelineStages(bot);
  const parts = [
    stages.resolve !== 'none' ? `Resolve ${stages.resolve}` : null,
    stages.work !== 'none' ? `Work ${stages.work}` : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length) return parts.join(' · ');
  return bot.auto_approve ? 'Record only · auto' : 'Review only';
}

/** Long form used by Trust, e.g. "Propose → Resolve (manual) → Work (auto)". */
export function pipelineSummary(bot: PipelineSource): string {
  const stages = pipelineStages(bot);
  return ['Propose', stages.resolve !== 'none' ? `Resolve (${stages.resolve})` : null, stages.work !== 'none' ? `Work (${stages.work})` : null]
    .filter((part): part is string => Boolean(part)).join(' → ');
}

/**
 * Label for the auto_approve toggle, or null when it has no effect (no resolve
 * prompt but a work stage exists). Only 'approve' actions ever run automatically.
 */
export function autoApproveLabel(bot: PipelineSource): { label: string; description: string } | null {
  if (bot.resolve_prompt?.trim()) return { label: 'Resolve automatically', description: 'Runs the Approve action on each new item as soon as a tick creates it, so the resolve prompt runs without review. Held or denied MCP tools still require their policy decision.' };
  if (!bot.work_profile) return { label: 'Approve automatically', description: 'This bot only records items: new items are marked done immediately instead of waiting in the inbox.' };
  return null;
}

/** Mirrors server routing: unique client/alias match → route project, else default project, else null. */
export function normalizeClient(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function routeWorkProject(item: Pick<McItem, 'body'>, profile: Pick<McWorkProfile, 'routes' | 'default_project_id'> | null | undefined): string | null {
  if (!profile) return null;
  const client = normalizeClient(typeof item.body?.client === 'string' ? item.body.client : '');
  const matches = client ? (profile.routes ?? []).filter((route) => [route.client, ...route.aliases].some((name) => normalizeClient(name) === client)) : [];
  if (matches.length === 1 && matches[0].project_id) return matches[0].project_id;
  return profile.default_project_id ?? null;
}

export function itemWorkSession(item: Pick<McItem, 'body'>): McWorkSession | null {
  const value = item.body?.workSession;
  if (!value || typeof value !== 'object') return null;
  const session = value as Partial<McWorkSession>;
  return typeof session.sessionId === 'string' ? session as McWorkSession : null;
}

/** A failed item with work_ready_at failed in the Work stage; otherwise it failed in Resolve/produce. */
export function itemFailedInWork(item: Pick<McItem, 'status' | 'work_ready_at'>): boolean {
  return item.status === 'failed' && Boolean(item.work_ready_at);
}

/** Items whose existing action buttons (approve/dismiss/etc.) apply. */
export function itemAcceptsActions(item: Pick<McItem, 'status' | 'work_ready_at'>): boolean {
  return item.status === 'pending' || (item.status === 'failed' && !item.work_ready_at);
}

export function workRetryMessage(item: Pick<McItem, 'error'>): string {
  return `The previous attempt failed: ${item.error?.trim() || 'unknown error'}. Diagnose and continue.`;
}

export function itemHasDraft(item: McItem): boolean {
  const draft = item.body?.draft ?? item.body?.reply;
  return typeof draft === 'string' ? draft.trim().length > 0 : Boolean(draft);
}

/** Action buttons stay locked only while an agent is running on the item. */
export function isInboxActionLocked(item: Pick<McItem, 'status'>): boolean {
  return item.status === 'resolving' || item.status === 'working';
}

export function formatAge(value: string | null | undefined): string {
  if (!value) return 'No ticks yet';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown time';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
