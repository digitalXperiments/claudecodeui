# Agent Relay

Agent Relay is CloudCLI's lead-owned delegation path. A provider chat plans,
coordinates, and synthesizes. CloudCLI's MCP broker starts workers and returns
durable results to that chat. The bundled `delegate-agent-work` skill tells the
lead to stay an orchestrator: plan, dispatch, wait, unblock, and synthesize —
never grep, edit, test, or implement in the lead session.

Claude workers host-disallow native `Task` / `Agent` (and related Task
lifecycle tools) so nested fan-out cannot leave Relay ownership. Plan mode does
not re-inject `Task` for `relayWorker` runs. Other native tools still exist;
the skill is the remaining enforcement for lead-side behavior. Agent Swarm is
retired. Interactive orchestration uses Agent Relay only.

## Enable it

1. Open **Agent Relay** from the left sidebar rail (or the command palette).
2. Select the lead providers that should receive the MCP server and managed
   delegation skill.
3. Select the providers allowed in the worker pool.
4. Choose concurrency, timeout, execution mode, and approval-policy defaults,
   then enable Relay. `Auto` is recommended.
5. Start a new provider chat so its native MCP/skill configuration is reloaded.

CloudCLI registers `cloudcli-agent-relay` in the existing MCP catalog and fans
out the bundled `delegate-agent-work` skill through the existing global-skills
system (OpenCode and Kilo have their own global skill directories, so
OpenCode-only leads receive the skill too). Disabling Relay removes those
provider bindings while preserving the managed catalog definitions for later
re-enabling; boot re-runs the teardown when Relay was disabled before a
restart, so stale projections do not linger. Skill fan-out conflicts and
unsupported lead providers are reported as warnings by the sync endpoint.

OpenCode is a first-class lead. Catalog MCP servers bound to OpenCode —
including Agent Relay — are passed on ACP `session/new` (OpenCode ACP does not
load `~/.config/opencode/opencode.json` `mcp` for those sessions). The same
bindings are still written to that native config so the OpenCode TUI outside
CloudCLI keeps working. Existing installs that already had Relay enabled pick
OpenCode up as a lead on the next CloudCLI start; start a new OpenCode chat
afterward so the MCP server and skill reload.

## Execution model

The MCP server exposes twelve tools:

- `relay_capabilities` reports allowed/available worker providers, their current
  model catalogs, labels, alias-resolved ids, and defaults, per-model effort levels, per-provider seats
  (`readOnlyPlanSeat`, `honorsMcpGrants`), and the hard limits (batch size,
  task characters, concurrency, timeouts, retries).
- `relay_delegate` queues up to 20 assignments and immediately returns IDs with
  compact summaries. Each task may carry a `label`, an `outputSchema`, a
  `dependsOn` list, a `retries` budget, and an `approvalPolicy` override (see
  below).
- `relay_status` reads durable job state as compact summaries — label, provider,
  requested/selected/catalog-resolved/runtime-resolved model identity, effort,
  status, truncated result summary, structured output, token/cost usage, and
  pending approvals. With no IDs it reports every job the calling chat owns.
- `relay_wait` waits up to 60 seconds for any or all selected jobs, and returns
  early when a worker is blocked on an approval the lead must answer.
- `relay_result` returns one job's provider/model identity and complete report:
  full summary, evidence, validated structured output, and the worker's raw
  final text. Status and wait deliberately truncate; this is the full-fidelity read.
- `relay_peek` shows elapsed/idle time, the recent tool trail, a compact result,
  and a live tail of the worker's streamed prose (`recentOutput`) for a running
  job. It never repeats the full raw result.
- `relay_follow_up` resumes the same provider session for a focused follow-up.
- `relay_diff` inspects an isolated writer's bounded diff.
- `relay_cancel` stops queued or running work.
- `relay_pending_approvals`, `relay_approve`, and `relay_deny` let the lead
  unblock a worker that hit an out-of-envelope permission request.

Every job gets an internal provider session and a canonical run-spine record.
Results, errors, timeouts, provider/model attribution, lineage, and workspace
links are persisted in `agent_relay_jobs`. The chat composer shows that chat's
jobs, surfaces pending approvals, and links each row to the worker's own
session, without turning the UI into another orchestrator.

## Orchestration features

- **Labels.** Each task takes a short `label` used in status listings, session
  titles, run titles, and dependency references.
- **Structured output schemas.** A task may declare `outputSchema` (a practical
  JSON Schema subset: type, properties/required/additionalProperties, items,
  enum/const, anyOf, common bounds). The worker must return a `data` object in
  its `<agent_relay_result>` tag; CloudCLI validates it server-side, sends one
  automatic repair turn to the same session on violation (also for a
  present-but-unparseable result tag), and records the verdict as
  `result.outputValidation`. Output that stays invalid is reported, not hidden.
- **Pipelines.** `dependsOn` lists zero-based indices of earlier tasks in the
  same batch. A dependent stays queued until its inputs complete; their
  summaries and structured outputs are injected into its prompt. A failed,
  cancelled, or timed-out input fails the dependent fast with the reason.
- **Retries.** `retries` (0–2) re-dispatches after an infrastructure failure
  that produced no output — spawn errors, provider crashes — on a fresh worker
  session. A worker that answered is never silently re-run.
- **Usage.** Job summaries carry token totals and cost from the run spine so a
  lead can notice a worker outspending its task. Relay honors the same project
  monthly token/cost budget as other runs: exhausted budgets reject submission,
  are checked again before dispatch, and stop workers when a live usage update
  crosses the ceiling.
- **Fair parallelism.** A single lead uses the full configured concurrency.
  When multiple leads contend, Relay reserves capacity so one large batch
  cannot indefinitely monopolize the worker fleet.

## Session ownership

A relay belongs to the chat that dispatched it. CloudCLI stamps the owning app
session id into the provider run's environment as `CLOUDCLI_LEAD_SESSION_ID`.
The stdio MCP bridge sends it as `X-CloudCLI-Lead-Session-Id` on every HTTP
call. The API uses that header only; body `sourceSessionId` is ignored so a
shared installation bearer cannot impersonate another chat. Codex forwards only
the variables an MCP entry names, so the managed catalog entry declares
`CLOUDCLI_LEAD_SESSION_ID` in `env_vars`. Residual: the MCP token is still
installation-wide, so a caller who also knows another lead's session id can
put it on the header.

The panel scopes to the current chat by default and offers an explicit
project-wide operator view. Worker sessions are internal: their transcripts open
by id from the panel or the Running rail, but they are excluded from project
session lists so delegate prompts never appear as the user's own sessions.

Archiving or deleting a lead session cancels that chat's queued, running, and
approval-blocked workers. Session handoff rehomes in-flight jobs'
`source_session_id` onto the new lead chat; finished jobs keep the original
source for history.

## Permission envelope

Workers run unattended, so CloudCLI answers their permission prompts against the
envelope the lead declared per task, reusing the swarm module's request
classifier:

- safe reads proceed immediately in both modes;
- `approvalPolicy: auto` is the default and recommended profile. It never
  parks the lead. Scouts (`read_only`) get proven-safe reads auto-approved
  and every mutation auto-denied. Isolated writers get in-worktree edits
  auto-approved; network, installs, outside-tree paths, destructive, and
  unclassifiable actions are auto-denied. The worker reports the blocker
  instead of spending lead tokens on `relay_approve`. Isolated writers do
  **not** run with full bypass — CloudCLI still intercepts prompts.
- `approvalPolicy: manual` is the opt-in that still parks the lead for
  isolated-worktree mutations and risky actions. Use it only when you want
  that gate.
- a `read_only` worker may never mutate state, even with lead approval
  (`plan` mode where the provider has it). Unattended explorers run in a
  read-only sandbox and do not prompt on inspect bash: Codex uses
  `approvalPolicy: never` with a read-only sandbox; OpenCode/Kilo/Qwen
  auto-approve plan-mode permission asks. The host still auto-denies
  mutating commands if a prompt does fire. Codex interactive plan chats
  are unchanged.
- only `manual` jobs write durable `agent_relay_approvals` rows and park as
  `waiting_approval`. The classifier is host-enforced; workers do not
  approve or classify their own permissions. Worker prompts name the role
  (EXPLORER vs IMPLEMENTER) so they stay inside the envelope instead of
  probing it.

Approval objects returned over MCP truncate long commands, reasons, and path
lists. The durable REST/operator record remains complete, while repeated lead
polls stay context-cheap.

An unanswered request is denied when the approval budget (Agent Relay → Approval
wait) expires, so a worker resumes and reports the blocker instead of hanging
until its job timeout. The effective approval wait is clamped to end at least
30 seconds before the job timeout, so a parked worker always gets to report. A job that does time out keeps whatever partial findings
it had produced, reported as a `blocked` result.

The lead can set `provider`, `model`, and `effort` independently for every task
in a batch. Agent Relay settings can allowlist worker models per provider.
`relay_capabilities` then returns only those models, and `relay_delegate`
rejects anything outside the list. Omitting `model` uses that provider's
reported catalog default when it is allowlisted (or unrestricted); otherwise
the first allowlisted model. Relay snapshots the catalog label, catalog default,
and any catalog-resolved alias while keeping the existing `model` field as the
selected id passed to the provider. `requestedModel` distinguishes an explicit
lead choice from an omitted default; `runtimeResolvedModel` is added when the
provider reports the concrete running id. This keeps Claude `default`/family
aliases visible alongside their concrete generation and preserves opaque,
provider-qualified OpenCode ids such as `openrouter/z-ai/glm-5.2` exactly.
Legacy rows retain their old nullable `model`; absent identity metadata is
shown as an unrecorded legacy default instead of guessing a concrete model.
Omitting `effort` uses the selected model's provider-native default. A provider
with no limit keeps its full catalog.

`read_only` asks the delegate to inspect and report. `isolated_write` creates a
separate CloudCLI worktree and feature branch for each writer. Writers do not
share a writable checkout. Relay never auto-rebases or auto-merges worker
branches; the lead must inspect each diff and deliberately integrate compatible
changes through the existing Workspaces/Git flow. Completed writers are asked
to commit on their feature branch so that explicit merge/squash integration is
available; failed or interrupted workers may still leave an uncommitted diff
for inspection.

Auto-pick skips Cursor for `read_only` because Cursor has no host-enforceable
plan seat. Explicit `isolated_write` on Cursor is allowed. Cursor headless
`cursor-agent` does not emit permission events CloudCLI can broker, has no
`--disallowedTools` / MCP-isolation flags, and still loads
`~/.cursor/mcp.json` and `<cwd>/.cursor/mcp.json`. Tool deny lists and MCP
grants for Cursor are advisory (env + prompt suffix) only.

## Boundaries

- The lead should delegate only independent scopes; overlapping writers are
  intentionally not reconciled by Relay.
- Delegates must not call Relay again. Coordination is one level deep and
  owned by the interactive lead. Claude workers host-disallow native
  `Task` / `Agent` / `TaskOutput` / `TaskStop` and `mcp__cloudcli-agent-relay*`.
  Plan mode does not re-inject `Task` when `relayWorker` is set. Cursor has
  no equivalent deny flag.
- MCP grants are opt-in per task via catalog names, and only on providers
  with `honorsMcpGrants` (`claude`, `grok`, `opencode`, `kilo`, `cline`,
  `qwencode`). Codex workers get `mcp_servers: {}` (empty managed config), not
  native MCP inherit and not profile/task grants. Grok Relay workers use a
  separate managed home with local `mcp_servers` stripped from `config.toml`;
  granted servers attach on ACP `session/new`. Managed-gateway wait and the
  cloud-catalog hint are skipped for `relayWorker`. Residual: Grok CLI may
  still attach a grok.com managed catalog later in the session.
- A server restart preserves jobs that never started and safely schedules them
  again. Jobs interrupted after provider dispatch are marked failed rather than
  silently replayed, because replay could duplicate side effects.
- Disabling Relay cancels queued, running, and approval-blocked work. Cancellation
  is persisted and returned immediately while slow provider abort cleanup runs
  in the background.
- Terminal Relay jobs older than 14 days are purged on boot (approvals cascade;
  isolated worktrees discarded).
- Provider CLI authentication and availability are shown in Settings and by
  `relay_capabilities`; Relay does not provision provider credentials.

## Open gaps

- mweb has no Agent Relay UI.
- Cursor is not a real read-only seat (`readOnlyPlanSeat` is false). Do not
  send `read_only` to Cursor; auto-pick already excludes it for that mode.

## CLI and packaging

`cloudcli agent-relay-mcp` runs the stdio MCP bridge. Agent Relay settings normally install
this command automatically, along with a loopback API URL and generated bearer
token. The production server build copies the bundled skill assets beside the
compiled service so npm, desktop, and local-server distributions share the same
behavior as a development checkout.
