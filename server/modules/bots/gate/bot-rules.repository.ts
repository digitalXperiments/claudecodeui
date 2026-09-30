import { getConnection } from '@/modules/database/index.js';
import { newBotRuleId } from '@/shared/ids.js';
import { nowIso, parseJsonObject } from '@/modules/bots/bots.util.js';
import type { BotRule, BotRuleDecision, BotRuleMatch, BotRuleScope } from '@/modules/bots/bots.types.js';

type RuleRow = {
  rule_id: string;
  scope: string;
  bot_id: string | null;
  match_json: string;
  decision: string;
  priority: number;
  created_from: string;
  note: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function mapRule(row: RuleRow): BotRule {
  return {
    rule_id: row.rule_id,
    scope: row.scope as BotRuleScope,
    bot_id: row.bot_id,
    match: parseJsonObject(row.match_json) as BotRuleMatch,
    decision: row.decision as BotRuleDecision,
    priority: row.priority,
    created_from: row.created_from,
    note: row.note,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateBotRuleInput {
  scope: BotRuleScope;
  botId?: string | null;
  match?: BotRuleMatch;
  decision: BotRuleDecision;
  priority?: number;
  createdFrom?: string;
  note?: string;
  expiresAt?: string | null;
}

export interface UpdateBotRuleInput {
  match?: BotRuleMatch;
  decision?: BotRuleDecision;
  priority?: number;
  note?: string;
  expiresAt?: string | null;
}

export const botRulesDb = {
  get(ruleId: string): BotRule | null {
    const row = getConnection().prepare('SELECT * FROM bot_rules WHERE rule_id = ?').get(ruleId) as
      | RuleRow
      | undefined;
    return row ? mapRule(row) : null;
  },

  /** Global rules plus rules scoped to `botId` (when given), highest priority first, expired rules excluded. */
  listApplicable(botId: string, now: Date = new Date()): BotRule[] {
    const rows = getConnection()
      .prepare(
        `SELECT * FROM bot_rules
         WHERE (scope = 'global' OR (scope = 'bot' AND bot_id = ?)) AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY priority DESC, created_at ASC`,
      )
      .all(botId, now.toISOString()) as RuleRow[];
    return rows.map(mapRule);
  },

  list(filter: { scope?: BotRuleScope; botId?: string } = {}): BotRule[] {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.scope) {
      clauses.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.botId) {
      clauses.push('bot_id = ?');
      params.push(filter.botId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM bot_rules ${where} ORDER BY priority DESC, created_at ASC`)
      .all(...params) as RuleRow[];
    return rows.map(mapRule);
  },

  create(input: CreateBotRuleInput): BotRule {
    const id = newBotRuleId();
    const ts = nowIso();
    getConnection()
      .prepare(
        `INSERT INTO bot_rules (rule_id, scope, bot_id, match_json, decision, priority, created_from, note, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.scope === 'bot' ? input.botId ?? null : null,
        JSON.stringify(input.match ?? {}),
        input.decision,
        input.priority ?? 0,
        input.createdFrom ?? 'manual',
        input.note ?? '',
        input.expiresAt ?? null,
        ts,
        ts,
      );
    return botRulesDb.get(id)!;
  },

  update(ruleId: string, patch: UpdateBotRuleInput): BotRule | null {
    const current = botRulesDb.get(ruleId);
    if (!current) return null;
    getConnection()
      .prepare(
        'UPDATE bot_rules SET match_json = ?, decision = ?, priority = ?, note = ?, expires_at = ?, updated_at = ? WHERE rule_id = ?',
      )
      .run(
        JSON.stringify(patch.match ?? current.match),
        patch.decision ?? current.decision,
        patch.priority ?? current.priority,
        patch.note ?? current.note,
        patch.expiresAt === undefined ? current.expires_at : patch.expiresAt,
        nowIso(),
        ruleId,
      );
    return botRulesDb.get(ruleId);
  },

  delete(ruleId: string): boolean {
    return getConnection().prepare('DELETE FROM bot_rules WHERE rule_id = ?').run(ruleId).changes > 0;
  },
};
