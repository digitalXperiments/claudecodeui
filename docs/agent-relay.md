# Agent Relay

Agent Relay is CloudCLI's lightweight, lead-owned delegation path. A normal
Claude, Codex, OpenCode, or other provider chat remains responsible for planning,
coordination, judgment, and final verification. CloudCLI supplies a small MCP
broker that starts provider workers and returns durable results to that chat.

Use Agent Relay as the primary interactive orchestration path where a capable
lead splits bounded assignments, pipelines dependent stages, verifies findings
adversarially, and reviews the answers. The bundled `delegate-agent-work` skill
tells the lead to stay an orchestrator: plan, dispatch, wait, unblock, and
synthesize — never grep, edit, test, or implement in the lead session. Native
provider tools (Codex `exec` / `FileChanges`, Claude Read/Bash, and so on)
cannot be stripped; the skill and MCP descriptions are the enforcement layer.
Agent Swarm remains a compatibility fallback while Relay closes the remaining
unattended-recovery and worktree-retention gates; new interactive workflows
should prefer Relay.

## Enable it

1. Open **Settings → Agent Relay**.
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
session id into the provider run's environment as `CLOUDCLI_LEAD_SESSION_ID`;
the MCP process inherits it and sends it on every call, so a lead can only read
and steer its own workers. Codex forwards only the variables an MCP entry names,
so the managed catalog entry declares it in `env_vars`.

The panel scopes to the current chat by default and offers an explicit
project-wide operator view. Worker sessions are internal: their transcripts open
by id from the panel or the Running rail, but they are excluded from project
session lists so delegate prompts never appear as the user's own sessions.

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

An unanswered request is denied when the approval budget (Settings → Approval
wait) expires, so a worker resumes and reports the blocker instead of hanging
until its job timeout. The effective approval wait is clamped to end at least
30 seconds before the job timeout, so a parked worker always gets to report. A job that does time out keeps whatever partial findings
it had produced, reported as a `blocked` result.

The lead can set `provider`, `model`, and `effort` independently for every task
in a batch. Settings → Agent Relay can allowlist worker models per provider.
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

## Boundaries

- The lead should delegate only independent scopes; overlapping writers are
  intentionally not reconciled by Relay.
- Delegates are explicitly prohibited from calling Relay again; coordination
  remains one level deep and owned by the interactive lead. Relay also removes
  native Claude/Cursor Task/Agent tools from worker runtimes, so this boundary
  is host-enforced rather than prompt-only.
- MCP tool access for workers is opt-in per task through existing catalog names.
  Grok Relay workers use a separate MCP-clean managed home; explicitly granted
  servers are attached to the ACP session instead of inherited from user config.
- A server restart preserves jobs that never started and safely schedules them
  again. Jobs interrupted after provider dispatch are marked failed rather than
  silently replayed, because replay could duplicate side effects.
- Disabling Relay cancels queued, running, and approval-blocked work. Cancellation
  is persisted and returned immediately while slow provider abort cleanup runs
  in the background.
- Provider CLI authentication and availability are shown in Settings and by
  `relay_capabilities`; Relay does not provision provider credentials.

## CLI and packaging

`cloudcli agent-relay-mcp` runs the stdio MCP bridge. Settings normally install
this command automatically, along with a loopback API URL and generated bearer
token. The production server build copies the bundled skill assets beside the
compiled service so npm, desktop, and local-server distributions share the same
behavior as a development checkout.
