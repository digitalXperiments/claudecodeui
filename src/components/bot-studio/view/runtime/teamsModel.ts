/** Pure helpers for the Teams view: membership rules, draft validation, spaces + peer traffic shaping. */

import type { BotPeerTraffic, BotSpace, BotTeam } from '../../types/botRuntime';

/** Mirrors MAX_TEAM_MEMBERS in server/modules/bots/collab/teams.service.ts. */
export const MAX_TEAM_MEMBERS = 6;
export const MAX_TEAM_NAME = 80;
export const MAX_TEAM_GOAL = 1_000;
export const MAX_ROLE = 200;
export const MAX_WAKE_NOTE = 2_000;

export type BotOption = { section_id: string; title: string };

export function canAddMember(team: Pick<BotTeam, 'members'>): boolean {
  return team.members.length < MAX_TEAM_MEMBERS;
}

/** Bots that are not yet on the team, alphabetical by title. */
export function addableBots<T extends BotOption>(bots: T[], team: Pick<BotTeam, 'members'>): T[] {
  const taken = new Set(team.members.map((member) => member.bot_id));
  return bots.filter((bot) => !taken.has(bot.section_id)).sort((a, b) => a.title.localeCompare(b.title));
}

export type TeamDraft = { name: string; goal: string };

/** Returns an error string, or null. `taken` are the other teams' names (server enforces uniqueness, case-insensitively). */
export function validateTeamDraft(draft: TeamDraft, taken: string[] = []): string | null {
  const name = draft.name.trim();
  if (!name) return 'A team needs a name.';
  if (name.length > MAX_TEAM_NAME) return `Team name is limited to ${MAX_TEAM_NAME} characters.`;
  if (draft.goal.trim().length > MAX_TEAM_GOAL) return `Team goal is limited to ${MAX_TEAM_GOAL} characters.`;
  if (taken.some((entry) => entry.trim().toLowerCase() === name.toLowerCase())) return `A team named "${name}" already exists.`;
  return null;
}

export type TeamMemberRow = { botId: string; title: string; role: string; isCoordinator: boolean };

/** Coordinator first, then alphabetical. */
export function memberRows(team: BotTeam, titleOf: (botId: string) => string): TeamMemberRow[] {
  return team.members
    .map((member) => ({ botId: member.bot_id, title: titleOf(member.bot_id), role: member.role, isCoordinator: member.bot_id === team.coordinator_bot_id }))
    .sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator) || a.title.localeCompare(b.title));
}

/** Why "Wake team" is unavailable, or null when it can be used. */
export function wakeBlockedReason(team: BotTeam): string | null {
  if (!team.coordinator_bot_id) return 'Choose a coordinator before waking the team.';
  if (!team.members.some((member) => member.bot_id === team.coordinator_bot_id)) return 'The coordinator is no longer a member of this team.';
  return null;
}

// ---- spaces ---------------------------------------------------------------------------------------

export function validateSpaceTitle(title: string): string | null {
  const value = title.trim();
  if (!value) return 'A space needs a title.';
  if (value.length > 120) return 'Space title is limited to 120 characters.';
  return null;
}

/** `/a/b/notes.md` -> `notes.md` (the path is shown as context, never edited). */
export function spaceFileName(space: Pick<BotSpace, 'path'>): string {
  const parts = space.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? space.path;
}

/** Newest first. */
export function sortSpaces(spaces: BotSpace[]): BotSpace[] {
  return [...spaces].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** GET /space-roots returns strings; ignore anything else the server might add later. */
export function rootOptions(roots: unknown[]): string[] {
  return roots.filter((root): root is string => typeof root === 'string' && root.trim() !== '');
}

// ---- peers ----------------------------------------------------------------------------------------

export type PeerRow = BotPeerTraffic & { otherTitle: string; directionLabel: string };

export function peerRows(traffic: BotPeerTraffic[], titleOf: (botId: string) => string): PeerRow[] {
  return [...traffic]
    .sort((a, b) => b.received_at.localeCompare(a.received_at))
    .map((entry) => ({
      ...entry,
      otherTitle: titleOf(entry.other_bot_id),
      directionLabel: entry.direction === 'out' ? 'Sent to' : 'Received from',
    }));
}
