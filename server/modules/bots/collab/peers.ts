/** Peer context: what the operator sees (routes) and what a bot sees (perceive section). */

import { getConnection } from '@/modules/database/index.js';
import { missionControlDb } from '@/modules/mission-control/index.js';
import { parseJsonObject } from '@/modules/bots/bots.util.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botTeamsDb } from '@/modules/bots/collab/bot-teams.repository.js';
import { botSpacesDb } from '@/modules/bots/collab/bot-spaces.repository.js';

const MEMBER_SUMMARY_CHARS = 200;
const MAX_MEMBERS_SHOWN = 6;
const MAX_TEAMS_SHOWN = 3;

export interface PeerTrafficEntry {
  event_id: string;
  direction: 'in' | 'out';
  other_bot_id: string;
  kind: string;
  type: string;
  status: string;
  received_at: string;
  correlation_id: string | null;
  preview: string;
}

type TrafficRow = {
  event_id: string;
  bot_id: string;
  source: string;
  kind: string;
  status: string;
  payload_json: string;
  received_at: string;
};

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Recent ask/handoff/reply events this bot received or sent. */
export function recentPeerTraffic(botId: string, limit = 50): PeerTrafficEntry[] {
  const rows = getConnection()
    .prepare(
      `SELECT event_id, bot_id, source, kind, status, payload_json, received_at FROM bot_events
       WHERE kind IN ('ask_bot', 'peer_message') AND (bot_id = ? OR source = ? OR source = ?)
       ORDER BY received_at DESC, event_id DESC LIMIT ?`,
    )
    .all(botId, `bot:${botId}`, `bot:${botId}:reply`, Math.max(1, Math.min(200, limit))) as TrafficRow[];
  return rows.map((row) => {
    const payload = parseJsonObject(row.payload_json);
    const outbound = row.bot_id !== botId;
    const fromId = typeof payload.from_bot_id === 'string' ? payload.from_bot_id : row.source.replace(/^bot:/, '').replace(/:reply$/, '');
    const preview = String(payload.question ?? payload.answer ?? payload.title ?? '');
    return {
      event_id: row.event_id,
      direction: outbound ? 'out' : 'in',
      other_bot_id: outbound ? row.bot_id : fromId,
      kind: row.kind,
      type: typeof payload.type === 'string' ? payload.type : row.kind,
      status: row.status,
      received_at: row.received_at,
      correlation_id: typeof payload.correlation_id === 'string' ? payload.correlation_id : null,
      preview: oneLine(preview, 200),
    };
  });
}

export interface CollabPerceiveContext {
  botId?: string;
  section?: { section_id: string };
}

/**
 * Team + peer context for the kernel prompt. Empty string when the bot is in no team and owns
 * no space. Member summaries are other bots' episode text, so episodes that read external
 * content are shown without their text (they could carry injected instructions).
 */
export function collabPerceiveSection(ctx: CollabPerceiveContext): string {
  const botId = ctx.botId ?? ctx.section?.section_id;
  if (!botId) return '';
  const teams = botTeamsDb.listForBot(botId).slice(0, MAX_TEAMS_SHOWN);
  const spaces = botSpacesDb.list(botId);
  if (teams.length === 0 && spaces.length === 0) return '';

  const lines: string[] = [];
  for (const team of teams) {
    const mine = team.members.find((member) => member.bot_id === botId);
    lines.push(`TEAM "${oneLine(team.name, 80)}"${team.coordinator_bot_id === botId ? ' (you coordinate this team)' : ''}`);
    if (team.goal) lines.push(`Goal: ${oneLine(team.goal, 400)}`);
    if (mine?.role) lines.push(`Your role: ${oneLine(mine.role, 200)}`);
    const others = team.members.filter((member) => member.bot_id !== botId).slice(0, MAX_MEMBERS_SHOWN);
    if (others.length > 0) lines.push('Teammates:');
    for (const member of others) {
      const section = missionControlDb.getSection(member.bot_id);
      const title = section?.title ?? member.bot_id;
      const tags = [member.role ? oneLine(member.role, 80) : '', team.coordinator_bot_id === member.bot_id ? 'coordinator' : '', section && !section.enabled ? 'disabled' : '']
        .filter(Boolean)
        .join(', ');
      const last = botEpisodesDb.list(member.bot_id, 1)[0];
      let recent = 'no episodes yet';
      if (last) recent = last.tainted ? 'last episode read external content (summary withheld)' : oneLine(last.summary, MEMBER_SUMMARY_CHARS) || 'no summary';
      lines.push(`- ${title}${tags ? ` (${tags})` : ''} [id ${member.bot_id}]: ${recent}`);
    }
  }
  if (teams.length > 0) {
    lines.push(
      'Coordinate with teammates through tools: bot__ask_bot {bot, question, wait_seconds?} asks a teammate and returns their answer; bot__handoff {bot, title, body, context?} puts a task in their queue. Replies and handoffs arrive later as peer_message events. Do not ping-pong: each request chain is limited to 3 hops.',
    );
  }
  if (spaces.length > 0) {
    lines.push('YOUR SPACES (living documents you own; update them with bot__space_write, read with bot__space_read):');
    for (const space of spaces.slice(0, 10)) lines.push(`- ${oneLine(space.title, 80)} [id ${space.space_id}], updated ${space.updated_at}`);
  }
  return lines.join('\n');
}
