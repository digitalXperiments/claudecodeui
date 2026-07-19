# Kanban Orchestration — Native Implementation Plan (CloudCLI fork)

Status: design/plan. Supersedes the standalone `cloudcli-plugin-kanban` repo, which
proved a plugin **cannot** drive agent runs the way this feature needs (see
"Why native" below). That repo's schema and UX are reused here as a design seed only.

## Objective

A Kanban board that doesn't just organize tasks but **runs** them: each task is
assigned an agent (provider) with explicit permissions, and can be executed —
manually, on a schedule, when moved into a column, or automatically when the task
it depends on completes. The goal is to automate and streamline real work, with a
task **dependency graph** as the backbone.

## Why native, not a plugin (verified against this repo)

- The plugin frontend `api` exposes only `context`, `onContextChange`, `rpc` — and
  `rpc` is hard-wired to the plugin's *own* subprocess
  (`src/components/plugins/view/PluginTabContent.tsx:95-115`,
  `server/routes/plugins.js:251-257`). No host session-launch hook is reachable.
- Driving runs from a plugin means calling the host back over loopback with an
  api-key (`POST /api/agent`, only 4 of 7 providers) or a JWT+WS dance for the
  other 3 — duplicating the projects/sessions/runs bookkeeping the host already owns,
  with fragile run durability and no access to the live streaming UI.
- Native, we call the existing provider `spawnFns` map
  (`server/index.js:124-141`), hook the run lifecycle at
  `chat-run-registry.service.ts`, store data in the app SQLite DB, and reuse the
  chat streaming components — one code path, all 7 providers, real UI.

## Key integration seams (all verified)

| Concern | Where | Note |
|---|---|---|
| DB engine | `better-sqlite3`; schema constants in `server/modules/database/schema.ts`, wired via `INIT_SCHEMA_SQL` + `runMigrations` (`init-db.ts`, `migrations.ts`) | additive migrations via `addColumnToTableIfNotExists` |
| Repository pattern | `server/modules/database/repositories/projects.db.ts` (object literal + `getConnection()`) | mirror this |
| Route registration | `server/index.js:190-239` — `app.use('/api/<x>', authenticateToken, <x>Routes)` | add `/api/kanban` |
| Provider spawn map | `server/index.js:124-141` — `spawnFns`/`abortFns` for all 7 providers | the executor's target |
| Start-a-run (WS path) | `server/modules/websocket/services/chat-websocket.service.ts:141-220` `handleChatSend` → `spawnFn(command, runtimeOptions, run.writer)` | refactor to expose a headless starter |
| Session create | `server/modules/providers/services/sessions.service.ts:123` `createAppSession(provider, projectPath)` | reuse verbatim |
| Run completion | `chat-run-registry.service.ts` `completeRun`/`completeRunIfCurrent`; terminal `{kind:'complete', success, exitCode}` from `server/shared/utils.ts:365-381` | the automation trigger |
| Per-provider permission syntax | claude `allowedTools[]`/`disallowedTools[]`; grok `--allow`/`--deny Bash(glob)`; cursor `-f`; codex sandbox/approval; opencode agent/env; kimi ACP; agy `--mode`/`--dangerously-skip-permissions` | store provider-native; don't invent |
| Frontend tab | `AppTab` (`src/types/app.ts:27`) + `VALID_TABS` (`src/hooks/useProjectsState.ts:334`) + `MainContentTabSwitcher.tsx:34-68` + content switch in `MainContent.tsx` (~:206) | 4 edits to add a primary view |
| Reusable stream UI | `ChatMessagesPane.tsx` fed by `src/stores/useSessionStore.ts` (keyed by sessionId) | embed in task detail |
| Permission editor | `src/components/settings/.../agents-settings/sections/content/PermissionsContent.tsx` | reuse for allow/deny |
| Prior art | `server/routes/taskmaster.js` is `.taskmaster` folder detection — **unrelated**, no reuse | — |

New dependencies to add: `@dnd-kit/core` + `@dnd-kit/sortable` (board drag-drop),
and a cron lib (`croner` recommended — zero-dep, TS types) for scheduling. Neither
is currently in `package.json`.

---

## Data model (new tables in `schema.ts`)

Keep app-facing ids as TEXT UUIDs (match `projects`/`sessions` convention).

```sql
CREATE TABLE IF NOT EXISTS kanban_boards (
  board_id     TEXT PRIMARY KEY NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  columns_json TEXT NOT NULL,          -- [{id,name,order,runOnEnter?:bool,permissionMode?}]
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kanban_tasks (
  task_id           TEXT PRIMARY KEY NOT NULL,
  board_id          TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  title             TEXT NOT NULL,
  description        TEXT DEFAULT '',
  prompt            TEXT DEFAULT '',   -- instruction sent to the agent on run
  column_id         TEXT NOT NULL,
  position          INTEGER DEFAULT 0, -- ordering within a column
  assignee_provider TEXT,              -- LLMProvider | NULL
  permission_mode   TEXT DEFAULT 'default',
  tools_json        TEXT DEFAULT '{}', -- {allowedCommands:[], disallowedCommands:[]}
  schedule_cron     TEXT,              -- NULL = not scheduled
  status            TEXT DEFAULT 'todo', -- todo|queued|running|done|failed|blocked
  app_session_id    TEXT,              -- links to sessions(session_id) once run
  last_run_at       DATETIME,
  last_exit_code    INTEGER,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (board_id) REFERENCES kanban_boards(board_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kanban_task_deps (   -- DAG edges: task waits on depends_on
  task_id            TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kanban_runs (        -- one row per execution, for history + reconcile
  run_id         TEXT PRIMARY KEY NOT NULL,
  task_id        TEXT NOT NULL,
  app_session_id TEXT,
  provider       TEXT,
  trigger        TEXT,                 -- manual|schedule|column_move|dependency
  status         TEXT DEFAULT 'running', -- running|done|failed|aborted
  exit_code      INTEGER,
  started_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at    DATETIME,
  FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE
);
```

The three automation types map to: `schedule_cron` (schedule), per-column
`runOnEnter` in `columns_json` (column move), and `kanban_task_deps` (dependency
chaining). No separate automations table needed for v1.

Backend module layout (mirror `server/modules/providers/`):
```
server/modules/kanban/
  kanban.routes.ts            # REST under /api/kanban
  kanban.repository.ts        # better-sqlite3 object, like projects.db.ts
  kanban-runner.service.ts    # executor: resolves session + starts a run + records kanban_runs
  kanban-automation.service.ts# dependency cascade + column-move + completion handling
  kanban-scheduler.service.ts # croner tick -> due scheduled tasks
  tests/
```

---

## Phased plan (each phase ends runnable)

### Phase 0 — Skeleton + tab loads
- Create `server/modules/kanban/kanban.routes.ts` with a `GET /health` returning `{ok:true}`; register `app.use('/api/kanban', authenticateToken, kanbanRoutes)` in `server/index.js`.
- Frontend: add `'kanban'` to `AppTab` (`src/types/app.ts:27`) and `VALID_TABS` (`useProjectsState.ts:334`); add `KANBAN_TAB` to `MainContentTabSwitcher.tsx` `builtInTabs`; add `{activeTab==='kanban' && <KanbanView .../>}` in `MainContent.tsx` (~:206) rendering a placeholder.
- **Verify:** Kanban tab appears and renders; `GET /api/kanban/health` returns ok.
- Commit.

### Phase 1 — Persistence + CRUD (no execution)
- Add the 5 tables to `schema.ts` (`INIT_SCHEMA_SQL`) + additive guards in `migrations.ts`.
- `kanban.repository.ts`: boards/tasks/deps/runs CRUD (prepared statements, `getConnection()`), default columns `Backlog/In Progress/Review/Done` on board create, cascade task delete.
- `kanban.routes.ts`: REST — `GET/POST/PUT/DELETE` for `/boards`, `/tasks`, `/tasks/:id/deps`; a task move = `PUT /tasks/:id {column_id, position}`. Validate `assignee_provider` ∈ the 7 `LLMProvider` values; store `tools_json`/`permission_mode` as-is (provider-agnostic).
- **Tests:** repository round-trip + a DAG cycle-rejection test (reject an edge that would create a cycle).
- **Verify:** create board/tasks/deps via API; data survives restart.
- Commit.

### Phase 2 — Board UI (manage tasks, still no execution)
- Add `@dnd-kit/core` + `@dnd-kit/sortable`.
- `KanbanView`: columns from `columns_json`, task cards, column + card drag-drop → `PUT /tasks/:id`. Optimistic update, revert on failure.
- `TaskEditor` drawer: title, description, prompt, assignee (provider select), `permission_mode`, allow/deny via reused `PermissionsContent`, `schedule_cron`, dependency picker (multiselect of other tasks in the board; block cycles client- and server-side).
- Reads current project from the `selectedProject` prop already threaded into `MainContent`.
- **Verify:** full board management works end-to-end against the DB.
- Commit.

### Phase 3 — Execution seam (Claude first)
This is the riskiest refactor; do it in isolation.
- Extract a headless run starter from `handleChatSend` so both the WS handler and the
  runner share it: `startProviderRun({ appSessionId, provider, projectPath, content, options })`
  that builds `runtimeOptions`, calls `spawnFn`, and registers with `chatRunRegistry`
  (so a frontend can `chat.subscribe` and stream later, and completion flows through
  the existing exactly-one-complete contract). `handleChatSend` becomes a thin caller.
- `kanban-runner.service.ts`: `runTask(taskId, trigger)` →
  `createAppSession(provider, projectPath)` if the task has no live session →
  persist `app_session_id` + a `kanban_runs` row (status `running`) →
  `startProviderRun(...)` with the task's `prompt`, `permission_mode`, and
  `tools_json`. Respect the task's permissions — do **not** force `bypassPermissions`.
- `POST /api/kanban/tasks/:id/run` → `runner.runTask(id, 'manual')`. Manual and
  automated runs share this one path.
- Frontend: task detail embeds `ChatMessagesPane` fed by `useSessionStore` keyed by
  `task.app_session_id`; subscribe via `chat.subscribe` for live output. A "Run" button
  hits the new endpoint.
- **Verify:** create a Claude task with a real prompt, click Run, watch streaming
  output in the task detail; row lands in `kanban_runs`.
- Commit.

### Phase 4 — Completion, status lifecycle, durability
- `kanban-automation.service.ts` subscribes to run completion (hook the terminal
  `complete`/`completeRun` in `chat-run-registry`): update `kanban_runs`
  (`status`, `exit_code`, `finished_at`) and `kanban_tasks.status`
  (`done` on success, `failed` otherwise), stamp `last_run_at`/`last_exit_code`.
- Reconcile-on-boot (call from server startup, near `startEnabledPluginServers`):
  any `running` task/run with no live registry entry → mark `failed`; any `queued`
  → re-enqueue. Prevents silent loss across restarts (plugins get SIGKILL'd at 5s;
  native runs live in the host process but a crash still needs reconcile).
- Reuse the host notification infra (`server/modules/notifications/`) to push a
  "task done/failed" notification.
- **Verify:** run a task, confirm status transitions + notification; kill & restart
  mid-run and confirm reconcile.
- Commit.

### Phase 5 — Automation engine (the payoff)
- **Dependency chaining:** on a task reaching `done`, `automation.service` finds
  tasks whose deps are now all `done` and enqueues them (`trigger:'dependency'`).
  Guard against cycles (already rejected at write time) and double-fire.
- **Column-move trigger:** in `PUT /tasks/:id`, if `column_id` changed to a column
  with `runOnEnter`, enqueue a run (`trigger:'column_move'`).
- **Scheduler:** `kanban-scheduler.service.ts` uses `croner`; on each due
  `schedule_cron`, enqueue (`trigger:'schedule'`). Started at server boot; stopped
  on shutdown.
- A small in-memory **run queue** with a concurrency cap (e.g. 3) drains to
  `runner.runTask`; `status:'queued'` is persisted so reconcile can requeue.
- **Verify each trigger independently:** dependency cascade (A done → B runs),
  drag into a `runOnEnter` column, and a 1-minute cron.
- Commit.

### Phase 6 — All 7 providers + polish
- Extend the runner to all providers via the same `spawnFns` map (grok/kimi/agy
  included — native has no api-key/route restriction). Per-provider permission
  editors already exist in `PermissionsContent`; wire the right one per assignee.
- Board-wide **permission matrix** view (agents × tasks) as optional polish.
- **Verify:** run one task per provider.
- Commit.

### Phase 7 — Hardening & tests
- Repository + cycle-detection tests (`better-sqlite3` in-memory).
- A run-seam test: `startProviderRun` with a stub `spawnFn` asserts a `complete`
  drives task→`done` and cascades a dependent.
- Scheduler tick test (inject clock).
- Concurrency-cap test on the queue.
- Docs: this file + a short user guide (assign agent, set permissions, chain tasks,
  schedule).

---

## Risks / watch-list
- **`startProviderRun` refactor** is the crux — keep `handleChatSend` behavior
  byte-identical for the interactive path; add tests before and after.
- **Runaway automation:** a mis-set cron or a dependency fan-out could spawn many
  agent runs. Enforce the concurrency cap + a per-board max-in-flight, and log every
  auto-trigger. Consider a global "pause automations" switch.
- **Permissions are the safety boundary:** default `permission_mode` to `default`
  (interactive/guarded), never `bypassPermissions`, for automated runs. Make bypass
  an explicit per-task opt-in.
- **Cost/looping:** guard against a task whose completion re-triggers itself
  (self-dependency already rejected; also debounce column-move re-entry).
- **Upstream merge drift:** this is a fork feature; keep the kanban module
  self-contained (its own `server/modules/kanban/` + one `MainContent` switch case +
  4 small tab-registration edits) to minimize conflict surface on rebases.
