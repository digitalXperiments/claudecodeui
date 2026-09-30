/** Teams: 2-6 bots with a shared goal and a coordinator. Validation lives here; storage in bot-teams.repository. */

import { missionControlDb } from '@/modules/mission-control/index.js';
import { AppError } from '@/shared/utils.js';
import type { BotTeam } from '@/modules/bots/bots.types.js';
import { thread } from '@/modules/bots/channels/thread.service.js';
import { botTeamsDb } from '@/modules/bots/collab/bot-teams.repository.js';

export const MAX_TEAM_MEMBERS = 6;
const MAX_NAME = 80;
const MAX_GOAL = 1_000;
const MAX_ROLE = 200;
const MAX_NOTE = 2_000;

const invalid = (message: string): AppError => new AppError(message, { code: 'BOT_TEAM_INVALID', statusCode: 400 });
const notFound = (what = 'Team'): AppError => new AppError(`${what} not found`, { code: 'BOT_NOT_FOUND', statusCode: 404 });

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  const trimmed = value.trim().slice(0, max);
  if (required && !trimmed) throw invalid(`${field} is required.`);
  return trimmed;
}

function requireBot(botId: string): void {
  if (!missionControlDb.getSection(botId)) throw notFound(`Bot ${botId}`);
}

function requireTeam(teamId: string): BotTeam {
  const team = botTeamsDb.get(teamId);
  if (!team) throw notFound();
  return team;
}

function assertUniqueName(name: string, exceptTeamId?: string): void {
  const clash = botTeamsDb.list().find((team) => team.team_id !== exceptTeamId && team.name.toLowerCase() === name.toLowerCase());
  if (clash) throw invalid(`A team named "${name}" already exists.`);
}

export interface TeamCreateInput {
  name?: unknown;
  goal?: unknown;
  coordinator_bot_id?: unknown;
  members?: unknown;
}

export const teams = {
  list: (): BotTeam[] => botTeamsDb.list(),
  listForBot: (botId: string): BotTeam[] => botTeamsDb.listForBot(botId),
  get: (teamId: string): BotTeam => requireTeam(teamId),

  create(input: TeamCreateInput): BotTeam {
    const name = text(input.name, 'name', MAX_NAME, true)!;
    const goal = text(input.goal, 'goal', MAX_GOAL) ?? '';
    assertUniqueName(name);
    const rawMembers = input.members === undefined ? [] : input.members;
    if (!Array.isArray(rawMembers)) throw invalid('members must be an array.');
    const members: { botId: string; role: string }[] = [];
    for (const entry of rawMembers) {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      const botId = text(record.bot_id, 'members[].bot_id', 200, true)!;
      if (members.some((member) => member.botId === botId)) throw invalid(`Duplicate member ${botId}.`);
      requireBot(botId);
      members.push({ botId, role: text(record.role, 'members[].role', MAX_ROLE) ?? '' });
    }
    if (members.length > MAX_TEAM_MEMBERS) throw invalid(`A team holds at most ${MAX_TEAM_MEMBERS} bots.`);
    const coordinator = text(input.coordinator_bot_id, 'coordinator_bot_id', 200) || null;
    if (coordinator && !members.some((member) => member.botId === coordinator)) {
      throw invalid('The coordinator must be a member of the team.');
    }
    return botTeamsDb.create({ name, goal, coordinatorBotId: coordinator, members });
  },

  update(teamId: string, patch: { name?: unknown; goal?: unknown; coordinator_bot_id?: unknown }): BotTeam {
    const team = requireTeam(teamId);
    const name = text(patch.name, 'name', MAX_NAME);
    if (name !== undefined) {
      if (!name) throw invalid('name cannot be empty.');
      assertUniqueName(name, teamId);
    }
    let coordinator: string | null | undefined;
    if (patch.coordinator_bot_id !== undefined) {
      coordinator = patch.coordinator_bot_id === null ? null : text(patch.coordinator_bot_id, 'coordinator_bot_id', 200) || null;
      if (coordinator && !team.members.some((member) => member.bot_id === coordinator)) {
        throw invalid('The coordinator must be a member of the team.');
      }
    }
    return botTeamsDb.update(teamId, { name, goal: text(patch.goal, 'goal', MAX_GOAL), coordinatorBotId: coordinator })!;
  },

  remove(teamId: string): boolean {
    requireTeam(teamId);
    return botTeamsDb.delete(teamId);
  },

  /** Adds a member, or updates the role of an existing one. */
  addMember(teamId: string, botId: unknown, role?: unknown): BotTeam {
    const team = requireTeam(teamId);
    const id = text(botId, 'bot_id', 200, true)!;
    requireBot(id);
    const isNew = !team.members.some((member) => member.bot_id === id);
    if (isNew && team.members.length >= MAX_TEAM_MEMBERS) throw invalid(`A team holds at most ${MAX_TEAM_MEMBERS} bots.`);
    const existingRole = team.members.find((member) => member.bot_id === id)?.role ?? '';
    return botTeamsDb.addMember(teamId, id, text(role, 'role', MAX_ROLE) ?? existingRole)!;
  },

  /** Removing the coordinator clears the coordinator slot. */
  removeMember(teamId: string, botId: string): BotTeam {
    const team = requireTeam(teamId);
    if (!team.members.some((member) => member.bot_id === botId)) throw notFound('Member');
    botTeamsDb.removeMember(teamId, botId);
    if (team.coordinator_bot_id === botId) botTeamsDb.update(teamId, { coordinatorBotId: null });
    return botTeamsDb.get(teamId)!;
  },

  setCoordinator(teamId: string, botId: unknown): BotTeam {
    const team = requireTeam(teamId);
    const id = text(botId, 'bot_id', 200, true)!;
    if (!team.members.some((member) => member.bot_id === id)) throw invalid('The coordinator must be a member of the team.');
    return botTeamsDb.update(teamId, { coordinatorBotId: id })!;
  },

  /** Operator message into the coordinator's thread (so its reply lands there too). Returns the coordinator id. */
  wake(teamId: string, note: unknown): { team: BotTeam; coordinatorBotId: string; messageId: string } {
    const team = requireTeam(teamId);
    if (!team.coordinator_bot_id) throw invalid('This team has no coordinator to wake.');
    const extra = text(note, 'note', MAX_NOTE) ?? '';
    const body = [`[Team wake: ${team.name}]`, team.goal ? `Team goal: ${team.goal}` : '', extra ? `Operator note: ${extra}` : '']
      .filter(Boolean)
      .join('\n');
    const message = thread.postOperatorMessage(team.coordinator_bot_id, body, 'inapp', { team_id: team.team_id });
    return { team, coordinatorBotId: team.coordinator_bot_id, messageId: message.message_id };
  },
};
