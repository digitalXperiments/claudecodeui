# Bot Studio 2 — from scheduled prompts to a bot runtime

**Date:** 2026-09-30 · **Status:** PROPOSAL · **Owner:** Ram
**Benchmarks:** Hermes Agent (Nous), OpenAI Dots, Meta Muse, Grok Bot (xAI), Instinct
**Builds on:** `docs/prd/bot-studio/README.md`, Endurance PRD §5.2.2 + E1.13/E1.14, Obsidian `Decisions/bot-pipeline-single-mode`

---

## 0. The thesis in one paragraph

Today a bot is **a cron job that runs a prompt**: the scheduler fires, `runSectionProduce`
runs a fresh agent with a produce prompt, JSON items land in an inbox, and a human
approves them into Resolve and Work. The products we are measuring against are not
that. They are **long-lived agents with an identity, a home, goals, a memory that grows,
a way to reach you, and governed permission to act**. They wake up because *something
happened*, not because a clock ticked. They get better every week without you editing
a prompt. The upgrade is therefore not more features on the pipeline. It is putting a
**bot runtime** (kernel + event bus + action gate + memory/learning plane + channel
gateway) *under* Bot Studio. The existing Propose → Resolve → Work pipeline becomes the
**task lifecycle** inside that runtime, not the whole system.

---

## 1. What makes the benchmarks state of the art (system properties, not features)

| # | System property | Hermes | Dots | Muse | Grok Bot | Instinct | **Bot Studio today** |
|---|---|---|---|---|---|---|---|
| P1 | **Persistent identity + home** (a machine or state that survives between runs) | local/Docker/SSH/Modal backends | own cloud computer + browser | account-scoped | persistent cloud VM, shared by bots | persistent cloud computer | ❌ fresh run per tick in project dir / `$HOME` |
| P2 | **Event-driven wake-ups + goals** | cron + gateway messages | events, schedules, goals 24/7 | goals + events + schedule | routines + Cursor events | proactive, texts first | ⚠️ cron only; no goals |
| P3 | **Learning loop** (memory + procedural skills that improve themselves) | auto skill creation, self-patching skills, memory nudges, FTS5 recall, Honcho user model | learns preferences from feedback | remembers things said once | "process becomes skill", teach by demo | continuous thread | ⚠️ manual memory, 20 × 1k chars, no skills |
| P4 | **Channel-native** (reaches you where you are; you talk back) | Telegram/Discord/Slack/WhatsApp/Signal/email/SMS/voice | ChatGPT, Slack, Teams | Meta apps | desktop + iPhone | iMessage, WhatsApp, phone | ❌ in-app + OS notification only |
| P5 | **Governed autonomy** (rules, auto-review, handoff) | toolsets, approvals | Custom Rules + auto-review + read-only proactive research | approval cards | Allow once / Always / Deny + Auto Review + secure handoff | ❌ (its biggest failure) | ⚠️ binary `auto_approve`; tool policy enforced only for Claude |
| P6 | **Collaboration** (bots with bots and humans, shared artifacts) | subagents (3 parallel) | Space + Pages with humans and Codex | Artifacts | 2–6 bots in a group chat | — | ❌ bots are isolated |
| P7 | **Observability** (see and step into live work) | trajectories, hooks | Activity View, intervene | — | take over | — | ⚠️ event timeline, polled every 2.5 s |

**Where we can beat them (our structural edge):**

1. **Model freedom.** We run 12 provider CLIs. None of them can route by task, fail over
   across vendors, or pair a cheap watcher with a strong worker. Grok and Instinct offer
   no model choice; Dots is GPT-6 Astra only.
2. **Inspectable, portable memory.** Obsidian plus the DB. Grok offers no memory
   inspection or export, and Instinct's retention was a launch-week scandal.
3. **Local-first and self-hosted.** Nothing has to leave the machine. This
   is the one thing no benchmark offers (Hermes comes closest).
4. **Governance that is real.** A per-tool policy, a permission classifier, and a spend
   governor already exist. Instinct is the counterexample of what happens without them.
5. **Code-grade execution.** Worktrees, rehearsal, relay land/discard, evals. The
   consumer agents have none of this.

---

## 2. Target architecture

```
                         ┌────────────────────────── Bot Studio (web /bots, Endurance, mweb) ──────────────────────────┐
                         │  Command Center · Bot profile · Goals · Board · Activity (live) · Brief · Memory · Skills   │
                         └───────────────▲──────────────────────────────▲──────────────────────────────▲──────────────┘
                                         │ REST + WS                     │                              │
 ┌───────────── L1 SIGNALS ─────────────┐│  ┌──────────── L2 BOT KERNEL ─┴──────────┐   ┌──── L6 CHANNEL GATEWAY ────┐
 │ cron · interval · NL schedule         ││  │ per-bot mailbox (durable queue)       │   │ in-app · mweb push · Slack │
 │ webhooks (HMAC) · MCP watch adapters  │├─▶│ wake → perceive → plan → act →        │◀─▶│ Telegram · email · voice   │
 │ run_completed · kanban · interrupts   ││  │ reflect → sleep  (lease, budget,      │   │ approval cards, threads,   │
 │ peer/bot messages · file watch        ││  │ concurrency, resume after restart)    │   │ interruption policy        │
 │ commitments due (follow-ups)          ││  │ task lifecycle: Propose→Resolve→Work  │   └────────────────────────────┘
 └──────────── bot_events ──────────────┘│  └───────┬─────────────┬─────────────┬───┘
                                          │          │             │             │
                  ┌───────────────────────┘   ┌──────▼──────┐ ┌────▼────────┐ ┌──▼─────────────────────────┐
                  │                           │ L3 ACTION   │ │ L4 MEMORY & │ │ L5 EXECUTION SUBSTRATE      │
                  │                           │ GATE        │ │ LEARNING    │ │ provider router (12 CLIs)   │
                  │                           │ classify →  │ │ episodic    │ │ + failover + continuity     │
                  │                           │ rules →     │ │ semantic    │ │ bot home dir · browser      │
                  │                           │ taint check │ │ procedural  │ │ profile · worktrees ·       │
                  │                           │ → auto-     │ │ (skills)    │ │ docker/ssh backend          │
                  │                           │ review →    │ │ user model  │ │ secrets vault (per-bot      │
                  │                           │ budget →    │ │ reflector + │ │ credentials)                │
                  │                           │ run / ask   │ │ evals       │ └─────────────────────────────┘
                  │                           └─────────────┘ └─────────────┘
                  │        L7 COLLABORATION: bot↔bot mailbox · handoff · teams · Spaces (living artifacts) · ask_<bot> MCP
                  └──────  L8 OBSERVABILITY: traces (agent_run_events) · live transcript · replay · SLOs · cost ledger · shadow versions
```

### L1 — Signals (event bus)

**What:** every reason a bot might wake up becomes a normalized row in `bot_events`
(`bot_id?, source, kind, dedupe_key, payload, trust, received_at, status`). Bots
**subscribe** with `bot_triggers` (the E1.13 shape: `cron | interval | webhook |
kanban_event | run_completed | interrupt_created | manual | ask_bot | peer_message`, plus
`watch` and `commitment_due`).

**Reuse:** `server/modules/automation` already defines `AutomationTriggerType =
cron | webhook_inbound | kanban_event | run_completed | interrupt_created | manual`
with DAG cycle detection. `server/modules/webhooks` has HMAC ingest plus a retry
scheduler. Lift both into one shared **trigger registry**, so that recipes and bots
consume the same events and nothing is duplicated.

**New pieces:**
- **Watch adapters.** Cheap read-only pollers (a Gmail query, a Slack channel, a GitHub
  repo, an RSS feed, a directory) that diff against a cursor and emit events only when
  something changed. They run as deterministic code or a Haiku-class read-only agent, and
  the expensive bot wakes only when there is signal. This replaces "run a full produce
  prompt every 15 minutes to find nothing".
- **Natural-language schedules** ("weekdays at 9 except Fridays") compile to cron plus
  exclusions, and the compiled rule is shown back for confirmation.
- **Debounce and coalesce.** 20 Slack messages in 2 minutes become one wake-up with 20
  events attached.
- **Trust label** on each event: `operator` (you), `internal` (CloudCLI), or `external`
  (email, web, Slack from others). The Action Gate uses it for taint (L3).

### L2 — Bot kernel (the agent loop)

**What:** one durable, restart-safe loop per bot. It replaces `runSectionProduce` as the
single entry point.

```
wake(event batch)
  → perceive: load identity + goals + open tasks + relevant memory + skills + event payloads
  → plan:     decide which tasks to create, advance, or close, and which follow-ups to schedule
  → act:      tool calls, each passing through the Action Gate (L3)
  → reflect:  write episode; propose memory/skill patches (L4); update goal progress
  → sleep:    set next wake (commitments, backoff), release lease
```

- **Mailbox and lease.** Each bot has a durable queue and one active lease, which
  generalizes today's "skip the tick if the previous one is still running". When the
  server restarts, leases expire and the kernel resumes from the last persisted step. It
  does not mark the work failed, which is what `recoverWorkDispatches` does today.
- **Goals.** A new first-class object: `bot_goals(id, bot_id, statement,
  success_criteria, horizon, status, progress_json)`. Muse and Dots are goal-driven: the
  kernel plans against goals, and a goal's progress is visible and editable.
- **Tasks are today's items.** The stages stay (pending → resolving → awaiting_work →
  working → in_qa → resolved), so the single-mode pipeline decision holds. What changes is
  that the kernel, not only a cron-fired prompt, creates and advances them.
- **Commitments (Instinct's core idea).** `bot_commitments(task_id, waiting_on,
  due_at, nudge_policy)`. "Waiting on reply from vendor, check again Thursday" becomes a
  scheduled wake-up (`commitment_due` event). Threads you dropped are tracked, not
  forgotten.
- **Autonomy is policy, not modes.** No Propose/Act modes come back. What a bot may do
  on its own is set entirely by Action Gate rules (L3).
- **Cheap/strong split.** Perceive and plan can run on a small model, while act and Work
  run on the bot's configured model. This is how an always-on bot stays affordable.

### L3 — Action Gate (governed autonomy)

**What:** every tool call with a side effect passes through one pipeline, whichever
provider made it.

```
tool call → classify risk → match rules → taint check → auto-review → budget → execute | ask human | deny
```

1. **Classify.** `permissions/permission-classifier.service.ts` is already the source of
   truth for read, scoped, or escalate on CLI actions. Extend it with an **MCP tool risk
   taxonomy**: `read | draft | send | publish | delete | purchase | credential |
   prod_change`, inferred from tool names and annotations (MCP `readOnlyHint` /
   `destructiveHint`), then pinned by the operator.
2. **Rules.** `bot_rules(scope: global|bot|goal, match: {server, tool, risk, args
   predicate}, decision: allow|ask|deny, expires_at, created_from: 'always_allow_click' |
   'manual')`. This is Grok's *Allow once / Always allow / Deny* and Dots' *Custom
   Rules*. Clicking "Always allow" on an approval card writes a rule. `send`, `publish`,
   `delete`, `purchase` and `credential` default to `ask`, and a global floor can forbid
   loosening them.
3. **Taint check.** If the run has read `external`-trust content (an email body, a web
   page, a Slack message from someone else), any consequential call afterwards needs
   review, even when a rule would allow it. This is the direct defence against the email
   prompt injection that hijacked Instinct. It is a CaMeL-style "untrusted data cannot
   authorize actions" check, implemented as run-level taint.
4. **Auto-review.** A small reviewer model gets *(operator instructions, bot goals, the
   proposed call, its provenance)* and answers "does this follow from what the operator
   asked for?". If it doesn't, the call is escalated to a human. (Dots / Grok Auto Review)
5. **Budget.** Per-bot daily and monthly limits in dollars, tokens and actions.
   `runs/spend-governor.service.ts` already does soft downgrade and hard pause for swarms,
   so reuse it with a bot scope.
6. **Handoff.** For logins, 2FA and CAPTCHAs, the bot pauses, sends a handoff card
   through the channel gateway, and resumes once you finish. `browser_ask_human` in
   cloudcli-browser is the precedent.

**Enforcement across all 12 providers** (the hard part, and a gap today):
- **MCP tools: build a Tool Gateway MCP proxy.** A bot's provider config points at one
  stdio server, `cloudcli-tool-gateway`, instead of the real MCP servers. The gateway
  launches or connects to the upstream servers from the catalog, lists only the allowed
  tools, and runs every `tools/call` through the gate. This makes enforcement
  provider-agnostic: Codex, Grok, Kimi and OpenCode get the same guarantees as Claude.
  The gateway is also where taint, audit and per-bot credentials (L5) are applied.
  - *Limitation:* connectors built into a provider (for example claude.ai Gmail) cannot be
    proxied. Bot templates should prefer catalog MCP servers such as Composio, and Trust
    review should warn when a bot uses a non-proxyable connector.
- **Built-in CLI tools (Bash, Edit, Write).** Use each provider's native approval hook
  where one exists (Claude `canUseTool`, Codex app-server approvals, ACP permission
  requests) and route it to the same gate. Where no hook exists, sandbox the bot (L5)
  and mark it `enforcement: advisory` in Trust review.

### L4 — Memory and learning plane

Four memory tiers, all inspectable, editable and exportable. That is our edge over Grok
and Instinct.

| Tier | Holds | Store | Written by |
|---|---|---|---|
| **Episodic** | every wake: events, plan, actions, outcome, human feedback | `bot_episodes` + **SQLite FTS5** index (embeddings optional later) | kernel, automatically |
| **Semantic** | durable facts and preferences ("Ram wants Jira comments in bullet form") | `mc_bot_memories` grown: raise the 20 × 1k limit, add `kind`, `confidence`, `source_episode`, `last_used_at`, decay | reflector (proposed) → you (approve) or rule (auto) |
| **Procedural** | **skills**: steps, decision rules, output format, approval boundaries | `SKILL.md` files in the bot's home plus a `bot_skills` link table, shared with the existing skills catalog | reflector ("run → skill"), teach mode, you |
| **User model** | cross-bot operator profile | **Obsidian** note `Projects/CloudCLI/Entities/operator-profile.md` (read by every bot, written only through proposals) | reflector, you |

**The learning loop** (Hermes' closed loop, with our human-in-the-loop default):

```
episode ends
  → collect signals: approve / dismiss / edit-diff / send-back text / accept / time-to-approve / eval score
  → reflector job (cheap model, off the hot path):
       • memory patches   ("you dismissed 4 newsletters from X → propose: ignore sender X")
       • skill patches    (a step failed and the human fixed it → propose a SKILL.md diff)
       • new skill        (a novel multi-step success → propose "save as skill")
       • rule suggestions (you approved send_email to the same list 10× → propose an Always-allow rule)
  → proposals appear in the bot's Memory/Skills tab and in the morning brief
  → promotion: human approve (default) | auto if confidence ≥ threshold AND an auto-promote rule exists
  → every promotion creates a new bot version (versions service already snapshots memories)
```

- **Recall.** At perceive time the kernel runs an FTS5 query over episodes ("have I seen
  this sender, ticket or error before?") and loads the top k summaries. This also replaces
  the per-source dedupe heuristics such as `trello-dedupe.ts`.
- **Grading.** Accept and Send back are free labels. Put them into
  `server/modules/evals`, which already lists a `mission_control` scope that nothing
  uses. Each bot gets a regression suite built from its own history, and **a new version
  must pass that suite in shadow before it is promoted** (Endurance PRD "shadow
  versions").
- **Forgetting.** Per-bot "forget this" and "purge all data", with export as JSON or
  Markdown. This is a first-class feature, as Instinct's retention incident shows.

### L5 — Execution substrate

- **Bot home.** `~/.cloudcli/bots/<bot_id>/home/`: scratch files, notes, skills, cursors
  and a persistent browser profile, kept between wake-ups. This is our version of the
  cloud computer in Grok and Dots. It sits outside Documents, Desktop and Downloads (TCC
  rule).
- **Workspaces for code.** Work runs in a relay-style worktree and ends with land or
  discard. Hermes-style checkpoints come free with this.
- **Backends.** `local` (default), `docker` (sandbox for providers without enforceable
  hooks), and `ssh` (a headless Mac or cloud box). Endurance can already connect to a
  remote server. **Always-on on a laptop that sleeps is not always-on**, so document and
  support the "headless box" deployment.
- **Provider router.** Reuse `relay-routing-policy.ts`, `model-registry` (cost ledger)
  and `failover`. Per-bot routing by phase (perceive, act, work, reflect), fallback chain
  on errors, and `continuity` limit detection so a rate-limited provider hands off
  instead of failing.
- **Per-bot identity and credentials.** `secrets` vault entries scoped to a bot (for
  example a separate Composio entity per bot), injected by the Tool Gateway rather than
  written into prompts. The audit log says "Bot *Jira triage* called
  `jira.transition` as `bot-jira@…`". (Dots specialist dots)

### L6 — Channel gateway

- **One conversation thread per bot**, mirrored across channels. You can ask "what are
  you working on?" or "stop emailing X". Operator messages in the thread become
  `operator`-trust events, and instructions become memory proposals.
- **Adapters:** in-app (existing notifications and interrupt queue), **mweb push** (web
  push via `public/sw.js`), **Slack** (bot user, Block Kit approval buttons),
  **Telegram**, **email** (digest plus reply-to-approve with a signed token), and
  **voice** (`voice/local-stt.ts` for talking to a bot on the Mac).
- **Interactive approval cards everywhere.** Approve, Deny, Always allow, Edit and Take
  over. A card resolves the same interrupt row whichever channel you answer from.
- **Interruption policy (Muse: a proactive message has to be worth the interruption).**
  Each outbound message gets an urgency score. Quiet hours, batching into digests, a
  per-bot "max pings a day", and escalation only for high urgency or a stale approval.
- **Morning brief.** One scheduled digest across all bots: what happened, what needs you,
  what it cost, what the bots learned. It is also the main place where learning proposals
  get approved.

### L7 — Collaboration

- **Bot-to-bot messaging.** Use the `session-mailbox` peer-mailbox pattern and add an
  `ask_<bot>` MCP tool (already in the Endurance PRD). Triage can hand a task to PR
  Shepherd along with its context.
- **Teams.** A named group of 2–6 bots with a shared goal and a coordinator (Grok group
  chats). The lead/worker orchestration logic from Agent Relay can be reused.
- **Spaces (living artifacts).** A bot owns and updates documents: an Obsidian note, a
  dashboard, a report. The artifact becomes its long-term output, not a stream of cards.
  (Dots Pages, Muse Artifacts)
- **Humans in the loop as teammates.** A task can be assigned to a human, and the bot
  tracks it as a commitment.

### L8 — Observability

- **Live Activity.** Stream `agent_run_events` over WebSocket instead of polling, and
  render them as a readable transcript (thoughts, tool calls, gate decisions) with
  **Pause**, **Take over** and **Inject instruction** buttons.
- **Replay.** Any episode can be re-rendered from its events.
- **Bot health SLOs.** Wake success rate, gate escalation rate, approval latency,
  cost/day and learning acceptance rate, with a sparkline on each roster card.
- **Audit log.** Every gate decision, with who or which rule decided it. Exportable.

---

## 3. Data model delta

New (prefix `bot_` as in Endurance E1.13; `mc_*` becomes a migrated alias):

| Table | Purpose |
|---|---|
| `bot_triggers` | subscriptions (kind, config, enabled), replacing `schedule_cron` |
| `bot_events` | normalized inbound signals with trust label, dedupe key and batch id |
| `bot_goals` | goal statement, success criteria, horizon, progress |
| `bot_commitments` | follow-ups: waiting_on, due_at, nudge policy |
| `bot_episodes` (+ `bot_episodes_fts`) | one per wake: events, plan, actions, outcome, feedback, summary |
| `bot_rules` | Action Gate rules (scope, match, decision, provenance, expiry) |
| `bot_gate_decisions` | audit trail for every consequential call |
| `bot_skills` | bot ↔ skill links, version, origin (reflector/teach/manual) |
| `bot_learning_proposals` | memory / skill / rule proposals with evidence episodes |
| `bot_channels` | per-bot channel bindings and interruption policy |
| `bot_threads` | the conversation thread with the bot (messages across channels) |
| `bot_budgets` | per-bot limits and spend-to-date |
| `bot_teams` / `bot_team_members` | groups and coordinator |

Changed: `mc_sections` → `bots` (add `identity_json`, `home_path`, `backend`,
`routing_json`, `enforcement_level`). `mc_items` → `bot_tasks` (add `goal_id`,
`episode_id`). Dead `kanban_*` columns are dropped in the same migration.

---

## 4. Phased roadmap

Each phase ships behind a flag (`bots.runtimeV2`) and keeps the current UI working.
Every phase ends with tests plus a Playwright verification run (see the
prototype-verification memory).

### Phase 0 — Foundation (≈1 week)
- Fix existing defects: scheduled ticks recorded as `'manual'`; approval interrupts
  linking to `/mission-control`; dead `kanban_*` columns.
- E1.13 migration: create `server/modules/bots/` and move the MC services behind it,
  keeping `/api/mission-control/*` aliases for one release.
- `bot_events` + `bot_triggers` with the cron trigger re-plumbed through them (no behavior
  change). Merge the automation and webhooks trigger registry.
- **Exit:** every existing bot runs through `bot_events`, with the identical outcome.

### Phase 1 — Governed autonomy (≈2–3 weeks) ← *do this before making anything more autonomous*
- `cloudcli-tool-gateway` MCP proxy; per-bot tool listing; the risk taxonomy.
- `bot_rules` with Allow once / Always allow / Deny cards; global floor for
  send/publish/delete/purchase/credential.
- Run-level taint tracking and the auto-reviewer.
- Per-bot budgets via the spend governor; audit log.
- Native approval hooks for Claude and Codex; `enforcement_level` shown in Trust review.
- **Exit:** a Grok- or Codex-backed bot cannot call a denied tool (proven by a test), and
  an injected email cannot trigger `send` without a human.

### Phase 2 — The kernel and always-on (≈3 weeks)
- Kernel loop (wake → perceive → plan → act → reflect → sleep), mailbox and lease,
  resume after restart.
- Triggers: webhook, run_completed, kanban_event, interval, natural-language schedule;
  watch adapters (Gmail, Slack, GitHub, RSS, directory) with cursors; debounce/coalesce.
- Goals and commitments (follow-ups); cheap/strong model split per phase.
- Bot home dir; persistent browser profile.
- **Exit:** the Gmail bot wakes on new mail rather than polling every 15 minutes, costs
  at least 50% less per day than the Phase 0 baseline, and a follow-up set for Thursday
  fires on Thursday.

### Phase 3 — Channels and conversation (≈2 weeks)
- `bot_threads`; talk-to-bot pane in Bot Studio; operator messages become events.
- Adapters: mweb push, Slack, email digest with reply-to-approve, Telegram.
- Interruption policy and the morning brief.
- **Exit:** approve a real item from the phone; the brief arrives at 08:00 and reflects
  the overnight work.

### Phase 4 — Learning loop (≈3 weeks)
- Episodes + FTS5 recall at perceive time.
- Reflector job: memory, skill and rule proposals with evidence; promotion flow; version
  bump.
- Bot skills (SKILL.md in the bot's home, linked to the catalog); "save this run as a
  skill".
- Evals: auto-built regression suite per bot; shadow-version gate before promotion.
- Operator profile in Obsidian; forget, purge and export.
- **Exit:** after two weeks of use, a bot's dismiss rate falls measurably with no prompt
  edits, and every change it made to itself is traceable to an episode.

### Phase 5 — Execution depth (≈2–3 weeks)
- Teach mode: record a browser workflow with cloudcli-browser and compile it into a skill
  with parameters.
- Docker and SSH backends; the headless-box deployment guide.
- Per-bot credentials through the vault and the gateway; handoff cards for 2FA/login.
- Per-phase provider routing plus failover and continuity handoff.
- **Exit:** a bot finishes a browser task end to end with one human handoff, and a
  provider rate limit causes a fallback rather than a failure.

### Phase 6 — Collaboration (≈2 weeks)
- `ask_<bot>` MCP tool; bot-to-bot handoff with context; teams with a coordinator.
- Spaces: bot-owned living artifacts (Obsidian note or dashboard) kept in sync.
- **Exit:** a Triage → PR shepherd → Changelog chain runs with no human relaying.

### Phase 7 — Observability and Studio UX (continuous; heavy in the final 2 weeks)
- Live transcript over WebSocket with Pause, Take over and Inject; replay.
- Bot profile page (identity, goals, memory, skills, rules, channels, budget, health);
  roster sparklines; SLO dashboard.
- Goal-first creation: the Architect starts from "what should this bot achieve?". It
  reads your connected MCP servers and *suggests* bots (Dots-style proactive research,
  read-only).
- Version restore; template "refresh from upstream" as a proposal.

**Total:** roughly 17–21 weeks of focused work, or about half that with parallel Relay
workers on independent phases (Phases 3, 5 and 6 can overlap once Phase 2 lands).

---

## 5. Complete feature catalogue (everything this plan makes buildable)

**Signals and triggers:** cron · interval · natural-language schedules with exclusions
and holidays · inbound webhooks (HMAC) · Gmail/Slack/GitHub/RSS/directory watch
adapters with cursors · run_completed · kanban_event · interrupt_created · peer/bot
message · `ask_<bot>` · commitment-due · manual "wake now with this note" · debounce and
coalesce · trigger test-fire with sample payload.

**Kernel:** durable mailbox · lease plus resume after restart · goals with success
criteria and progress · commitments and follow-ups · dropped-thread detection · cheap
perceive / strong act · max wakes per hour · backoff on repeated failure · dry-run wake ·
simulator using recorded events.

**Governance:** Tool Gateway MCP proxy · risk taxonomy · Allow once / Always allow /
Deny · conditional rules (argument predicates, time windows, expiry) · global safety
floor · taint tracking on external content · auto-reviewer · budgets (dollars, tokens,
actions) with soft downgrade and hard pause · kill switch (one bot or all) · handoff cards
· per-bot credentials · audit log with export · enforcement-level badge.

**Memory and learning:** episodic log with FTS5 recall · semantic memory with
confidence, decay and source · procedural skills (SKILL.md) · reflector proposals for
memory, skills and rules · "save run as skill" · skill self-patching from human fixes ·
operator profile in Obsidian · feedback labels from Approve/Dismiss/Edit/Send back ·
per-bot eval suites · shadow-version gate · version restore · forget, purge and export.

**Execution:** bot home dir · persistent browser profile · teach mode (record →
parameterized skill) · worktree Work with land/discard · local, Docker and SSH backends
· per-phase provider routing · cross-vendor failover · rate-limit continuity handoff ·
headless-box deployment.

**Channels:** per-bot conversation thread · talk-to-bot pane · mweb push · Slack
(Block Kit approvals) · Telegram · email digest plus reply-to-approve · voice on Mac ·
interactive approval cards on every channel · urgency scoring · quiet hours · digest
batching · morning brief · weekly bot report.

**Collaboration:** bot-to-bot messaging · handoff with context · teams with a coordinator
· Spaces / living artifacts · human-assigned tasks as commitments · shared operator
profile.

**Observability and UX:** live transcript over WebSocket · Pause / Take over / Inject ·
replay · bot profile page · roster sparklines · SLOs (success, escalation, approval
latency, cost, learning acceptance) · Activity that separates scheduled, event and manual
wakes · goal-first Architect · bot suggestions from connected apps · templates with
upstream refresh · Endurance and iOS parity through the same API.

---

## 6. Key design decisions (to confirm)

| # | Decision | Recommendation | Why | Alternatives |
|---|---|---|---|---|
| D1 | How to enforce policy across 12 providers | **MCP proxy (Tool Gateway)** plus native hooks where they exist | the only provider-agnostic interception point we own | prompt advisories (today; not enforcement); per-provider patches (N× work) |
| D2 | Kernel: new loop, or grow `runSectionProduce`? | **New kernel in `server/modules/bots/`**, reusing the runner, dispatch and work-profile code as libraries | the tick model is the thing we are replacing | incremental grafting (keeps the cron-shaped assumptions) |
| D3 | Autonomy model | **Rules only; no modes** | consistent with the 2026-09-25 single-pipeline decision | reintroducing Propose/Act modes (rejected before) |
| D4 | Episodic recall | **SQLite FTS5 first**, embeddings later if needed | zero new infra, and Hermes shows FTS5 plus summaries is enough | vector DB now (more infra, marginal gain) |
| D5 | Where the operator profile lives | **Obsidian note**, written only through proposals | one second brain, which the user already rejected duplicating | a USER.md per bot (rejected 2026-08-15) |
| D6 | Always-on hosting | **Support a headless Mac or cloud box through Endurance's remote server** | a laptop sleeps; the benchmarks all run on cloud machines | laptop-only (not really always-on) |
| D7 | Learning promotion default | **Human approval; opt-in auto-promote rules** | earns trust before autonomy, the lesson from Instinct | fully automatic (Hermes-style; too risky at the start) |

---

## 7. Risks and mitigations

- **Prompt injection through inbound content.** Taint tracking, auto-review, and default
  `ask` for send/publish (Phase 1 ships before autonomy grows).
- **Runaway cost from always-on bots.** Watch adapters instead of full prompts, the
  cheap/strong split, budgets with a hard pause, and cost per day on each roster card.
- **fd exhaustion from watch adapters.** Don't use chokidar-native per-file watchers on
  macOS (see the spawn EBADF memory). Poll with cursors, and add a shared watcher
  registry with an fd budget.
- **Notification fatigue.** Urgency scoring, digests, quiet hours, and a per-bot daily
  ping cap.
- **LaunchAgent and TCC.** Bot homes live under `~/.cloudcli`, never in
  Documents/Desktop/Downloads. The LaunchAgent runs `dist-server`, so rebuild after each
  phase.
- **Scope creep.** Every phase has a measurable exit criterion, and the flag stays off
  until it passes.
- **Isolated e2e safety.** Never click Approve or Send back against real MCP accounts in
  e2e runs. Use a fake-MCP fixture server behind the Tool Gateway for tests (this also
  makes the gateway testable).

---

## 8. Success metrics (measured against the Phase 0 baseline)

- Cost per useful item down at least 50% (event-driven plus the cheap/strong split).
- Share of items dismissed down at least 30% after 2 weeks of learning, with no prompt edits.
- Median approval latency under 15 minutes (phone and Slack approvals).
- Zero ungated side effects in the red-team suite (injection emails, denied tools, every provider).
- At least 90% of wakes succeed; zero work lost to server restarts.
- At least 3 bots running 24/7 on the headless box for 2 weeks without intervention.
