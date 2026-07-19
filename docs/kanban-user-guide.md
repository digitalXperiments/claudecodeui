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
  - **Prompt** — the instruction sent to the **implementation** agent on run.
  - **Column** — which column the card lives in.
  - **Implementation agent** — provider that executes the task when it enters
    **In Progress** (Claude, Codex, Cursor, OpenCode, Grok, Kimi, Agy).
  - **Review agent** — optional second provider. When implementation finishes
    successfully, the card moves to **Review** with a review brief (original
    task + prompt + the implementation agent's output tail + instructions to
    inspect git/diff), and this agent runs. On success the card moves to
    **Done**. Leave as **None** to skip review and go straight to Done after
    implementation.
  - **Permission mode** — how guarded the run is. Defaults to **Default
    (guarded)**. Headless/auto runs cannot answer interactive permission
    prompts — for unattended work prefer **Accept edits** or **Bypass
    permissions**, or pre-allow the tools you need.
  - **Allowed / Disallowed commands** — one entry per line (e.g. `Bash(ls)`).
  - **Schedule (cron)** — a cron expression to run the task on a timer.
  - **Depends on** — other tasks that must reach **Done** before this one runs.
- Drag cards within/between columns to reorder or move them.

## Running a task

- Open a task and click **Run** to execute it immediately. Live output appears
  in the task editor; the card status moves `todo → running → …`. Each
  execution is recorded in the task's run history.
- Lifecycle on success:
  - **With review agent:** In Progress → (implement) → Review → (review) → Done
  - **Without review agent:** In Progress → (implement) → Done
- On failure the card stays where it is with status **failed** so you can fix
  and re-run. Check exit code in the task editor.

## Automation

Triggers that run tasks without a manual click:

1. **Move to In Progress** — an assigned implementation agent is always
   auto-queued when a card enters In Progress (Backlog → In Progress).
2. **Move to Review / implement success** — a review agent is auto-queued when
   the card lands in Review (including the automatic move after implementation).
3. **Dependency chaining** — when a task reaches **Done** (after review if any),
   any task whose dependencies are now all done is queued automatically.
4. **Column-move (run on enter)** — click the ⚡ icon on a custom column to
   auto-run the implementation agent when tasks enter it.
5. **Schedule** — a task with a cron expression is queued each time the schedule
   fires.

Automated runs go through a queue with a concurrency cap (default **3**
simultaneous runs) to prevent runaway fan-out. Tasks waiting for a slot show as
**queued**.

## Global board (cross-project)

The **Project / Global** toggle in the header switches between the current
project's board and a single **global board** shared across all projects:

- The global board works even with no project selected.
- Each task on it belongs to a project you pick in the task editor; cards show a
  project badge so you can tell them apart.
- Dependencies can cross project boundaries — a task in project A can depend on a
  task in project B. The dependency picker labels each task with its project.
- Runs still execute in the task's own project directory, so an automated global
  workflow can orchestrate work spanning multiple repos.

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
