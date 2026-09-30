/**
 * Pure logic for the Learning tab: proposal grouping and warnings, evidence chips, skill naming and
 * validation, teach-mode input parsing, operator profile validation and the privacy purge guard.
 */

import type { BotOperatorProfileEntry, BotProposal, BotProposalKind, BotPurgeCounts, BotPurgeSelection, BotSkill } from '../../../../types/botRuntime';

// ---- proposals -----------------------------------------------------------------------------

export type ProposalTab = 'proposed' | 'approved' | 'rejected';

export const PROPOSAL_TABS: Array<{ value: ProposalTab; label: string }> = [
  { value: 'proposed', label: 'Proposed' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const TAB_STATUSES: Record<ProposalTab, string[]> = {
  proposed: ['proposed'],
  approved: ['approved', 'applied'],
  rejected: ['rejected', 'superseded'],
};

export function proposalsForTab(list: BotProposal[], tab: ProposalTab): BotProposal[] {
  const statuses = TAB_STATUSES[tab];
  return list.filter((proposal) => statuses.includes(proposal.status));
}

export function proposalCounts(list: BotProposal[]): Record<ProposalTab, number> {
  return { proposed: proposalsForTab(list, 'proposed').length, approved: proposalsForTab(list, 'approved').length, rejected: proposalsForTab(list, 'rejected').length };
}

export const PROPOSAL_KIND_LABELS: Record<string, string> = {
  memory: 'Memory',
  rule: 'Rule',
  new_skill: 'New skill',
  skill_patch: 'Skill patch',
  goal: 'Goal',
};

export const PROPOSAL_KIND_HINTS: Record<string, string> = {
  memory: 'A durable fact the bot will remember.',
  rule: 'An allow rule for this bot, with an expiry.',
  new_skill: 'A drafted SKILL.md the bot can reuse.',
  skill_patch: 'A lesson appended to an existing skill.',
  goal: 'A suggested goal.',
};

/** Only text-bodied proposals take an edit before approval; a rule proposal is built from its payload. */
export const canEditProposalBody = (kind: BotProposalKind | string): boolean => kind === 'memory' || kind === 'new_skill' || kind === 'skill_patch';

export const confidencePercent = (confidence: number): number => (Number.isFinite(confidence) ? Math.round(Math.min(1, Math.max(0, confidence)) * 100) : 0);

export function confidenceTone(confidence: number): 'high' | 'medium' | 'low' {
  const pct = confidencePercent(confidence);
  return pct >= 75 ? 'high' : pct >= 50 ? 'medium' : 'low';
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Loud warning for a rule proposal that would let this bot skip approval on a high-risk action. */
export function proposalFloorWarning(proposal: Pick<BotProposal, 'kind' | 'payload'>): string | null {
  if (proposal.kind !== 'rule' || proposal.payload?.floor !== true) return null;
  const risk = str(proposal.payload.risk);
  return `Approving this lets the bot ${risk ? `run ${risk} actions` : 'take a high-risk action'} on ${str(proposal.payload.server) || 'this server'} without asking you. It is a safety-floor risk. Review the evidence before you approve.`;
}

/** "gmail · send_email (send), allow for 30 days" for a rule proposal. */
export function ruleProposalSummary(proposal: Pick<BotProposal, 'kind' | 'payload'>): string | null {
  if (proposal.kind !== 'rule') return null;
  const p = proposal.payload ?? {};
  const target = [str(p.server), str(p.tool)].filter(Boolean).join(' · ');
  if (!target) return null;
  const risk = str(p.risk) ? ` (${str(p.risk)})` : '';
  const days = typeof p.expires_days === 'number' ? `${p.expires_days} days` : '30 days';
  return `Allow ${target}${risk} for ${days}`;
}

export type EvidenceKind = 'episode' | 'decision' | 'item' | 'other';
export type EvidenceRef = { id: string; kind: EvidenceKind; short: string };

/** Classify evidence ids against the ids the tab already has loaded; unknown ids are "item" (board item). */
export function evidenceRefs(evidence: unknown[], known: { episodes?: Iterable<string>; decisions?: Iterable<string> } = {}): EvidenceRef[] {
  const episodes = new Set(known.episodes ?? []);
  const decisions = new Set(known.decisions ?? []);
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const entry of evidence) {
    if (typeof entry !== 'string' || !entry || seen.has(entry)) continue;
    seen.add(entry);
    const kind: EvidenceKind = episodes.has(entry) ? 'episode' : decisions.has(entry) ? 'decision' : 'item';
    out.push({ id: entry, kind, short: entry.length > 10 ? `${entry.slice(0, 8)}…` : entry });
  }
  return out;
}

// ---- skills --------------------------------------------------------------------------------

export const SKILL_ORIGINS = ['manual', 'reflector', 'teach', 'catalog'] as const;

export const SKILL_ORIGIN_LABELS: Record<string, string> = {
  manual: 'Manual',
  reflector: 'Reflector',
  teach: 'Teach',
  catalog: 'Catalog',
};

export const SKILL_ORIGIN_TONES: Record<string, string> = {
  manual: 'bg-muted text-muted-foreground',
  reflector: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  teach: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  catalog: 'bg-primary/10 text-primary',
};

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SKILL_BYTES = 64 * 1024;

export function slugifySkillName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
}

export function validateSkillName(name: string): string | null {
  if (!name) return 'Give the skill a name.';
  if (!SKILL_NAME_PATTERN.test(name)) return 'Use lowercase letters, digits and dashes (max 64 characters).';
  return null;
}

export function skillContentProblem(content: string): string | null {
  if (!content.trim()) return 'The skill needs content.';
  if (new TextEncoder().encode(content).length > MAX_SKILL_BYTES) return 'The skill is larger than 64 KB.';
  return null;
}

export function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: One line on when the bot should use this skill.\n---\n\n# ${name}\n\n## When to use\n\n## Steps\n\n1. \n\n## Approval boundaries\n\nNever send, publish or delete without asking first.\n`;
}

/** Enabled skills first, then by name. */
export function sortSkills(skills: BotSkill[]): BotSkill[] {
  return [...skills].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

// ---- teach mode ----------------------------------------------------------------------------

/** Comma or newline separated selectors. */
export function parseSafeFields(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((part) => part.trim()).filter(Boolean))];
}

/** "1, 3" -> [1, 3]; an error string when a part is not a positive whole number. */
export function parseSafeSteps(text: string): number[] | { error: string } {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const steps: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1) return { error: `"${part}" is not a step number (use 1, 2, 3...).` };
    steps.push(n);
  }
  return [...new Set(steps)];
}

// ---- operator profile ----------------------------------------------------------------------

const PROFILE_KEY = /^[\p{L}\p{N}_ .-]{1,80}$/u;
export const MAX_PROFILE_VALUE = 500;

export function validateProfileEntry(key: string, value: string): string | null {
  if (!PROFILE_KEY.test(key.trim())) return 'The key can use letters, digits, spaces, dots and dashes (max 80 characters).';
  if (!value.trim()) return 'Enter a value.';
  if (value.trim().length > MAX_PROFILE_VALUE) return `The value is over ${MAX_PROFILE_VALUE} characters.`;
  return null;
}

export const sortProfile = (entries: BotOperatorProfileEntry[]): BotOperatorProfileEntry[] => [...entries].sort((a, b) => a.key.localeCompare(b.key));

// ---- privacy -------------------------------------------------------------------------------

export const PURGE_ITEMS: Array<{ key: keyof BotPurgeSelection; label: string; description: string }> = [
  { key: 'memories', label: 'Memories', description: 'What the bot has learned about you and its work.' },
  { key: 'episodes', label: 'Episodes', description: 'Every wake: events, plan, actions and outcome.' },
  { key: 'events', label: 'Events', description: 'The signals that woke the bot.' },
  { key: 'threads', label: 'Conversation', description: 'Your thread with this bot.' },
  { key: 'proposals', label: 'Proposals', description: 'Pending and decided learning proposals.' },
  { key: 'skills', label: 'Skills', description: 'Skill files and links (catalog skills are only unlinked).' },
];

export const selectedPurgeKeys = (selection: BotPurgeSelection): Array<keyof BotPurgeSelection> =>
  PURGE_ITEMS.map((item) => item.key).filter((key) => selection[key] === true);

/** The phrase to type before a purge is enabled: the bot's title, or "purge" when it has none. */
export const purgePhrase = (title: string): string => title.trim() || 'purge';

export function canPurge(selection: BotPurgeSelection, typed: string, phrase: string): boolean {
  return selectedPurgeKeys(selection).length > 0 && typed.trim() === phrase;
}

export function purgeSummary(counts: BotPurgeCounts): string {
  const parts = PURGE_ITEMS.filter((item) => typeof counts[item.key] === 'number' && counts[item.key] > 0).map((item) => `${counts[item.key]} ${item.label.toLowerCase()}`);
  return parts.length ? `Deleted ${parts.join(', ')}.` : 'Nothing matched; no data was deleted.';
}

export function exportFilename(botId: string, now = new Date()): string {
  return `bot-${botId.replace(/[^A-Za-z0-9_-]+/g, '-')}-export-${now.toISOString().slice(0, 10)}.json`;
}
