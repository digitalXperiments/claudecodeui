# Bot Runtime v2 — implementation contracts

Companion to `PLAN.md`. This is the **shared contract** that parallel implementers code against.
If you need to change a contract, say so in your report rather than silently diverging.

## Ground rules

- Branch `feat/bot-runtime-v2`, worktree `tmp/cloudcli/worktrees/bot-runtime-v2`.
- **Storage stays on `mc_sections` / `mc_items`.** A bot *is* an `mc_sections` row (`section_id` = bot id). The E1.13 table rename is deferred; new tables are keyed by `bot_id TEXT` referencing `mc_sections(section_id) ON DELETE CASCADE`.
- New server module: `server/modules/bots/` with barrel `index.ts`. Sub-folders: `signals/`, `kernel/`, `gate/`, `gateway/`, `learning/`, `channels/`, `collab/`, `exec/`, `tests/`. Cross-module imports go through `@/modules/<module>/index.js` only.
- IDs: use prefixed ULIDs from `server/shared/ids.ts` (add `newBotEventId` → `bev_`, `newBotGoalId` → `bgl_`, `newBotCommitmentId` → `bcm_`, `newBotEpisodeId` → `bep_`, `newBotRuleId` → `brl_`, `newBotGateDecisionId` → `bgd_`, `newBotProposalId` → `bpr_`, `newBotThreadMessageId` → `btm_`, `newBotTeamId` → `btt_`, `newBotSkillLinkId` → `bsk_`, `newBotTriggerId` → `btr_`, `newBotChannelId` → `bch_`, `newBotSpaceId` → `bsp_`).
- Timestamps: ISO strings via `new Date().toISOString()`. JSON columns: `*_json TEXT NOT NULL DEFAULT '{}'|'[]'`, parsed with safe helpers.
- Feature flag: `bots.runtime_v2` in `appConfigDb` (key `feature.bots_runtime_v2`, default **off**), exposed as `botsRuntimeV2: boolean` in `getAppFeatures()` / `PUT /api/features`, and client `useAppFeatures().botsRuntimeV2`. When off, current behaviour is unchanged.
- Run spine: add `'bot'` to `RunEventSource`. Kernel runs keep `source: 'mission_control'` (the UI already filters on it) but set `meta.runtime = 'v2'` and `meta.episode_id`.
- WS events (add to the `SystemWsEvent` union in `server/shared/run-events.ts`):
  `bot_event_received {bot_id, event_id, kind}`, `bot_episode_updated {bot_id, episode_id, status}`,
  `bot_gate_decision {bot_id, decision_id, decision, tool}`, `bot_thread_message {bot_id, message}`,
  `bot_proposal_updated {bot_id, proposal_id, status}`, `bot_goal_updated {bot_id, goal_id}`.
- Tests: `node:test` under `server/modules/bots/tests/`. Isolate the DB: `closeConnection()`, `DATABASE_PATH=<scratch>/auth.db`, `await initializeDatabase()`. Never hit a network or a real provider; use `configureMissionControlRuntimes({ claude: fake })`.
- Temporary files only under `tmp/cloudcli/`. Bot homes: `${CLOUDCLI_BOTS_HOME ?? ~/.cloudcli/bots}/<bot_id>/home` (tests set `CLOUDCLI_BOTS_HOME` to scratch).

## Schema (added as `BOTS_RUNTIME_SCHEMA_SQL` in schema.ts, executed in `runMigrations` right after the MC block)

```sql
CREATE TABLE IF NOT EXISTS bot_triggers (
  trigger_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL,       -- cron|interval|nl_schedule|webhook|kanban_event|run_completed|interrupt_created|watch|peer_message|ask_bot|commitment_due|operator_message|manual
  config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  cursor_json TEXT NOT NULL DEFAULT '{}', last_fired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_events (
  event_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, trigger_id TEXT, source TEXT NOT NULL, kind TEXT NOT NULL,
  dedupe_key TEXT, trust TEXT NOT NULL DEFAULT 'external',                       -- operator|internal|external
  payload_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', -- queued|claimed|consumed|dropped
  episode_id TEXT, received_at TEXT NOT NULL, claimed_at TEXT,
  FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_events_dedupe ON bot_events(bot_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS bot_leases (
  bot_id TEXT PRIMARY KEY, holder TEXT NOT NULL, episode_id TEXT, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_goals (
  goal_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, statement TEXT NOT NULL, success_criteria TEXT NOT NULL DEFAULT '',
  horizon TEXT, status TEXT NOT NULL DEFAULT 'active',                            -- active|paused|achieved|abandoned
  progress_json TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_commitments (
  commitment_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, item_id TEXT, goal_id TEXT, description TEXT NOT NULL,
  waiting_on TEXT, due_at TEXT NOT NULL, nudge_policy_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',                                            -- open|fired|done|cancelled
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_episodes (
  episode_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, status TEXT NOT NULL,        -- running|succeeded|failed|interrupted
  trigger_kinds TEXT NOT NULL DEFAULT '', event_ids_json TEXT NOT NULL DEFAULT '[]', run_ids_json TEXT NOT NULL DEFAULT '[]',
  plan_text TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', outcome_json TEXT NOT NULL DEFAULT '{}',
  feedback_json TEXT NOT NULL DEFAULT '[]', tainted INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  bot_version INTEGER, started_at TEXT NOT NULL, finished_at TEXT,
  FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE VIRTUAL TABLE IF NOT EXISTS bot_episodes_fts USING fts5(episode_id UNINDEXED, bot_id UNINDEXED, summary, plan_text, content='');
CREATE TABLE IF NOT EXISTS bot_rules (
  rule_id TEXT PRIMARY KEY, scope TEXT NOT NULL, bot_id TEXT,                    -- scope: global|bot
  match_json TEXT NOT NULL DEFAULT '{}',                                          -- {server?, tool?, risk?: Risk[], args?: {path, op: eq|contains|regex|in, value}[]}
  decision TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,                    -- allow|ask|deny
  created_from TEXT NOT NULL DEFAULT 'manual', note TEXT NOT NULL DEFAULT '', expires_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_gate_decisions (
  decision_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, episode_id TEXT, run_id TEXT, server TEXT NOT NULL, tool TEXT NOT NULL,
  risk TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}', decision TEXT NOT NULL,          -- allow|ask|deny
  decided_by TEXT NOT NULL,                                                       -- rule:<id>|floor|taint|reviewer|budget|human|default
  reason TEXT NOT NULL DEFAULT '', interrupt_id TEXT, outcome TEXT,               -- executed|denied|approved|rejected|expired|error
  created_at TEXT NOT NULL, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS bot_budgets (
  bot_id TEXT PRIMARY KEY, daily_usd REAL, monthly_usd REAL, daily_actions INTEGER, max_wakes_per_hour INTEGER,
  soft_ratio REAL NOT NULL DEFAULT 0.8, updated_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_learning_proposals (
  proposal_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, kind TEXT NOT NULL,         -- memory|skill_patch|new_skill|rule|goal
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'proposed',                                        -- proposed|approved|rejected|applied|superseded
  created_at TEXT NOT NULL, decided_at TEXT,
  FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_skills (
  link_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'manual', -- manual|reflector|teach|catalog
  version INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(bot_id, name), FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_channels (
  channel_id TEXT PRIMARY KEY, bot_id TEXT, kind TEXT NOT NULL,                   -- inapp|webpush|slack|telegram|email ; bot_id NULL = global default
  config_json TEXT NOT NULL DEFAULT '{}', policy_json TEXT NOT NULL DEFAULT '{}', -- policy: {quiet_hours:{start,end,tz}, max_pings_per_day, min_urgency, digest: bool}
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_thread_messages (
  message_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, role TEXT NOT NULL,          -- operator|bot|system
  body TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'inapp', meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_outbound_log (
  bot_id TEXT, channel_kind TEXT NOT NULL, urgency REAL NOT NULL, delivered INTEGER NOT NULL, reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_teams (
  team_id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', coordinator_bot_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_team_members (
  team_id TEXT NOT NULL, bot_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', PRIMARY KEY (team_id, bot_id));
CREATE TABLE IF NOT EXISTS bot_spaces (
  space_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'markdown',
  updated_at TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (bot_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bot_operator_profile (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', updated_at TEXT NOT NULL);
```

Columns added to `mc_sections` (migration): `runtime_json TEXT NOT NULL DEFAULT '{}'`, holding
`{ identity?: {persona, avatar}, routing?: {perceive?, act?, reflect?: {provider, model, effort}}, backend?: 'local'|'docker'|'ssh', backend_config?, gateway?: boolean (default true when flag on), enforcement?: 'enforced'|'advisory' }`.

## Service contracts (exported from `@/modules/bots/index.js`)

```ts
// signals/
type Trust = 'operator' | 'internal' | 'external';
interface IngestEventInput { botId: string; source: string; kind: string; triggerId?: string; dedupeKey?: string; trust: Trust; payload: Record<string, unknown> }
botSignals.ingest(input): { event: BotEvent; duplicate: boolean }   // inserts queued event, then kernel.notify(botId)
botSignals.claimBatch(botId, { max, coalesceMs }): BotEvent[]
botSignals.markConsumed(eventIds, episodeId) / markDropped(eventIds, reason)
botTriggers.list/create/update/delete; botTriggers.sync()           // (re)schedules cron/interval/nl_schedule/watch/commitment timers
compileNaturalSchedule(text, tz?): { cron: string; exclusions: {weekdays?: number[]; dates?: string[]}; description: string } | { error }
registerWatchAdapter(kind, adapter: { poll(cfg, cursor): Promise<{ events: Omit<IngestEventInput,'botId'>[]; cursor }> })   // built in: rss, directory, github (gh CLI, read only), http_json

// kernel/
kernel.notify(botId): void                                           // debounced wake request
kernel.wake(botId, { reason, force? }): Promise<EpisodeResult>       // lease → perceive → act → reflect → sleep
kernel.start() / kernel.stop()                                       // boot: expire stale leases, resume interrupted episodes, sync triggers
goals.list/create/update/delete(botId, …); commitments.list/create/complete/cancel(botId, …)
episodes.search(botId, query, limit): { episode_id, summary, score }[]   // FTS5

// gate/
type Risk = 'read' | 'draft' | 'send' | 'publish' | 'delete' | 'purchase' | 'credential' | 'prod_change' | 'unknown';
classifyToolRisk({ server, tool, annotations?, description? }): Risk
interface GateContext { botId: string; episodeId?: string; runId?: string; tainted: boolean; operatorInstructions: string; goals: string[] }
interface GateRequest { server: string; tool: string; args: Record<string, unknown>; annotations?: Record<string, unknown>; description?: string }
interface GateVerdict { decision: 'allow' | 'ask' | 'deny'; decidedBy: string; reason: string; risk: Risk; decisionId: string }
actionGate.evaluate(ctx, req): Promise<GateVerdict>                  // classify → rules → floor → taint → reviewer → budget; persists bot_gate_decisions
actionGate.awaitHuman(decisionId, { timeoutMs }): Promise<'approved' | 'rejected' | 'expired'>  // creates interrupt (kind 'bot_gate'), actions approve_once|always_allow|deny
actionGate.recordOutcome(decisionId, outcome)
rules.list/create/update/delete; SAFETY_FLOOR: Risk[] = ['send','publish','delete','purchase','credential','prod_change']  // default ask; global floor rule cannot be loosened to allow except by an explicit bot-scoped rule the operator created ('always_allow_click' | 'manual')
setAutoReviewer(fn: (ctx, req, risk) => Promise<{ ok: boolean; reason: string }>)   // default: cheap-model reviewer; tests inject a fake
budgets.get/put(botId); budgets.check(botId): { ok: boolean; soft: boolean; reason?: string }

// gateway/
// stdio MCP script server/bot-tool-gateway-mcp.ts (like session-mailbox-mcp.ts). Env: CLOUDCLI_BOT_GATEWAY_API_URL, CLOUDCLI_BOT_GATEWAY_MCP_TOKEN,
// plus CLOUDCLI_SESSION_ID (stamped by the provider runtime). Route /api/bot-gateway-mcp (mounted before auth, token-checked):
//   POST /tools/list  → tools the calling session's bot may see: upstream `<server>__<tool>` plus first-party `bot__*` tools
//   POST /tools/call  → gate.evaluate → (ask → awaitHuman) → upstream call via pooled MCP SDK Client → recordOutcome; marks episode tainted when a read returns external content
gatewaySessions.bind(appSessionId, { botId, episodeId, runId, servers: string[] }) / unbind(appSessionId)
first-party tools: bot__remember (memory proposal), bot__commit (create commitment), bot__goal_progress, bot__ask_bot, bot__handoff, bot__space_write, bot__notify_operator, bot__request_handoff

// learning/
reflector.onEpisodeFinished(episodeId): Promise<BotLearningProposal[]>   // heuristics first, then optional cheap-model pass
learning.list/approve/reject(proposalId); approve applies (memory → mc_bot_memories approved; skill → SKILL.md + bot_skills; rule → bot_rules) and records a section version
skills.list/save/fromRun(botId, runId); evalsBridge.buildSuite(botId); shadow.evaluate(botId, candidateVersion)
privacy.exportBot(botId) → JSON; privacy.purgeBot(botId, { memories, episodes, threads, events })
operatorProfile.get/set/proposals

// channels/
channels.list/upsert/delete; notifyOperator({ botId, title, body, urgency 0..1, actions?, interruptId? }): Promise<{ delivered: string[]; suppressed: string[] }>
thread.post(botId, { role, body, channel }) ; operator messages → botSignals.ingest(kind 'operator_message', trust 'operator')
signedActionLinks.create(interruptId, actionKey, ttl) / verify(token)     // GET /api/bot-actions/:token (no auth, HMAC-signed) for channel approve buttons
brief.generate({ since }): BriefDoc ; brief scheduled daily via bot_channels global policy
```

## Wave plan

| Wave | Owner slices (parallel within a wave) | Depends on |
|---|---|---|
| A | A1 schema + ids + flag + ws/run-event types + bots module skeleton + repositories. A2 MC bug fixes (trigger threading, interrupt href, Activity trigger display) | — |
| B | B1 gate (rules, risk, floor, taint, reviewer, budgets, awaitHuman). B2 gateway (stdio MCP + route + upstream pool + session binding + provider strict selection). B3 signals (ingest, triggers, NL schedule, watch adapters, automation bridge, webhooks bridge) | A |
| C | C1 kernel (lease, mailbox, perceive/act/reflect, goals, commitments, episodes + FTS, cheap/strong routing, restart recovery, scheduler switch under flag) | A, B |
| D | D1 channels (thread, in-app, web push, Slack, Telegram, signed links, interruption policy, brief). D2 learning (reflector, proposals, skills, evals bridge, shadow gate, privacy, operator profile) | C |
| E | E1 execution (bot home, browser profile, per-bot credentials, handoff, per-phase routing + failover, teach mode, docker/ssh backends). E2 collaboration (ask_bot, handoff, teams, spaces) | C |
| F | F1–F4 Bot Studio UI (profile, goals, rules/gate log, thread, learning, skills, triggers, channels, budget, live activity, brief, settings flag) | D, E |
| G | Integration: full tests, typecheck, lint, build, isolated-server Playwright smoke, reviewer pass, docs | all |
