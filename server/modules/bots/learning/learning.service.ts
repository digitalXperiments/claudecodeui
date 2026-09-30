/**
 * Learning proposals: list, approve (apply) and reject. Approving applies the change to the bot
 * (memory, rule, new skill or skill patch), records a section version and broadcasts
 * `bot_proposal_updated`. Only memory proposals can ever be promoted automatically.
 */
import {
  listBotMemories,
  missionControlDb,
  proposeBotMemory,
  recordSectionVersion,
  reviewBotMemory,
} from '@/modules/mission-control/index.js';
import { broadcastSystemEvent } from '@/modules/websocket/index.js';
import { readBotRuntimeConfig } from '@/modules/bots/bots-runtime-config.js';
import type { BotLearningProposal, BotProposalStatus } from '@/modules/bots/bots.types.js';
import { rules } from '@/modules/bots/gate/rules.service.js';
import { botProposalsDb } from '@/modules/bots/learning/bot-proposals.repository.js';
import { isHiddenProposal } from '@/modules/bots/learning/feedback.js';
import { DAY_MS, learningError } from '@/modules/bots/learning/learning.util.js';
import { skills } from '@/modules/bots/learning/skills.service.js';

const STATUSES: BotProposalStatus[] = ['proposed', 'approved', 'rejected', 'applied', 'superseded'];
const RULE_EXPIRY_DAYS = 30;

function broadcast(proposal: BotLearningProposal): void {
  try {
    broadcastSystemEvent({ kind: 'bot_proposal_updated', bot_id: proposal.bot_id, proposal_id: proposal.proposal_id, status: proposal.status });
  } catch (error) {
    console.warn('[bots] proposal broadcast failed', error instanceof Error ? error.message : error);
  }
}

/** Snapshot the bot after a learned change. Memory changes alter the snapshot; others may map to the same version. */
function recordVersion(botId: string): void {
  const section = missionControlDb.getSection(botId);
  if (section) recordSectionVersion(section, 'edited');
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function applyProposal(proposal: BotLearningProposal, editedBody?: string): void {
  const botId = proposal.bot_id;
  const body = editedBody?.trim();
  switch (proposal.kind) {
    case 'memory': {
      const content = body || text(proposal.payload.content) || proposal.body;
      const duplicate = listBotMemories(botId).find((m) => m.status === 'approved' && m.content === content.trim());
      if (!duplicate) {
        const memory = proposeBotMemory(botId, content, null);
        reviewBotMemory(botId, memory.memoryId, 'approved');
      }
      return;
    }
    case 'rule': {
      const server = text(proposal.payload.server);
      const tool = text(proposal.payload.tool);
      if (!server || !tool) throw learningError('Rule proposal is missing server or tool');
      const days = typeof proposal.payload.expires_days === 'number' ? proposal.payload.expires_days : RULE_EXPIRY_DAYS;
      rules.create({
        scope: 'bot',
        botId,
        match: { server, tool },
        decision: 'allow',
        createdFrom: 'manual',
        note: 'learned',
        expiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
      });
      return;
    }
    case 'new_skill': {
      const name = text(proposal.payload.name);
      const content = body || text(proposal.payload.content);
      if (!name || !content) throw learningError('Skill proposal is missing its draft');
      if (skills.list(botId).some((s) => s.name === name)) throw learningError(`A skill named "${name}" already exists`, 409);
      skills.save(botId, { name, content, description: text(proposal.payload.description) || undefined, origin: 'reflector' });
      return;
    }
    case 'skill_patch': {
      const name = text(proposal.payload.skill);
      const note = body || text(proposal.payload.note);
      if (!name || !note) throw learningError('Skill patch is missing its target or note');
      skills.appendLesson(botId, name, note);
      return;
    }
    default:
      throw learningError(`Proposals of kind "${proposal.kind}" cannot be applied`);
  }
}

export const learning = {
  get(proposalId: string): BotLearningProposal | null {
    const proposal = botProposalsDb.get(proposalId);
    return proposal && !isHiddenProposal(proposal) ? proposal : null;
  },

  list(botId: string, filter: { status?: string } = {}): BotLearningProposal[] {
    if (filter.status && !STATUSES.includes(filter.status as BotProposalStatus)) throw learningError('Invalid proposal status');
    return botProposalsDb.list(botId, filter.status as BotProposalStatus | undefined).filter((p) => !isHiddenProposal(p));
  },

  approve(proposalId: string, options: { editedBody?: string } = {}): BotLearningProposal {
    const proposal = learning.get(proposalId);
    if (!proposal) throw learningError('Proposal not found', 404, 'BOT_PROPOSAL_NOT_FOUND');
    if (proposal.status !== 'proposed') throw learningError(`Proposal is already ${proposal.status}`, 409);
    applyProposal(proposal, options.editedBody);
    const applied = botProposalsDb.setStatus(proposalId, 'applied') ?? proposal;
    recordVersion(proposal.bot_id);
    broadcast(applied);
    return applied;
  },

  reject(proposalId: string): BotLearningProposal {
    const proposal = learning.get(proposalId);
    if (!proposal) throw learningError('Proposal not found', 404, 'BOT_PROPOSAL_NOT_FOUND');
    if (proposal.status !== 'proposed') throw learningError(`Proposal is already ${proposal.status}`, 409);
    const rejected = botProposalsDb.setStatus(proposalId, 'rejected') ?? proposal;
    broadcast(rejected);
    return rejected;
  },

  supersede(proposalId: string): void {
    const updated = botProposalsDb.setStatus(proposalId, 'superseded');
    if (updated) broadcast(updated);
  },

  /** Apply a fresh memory proposal when the bot opted in via runtime_json.learning. Never for rules or skills. */
  maybeAutoPromote(proposal: BotLearningProposal): BotLearningProposal {
    if (proposal.kind !== 'memory') return proposal;
    const threshold = readBotRuntimeConfig(proposal.bot_id)?.learning?.auto_promote_memory_min_confidence;
    if (typeof threshold !== 'number' || proposal.confidence < threshold) return proposal;
    try {
      return learning.approve(proposal.proposal_id);
    } catch (error) {
      console.warn('[bots] auto-promotion skipped', error instanceof Error ? error.message : error);
      return proposal;
    }
  },

  announce(proposal: BotLearningProposal): void {
    broadcast(proposal);
  },
};
