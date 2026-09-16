import type {
  CreateMcSectionInput,
  McAction,
  McItem,
  McSection,
} from '../mission-control/api/missionControlApi';

export type BotAutonomy = 'dry_run' | 'propose' | 'act';
export type BotToolPhase = 'produce' | 'resolve' | 'kanban';
export type ToolPolicyDecision = 'allow' | 'ask' | 'deny';
export type ToolPolicy = Record<string, Record<string, ToolPolicyDecision>>;

/** A single MCP server attached to a bot, including the phases that use it. */
export type BotTool = {
  name: string;
  /** Convenience flags for consumers that render a compact policy table. */
  produce: boolean;
  resolve: boolean;
  kanban: boolean;
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
  /** Bot Studio vocabulary for mode + dry_run. */
  autonomy: BotAutonomy;
  /** First line of produce_prompt, used as the roster purpose. */
  purpose: string;
  /** Union of produce, resolve, and kanban MCP server names. */
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

function autonomyFromSection(section: Pick<McSection, 'mode' | 'dry_run'>): BotAutonomy {
  // dry_run is authoritative when an old section contains the otherwise
  // contradictory combination fire_and_forget + dry_run.
  if (section.dry_run) return 'dry_run';
  return section.mode === 'fire_and_forget' ? 'act' : 'propose';
}

function makeTools(section: Pick<McSection, 'produce_tools' | 'resolve_tools' | 'kanban_mcp_tools'>): BotTool[] {
  const phases: Record<string, BotToolPhase[]> = {};
  const add = (names: string[] | undefined, phase: BotToolPhase) => {
    for (const name of names ?? []) {
      if (!name) continue;
      phases[name] = [...(phases[name] ?? []), phase];
    }
  };
  add(section.produce_tools, 'produce');
  add(section.resolve_tools, 'resolve');
  add(section.kanban_mcp_tools, 'kanban');
  return Object.entries(phases).map(([name, usedIn]) => ({
    name,
    produce: usedIn.includes('produce'),
    resolve: usedIn.includes('resolve'),
    kanban: usedIn.includes('kanban'),
    phases: {
      produce: usedIn.includes('produce'),
      resolve: usedIn.includes('resolve'),
      kanban: usedIn.includes('kanban'),
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
    autonomy: autonomyFromSection(section),
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

type BotPatch = Partial<CreateMcSectionInput> & { autonomy?: BotAutonomy };

function mapAutonomy(autonomy: BotAutonomy): Pick<CreateMcSectionInput, 'mode' | 'dry_run'> {
  if (autonomy === 'dry_run') return { mode: 'review', dry_run: true };
  if (autonomy === 'act') return { mode: 'fire_and_forget', dry_run: false };
  return { mode: 'review', dry_run: false };
}

/**
 * Converts Bot Studio vocabulary back to the existing section payload.
 * Both `botPatch('act', patch)` and `botPatch({ autonomy: 'act', ...patch })`
 * are supported so tab workers can use the helper without knowing the legacy
 * Mission Control field names.
 */
export function botPatch(autonomy: BotAutonomy, patch?: Partial<CreateMcSectionInput>): Partial<CreateMcSectionInput>;
export function botPatch(patch: BotPatch): Partial<CreateMcSectionInput>;
export function botPatch(
  autonomyOrPatch: BotAutonomy | BotPatch,
  patch: Partial<CreateMcSectionInput> = {},
): Partial<CreateMcSectionInput> {
  if (typeof autonomyOrPatch === 'string') {
    return { ...patch, ...mapAutonomy(autonomyOrPatch) };
  }
  const { autonomy, ...sectionPatch } = autonomyOrPatch;
  return autonomy ? { ...sectionPatch, ...mapAutonomy(autonomy) } : sectionPatch;
}

export function itemHasDraft(item: McItem): boolean {
  const draft = item.body?.draft ?? item.body?.reply;
  return typeof draft === 'string' ? draft.trim().length > 0 : Boolean(draft);
}

export function actionIsSendLike(action: McAction): boolean {
  return /send|publish|post|reply|transition|update|delete|archive/i.test(`${action.id} ${action.kind} ${action.label}`);
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
