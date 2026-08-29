# PRD: Swarm Studio v2 — Autonomous, Fast, Legible

**Date:** 2026-08-23
**Status:** In progress (phase 1 implemented in this change)

## Problem

Swarm Studio is architecturally strong (persistent blackboard, escalation ladder,
supervisor mode, crash recovery) but three things keep it below Claude-style
dynamic workflows in felt experience:

1. **Not fully autonomous** — budget/wall-clock checks only fire at wave/cycle
   boundaries; a single long step can blow the budget. Unscoped writer steps
   silently serialize, killing fan-out speed.
2. **Not fast enough** — spend checks recompute the full usage rollup
   (O(members × child-run reads)) on every cycle; post-restart recovery admits
   swarms strictly sequentially.
3. **Not legible** — the UI polls whole swarm rows and renders a text wall.
   The user cannot answer "how many agents are running right now and what is
   each doing?" in one glance, which Claude dynamic workflows nails.

## Goals (phase 1 — this change)

- G1: Append-only `swarm_events` log for every meaningful transition (the
  determinism layer that later enables replay + fork-from-checkpoint).
- G2: Live activity endpoint (`GET /api/swarm/:id/activity`) answering:
  running-agent count, per-agent card data (label/model/status/elapsed/tokens),
  wave progress summary.
- G3: O(1)-ish spend sum for budget/finish-mode checks via SQL instead of the
  full `withUsage` rollup.
- G4: Mid-step wall-clock enforcement: each dispatched step's hard timeout is
  clamped to the swarm's remaining `wallClockMs`, so a runaway step preempts
  at the deadline using existing abort machinery.
- G5: Parallel restart recovery with bounded admission (pool of 4).
- G6: Scope discipline: planner prompt *requires* `scope` on every non-read-only
  task; violations emit a `[scope]` blackboard event so serialization is visible
  instead of silent.
- G7: SwarmActivityStrip UI — "N agents running" header, live agent cards,
  wave timeline strip; 2.5s polling while active + instant refresh on
  `swarm_updated`.

## Non-goals (later phases)

- Fork-from-checkpoint / time-travel UX (needs G1 history, phase 2).
- Semantic merge of overlapping parallel writers.
- Mechanical verifier seat tier.
- Mission Control → swarm bridge action type.
- Incremental token accounting inside child runs.

## Design

### swarm_events table

```sql
CREATE TABLE IF NOT EXISTS swarm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swarm_id TEXT NOT NULL REFERENCES swarms(swarm_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- wave_dispatch | step_started | step_finished |
                             -- step_retry | step_failed | budget_stop |
                             -- scope_violation | supervisor | handoff | status
  step_id TEXT,
  level TEXT DEFAULT 'info', -- info | warn | error
  data TEXT NOT NULL DEFAULT '{}',  -- JSON payload
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(swarm_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_swarm_events_swarm_seq ON swarm_events(swarm_id, seq);
```

Repository helpers: `appendEvent(swarmId, kind, { stepId, level, data })`
(auto-increments seq), `listEventsForSwarm(swarmId, { sinceSeq?, limit? })`.
Emitted alongside existing blackboard messages at dispatch, execution, retry,
budget-stop, scope-violation, handoff points. Blackboard stays human-readable;
events are the machine stream.

### Activity endpoint

`GET /api/swarm/:swarmId/activity` →

```json
{
  "activity": {
    "status": "running",
    "runningCount": 3,
    "agents": [{ "memberId","stepId","label","model","status","startedAtMs",
                 "elapsedMs","tokens","costUsd" }],
    "waves": [{ "wave":0,"total":4,"done":3,"running":1,"failed":0,"queued":0 }],
    "totals": { "stepsDone":9,"stepsTotal":14,"failedSteps":1 }
  }
}
```

Computed from members + plan steps + live child runs; cheap enough to poll at
~2s. The UI uses this instead of refetching the full swarm row while active.

### Spend sum

`swarmDb.sumSpendUsd(swarmId)`: single SQL join over members × agent_runs
returning total cost (with the same fallback estimate used by `withUsage`
applied per-row in JS over the slim result). Budget/finish-mode checks call
this; full `withUsage` remains for the detail view.

### Wall-clock clamp

Pipeline tracks `deadlineAt` when `wallClockMs` is set. Each step launch passes
`timeoutMs = min(stepTimeoutMs, deadlineAt - now)` when positive; if already past
deadline no new steps start (existing behavior) and the in-flight one preempts at
its own clamp via the existing race/abort machinery.

### Recovery pool

`recoverActiveSwarms` runs recoverable swarms through a fixed worker pool of 4
(`CLOUDCLI_SWARM_RECOVERY_CONCURRENCY`), preserving lease/defer semantics per
swarm.

## Success criteria

- While a swarm runs, the activity panel shows an accurate running count and
  per-agent cards updating within ~2.5s without a full-row refetch.
- Finish-mode/spend checks do not scale with member history (single SQL).
- A step cannot outlive `wallClockMs` by more than its own stall grace.
- Every wave dispatch / step outcome / budget stop is queryable from
  `swarm_events`.
