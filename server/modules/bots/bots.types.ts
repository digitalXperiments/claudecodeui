/** Row / domain types for the Bot Runtime v2 tables (see docs/prd/bot-runtime/IMPLEMENTATION.md). */

export type BotTrust = 'operator' | 'internal' | 'external';

export type BotTriggerKind =
  | 'cron' | 'interval' | 'nl_schedule' | 'webhook' | 'kanban_event' | 'run_completed'
  | 'interrupt_created' | 'watch' | 'peer_message' | 'ask_bot' | 'commitment_due'
  | 'operator_message' | 'manual';

export interface BotTrigger {
  trigger_id: string;
  bot_id: string;
  kind: BotTriggerKind | string;
  config: Record<string, unknown>;
  enabled: boolean;
  cursor: Record<string, unknown>;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export type BotEventStatus = 'queued' | 'claimed' | 'consumed' | 'dropped';

export interface BotEvent {
  event_id: string;
  bot_id: string;
  trigger_id: string | null;
  source: string;
  kind: string;
  dedupe_key: string | null;
  trust: BotTrust;
  payload: Record<string, unknown>;
  status: BotEventStatus;
  episode_id: string | null;
  received_at: string;
  claimed_at: string | null;
}

export interface IngestEventInput {
  botId: string;
  source: string;
  kind: string;
  triggerId?: string;
  dedupeKey?: string;
  trust: BotTrust;
  payload: Record<string, unknown>;
}

export interface BotLease {
  bot_id: string;
  holder: string;
  episode_id: string | null;
  acquired_at: string;
  expires_at: string;
}

export type BotGoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned';

export interface BotGoal {
  goal_id: string;
  bot_id: string;
  statement: string;
  success_criteria: string;
  horizon: string | null;
  status: BotGoalStatus;
  progress: Record<string, unknown>;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type BotCommitmentStatus = 'open' | 'fired' | 'done' | 'cancelled';

export interface BotCommitment {
  commitment_id: string;
  bot_id: string;
  item_id: string | null;
  goal_id: string | null;
  description: string;
  waiting_on: string | null;
  due_at: string;
  nudge_policy: Record<string, unknown>;
  status: BotCommitmentStatus;
  created_at: string;
  updated_at: string;
}

export type BotEpisodeStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface BotEpisode {
  episode_id: string;
  bot_id: string;
  status: BotEpisodeStatus;
  trigger_kinds: string;
  event_ids: string[];
  run_ids: string[];
  plan_text: string;
  summary: string;
  outcome: Record<string, unknown>;
  feedback: unknown[];
  tainted: boolean;
  cost_usd: number;
  bot_version: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface BotEpisodeSearchHit {
  episode_id: string;
  summary: string;
  score: number;
}

export type BotRuleScope = 'global' | 'bot';
export type BotRuleDecision = 'allow' | 'ask' | 'deny';

export interface BotRuleMatch {
  server?: string;
  tool?: string;
  risk?: string[];
  args?: { path: string; op: 'eq' | 'contains' | 'regex' | 'in'; value: unknown }[];
  /** An allow rule that may also approve floor-risk calls made after the run read untrusted content. */
  allow_when_tainted?: boolean;
}

export interface BotRule {
  rule_id: string;
  scope: BotRuleScope;
  bot_id: string | null;
  match: BotRuleMatch;
  decision: BotRuleDecision;
  priority: number;
  created_from: string;
  note: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotGateDecision {
  decision_id: string;
  bot_id: string;
  episode_id: string | null;
  run_id: string | null;
  server: string;
  tool: string;
  risk: string;
  args: Record<string, unknown>;
  decision: BotRuleDecision;
  decided_by: string;
  reason: string;
  interrupt_id: string | null;
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface BotBudget {
  bot_id: string;
  daily_usd: number | null;
  monthly_usd: number | null;
  daily_actions: number | null;
  max_wakes_per_hour: number | null;
  soft_ratio: number;
  updated_at: string;
}

export type BotProposalKind = 'memory' | 'skill_patch' | 'new_skill' | 'rule' | 'goal';
export type BotProposalStatus = 'proposed' | 'approved' | 'rejected' | 'applied' | 'superseded';

export interface BotLearningProposal {
  proposal_id: string;
  bot_id: string;
  kind: BotProposalKind;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  evidence: unknown[];
  confidence: number;
  status: BotProposalStatus;
  created_at: string;
  decided_at: string | null;
}

export interface BotSkill {
  link_id: string;
  bot_id: string;
  name: string;
  path: string;
  origin: string;
  version: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BotChannelPolicy {
  quiet_hours?: { start: string; end: string; tz?: string };
  max_pings_per_day?: number;
  min_urgency?: number;
  digest?: boolean;
}

export interface BotChannel {
  channel_id: string;
  bot_id: string | null;
  kind: string;
  config: Record<string, unknown>;
  policy: BotChannelPolicy;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type BotThreadRole = 'operator' | 'bot' | 'system';

export interface BotThreadMessage {
  message_id: string;
  bot_id: string;
  role: BotThreadRole;
  body: string;
  channel: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface BotOutboundLogEntry {
  bot_id: string | null;
  channel_kind: string;
  urgency: number;
  delivered: boolean;
  reason: string | null;
  created_at: string;
}

export interface BotTeamMember {
  team_id: string;
  bot_id: string;
  role: string;
}

export interface BotTeam {
  team_id: string;
  name: string;
  goal: string;
  coordinator_bot_id: string | null;
  members: BotTeamMember[];
  created_at: string;
  updated_at: string;
}

export interface BotSpace {
  space_id: string;
  bot_id: string;
  title: string;
  path: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface BotOperatorProfileEntry {
  key: string;
  value: string;
  source: string;
  updated_at: string;
}
