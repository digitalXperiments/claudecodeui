import { getConnection } from '@/modules/database/index.js';
import { newBotTeamId } from '@/shared/ids.js';
import { nowIso } from '@/modules/bots/bots.util.js';
import type { BotTeam, BotTeamMember } from '@/modules/bots/bots.types.js';

type TeamRow = {
  team_id: string;
  name: string;
  goal: string;
  coordinator_bot_id: string | null;
  created_at: string;
  updated_at: string;
};

function loadMembers(teamId: string): BotTeamMember[] {
  return getConnection()
    .prepare('SELECT team_id, bot_id, role FROM bot_team_members WHERE team_id = ? ORDER BY bot_id ASC')
    .all(teamId) as BotTeamMember[];
}

function mapTeam(row: TeamRow): BotTeam {
  return { ...row, members: loadMembers(row.team_id) };
}

export interface CreateBotTeamInput {
  name: string;
  goal?: string;
  coordinatorBotId?: string | null;
  members?: { botId: string; role?: string }[];
}

export const botTeamsDb = {
  get(teamId: string): BotTeam | null {
    const row = getConnection().prepare('SELECT * FROM bot_teams WHERE team_id = ?').get(teamId) as TeamRow | undefined;
    return row ? mapTeam(row) : null;
  },

  list(): BotTeam[] {
    const rows = getConnection().prepare('SELECT * FROM bot_teams ORDER BY created_at ASC').all() as TeamRow[];
    return rows.map(mapTeam);
  },

  listForBot(botId: string): BotTeam[] {
    const rows = getConnection()
      .prepare(
        `SELECT t.* FROM bot_teams t JOIN bot_team_members m ON m.team_id = t.team_id
         WHERE m.bot_id = ? ORDER BY t.created_at ASC`,
      )
      .all(botId) as TeamRow[];
    return rows.map(mapTeam);
  },

  create(input: CreateBotTeamInput): BotTeam {
    const db = getConnection();
    const id = newBotTeamId();
    const ts = nowIso();
    db.transaction(() => {
      db.prepare(
        'INSERT INTO bot_teams (team_id, name, goal, coordinator_bot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, input.name, input.goal ?? '', input.coordinatorBotId ?? null, ts, ts);
      for (const member of input.members ?? []) {
        db.prepare('INSERT OR REPLACE INTO bot_team_members (team_id, bot_id, role) VALUES (?, ?, ?)').run(
          id,
          member.botId,
          member.role ?? '',
        );
      }
    })();
    return botTeamsDb.get(id)!;
  },

  update(teamId: string, patch: { name?: string; goal?: string; coordinatorBotId?: string | null }): BotTeam | null {
    const current = botTeamsDb.get(teamId);
    if (!current) return null;
    getConnection()
      .prepare('UPDATE bot_teams SET name = ?, goal = ?, coordinator_bot_id = ?, updated_at = ? WHERE team_id = ?')
      .run(
        patch.name ?? current.name,
        patch.goal ?? current.goal,
        patch.coordinatorBotId === undefined ? current.coordinator_bot_id : patch.coordinatorBotId,
        nowIso(),
        teamId,
      );
    return botTeamsDb.get(teamId);
  },

  addMember(teamId: string, botId: string, role = ''): BotTeam | null {
    if (!botTeamsDb.get(teamId)) return null;
    getConnection()
      .prepare('INSERT OR REPLACE INTO bot_team_members (team_id, bot_id, role) VALUES (?, ?, ?)')
      .run(teamId, botId, role);
    return botTeamsDb.get(teamId);
  },

  removeMember(teamId: string, botId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_team_members WHERE team_id = ? AND bot_id = ?').run(teamId, botId).changes > 0;
  },

  delete(teamId: string): boolean {
    const db = getConnection();
    return db.transaction((): boolean => {
      db.prepare('DELETE FROM bot_team_members WHERE team_id = ?').run(teamId);
      return db.prepare('DELETE FROM bot_teams WHERE team_id = ?').run(teamId).changes > 0;
    })();
  },
};
