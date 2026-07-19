# Kanban Orchestration — User Guide

The **Kanban** tab turns a board of tasks into a set of agent runs. Each task can
be assigned to an agent (provider), given explicit permissions, and executed —
manually, on a schedule, when moved into a column, or automatically when a task
it depends on finishes.

## Opening the board

Select a project, then open the **Kanban** tab in the main content area. The
first time you open it for a project, a board with four default columns is
created: **Backlog → In Progress → Review → Done**.

## Tasks

- **New task** (top-right) or the **+** on a column header creates a task.
- Click a card to open the task editor. Fields:
  - **Title / Description** — human-facing labels.
  - **Prompt** — the instruction sent to the agent when the task runs.
  - **Column** — which column the card lives in.
  - **Agent** — the provider that will execute the task (Claude, Codex, Cursor,
    OpenCode, Grok, Kimi, Agy). Leave **Unassigned** for a note-only card.
  - **Permission mode** — how guarded the run is. Defaults to **Default
    (guarded)**; automated runs never bypass permissions unless you explicitly
    pick **Bypass permissions**.
  - **Allowed / Disallowed commands** — one entry per line (e.g. `Bash(ls)`).
  - **Schedule (cron)** — a cron expression to run the task on a timer.
  - **Depends on** — other tasks that must reach **Done** before this one runs.
- Drag cards within/between columns to reorder or move them.

## Running a task

- Open a task and click **Run** to execute it immediately. Live output appears
  in the task editor; the card status moves `todo → running → done` (or
  `failed`). Each execution is recorded in the task's run history.

## Automation

Three triggers run tasks without a manual click:

1. **Dependency chaining** — when a task reaches **Done**, any task whose
   dependencies are now all done is queued automatically. Cycles are rejected
   when you create the dependency.
2. **Column-move (run on enter)** — click the ⚡ icon on a column header to turn
   on auto-run. Moving an assigned task into that column queues a run.
3. **Schedule** — a task with a cron expression is queued each time the schedule
   fires.

Automated runs go through a queue with a concurrency cap (default **3**
simultaneous runs) to prevent runaway fan-out. Tasks waiting for a slot show as
**queued**.

## Permission matrix

The table icon (top-right) switches to a board-wide **agents × tasks** view:
each task, its assigned agent, permission mode, allow/deny counts, and schedule.
Click a row to edit the task.

## Durability

Task and run status live in the app database. If the server restarts while a run
is in flight, that run is reconciled to **failed** on boot and anything left
**queued** is re-enqueued, so nothing is silently lost.

## Safety notes

- Permissions are the safety boundary. Keep automated tasks on **Default**
  unless you have a specific reason to relax them.
- A mis-set cron or a wide dependency fan-out can queue many runs; the
  concurrency cap and per-task debounce limit this, and every auto-trigger is
  logged server-side.
