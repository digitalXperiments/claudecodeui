# Kanban Orchestration — User Guide

The **Kanban** tab turns a board of tasks into a set of agent runs. Each task can
be assigned to an agent (provider), given explicit permissions, and executed —
manually, on a schedule, when moved into a column, or automatically when a task
it depends on finishes.

## Agent profiles

Create reusable run configs under **Settings → Agent profiles** (for example
“Claude High Effort” or “Grok Low Effort”). Each profile stores provider, model,
effort, permission mode, optional plain-English permission intent, and
allow/deny rules. Kanban implement/review pickers select from this catalog.

Failed runs and permission waits surface in the left sidebar **Notifications**
entry (above Settings) so headless work does not hang silently.

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
  - **Implementation profile** — preferred: pick a named **agent run profile**
    from **Settings → Agent profiles** (provider + model + effort +
    permissions). Falls back to a raw provider if no profile is selected.
    Auto-runs when the card enters **In Progress**.
  - **Review profile** — optional second profile. When implementation finishes
    successfully, the card moves to **Review** with a review brief (original
    task + prompt + the implementation agent's output tail + instructions to
    inspect git/diff), and this agent runs. On success the card moves to
    **Done**. Leave as **None** to skip review and go straight to Done after
    implementation.
  - **Permission mode / tools** — used when no implement profile is selected.
    With a profile, permissions are **live-linked** from the profile (edit them
    under Agent profiles). For unattended work prefer profiles with **Accept
    edits**, **Auto** + allow lists, or **Bypass**, or plain-English permission
    intents that compile to allow/deny rules.
  - **Allowed / Disallowed commands** — one entry per line (e.g. `Bash(ls)`),
    when not using a profile.
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
