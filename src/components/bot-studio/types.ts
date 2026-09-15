import type { CreateMcSectionInput, McAction, McItem, McSection } from '../mission-control/api/missionControlApi';

export type BotAutonomy = 'dry_run' | 'propose' | 'act';

export type BotSummary = {
  pending?: number;
  failed?: number;
  resolvedToday?: number;
  lastRunAt?: string | null;
  lastError?: string | null;
};

export type Bot = McSection & {
  autonomy: BotAutonomy;
  purpose: string;
  pending: number;
  failed: number;
  resolvedToday: number;
  lastError: string | null;
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

function getAutonomy(section: Pick<McSection, 'mode' | 'dry_run'>): BotAutonomy {
  if (section.dry_run) return 'dry_run';
  return section.mode === 'fire_and_forget' ? 'act' : 'propose';
}

export function sectionToBot(section: McSection, summary?: BotSummary): Bot {
  const purpose = section.produce_prompt.split(/\r?\n/, 1)[0]?.trim() || 'No purpose brief yet.';
  return {
    ...section,
    autonomy: getAutonomy(section),
    purpose,
    pending: summary?.pending ?? 0,
    failed: summary?.failed ?? 0,
    resolvedToday: summary?.resolvedToday ?? 0,
    lastError: summary?.lastError ?? section.last_run_error ?? null,
    last_run_at: summary?.lastRunAt ?? section.last_run_at,
  };
}

/** Converts Bot Studio vocabulary back to the legacy section payload. */
export function botPatch(autonomy: BotAutonomy, patch: Partial<CreateMcSectionInput> = {}): Partial<CreateMcSectionInput> {
  if (autonomy === 'dry_run') {
    return { ...patch, mode: 'review', dry_run: true };
  }
  if (autonomy === 'act') {
    return { ...patch, mode: 'fire_and_forget', dry_run: false };
  }
  return { ...patch, mode: 'review', dry_run: false };
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
