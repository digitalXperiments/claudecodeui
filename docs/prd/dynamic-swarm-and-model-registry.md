# PRD: Dynamic Swarm Orchestration + Model Capability Registry

**Status:** Draft v1
**Owner:** Swarm platform
**Related:** `docs/prd/CloudCLI-Feature-PRD-v1.md` (P11 swarm), audit of `server/modules/swarm/` (2026-08)

---

## 1. Problem

The current Agent Swarm has two structural problems:

1. **Static pipeline, serial execution.** The orchestrator emits a fixed ≤12-step DAG up front; mixed writer/reader waves collapse to concurrency 1 in a shared worktree (`swarm.service.ts:2852`). Runs grind for hours, and the first step failure abandons all remaining planned waves in favor of a small tick-budgeted supervisor loop.
2. **Stale, manual agent profiles.** Seat selection depends on user-maintained Agent Profiles tagged with `swarm_roles`. These rot as new models ship, and the spend governor's model-downgrade path is a name-regex (`spend-governor.service.ts:32-50`).

Goal: a **Claude-dynamic-workflows-grade swarm** — an orchestrator loop that fans out parallel workers into isolated worktrees, replans after every result cycle, and staffs each task from an **automated, benchmark-backed model capability registry** that requires zero per-model maintenance from the user.

## 2. Non-goals

- Replacing chat / Mission Control / Kanban runtimes (they keep their current engines).
- Cross-machine distributed execution (single-host, multi-process via DB lease only).
- Training or fine-tuning anything; capability data comes from public benchmarks + live probes.

## 3. Architecture overview

```
┌────────────────────────────────────────────────────────────┐
│                    Orchestrator Loop                        │
│  (LLM-driven; one dispatch cycle = plan→fan-out→harvest)    │
│                                                            │
│   ┌──────────────┐   ┌──────────────────┐                  │
│   │ Task Graph   │◄──┤ Result Harvester │                  │
│   │ (live state) │   └──────────────────┘                  │
│   └──────┬───────┘                                         │
│          ▼                                                 │
│   ┌──────────────┐   ┌──────────────────────────────┐      │
│   │ Staffing     │◄──┤ Model Capability Registry    │      │
│   │ Router       │   │ (benchmarks + probes, cached)│      │
│   └──────────────┘   └──────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘
          │ fan-out                       ▲ harvest
          ▼                               │
┌────────────────────────────────────────────────────────────┐
│  Worker pool: N concurrent seats                           │
│  each = provider runtime (existing ACP adapters)           │
│        + isolated git worktree (writers)                   │
│        + private scratchpad + structured result contract   │
└────────────────────────────────────────────────────────────┘
```

Two new subsystems:

- **A. Dynamic Orchestrator** — replaces the static-DAG-as-contract engine.
- **B. Model Capability Registry** — replaces hand-authored agent profiles as the staffing source.

---

## 4. Subsystem A — Dynamic Orchestrator

### A1. Execution model

Replace `executePipeline`'s wave executor with a **dispatch loop**:

```
while (!goalComplete && budgets remain):
    batch = orchestrator.decideNextBatch(goalCard, results, graph)
    # batch = 1..N tasks, each {kind, brief, acceptanceChecks, suggestedCapability}
    seats = staffingRouter.assign(batch)            # §5
    results = await Promise.all(dispatch(seats))     # true parallelism
    harvester.distill(results) → goalCard + graph updates
```

- The initial LLM plan becomes a **seed suggestion**, not a contract. The loop may add, split, drop, or reorder tasks every cycle.
- **No tick budget.** Termination is governed by resource budgets only:
  - `maxSpendUsd` (hard, enforced mid-step via token streaming, not at step start)
  - `wallClockMs` for the whole swarm
  - `maxConcurrentSeats`
  - `stallTimeoutMs` per seat (existing stall detector reused)
- Failure semantics: a failed task triggers remediation **only on its subgraph**. Independent branches continue running. Remediation is just another dispatch decision, not a mode switch.

### A2. Parallelism by default

- Every writer seat runs in its own child worktree (promote the existing opt-in `parallelWriters` machinery to default). Merge-back is itself a dispatched task (`kind: 'merge'`) that rebases child branches onto the integration branch and resolves/report conflicts.
- Read-only kinds (`explore`, `review`, `test`, `research`) share the integration worktree read-only and are never serialized.
- Default concurrency: `min(maxConcurrentSeats, cpuHeuristic)`; UI-configurable per swarm.

### A3. Context isolation & result contracts

Replace the shared 10k-char blackboard paste:

- Each seat gets: goal summary (≤500 chars), its own brief, relevant distilled findings (retrieved, not dumped), and a **private scratchpad** file inside its worktree.
- Every worker returns a **structured result**: `{verdict, filesTouched[], decisions[], openQuestions[], evidenceForAcceptance{}, costSoFar}`. The harvester distills these into the goal card; later briefs cite findings by id, not by raw paste.
- Goal card decisions array gets capped + summarized (rolling window + running digest).

### A4. Acceptance checks become machine-checkable

Planner prompt must emit per-task assertions of the forms:
`{type:'test', pattern}`, `{type:'fileExists', path}`, `{type:'grep', pattern, path}`, `{type:'command', cmd, expectExit}`, `{type:'diffStat', maxFiles}`.
Verification runs the assertions directly; LLM judgment is fallback only. Removes the heuristic string matcher (`acceptanceEvidenceMatches`).

### A5. Persistence & recovery

- Keep the SQLite row + lease design; add an append-only `swarm_events` table (task dispatched/finished/remediated, budget checkpoints) so state reconstruction doesn't depend on whole-row JSON rewrites.
- Boot recovery parallelizes (bounded pool of 8) instead of sequential await (:6833).
- Durable pause points preserved: plan approval, budget exhaustion, cancel request.

## 5. Subsystem B — Model Capability Registry

### B1. Concept

A cached, auto-refreshed registry mapping every model available across installed providers to measured capabilities, so the staffing router can answer: *"for this task kind + difficulty, what is the cheapest model that can do it?"* No user-authored profiles required.

### B2. Data sources (layered)

| Layer | Source | Freshness | Cost |
|---|---|---|---|
| L1 Static | Provider `/models` endpoints (already exposed: `GET /api/providers/:provider/models`) | daily | free |
| L2 Benchmarks | Public leaderboards scraped/cached: SWE-bench Verified, LiveCodeBench, Aider polyglot, Terminal-Bench, plus general (MMLU-Pro, GPQA) and long-context scores | weekly refresh, ETag/If-Modified-Since | free |
| L3 Community signals | OpenRouter model metadata (pricing, context), LM Arena Elo where available | weekly | free |
| L4 Live probes *(opt-in)* | Tiny canary prompts through our own providers (e.g., "produce a JSON patch for this toy repo") scored mechanically | monthly, amortized | ~cents |

Each model gets a **capability vector**:

```ts
interface ModelCapability {
  modelId: string; provider: string;
  contextWindow: number;
  inputCostPerMtok: number; outputCostPerMtok: number;
  scores: {
    coding: number;        // composite: SWE-bench/LiveCodeBench/Aider
    agenticToolUse: number;// Terminal-Bench, tool-call evals
    longContext: number;
    speedTps?: number;     // from L4 probes or community data
  };
  confidence: number;      // decays with data age; low confidence → conservative routing
  fetchedAt: string;
}
```

Normalization: scores min-max scaled within the registry; missing scores lower `confidence` rather than being imputed optimistically.

### B3. Storage & refresh

- New table `model_capabilities` (SQLite): capability vector + source provenance + fetch timestamps.
- Background refresher (node-cron style, reuses Mission Control scheduler patterns): L1 daily, L2/L3 weekly, L4 monthly if enabled. All fetches ETag-cached; failures keep last-good data and decay `confidence`.
- Cold start (no network): ship a snapshot JSON in the repo, refreshed at release time by a build script. Swarm still works offline — it just routes conservatively.

### B4. Staffing router

Replaces profile-based roster as the default (profiles remain as an override layer):

```ts
route(task: {kind, difficulty, estTokens, needsTools, needsLongContext},
      constraints: {budgetRemaining, allowedProviders}):
  seat[] // ranked candidates
```

Rules:
- **Task-kind → score mapping:** implement/review/test → `coding`; explore/orchestrate → `agenticToolUse` + long context; docs → cheapest passing model.
- **Cost-efficiency frontier:** pick cheapest model whose `coding ≥ threshold(kind, difficulty)`; reserve top-tier models for planning/synthesis/remediation roles.
- **Diversity guard:** cap same-model seats per batch (default 3) so a single model's systematic failure mode can't sink a wave.
- **Feedback loop:** the existing cost ledger feeds outcomes back — per-(model × taskKind) success rate adjusts a local multiplier on the capability scores. This is the self-healing part: if a newly released model is overrated by benchmarks, live outcomes correct routing within a few swarms.
- **Spend governor rewrite:** downgrade = route next dispatch to the next-cheapest passing candidate (real registry lookup), not regex. Mid-step enforcement via streamed usage against a token bucket.
- **Fallback chain:** if a routed model errors/rate-limits, the runner retries down the ranked candidate list automatically (failover already exists in runs service — reuse).

### B5. UI

- Settings → **Model Registry** panel: table of discovered models, capability bars, last-refreshed, confidence, "Refresh now", toggle for live probes.
- Swarm creation form: "Auto-staff (recommended)" vs "Custom profiles". Auto-staff shows the projected roster + estimated cost before launch; user can pin/swap individual seats.
- During a run, each seat card shows why it was chosen ("cheapest model meeting coding≥0.75 for implement·medium").

## 6. Migration & compatibility

| Phase | Scope |
|---|---|
| P1 | Registry: schema, fetchers, snapshot, settings UI. Ship read-only (no behavior change). |
| P2 | Staffing router behind flag `swarm.autoStaffing`; profiles still win when explicitly set. Spend-governor regex replaced. |
| P3 | Dynamic orchestrator behind flag `swarm.dynamicEngine`: new dispatch loop, structured results, machine-checkable acceptance, writer isolation default. Old engine stays available (`swarm.engine=classic`) for one release. |
| P4 | Default flip, classic engine deprecated, blackboard removed after migration of in-flight swarms. |

Existing durable swarms resume on the engine that started them.

## 7. Success metrics

- Median swarm wall-clock −50% at equal success rate (parallelism + no tick stalls).
- Swarm failure rate (failed/blocked terminations) <10%, from current baseline.
- Zero user-maintained profile edits required for good staffing on new-model day (registry picks them up within one refresh cycle).
- Cost per completed goal flat or lower despite more parallelism (cheaper-model routing offsets concurrency).

## 8. Risks

- **Benchmark gaming/staleness** → confidence decay + live-outcome multiplier + L4 probes.
- **Merge conflicts explode with high writer concurrency** → merge tasks are first-class, conflict-heavy batches trigger automatic scope-splitting (reuse `splitWaveByScope` logic as a router hint).
- **Registry scraping breaks** → layered sources + shipped snapshot degrade gracefully.
- **Cost blowout from parallelism** → hard spend cap enforced mid-step via token bucket; concurrency scales down automatically as budget tightens.

## 9. Feedback-loop pitfalls & mitigations

The orchestrator/supervisor continuously consumes subagent results. This loop is powerful but has known failure modes. Each pitfall below includes its solution and where it lands in the implementation.

### P1. Feedback overload / context explosion at the orchestrator
**Pitfall:** N parallel workers × every cycle = the orchestrator's own context fills with raw results. By cycle 6 it's re-reading megabytes and starts making worse decisions than a static plan would — the exact problem the 10k blackboard had, relocated one level up.
**Solution:**
- Workers never return raw logs; only the structured contract (§A3). Raw output stays in per-seat scratchpads, retrievable by id on demand ("pull, not push").
- Harvester enforces a fixed orchestrator context budget (e.g., ≤24k chars): rolling digest of completed work + full detail only for the last cycle + open questions. Older cycles compress to one line each in the goal card.
- Orchestrator decisions are emitted as compact JSON batches; if the model's decision payload exceeds budget, it's rejected and retried with a compression hint.

### P2. Oscillation / thrash between replans
**Pitfall:** Result A says "needs changes", remediation runs, next review says the opposite; the loop ping-pongs burning budget without progress (the current validation remediation loop can already do this for up to 8 rounds).
**Solution:**
- Every task carries an `attemptLineage` counter; when the same task id hits 3 generations, the orchestrator is *forced* into one of two exits: split differently (change scope/approach) or escalate to a stronger model — "retry harder" is not an option.
- Track a per-swarm `progressSignal` (net acceptance checks passed − regressed). Two consecutive non-positive cycles trigger a mandatory plan-level rethink prompt rather than another local fix.
- Hysteresis on reviewer verdicts: a "needs changes" must cite specific failed acceptance checks to count; vibes-based rejections are downgraded to advisory notes.

### P3. Divergent workers / conflicting writes
**Pitfall:** Parallel writers make incompatible decisions (two agents refactor the same module differently) and the swarm discovers this only at merge time, losing hours of work.
**Solution:**
- Pre-dispatch conflict prediction: the router checks batch briefs against touched-path declarations from prior results; overlapping scopes are either serialized, scope-split, or given explicit interface contracts ("you own `api/`, they own `ui/`").
- Interface-first for shared surfaces: when two writers must touch one module, dispatch a cheap `contract` task first that writes the interface/signature file; both writers then build against it.
- Merge tasks run *incrementally* (merge child 1 before child 3 finishes), so conflicts surface while the conflicting worker is still alive and can be asked to fix forward instead of after everything lands.

### P4. Echo-chamber / correlated failure
**Pitfall:** All seats in a wave share the same misunderstanding from the goal card (bad assumption planted at planning), so all fail identically — parallelism multiplies the waste instead of dividing it.
**Solution:**
- Canary pattern for risky or novel work: dispatch 1 seat first at small scope; only fan out the batch once its result validates the approach (the orchestrator prompt includes this heuristic).
- Diversity guard (§B4) doubles as failure isolation: mixed models fail differently, so one systematic misread doesn't take out the whole wave.
- Goal-card assumptions are explicit, numbered, and falsifiable; any worker result that contradicts an assumption flags it, invalidating dependent planned tasks for re-plan rather than silent continuation.

### P5. Stall cascade & zombie feedback
**Pitfall:** One hung seat blocks `Promise.all` harvest; meanwhile stale results from earlier cycles keep influencing decisions after the world has moved on (e.g., after a mid-run revert).
**Solution:**
- Harvest is streaming, not barrier-synced: results apply to the goal card as they arrive (`Promise.allSettled` + per-seat event application); the orchestrator can act on partial batches and cancel stragglers via the existing stall detector.
- Every result carries the goal-card `revision` it was produced against; results older than the current revision by >1 are marked `stale` and only inform, not drive, decisions.

### P6. Orchestrator is itself an LLM — it can be wrong
**Pitfall:** The single point of intelligence hallucinates task graphs, misroutes models, or emits malformed JSON; unlike workers there's no reviewer above it.
**Solution:**
- Schema-validated decision outputs (same JSON-RPC discipline as the ACP layer); invalid decisions retry once, then fall back to a deterministic policy (dispatch the oldest unblocked ready task to the default-routed seat).
- Periodic self-audit: every K cycles, a cheap second-model pass reviews the goal card vs actual git state of the integration worktree and reports drift ("plan says auth done; no auth files exist"). Drift triggers a forced re-grounding prompt.
- All orchestrator decisions land in `swarm_events` (§A5), so post-mortems show exactly which decision sent the swarm sideways.

### P7. Budget death-spiral near the cap
**Pitfall:** As spend approaches the cap, the swarm panics-dispatches cheap models at hard tasks, fails, retries, and burns the remainder without finishing anything.
**Solution:**
- Reserve accounting: the governor holds back an `escapeReserve` (~15% of budget). When remaining budget crosses the reserve threshold, the orchestrator gets one structured notice: "finish mode" — consolidate what exists, run acceptance checks, produce handoff/PR with honest status, and stop. No new feature tasks in finish mode.
- Concurrency auto-scales down with remaining budget (fewer parallel seats = finer spend control).

### P8. Registry routing mistakes compound silently
**Pitfall:** The capability registry routes a hard agentic task to a model that benchmarks well but chokes on our tool protocol; every such task fails slowly and expensively before the outcome multiplier corrects.
**Solution:**
- First-N-tasks-on-new-model rule: a model with <5 observed outcomes in our ledger is capped at medium difficulty and never assigned sole ownership of a critical-path task until it earns trust.
- Slow-fail detection: if a seat exceeds 2× the median tokens-at-completion for its task kind without passing checks, the runner preempts and reroutes down the candidate list rather than waiting out the timeout.
- Confidence-weighted routing (§B2): low-confidence entries route conservatively (cheaper-but-safe or known-good), never optimistically.
