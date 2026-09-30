import type { BotCommitment, BotCommitmentStatus, BotGoal, BotGoalStatus } from '../../../../types/botRuntime';

export type GoalProgressView = {
  percent: number | null;
  note: string;
  tainted: boolean;
  updatedAt: string | null;
};

/** Read the kernel's free-form `progress` object defensively: percent 0-100, latest note, taint marker. */
export function goalProgressView(goal: Pick<BotGoal, 'progress'>): GoalProgressView {
  const progress = goal.progress && typeof goal.progress === 'object' ? goal.progress : {};
  const rawPercent = progress.percent;
  const percent = typeof rawPercent === 'number' && Number.isFinite(rawPercent) ? Math.min(100, Math.max(0, Math.round(rawPercent))) : null;
  return {
    percent,
    note: typeof progress.note === 'string' ? progress.note : '',
    tainted: progress.note_tainted === true,
    updatedAt: typeof progress.updated_at === 'string' ? progress.updated_at : null,
  };
}

export const GOAL_STATUSES: Array<{ value: BotGoalStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'achieved', label: 'Achieved' },
  { value: 'abandoned', label: 'Abandoned' },
];

/**
 * `sort_order` patches that move a goal one slot up/down. Positions are renormalised to the array
 * index first (the server may hand out ties, e.g. everything at 0), and only rows whose value
 * actually changes are returned. Empty when the move is impossible (already at the edge).
 */
export function moveGoal(goals: BotGoal[], goalId: string, direction: 'up' | 'down'): Array<{ goalId: string; sort_order: number }> {
  const index = goals.findIndex((goal) => goal.goal_id === goalId);
  if (index < 0) return [];
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= goals.length) return [];
  const reordered = [...goals];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  const patches: Array<{ goalId: string; sort_order: number }> = [];
  reordered.forEach((goal, position) => {
    if (goal.sort_order !== position) patches.push({ goalId: goal.goal_id, sort_order: position });
  });
  return patches;
}

/** `sort_order` for a new goal so it lands after every existing one. */
export function nextSortOrder(goals: BotGoal[]): number {
  return goals.reduce((max, goal) => Math.max(max, goal.sort_order + 1), 0);
}

export type CommitmentFilter = 'all' | BotCommitmentStatus;

export const COMMITMENT_FILTERS: Array<{ value: CommitmentFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'fired', label: 'Fired' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All' },
];

export function countCommitments(commitments: BotCommitment[]): Record<CommitmentFilter, number> {
  const counts: Record<CommitmentFilter, number> = { all: commitments.length, open: 0, fired: 0, done: 0, cancelled: 0 };
  for (const commitment of commitments) if (commitment.status in counts) counts[commitment.status] += 1;
  return counts;
}

/** Filter by status; active ones (open/fired) sort by due date ascending, finished ones newest first. */
export function filterCommitments(commitments: BotCommitment[], filter: CommitmentFilter): BotCommitment[] {
  const visible = filter === 'all' ? commitments : commitments.filter((commitment) => commitment.status === filter);
  const active = (c: BotCommitment) => c.status === 'open' || c.status === 'fired';
  return [...visible].sort((a, b) => {
    if (active(a) !== active(b)) return active(a) ? -1 : 1;
    return active(a) ? a.due_at.localeCompare(b.due_at) : b.due_at.localeCompare(a.due_at);
  });
}

export function commitmentIsActionable(commitment: Pick<BotCommitment, 'status'>): boolean {
  return commitment.status === 'open' || commitment.status === 'fired';
}

export type CommitmentDraft = { description: string; dueLocal: string; waitingOn: string };

/** Validate the create form; returns the API input or a user-facing error. */
export function buildCommitmentInput(
  draft: CommitmentDraft,
  toIso: (local: string) => string | null,
): { ok: true; input: { description: string; due_at: string; waiting_on?: string } } | { ok: false; error: string } {
  const description = draft.description.trim();
  if (!description) return { ok: false, error: 'Describe what the bot owes or is waiting for.' };
  const dueAt = toIso(draft.dueLocal);
  if (!dueAt) return { ok: false, error: 'Choose when this is due.' };
  const waitingOn = draft.waitingOn.trim();
  return { ok: true, input: { description, due_at: dueAt, ...(waitingOn ? { waiting_on: waitingOn } : {}) } };
}

export type GoalDraft = {
  statement: string;
  successCriteria: string;
  horizon: string;
  status: BotGoalStatus;
  /** Empty string = leave progress percent untouched. */
  percent: string;
  note: string;
};

export function goalToDraft(goal?: BotGoal): GoalDraft {
  const view = goal ? goalProgressView(goal) : null;
  return {
    statement: goal?.statement ?? '',
    successCriteria: goal?.success_criteria ?? '',
    horizon: goal?.horizon ?? '',
    status: goal?.status ?? 'active',
    percent: view?.percent != null ? String(view.percent) : '',
    note: view?.note ?? '',
  };
}

/**
 * Turn the goal form into a create/patch body. For edits only changed fields are sent; progress is
 * rewritten (merged over the existing object) only when percent or note changed, and an operator
 * written note is never marked tainted.
 */
export function buildGoalPatch(
  draft: GoalDraft,
  original?: BotGoal,
): { ok: true; patch: { statement?: string; success_criteria?: string; horizon?: string | null; status?: BotGoalStatus; progress?: Record<string, unknown> } } | { ok: false; error: string } {
  const statement = draft.statement.trim();
  if (!statement) return { ok: false, error: 'A goal needs a statement.' };
  const percentText = draft.percent.trim();
  let percent: number | null = null;
  if (percentText) {
    const parsed = Number(percentText);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return { ok: false, error: 'Progress must be between 0 and 100.' };
    percent = Math.round(parsed);
  }
  const base = original ? goalToDraft(original) : null;
  const patch: { statement?: string; success_criteria?: string; horizon?: string | null; status?: BotGoalStatus; progress?: Record<string, unknown> } = {};
  if (!base || statement !== base.statement) patch.statement = statement;
  if (!base || draft.successCriteria.trim() !== base.successCriteria) patch.success_criteria = draft.successCriteria.trim();
  if (!base || draft.horizon.trim() !== base.horizon) patch.horizon = draft.horizon.trim() || null;
  if (!base || draft.status !== base.status) patch.status = draft.status;
  const note = draft.note.trim();
  const percentChanged = percent !== (base && base.percent ? Number(base.percent) : null);
  const noteChanged = note !== (base?.note ?? '');
  if (percentChanged || noteChanged) {
    const progress: Record<string, unknown> = { ...(original?.progress ?? {}) };
    if (percent !== null) progress.percent = percent; else delete progress.percent;
    if (noteChanged) { progress.note = note; progress.note_tainted = false; }
    patch.progress = progress;
  }
  return { ok: true, patch };
}
