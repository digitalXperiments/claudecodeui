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
    has_completed_onboarding BOOLEAN DEFAULT 0
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
    custom_name TEXT,
    project_path TEXT,
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

${KANBAN_SCHEMA_SQL}

${MISSION_CONTROL_SCHEMA_SQL}
`;
