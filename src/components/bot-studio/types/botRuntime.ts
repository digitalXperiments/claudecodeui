/**
 * Client mirrors of the Bot Runtime v2 server domain types (server/modules/bots/bots.types.ts and
 * the route response shapes). Copied, not imported: the client never reaches into server code.
 * Keep in sync with the server when a row shape changes.
 */

export type BotTrust = 'operator' | 'internal' | 'external';

// ---- signals ------------------------------------------------------------------------------------

export type BotTriggerKind =
  | 'cron' | 'interval' | 'nl_schedule' | 'webhook' | 'kanban_event' | 'run_completed'
  | 'interrupt_created' | 'watch' | 'peer_message' | 'ask_bot' | 'commitment_due'
  | 'operator_message' | 'manual';

export type BotTrigger = {
  trigger_id: string;
  bot_id: string;
  kind: BotTriggerKind | string;
  config: Record<string, unknown>;
  enabled: boolean;
  cursor: Record<string, unknown>;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BotEventStatus = 'queued' | 'claimed' | 'consumed' | 'dropped';

export type BotEvent = {
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
  attempts?: number;
};

/** POST /triggers/compile-schedule success body. Only the fields the UI reads are typed. */
export type CompiledSchedule = {
  success: true;
  [key: string]: unknown;
};

// ---- kernel -------------------------------------------------------------------------------------

export type BotGoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned';

export type BotGoal = {
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
};

export type BotGoalInput = {
  statement: string;
  success_criteria?: string;
  horizon?: string | null;
  status?: BotGoalStatus;
  sort_order?: number;
};

export type BotGoalPatch = Partial<BotGoalInput> & { progress?: Record<string, unknown> };

export type BotCommitmentStatus = 'open' | 'fired' | 'done' | 'cancelled';

export type BotCommitment = {
  commitment_id: string;
  bot_id: string;
  item_id: string | null;
  goal_id: string | null;
  description: string;
  waiting_on: string | null;
  due_at: string;
  nudge_policy: Record<string, unknown>;
  status: BotCommitmentStatus;
  source_episode_id: string | null;
  tainted: boolean;
  created_at: string;
  updated_at: string;
};

export type BotCommitmentInput = {
  description: string;
  due_at: string;
  waiting_on?: string | null;
  goal_id?: string | null;
  item_id?: string | null;
  nudge_policy?: Record<string, unknown>;
};

export type BotEpisodeStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export type BotEpisode = {
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
};

export type BotEpisodeSearchHit = {
  episode_id: string;
  summary: string;
  score: number;
  tainted?: boolean;
};

export type BotEpisodeRun = {
  run_id: string;
  status: string;
  trigger?: string | null;
  provider?: string | null;
  model?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  cost_usd?: number | null;
  error_summary?: string | null;
};

/** GET /:botId/episodes/:episodeId. Note `gate_decisions` args are NOT redacted by this endpoint. */
export type BotEpisodeDetail = {
  episode: BotEpisode;
  events: BotEvent[];
  gate_decisions: BotGateDecision[];
  runs: BotEpisodeRun[];
};

export type BotPhaseRoute = { provider: string; model?: string; effort?: string };

export type BotRuntimeConfig = {
  identity?: { persona?: string; avatar?: string };
  routing?: {
    perceive?: BotPhaseRoute;
    act?: BotPhaseRoute;
    reflect?: BotPhaseRoute;
    fallback?: BotPhaseRoute[];
  };
  backend?: 'local' | 'docker' | 'ssh';
  backend_config?: Record<string, unknown>;
  gateway?: boolean;
  enforcement?: 'enforced' | 'advisory';
  learning?: { auto_promote_memory_min_confidence?: number };
};

/** PATCH body: a key set to null removes it; a routing phase set to null removes that override. */
export type BotRuntimeConfigPatch = {
  [K in keyof BotRuntimeConfig]?: BotRuntimeConfig[K] | null;
} & { routing?: { [phase: string]: BotPhaseRoute | null } | null };

export type BotLease = {
  bot_id: string;
  holder: string;
  episode_id: string | null;
  acquired_at: string;
  expires_at: string;
};

export type BotRuntimeStatus = {
  /** The feature flag. */
  enabled: boolean;
  /** Whether this server process is actually running the runtime (absent on older servers). */
  runtime_running?: boolean;
  /** True when CLOUDCLI_BOTS_RUNTIME=off keeps the runtime stopped despite the flag. */
  forced_off?: boolean;
  running: string[];
  queuedWakes: number;
  queuedEvents: number;
  leases: BotLease[];
};

// ---- gate ---------------------------------------------------------------------------------------

export type BotRisk =
  | 'read' | 'draft' | 'send' | 'publish' | 'delete' | 'purchase' | 'credential' | 'prod_change' | 'unknown';

/** Risks a global allow rule can never cover (only a bot-scoped rule can loosen them). */
export const BOT_SAFETY_FLOOR: BotRisk[] = ['send', 'publish', 'delete', 'purchase', 'credential', 'prod_change'];

export type BotRuleScope = 'global' | 'bot';
export type BotRuleDecision = 'allow' | 'ask' | 'deny';

export type BotRuleArgPredicate = {
  path: string;
  op: 'eq' | 'contains' | 'regex' | 'in';
  value: unknown;
};

export type BotRuleMatch = {
  server?: string;
  tool?: string;
  risk?: string[];
  args?: BotRuleArgPredicate[];
  allow_when_tainted?: boolean;
};

export type BotRule = {
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
};

export type BotRuleInput = {
  scope?: BotRuleScope;
  botId?: string | null;
  decision: BotRuleDecision;
  match?: BotRuleMatch;
  priority?: number;
  note?: string;
  expiresAt?: string | null;
};

export type BotRulePatch = Partial<Pick<BotRuleInput, 'decision' | 'match' | 'priority' | 'note' | 'expiresAt'>>;

/** Rule create/patch response: `warnings` explains a rule that saves but is narrowed by the floor. */
export type BotRuleResult = { rule: BotRule; warnings?: string[] };

export type BotGateOutcome = 'executed' | 'denied' | 'approved' | 'rejected' | 'expired' | 'error';

export type BotGateDecision = {
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
};

/** GET /:botId/gate-decisions rows: args are redacted/truncated and a one-line summary is added. */
export type BotGateDecisionView = BotGateDecision & { args_summary: string };

export type BotGateDecisionFilter = {
  limit?: number;
  decision?: BotRuleDecision;
  /** `pending` matches rows with no outcome yet. */
  outcome?: BotGateOutcome | 'pending';
};

export type BotRiskPreview = { risk: BotRisk; floor: boolean; default_decision: 'allow' | 'ask' };

export type BotBudget = {
  bot_id: string;
  daily_usd: number | null;
  monthly_usd: number | null;
  daily_actions: number | null;
  max_wakes_per_hour: number | null;
  soft_ratio: number;
  updated_at: string;
};

export type BotBudgetInput = {
  daily_usd?: number | null;
  monthly_usd?: number | null;
  daily_actions?: number | null;
  max_wakes_per_hour?: number | null;
  soft_ratio?: number;
};

export type BotBudgetCheck = { ok: boolean; soft: boolean; reason?: string };

export type BotBudgetStatus = {
  budget: BotBudget | null;
  check: BotBudgetCheck;
  spend: { today_usd: number; month_usd: number; actions_today: number; wakes_last_hour: number };
  wake_allowed: boolean;
};

export type BotEnforcementLevel = 'enforced' | 'advisory';

export type BotEnforcement = {
  provider: string;
  level: BotEnforcementLevel;
  builtin_tool_gate: boolean;
  gateway: boolean;
  configured: BotEnforcementLevel | null;
  phases: Array<{ phase: 'perceive' | 'act' | 'reflect'; provider: string; level: BotEnforcementLevel }>;
};

// ---- channels + thread --------------------------------------------------------------------------

export type BotChannelPolicy = {
  quiet_hours?: { start: string; end: string; tz?: string };
  max_pings_per_day?: number;
  min_urgency?: number;
  digest?: boolean;
};

export type BotChannel = {
  channel_id: string;
  /** null = a global channel shared by every bot. */
  bot_id: string | null;
  kind: string;
  config: Record<string, unknown>;
  policy: BotChannelPolicy;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type BotChannelInput = {
  botId?: string | null;
  kind: string;
  config?: Record<string, unknown>;
  policy?: BotChannelPolicy;
  enabled?: boolean;
};

export type BotChannelPatch = { config?: Record<string, unknown>; policy?: BotChannelPolicy; enabled?: boolean };

export type BotChannelList = { channels: BotChannel[]; effective?: BotChannel[] };

export type BotOutboundLogEntry = {
  bot_id: string | null;
  channel_kind: string;
  urgency: number;
  delivered: boolean;
  reason: string | null;
  created_at: string;
};

export type BotThreadRole = 'operator' | 'bot' | 'system';

export type BotThreadMessage = {
  message_id: string;
  bot_id: string;
  role: BotThreadRole;
  body: string;
  channel: string;
  meta: Record<string, unknown>;
  created_at: string;
};

export type BotBrief = {
  generated_at: string;
  since: string;
  totals: { episodes: number; failed: number; cost_usd: number };
  bots: Array<{
    bot_id: string;
    title: string;
    episodes: { count: number; succeeded: number; failed: number; top_summaries: string[] };
    cost_usd: number;
  }>;
  awaiting_you: {
    approvals: Array<{ interrupt_id: string; bot_id: string; title: string; kind: string; created_at: string }>;
    in_qa: Array<{ item_id: string; bot_id: string; title: string }>;
  };
  gate_decisions_awaiting: Array<{
    decision_id: string; bot_id: string; server: string; tool: string; risk: string; interrupt_id: string | null;
  }>;
  commitments_due: Array<{
    commitment_id: string; bot_id: string; description: string; due_at: string; waiting_on: string | null;
  }>;
  learning_proposals: Array<{ proposal_id: string; bot_id: string; kind: string; title: string; confidence: number }>;
  suppressed: Array<{ bot_id: string | null; channel: string; reason: string; created_at: string }>;
  markdown: string;
};

// ---- learning -----------------------------------------------------------------------------------

export type BotProposalKind = 'memory' | 'skill_patch' | 'new_skill' | 'rule' | 'goal';
export type BotProposalStatus = 'proposed' | 'approved' | 'rejected' | 'applied' | 'superseded';

export type BotProposal = {
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
};

export type BotSkill = {
  link_id: string;
  bot_id: string;
  name: string;
  path: string;
  origin: string;
  version: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  description: string;
  /** Catalog-linked skills are read-only. */
  readonly: boolean;
};

export type BotSkillSaveInput = { content: string; description?: string; enabled?: boolean };

export type BotOperatorProfileEntry = {
  key: string;
  value: string;
  source: string;
  updated_at: string;
};

export type BotShadowScore = { precision: number; recall: number; f1: number };

export type BotShadowResult = {
  botId: string;
  episodes: number;
  candidate: BotShadowScore;
  baseline: BotShadowScore;
  deltaF1: number;
  verdict: 'better' | 'same' | 'worse' | 'insufficient_data';
  perEpisode: Array<BotShadowScore & {
    episodeId: string;
    labeled: boolean;
    positives: number;
    negatives: number;
    produced: string[];
    truePositives: number;
    falsePositives: number;
    baseline: BotShadowScore;
  }>;
};

export type BotShadowJob = {
  jobId: string;
  botId: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  result: BotShadowResult | null;
  error: string | null;
};

export type BotShadowCandidate = { produce_prompt?: string; memories?: string[] };

export type BotPurgeSelection = {
  memories?: boolean;
  episodes?: boolean;
  events?: boolean;
  threads?: boolean;
  proposals?: boolean;
  skills?: boolean;
};

export type BotPurgeCounts = Record<keyof BotPurgeSelection, number>;

// ---- collaboration (server shapes from collab.routes.ts) ---------------------------------------

export type BotTeamMember = { team_id: string; bot_id: string; role: string };

export type BotTeam = {
  team_id: string;
  name: string;
  goal: string;
  coordinator_bot_id: string | null;
  members: BotTeamMember[];
  created_at: string;
  updated_at: string;
};

export type BotTeamInput = {
  name: string;
  goal?: string;
  coordinator_bot_id?: string | null;
  members?: Array<{ bot_id: string; role?: string }>;
};

export type BotSpace = {
  space_id: string;
  bot_id: string;
  title: string;
  path: string;
  kind: string;
  created_at: string;
  updated_at: string;
};

export type BotSpaceContent = { space: BotSpace; content: string; truncated: boolean };

export type BotPeerTraffic = {
  event_id: string;
  direction: 'in' | 'out';
  other_bot_id: string;
  kind: string;
  type: string;
  status: string;
  received_at: string;
  correlation_id: string | null;
  preview: string;
};

export type BotPeers = { teams: BotTeam[]; traffic: BotPeerTraffic[] };

// ---- execution (server/modules/bots/exec) ------------------------------------------------------

/** One per-bot credential as listed by GET /:botId/credentials: names and timestamps, never values. */
export type BotCredentialName = {
  /** Normalized server key (`jira-cloud` -> `JIRA_CLOUD`). */
  server: string;
  /** Env var (stdio servers) or HTTP header (http/sse servers) the credential overrides. */
  key: string;
  /** The vault secret name, `<SERVER>__<KEY>`. */
  name: string;
  updated_at: string;
  last_used_at: string | null;
};

/** GET /runtime/host: facts that matter for always-on deployments. */
export type BotRuntimeHost = {
  platform: string;
  /** null = unknown (not macOS, or `pmset` failed): treat as unknown, not as awake. */
  sleepPrevented: boolean | null;
  publicUrlConfigured: boolean;
  uptime: number;
  hostUptime: number;
};

/** GET /:botId/teach: the running teach session, or null. */
export type BotTeachSession = { sessionId: string; startedAt: string; startUrl: string | null };

export type BotTeachStartInput = { url?: string; useBotProfile?: boolean };

export type BotTeachStarted = BotTeachSession & { profile: 'bot' | 'temporary'; note: string };

export type BotTeachStopInput = {
  name?: string;
  description?: string;
  successCheck?: string;
  /** CSS selectors of fields whose typed/selected values may be kept as literals instead of redacted inputs. */
  safeFields?: string[];
  /** 1-based step numbers whose typed/selected values may be kept. */
  safeSteps?: number[];
  /** Compile and return the steps without saving a skill. */
  dryRun?: boolean;
};

export type BotTeachStep = {
  index: number;
  kind: string;
  /** Human-readable instruction; never contains an unredacted typed value. */
  text: string;
  selector?: string;
  input?: string;
  /** True when a literal value was kept because the operator marked it safe. */
  safeLiteral?: boolean;
};

export type BotTeachInput = {
  name: string;
  label: string;
  /** Password-like field: the bot must ask the operator for the value at run time. */
  secret: boolean;
  step: number;
};

export type BotTeachResult = {
  skill: { name: string; enabled: boolean; origin: string } | null;
  name: string;
  content: string;
  steps: BotTeachStep[];
  inputs: BotTeachInput[];
  captured: { actions: number; skipped: number };
  /** Exactly what teach mode records. */
  capturedKinds: string[];
};

/** Kept for callers that only need "a recording is running". */
export type BotTeachState = BotTeachStarted;

// ---- websocket payloads (server/shared/run-events.ts) -------------------------------------------

export type BotRuntimeEvent =
  | { kind: 'bot_event_received'; bot_id: string; event_id: string; event_kind: string }
  | { kind: 'bot_episode_updated'; bot_id: string; episode_id: string; status: string }
  | { kind: 'bot_gate_decision'; bot_id: string; decision_id: string; decision: string; tool: string }
  | { kind: 'bot_thread_message'; bot_id: string; message: unknown }
  | { kind: 'bot_proposal_updated'; bot_id: string; proposal_id: string; status: string }
  | { kind: 'bot_goal_updated'; bot_id: string; goal_id: string };
