const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0,
    totp_secret TEXT,
    totp_enabled BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_channel_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    enabled BOOLEAN DEFAULT 1,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel, endpoint_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0,
    category_id TEXT DEFAULT NULL
);
`;

export const PROJECT_MEMORY_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_memory (
    project_path TEXT PRIMARY KEY NOT NULL,
    enabled BOOLEAN DEFAULT 1,
    vault_folder TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE CASCADE
    ON UPDATE CASCADE
);
`;

export const CATEGORIES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS categories (
    category_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    -- Set when this session was created by a cross-provider/model handoff:
    -- points at the app-facing session id the conversation continues from.
    continued_from_session_id TEXT,
    custom_name TEXT,
    project_path TEXT,
    -- The logical project owns the session; this keeps the actual provider cwd
    -- separate when the run executes inside an isolated agent worktree.
    runtime_project_path TEXT,
    jsonl_path TEXT,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// --- Kanban orchestration -------------------------------------------------
// App-facing ids are TEXT UUIDs to match projects/sessions conventions.

export const KANBAN_BOARDS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kanban_boards (
    board_id     TEXT PRIMARY KEY NOT NULL,
    project_id   TEXT,                    -- NULL for a global (cross-project) board
    name         TEXT NOT NULL,
    columns_json TEXT NOT NULL,          -- [{id,name,order,runOnEnter?:bool,permissionMode?}]
    scope        TEXT NOT NULL DEFAULT 'project', -- 'project' | 'global'
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);
`;

export const KANBAN_TASKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kanban_tasks (
    task_id           TEXT PRIMARY KEY NOT NULL,
    board_id          TEXT NOT NULL,
    project_id        TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT DEFAULT '',
    prompt            TEXT DEFAULT '',   -- instruction sent to the agent on run
    column_id         TEXT NOT NULL,
    position          INTEGER DEFAULT 0, -- ordering within a column
    assignee_provider TEXT,              -- implementation agent (LLMProvider | NULL)
    review_provider   TEXT,              -- review agent (LLMProvider | NULL)
    implement_profile_id TEXT,           -- optional agent_run_profiles.profile_id
    review_profile_id    TEXT,           -- optional agent_run_profiles.profile_id
    permission_mode   TEXT DEFAULT 'default',
    tools_json        TEXT DEFAULT '{}', -- {allowedCommands:[], disallowedCommands:[]}
    schedule_cron     TEXT,              -- NULL = not scheduled
    due_date          TEXT,              -- ISO deadline; overdue cards can be escalated
    feature_branch    TEXT,              -- git branch auto-created when a run starts
    escalated_at      DATETIME,          -- last escalation sweep timestamp
    archived_at       DATETIME,          -- archived cards are hidden from the active board
    status            TEXT DEFAULT 'todo', -- todo|queued|running|done|failed|blocked
    app_session_id    TEXT,              -- links to sessions(session_id) once run
    last_run_at       DATETIME,
    last_exit_code    INTEGER,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (board_id) REFERENCES kanban_boards(board_id) ON DELETE CASCADE
);
`;

/** Named reusable agent run configs (provider + model + effort + permissions). */
export const AGENT_RUN_PROFILES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_run_profiles (
    profile_id         TEXT PRIMARY KEY NOT NULL,
    name               TEXT NOT NULL,
    description        TEXT DEFAULT '',
    provider           TEXT NOT NULL,
    model              TEXT,
    effort             TEXT,
    permission_mode    TEXT DEFAULT 'default',
    tools_json         TEXT DEFAULT '{}',
    permission_intent  TEXT DEFAULT '',
    -- JSON array of swarm roles this profile may serve ("explorer" |
    -- "implementer" | "reviewer"). NULL/empty = not available to swarms.
    swarm_roles        TEXT DEFAULT NULL,
    -- Quantitative capability tier the orchestrator ranks seats by:
    -- "basic" | "medium" | "advanced". NULL is read as "medium".
    swarm_level        TEXT DEFAULT NULL,
    -- 0 = disabled: kept for explicit/manual use but excluded from every
    -- automatic seat selection (swarm auto-roster, retry reassignment).
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_run_profiles_provider ON agent_run_profiles(provider);
CREATE INDEX IF NOT EXISTS idx_agent_run_profiles_name ON agent_run_profiles(name);
`;

/** In-app attention inbox (permission limbo, failures, action required). */
export const SYSTEM_NOTIFICATIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS system_notifications (
    notification_id  TEXT PRIMARY KEY NOT NULL,
    kind             TEXT NOT NULL,          -- permission_pending|run_failed|action_required|info
    severity         TEXT DEFAULT 'info',    -- info|warning|error
    title            TEXT NOT NULL,
    body             TEXT DEFAULT '',
    source           TEXT DEFAULT 'system',  -- kanban|chat|system
    href             TEXT,                   -- optional deep-link path/query
    meta_json        TEXT DEFAULT '{}',
    read_at          DATETIME,
    dismissed_at     DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_system_notifications_created ON system_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_notifications_unread ON system_notifications(read_at, dismissed_at);
`;

export const INTERRUPTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS interrupts (
    interrupt_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    run_id TEXT,
    task_id TEXT,
    workspace_id TEXT,
    href TEXT,
    actions_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    snooze_until DATETIME,
    resolved_at DATETIME,
    resolved_by TEXT,
    resolution TEXT,
    priority INTEGER NOT NULL DEFAULT 50,
    dedupe_key TEXT,
    expires_at DATETIME,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    meta_json TEXT DEFAULT '{}',
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_interrupts_open ON interrupts(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_interrupts_project ON interrupts(project_id, status);
-- NOTE: indexes over additive columns (expires_at, dedupe_key) live in the
-- migration that adds those columns, NOT here. This SQL also runs against
-- databases created before the column existed, where CREATE INDEX on a missing
-- column fails and crashes boot. See ensureInterruptLifecycleSchema.
`;

export const KANBAN_TASK_DEPS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kanban_task_deps (
    task_id            TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE
);
`;

export const KANBAN_TASK_COMMENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kanban_task_comments (
    comment_id   TEXT PRIMARY KEY NOT NULL,
    task_id      TEXT NOT NULL,
    author_type  TEXT NOT NULL DEFAULT 'human', -- 'human' | 'agent'
    author       TEXT,                          -- human user id/name or agent provider
    body         TEXT NOT NULL,
    run_id       TEXT,                          -- links an agent comment to its run
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE
);
`;

export const KANBAN_RUNS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kanban_runs (
    run_id         TEXT PRIMARY KEY NOT NULL,
    task_id        TEXT NOT NULL,
    app_session_id TEXT,
    provider       TEXT,
    trigger        TEXT,                 -- manual|schedule|column_move|dependency|review
    role           TEXT DEFAULT 'implement', -- implement|review
    status         TEXT DEFAULT 'running', -- running|done|failed|aborted
    exit_code      INTEGER,
    started_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at    DATETIME,
    FOREIGN KEY (task_id) REFERENCES kanban_tasks(task_id) ON DELETE CASCADE
);
`;

export const KANBAN_SCHEMA_SQL = `
${KANBAN_BOARDS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_kanban_boards_project ON kanban_boards(project_id);
-- NOTE: idx_kanban_boards_scope is created in migrations, after the boards
-- table is rebuilt to add the scope column on upgraded installs.

${KANBAN_TASKS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_kanban_tasks_board ON kanban_tasks(board_id);
CREATE INDEX IF NOT EXISTS idx_kanban_tasks_project ON kanban_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_kanban_tasks_column ON kanban_tasks(column_id);
CREATE INDEX IF NOT EXISTS idx_kanban_tasks_status ON kanban_tasks(status);
CREATE INDEX IF NOT EXISTS idx_kanban_tasks_session ON kanban_tasks(app_session_id);

${KANBAN_TASK_DEPS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_kanban_task_deps_depends_on ON kanban_task_deps(depends_on_task_id);

${KANBAN_RUNS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_kanban_runs_task ON kanban_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_kanban_runs_status ON kanban_runs(status);

${KANBAN_TASK_COMMENTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_kanban_task_comments_task ON kanban_task_comments(task_id);
`;

/** Mission Control — config-driven produce/resolve sections + reviewable items. */
export const MC_SECTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mc_sections (
    section_id          TEXT PRIMARY KEY NOT NULL,
    title               TEXT NOT NULL,
    icon                TEXT DEFAULT '',
    sort_order          INTEGER DEFAULT 0,
    enabled             INTEGER DEFAULT 1,
    scope               TEXT DEFAULT 'global',  -- global | project
    project_id          TEXT,                  -- required when scope=project
    mode                TEXT DEFAULT 'review', -- review | fire_and_forget
    schedule_cron       TEXT DEFAULT '',
    provider            TEXT DEFAULT 'claude',
    model               TEXT DEFAULT '',
    permission_mode     TEXT DEFAULT 'bypassPermissions',
    dry_run             INTEGER DEFAULT 0,
    auto_approve        INTEGER DEFAULT 0,
    produce_prompt      TEXT DEFAULT '',
    produce_tools_json  TEXT DEFAULT '[]',
    resolve_prompt      TEXT DEFAULT '',
    resolve_tools_json  TEXT DEFAULT '[]',
    actions_json        TEXT DEFAULT '[]',
    -- Bridge: on approve, also create a card on the global kanban backlog.
    create_kanban_task        INTEGER DEFAULT 0,
    kanban_assignee_provider  TEXT,   -- default implementation agent for bridged cards
    kanban_review_provider    TEXT,   -- default review agent for bridged cards
    kanban_mcp_tools_json     TEXT DEFAULT '[]', -- MCP servers for bridged kanban tasks
    last_run_at         DATETIME,
    last_run_error      TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mc_sections_enabled ON mc_sections(enabled);
CREATE INDEX IF NOT EXISTS idx_mc_sections_project ON mc_sections(project_id);
CREATE INDEX IF NOT EXISTS idx_mc_sections_sort ON mc_sections(sort_order);
`;

export const MC_ITEMS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mc_items (
    item_id       TEXT PRIMARY KEY NOT NULL,
    section_id    TEXT NOT NULL,
    status        TEXT DEFAULT 'pending', -- pending|resolving|resolved|dismissed|failed|expired
    title         TEXT NOT NULL,
    summary       TEXT DEFAULT '',
    body_json     TEXT DEFAULT '{}',
    source_json   TEXT DEFAULT '{}',
    actions_json  TEXT DEFAULT '[]',
    confidence    REAL DEFAULT 0,
    provider      TEXT DEFAULT '',
    model         TEXT DEFAULT '',
    dedupe_key    TEXT NOT NULL,
    result_json   TEXT,
    error         TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at   DATETIME,
    FOREIGN KEY (section_id) REFERENCES mc_sections(section_id) ON DELETE CASCADE,
    UNIQUE(section_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_mc_items_section ON mc_items(section_id);
CREATE INDEX IF NOT EXISTS idx_mc_items_status ON mc_items(status);
CREATE INDEX IF NOT EXISTS idx_mc_items_created ON mc_items(created_at DESC);
`;

export const MISSION_CONTROL_SCHEMA_SQL = `
${MC_SECTIONS_TABLE_SCHEMA_SQL}
${MC_ITEMS_TABLE_SCHEMA_SQL}
`;

/** Inbound webhooks — source-routed headless agent runs. */
export const WEBHOOK_SOURCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS webhook_sources (
    source_id        TEXT PRIMARY KEY NOT NULL,
    source           TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    description      TEXT DEFAULT '',
    enabled          INTEGER DEFAULT 1,
    provider         TEXT NOT NULL DEFAULT 'claude',
    model            TEXT,
    prompt           TEXT DEFAULT '',
    permission_mode  TEXT DEFAULT 'bypassPermissions',
    mcp_tools_json   TEXT DEFAULT '[]',
    skills_json      TEXT DEFAULT '[]',
    profile_id       TEXT,
    scope            TEXT DEFAULT 'global',
    project_id       TEXT,
    retry_max            INTEGER DEFAULT 0,   -- max automatic retries after failure (0 = none)
    retry_backoff_seconds INTEGER DEFAULT 60, -- base backoff between retry attempts
    secret               TEXT,                -- legacy HMAC secret; new values use secrets.secret_id
    secret_id            TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhook_sources_enabled ON webhook_sources(enabled);
CREATE INDEX IF NOT EXISTS idx_webhook_sources_source ON webhook_sources(source);
`;

export const WEBHOOK_DELIVERIES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id      TEXT PRIMARY KEY NOT NULL,
    source_id        TEXT NOT NULL,
    status           TEXT DEFAULT 'accepted',
    request_json     TEXT DEFAULT '{}',
    app_session_id   TEXT,
    error_message    TEXT,
    result_preview   TEXT,
    attempt          INTEGER DEFAULT 0,     -- how many times this delivery has run
    next_retry_at    DATETIME,              -- when the retry scheduler should re-run it
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at      DATETIME,
    FOREIGN KEY (source_id) REFERENCES webhook_sources(source_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_source ON webhook_deliveries(source_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_session ON webhook_deliveries(app_session_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
`;

export const WEBHOOKS_SCHEMA_SQL = `
${WEBHOOK_SOURCES_TABLE_SCHEMA_SQL}
${WEBHOOK_DELIVERIES_TABLE_SCHEMA_SQL}
`;

/**
 * Phase 1 — Isolated Agent Workspaces (PRD §5.4).
 * One row per git worktree / sandbox copy bound to an autonomous run.
 */
export const AGENT_WORKSPACES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_workspaces (
    workspace_id      TEXT PRIMARY KEY NOT NULL,
    project_id        TEXT NOT NULL,
    run_id            TEXT,
    task_id           TEXT,
    mode              TEXT NOT NULL DEFAULT 'git_worktree',
    root_path         TEXT NOT NULL,
    base_branch       TEXT NOT NULL,
    base_sha          TEXT,
    feature_branch    TEXT NOT NULL,
    head_sha          TEXT,
    status            TEXT NOT NULL DEFAULT 'active',
    last_error        TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    cleaned_at        DATETIME
);
CREATE INDEX IF NOT EXISTS idx_agent_workspaces_project ON agent_workspaces(project_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_workspaces_run ON agent_workspaces(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_workspaces_task ON agent_workspaces(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_workspaces_root ON agent_workspaces(root_path);
`;

/**
 * Phase 2 — Canonical run spine (PRD §6.3). One row per execution across
 * chat / kanban / mission-control / webhook / automation.
 */
export const AGENT_RUNS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_runs (
    run_id              TEXT PRIMARY KEY NOT NULL,
    project_id          TEXT,
    source              TEXT NOT NULL,
    source_ref          TEXT,
    workspace_id        TEXT,
    app_session_id      TEXT,
    provider            TEXT,
    model               TEXT,
    effort              TEXT,
    permission_mode     TEXT,
    profile_id          TEXT,
    status              TEXT NOT NULL DEFAULT 'queued',
    trigger             TEXT,
    parent_run_id       TEXT,
    root_run_id         TEXT,
    title               TEXT,
    error_summary       TEXT,
    exit_code           INTEGER,
    token_input         INTEGER,
    token_output        INTEGER,
    token_total         INTEGER,
    cost_usd_estimate   REAL,
    started_at          DATETIME,
    first_token_at      DATETIME,
    finished_at         DATETIME,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    meta_json           TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_created ON agent_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(app_session_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_source ON agent_runs(source, source_ref);
`;

export const AGENT_RUN_EVENTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_run_events (
    event_id     TEXT PRIMARY KEY NOT NULL,
    run_id       TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    ts           DATETIME NOT NULL,
    source       TEXT,
    type         TEXT NOT NULL,
    severity     TEXT DEFAULT 'info',
    payload_json TEXT DEFAULT '{}',
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_seq ON agent_run_events(run_id, seq);
`;

/**
 * Phase 4 — Secrets vault metadata (PRD §8.3). Values live in the OS
 * keychain when available, else encrypted ciphertext in this table.
 */
export const SECRETS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS secrets (
    secret_id       TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT 'user',
    scope_ref       TEXT,
    backend         TEXT NOT NULL,
    keychain_account TEXT,
    ciphertext      BLOB,
    nonce           BLOB,
    content_type    TEXT DEFAULT 'token',
    description     TEXT,
    last_used_at    DATETIME,
    expires_at      DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, scope, scope_ref)
);
`;

/** Phase 7 — bounded, attachable context packs compiled for a project goal. */
export const CONTEXT_PACKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS context_packs (
    pack_id          TEXT PRIMARY KEY NOT NULL,
    project_id       TEXT NOT NULL,
    goal             TEXT NOT NULL,
    budget_tokens    INTEGER NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    content_markdown TEXT NOT NULL,
    items_json       TEXT NOT NULL DEFAULT '[]',
    warnings_json    TEXT NOT NULL DEFAULT '[]',
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_context_packs_project_created ON context_packs(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS context_pack_attachments (
    attachment_id TEXT PRIMARY KEY NOT NULL,
    pack_id       TEXT NOT NULL,
    run_id        TEXT,
    session_id    TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pack_id) REFERENCES context_packs(pack_id) ON DELETE CASCADE,
    CHECK (run_id IS NOT NULL OR session_id IS NOT NULL),
    UNIQUE(pack_id, run_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_context_pack_attachments_run ON context_pack_attachments(run_id);
CREATE INDEX IF NOT EXISTS idx_context_pack_attachments_session ON context_pack_attachments(session_id);
`;

/** Phase 8 — versioned JSON recipes and their durable execution attempts. */
export const AUTOMATION_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_recipes (
    recipe_id       TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    version         INTEGER NOT NULL DEFAULT 1,
    project_id      TEXT,
    trigger_json    TEXT NOT NULL,
    conditions_json TEXT NOT NULL DEFAULT '[]',
    actions_json    TEXT NOT NULL,
    graph_json      TEXT,
    retry_json      TEXT NOT NULL DEFAULT '{"max":0}',
    timeout_ms      INTEGER,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automation_recipes_enabled ON automation_recipes(enabled, project_id);
CREATE TABLE IF NOT EXISTS automation_runs (
    automation_run_id      TEXT PRIMARY KEY NOT NULL,
    recipe_id              TEXT NOT NULL,
    agent_run_id           TEXT,
    status                 TEXT,
    attempt                INTEGER NOT NULL DEFAULT 1,
    trigger_payload_json   TEXT NOT NULL DEFAULT '{}',
    step_states_json       TEXT DEFAULT '{}',
    error                  TEXT,
    started_at             DATETIME,
    finished_at            DATETIME,
    FOREIGN KEY (recipe_id) REFERENCES automation_recipes(recipe_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_recipe ON automation_runs(recipe_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_agent ON automation_runs(agent_run_id);
`;

/** Agent Swarm — goal orchestration runs + roster members. */
export const SWARM_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS swarm_runs (
    swarm_id         TEXT PRIMARY KEY NOT NULL,
    project_id       TEXT NOT NULL,
    parent_run_id    TEXT,
    goal             TEXT NOT NULL,
    status           TEXT NOT NULL,
    roles_json       TEXT NOT NULL,
    findings_json    TEXT DEFAULT '[]',
    synthesis_json   TEXT,
    plan_json        TEXT,
    blackboard_json  TEXT DEFAULT '[]',
    skills_json      TEXT DEFAULT '[]',
    config_json      TEXT,
    workspace_id     TEXT,
    pr_url           TEXT,
    feature_branch   TEXT,
    approval_status  TEXT,
    interrupt_id     TEXT,
    archived_at      DATETIME,
    version          INTEGER NOT NULL DEFAULT 0,
    cancel_requested_at DATETIME,
    lease_owner      TEXT,
    lease_expires_at DATETIME,
    idempotency_key  TEXT,
    last_error       TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at      DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_swarm_runs_project ON swarm_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swarm_runs_created ON swarm_runs(created_at DESC);
-- NOTE: The archived_at index is created in migrations (ensureSwarmAgentSchema) after the
-- column is added. Creating it here fails on installs whose swarm_runs predates archived_at,
-- because CREATE TABLE IF NOT EXISTS leaves the existing table untouched.
CREATE TABLE IF NOT EXISTS swarm_members (
    member_id         TEXT PRIMARY KEY NOT NULL,
    swarm_id          TEXT NOT NULL,
    role              TEXT NOT NULL,
    kind              TEXT,
    label             TEXT,
    provider          TEXT,
    model             TEXT,
    effort            TEXT,
    permission_mode   TEXT,
    skills_json       TEXT,
    step_id           TEXT,
    run_id            TEXT,
    status            TEXT NOT NULL,
    findings_summary  TEXT,
    error             TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at       DATETIME,
    FOREIGN KEY (swarm_id) REFERENCES swarm_runs(swarm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_swarm_members_swarm ON swarm_members(swarm_id);
CREATE TABLE IF NOT EXISTS swarm_step_attempts (
    attempt_id        TEXT PRIMARY KEY NOT NULL,
    swarm_id          TEXT NOT NULL,
    step_id           TEXT NOT NULL,
    member_id         TEXT,
    run_id            TEXT,
    phase             TEXT NOT NULL DEFAULT 'execute',
    attempt_no        INTEGER NOT NULL,
    status            TEXT NOT NULL,
    workspace_id      TEXT,
    error             TEXT,
    started_at        DATETIME,
    finished_at       DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(swarm_id, step_id, attempt_no),
    FOREIGN KEY (swarm_id) REFERENCES swarm_runs(swarm_id) ON DELETE CASCADE,
    FOREIGN KEY (member_id) REFERENCES swarm_members(member_id) ON DELETE SET NULL,
    FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES agent_workspaces(workspace_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_swarm_attempts_swarm ON swarm_step_attempts(swarm_id, created_at);
CREATE INDEX IF NOT EXISTS idx_swarm_attempts_step ON swarm_step_attempts(swarm_id, step_id, attempt_no DESC);
CREATE TABLE IF NOT EXISTS swarm_messages (
    message_id       TEXT PRIMARY KEY NOT NULL,
    swarm_id         TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    from_agent       TEXT NOT NULL,
    to_agent         TEXT,
    kind             TEXT NOT NULL,
    content          TEXT NOT NULL,
    step_id          TEXT,
    at               DATETIME NOT NULL,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(swarm_id, seq),
    FOREIGN KEY (swarm_id) REFERENCES swarm_runs(swarm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_swarm_messages_swarm_seq ON swarm_messages(swarm_id, seq);
CREATE TABLE IF NOT EXISTS swarm_artifacts (
    artifact_id       TEXT PRIMARY KEY NOT NULL,
    swarm_id          TEXT NOT NULL,
    step_id           TEXT,
    attempt_id        TEXT,
    kind              TEXT NOT NULL,
    label             TEXT NOT NULL,
    content           TEXT,
    path              TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (swarm_id) REFERENCES swarm_runs(swarm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_swarm_artifacts_swarm ON swarm_artifacts(swarm_id, created_at);
`;

/** Phase 9 — declarative provider failover playbooks and ordered candidates. */
export const FAILOVER_PLAYBOOKS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS failover_playbooks (
    playbook_id    TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL,
    project_id     TEXT,
    enabled        INTEGER NOT NULL DEFAULT 1,
    match_json     TEXT NOT NULL DEFAULT '{}',
    strategy_json  TEXT NOT NULL,
    approval       TEXT NOT NULL DEFAULT 'auto',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_failover_playbooks_project ON failover_playbooks(project_id, enabled);
`;

/**
 * Per-project run observatory budgets and stuck threshold (Run Observatory).
 */
export const PROJECT_RUN_BUDGETS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_run_budgets (
  project_id TEXT PRIMARY KEY NOT NULL,
  monthly_token_budget INTEGER,
  monthly_cost_usd_budget REAL,
  stuck_minutes INTEGER NOT NULL DEFAULT 15,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const RUN_SPINE_SCHEMA_SQL = `
${AGENT_WORKSPACES_TABLE_SCHEMA_SQL}
${AGENT_RUNS_TABLE_SCHEMA_SQL}
${AGENT_RUN_EVENTS_TABLE_SCHEMA_SQL}
${PROJECT_RUN_BUDGETS_TABLE_SCHEMA_SQL}
${SECRETS_TABLE_SCHEMA_SQL}
${CONTEXT_PACKS_TABLE_SCHEMA_SQL}
${AUTOMATION_TABLE_SCHEMA_SQL}
${FAILOVER_PLAYBOOKS_TABLE_SCHEMA_SQL}
${SWARM_TABLE_SCHEMA_SQL}
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${CATEGORIES_TABLE_SCHEMA_SQL}

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${PROJECT_MEMORY_TABLE_SCHEMA_SQL}

${AGENT_RUN_PROFILES_TABLE_SCHEMA_SQL}

${SYSTEM_NOTIFICATIONS_TABLE_SCHEMA_SQL}
${INTERRUPTS_TABLE_SCHEMA_SQL}

${KANBAN_SCHEMA_SQL}

${MISSION_CONTROL_SCHEMA_SQL}

${WEBHOOKS_SCHEMA_SQL}

${RUN_SPINE_SCHEMA_SQL}
`;
