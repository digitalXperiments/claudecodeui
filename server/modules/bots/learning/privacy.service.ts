/**
 * Privacy: export everything a bot knows as JSON, and selectively purge it (including FTS rows and
 * skill files). Secrets in the bot config are masked in exports.
 */
import fs from 'node:fs';
import path from 'node:path';

import { deleteBotMemories, listBotMemories, missionControlDb } from '@/modules/mission-control/index.js';
import { getConnection } from '@/modules/database/index.js';
import { readBotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
import { resolveBotHome } from '@/modules/bots/bots-home.js';
import { botThreadDb } from '@/modules/bots/channels/bot-thread.repository.js';
import { botGateDecisionsDb } from '@/modules/bots/gate/bot-gate-decisions.repository.js';
import { rules } from '@/modules/bots/gate/rules.service.js';
import { botCommitmentsDb } from '@/modules/bots/kernel/bot-commitments.repository.js';
import { botEpisodesDb } from '@/modules/bots/kernel/bot-episodes.repository.js';
import { botGoalsDb } from '@/modules/bots/kernel/bot-goals.repository.js';
import { botProposalsDb } from '@/modules/bots/learning/bot-proposals.repository.js';
import { botSkillsDb } from '@/modules/bots/learning/bot-skills.repository.js';
import { isHiddenProposal, readBotFeedbackLog } from '@/modules/bots/learning/feedback.js';
import { learningError, redactSecrets } from '@/modules/bots/learning/learning.util.js';
import { skills } from '@/modules/bots/learning/skills.service.js';
import { botEventsDb } from '@/modules/bots/signals/bot-events.repository.js';

const EXPORT_LIMIT = 100_000;

export interface PurgeSelection {
  memories?: boolean;
  episodes?: boolean;
  events?: boolean;
  threads?: boolean;
  proposals?: boolean;
  skills?: boolean;
}

export type PurgeCounts = Record<keyof PurgeSelection, number>;

function requireBot(botId: string) {
  const section = missionControlDb.getSection(botId);
  if (!section) throw learningError('Bot not found', 404, 'BOT_NOT_FOUND');
  return section;
}

function readSkillContent(botId: string, name: string): string | null {
  try {
    return skills.get(botId, name).content;
  } catch {
    return null;
  }
}

export const privacy = {
  exportBot(botId: string): Record<string, unknown> {
    const section = requireBot(botId);
    const proposals = botProposalsDb.list(botId);
    return {
      exported_at: new Date().toISOString(),
      bot_id: botId,
      section: redactSecrets(section),
      runtime: redactSecrets(readBotRuntimeConfig(botId) ?? {}),
      goals: botGoalsDb.list(botId),
      commitments: botCommitmentsDb.list(botId),
      episodes: botEpisodesDb.list(botId, EXPORT_LIMIT),
      events: botEventsDb.listRecent(botId, EXPORT_LIMIT),
      memories: listBotMemories(botId),
      rules: rules.list({ botId }),
      gate_decisions: botGateDecisionsDb.listForBot(botId, EXPORT_LIMIT).map((d) => ({ ...d, args: redactSecrets(d.args) })),
      skills: botSkillsDb.list(botId).map((skill) => ({ ...skill, content: readSkillContent(botId, skill.name) })),
      thread: botThreadDb.list(botId, { limit: EXPORT_LIMIT }),
      proposals: proposals.filter((p) => !isHiddenProposal(p)),
      feedback_log: readBotFeedbackLog(botId),
    };
  },

  purgeBot(botId: string, selection: PurgeSelection): PurgeCounts {
    requireBot(botId);
    const db = getConnection();
    const counts: PurgeCounts = { memories: 0, episodes: 0, events: 0, threads: 0, proposals: 0, skills: 0 };
    if (selection.memories) counts.memories = deleteBotMemories(botId);
    if (selection.episodes) {
      db.transaction(() => {
        db.prepare('DELETE FROM bot_episodes_fts WHERE bot_id = ?').run(botId);
        counts.episodes = db.prepare('DELETE FROM bot_episodes WHERE bot_id = ?').run(botId).changes;
      })();
    }
    if (selection.events) counts.events = db.prepare('DELETE FROM bot_events WHERE bot_id = ?').run(botId).changes;
    if (selection.threads) counts.threads = botThreadDb.deleteForBot(botId);
    if (selection.proposals) counts.proposals = botProposalsDb.deleteForBot(botId);
    if (selection.skills) {
      const rows = botSkillsDb.list(botId);
      for (const skill of rows) botSkillsDb.delete(skill.link_id);
      counts.skills = rows.length;
      // The whole skills directory goes, including files that never had a link row.
      const skillsDir = path.join(resolveBotHome(botId), 'skills');
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
    return counts;
  },
};
