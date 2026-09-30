import { getConnection } from '@/modules/database/index.js';
import { newBotProposalId } from '@/shared/ids.js';
import { nowIso, parseJsonArray, parseJsonObject } from '@/modules/bots/bots.util.js';
import type { BotLearningProposal, BotProposalKind, BotProposalStatus } from '@/modules/bots/bots.types.js';

type ProposalRow = {
  proposal_id: string;
  bot_id: string;
  kind: string;
  title: string;
  body: string;
  payload_json: string;
  evidence_json: string;
  confidence: number;
  status: string;
  created_at: string;
  decided_at: string | null;
};

function mapProposal(row: ProposalRow): BotLearningProposal {
  return {
    proposal_id: row.proposal_id,
    bot_id: row.bot_id,
    kind: row.kind as BotProposalKind,
    title: row.title,
    body: row.body,
    payload: parseJsonObject(row.payload_json),
    evidence: parseJsonArray(row.evidence_json),
    confidence: row.confidence,
    status: row.status as BotProposalStatus,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

export interface CreateBotProposalInput {
  botId: string;
  kind: BotProposalKind;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  evidence?: unknown[];
  confidence?: number;
}

export const botProposalsDb = {
  get(proposalId: string): BotLearningProposal | null {
    const row = getConnection().prepare('SELECT * FROM bot_learning_proposals WHERE proposal_id = ?').get(proposalId) as
      | ProposalRow
      | undefined;
    return row ? mapProposal(row) : null;
  },

  list(botId: string, status?: BotProposalStatus): BotLearningProposal[] {
    const db = getConnection();
    const rows = (status
      ? db
          .prepare('SELECT * FROM bot_learning_proposals WHERE bot_id = ? AND status = ? ORDER BY created_at DESC, proposal_id DESC')
          .all(botId, status)
      : db
          .prepare('SELECT * FROM bot_learning_proposals WHERE bot_id = ? ORDER BY created_at DESC, proposal_id DESC')
          .all(botId)) as ProposalRow[];
    return rows.map(mapProposal);
  },

  create(input: CreateBotProposalInput): BotLearningProposal {
    const id = newBotProposalId();
    getConnection()
      .prepare(
        `INSERT INTO bot_learning_proposals (proposal_id, bot_id, kind, title, body, payload_json, evidence_json, confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      )
      .run(
        id,
        input.botId,
        input.kind,
        input.title,
        input.body ?? '',
        JSON.stringify(input.payload ?? {}),
        JSON.stringify(input.evidence ?? []),
        input.confidence ?? 0.5,
        nowIso(),
      );
    return botProposalsDb.get(id)!;
  },

  setStatus(proposalId: string, status: BotProposalStatus): BotLearningProposal | null {
    const decided = status === 'proposed' ? null : nowIso();
    const result = getConnection()
      .prepare('UPDATE bot_learning_proposals SET status = ?, decided_at = ? WHERE proposal_id = ?')
      .run(status, decided, proposalId);
    return result.changes > 0 ? botProposalsDb.get(proposalId) : null;
  },

  delete(proposalId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_learning_proposals WHERE proposal_id = ?').run(proposalId).changes > 0;
  },
};
