import { Database } from 'better-sqlite3';

import {
  AGENT_RUN_PROFILES_TABLE_SCHEMA_SQL,
  APP_CONFIG_TABLE_SCHEMA_SQL,
  CATEGORIES_TABLE_SCHEMA_SQL,
  CONTEXT_PACKS_TABLE_SCHEMA_SQL,
  AUTOMATION_TABLE_SCHEMA_SQL,
  FAILOVER_PLAYBOOKS_TABLE_SCHEMA_SQL,
  SWARM_TABLE_SCHEMA_SQL,
  KANBAN_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  MISSION_CONTROL_SCHEMA_SQL,
  RUN_SPINE_SCHEMA_SQL,
  WEBHOOKS_SCHEMA_SQL,
  NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL,
  PROJECT_MEMORY_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  SYSTEM_NOTIFICATIONS_TABLE_SCHEMA_SQL,
  INTERRUPTS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
  EVALS_SCHEMA_SQL,
} from '@/modules/database/schema.js';

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'runtime_project_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const runtimeProjectPathExpression = columnNames.includes('runtime_project_path')
    ? `COALESCE(runtime_project_path, ${projectPathExpression})`
    : projectPathExpression;

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        runtime_project_path TEXT,
        jsonl_path TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${runtimeProjectPathExpression} AS runtime_project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          runtime_project_path,
          jsonl_path,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        runtime_project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        runtime_project_path,
        jsonl_path,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

/**
 * Adds the `provider_session_id` mapping column used by the session gateway.
 *
 * Rows that existed before this migration were always keyed directly by the
 * provider-native session id, so backfilling `provider_session_id` with
 * `session_id` keeps every legacy row resolvable through the new mapping.
 */
const addProviderSessionIdMapping = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'provider_session_id', 'TEXT');
  db.exec(`
    UPDATE sessions
    SET provider_session_id = session_id
    WHERE provider_session_id IS NULL
  `);
};

/**
 * Adds the `continued_from_session_id` lineage column used by session handoff.
 *
 * Handoff creates a brand-new app session that continues an existing
 * conversation under a different provider/model; the column records the
 * app-facing source session id so the lineage stays queryable. Purely
 * additive — legacy rows simply have NULL.
 */
const addContinuedFromSessionId = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'continued_from_session_id', 'TEXT');
};

/**
 * Separates internal automation transcripts from user-facing chat sessions.
 * Legacy sessions are interactive by default; headless callers opt in when
 * allocating new rows.
 */
const addInternalSessionVisibility = (db: Database): void => {
  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'is_internal', 'BOOLEAN NOT NULL DEFAULT 0');
  if (tableExists(db, 'agent_runs')) {
    db.exec(`
      UPDATE sessions
      SET is_internal = 1
      WHERE session_id IN (
        SELECT app_session_id
        FROM agent_runs
        WHERE source = 'swarm' AND app_session_id IS NOT NULL
      )
    `);
  }
};

/**
 * Keeps the provider's actual working directory after the logical project
 * path was introduced. Existing rows initially use the same path for both;
 * workspace-aware session rehoming can then replace only the logical path.
 */
const ensureSessionsRuntimeProjectPath = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  const columnNames = getTableInfo(db, 'sessions').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'sessions', columnNames, 'runtime_project_path', 'TEXT');
  db.exec(`
    UPDATE sessions
    SET runtime_project_path = project_path
    WHERE runtime_project_path IS NULL
  `);
};

/**
 * Creates the categories table and links projects to it.
 *
 * Must run after the projects table has been rebuilt into its final
 * `project_id` primary-key shape, because the rebuild drops any column the
 * hardcoded replacement schema does not list.
 */
const ensureCategoriesSchema = (db: Database): void => {
  db.exec(CATEGORIES_TABLE_SCHEMA_SQL);

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'category_id', 'TEXT DEFAULT NULL');

  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_category_id ON projects(category_id)');
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

/**
 * Adds global (cross-project) board support: makes `kanban_boards.project_id`
 * nullable and introduces a `scope` column. Existing boards become `project`.
 * Idempotent — a no-op once the `scope` column exists.
 */
const ensureKanbanGlobalBoardSchema = (db: Database): void => {
  if (!tableExists(db, 'kanban_boards')) {
    return;
  }
  const columnNames = getTableInfo(db, 'kanban_boards').map((column) => column.name);
  if (!columnNames.includes('scope')) {
    console.log('Running migration: adding global-board support to kanban_boards');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN TRANSACTION');
      db.exec('DROP TABLE IF EXISTS kanban_boards__new');
      db.exec(`
        CREATE TABLE kanban_boards__new (
          board_id     TEXT PRIMARY KEY NOT NULL,
          project_id   TEXT,
          name         TEXT NOT NULL,
          columns_json TEXT NOT NULL,
          scope        TEXT NOT NULL DEFAULT 'project',
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO kanban_boards__new (board_id, project_id, name, columns_json, scope, created_at, updated_at)
        SELECT board_id, project_id, name, columns_json, 'project', created_at, updated_at
        FROM kanban_boards
      `);
      db.exec('DROP TABLE kanban_boards');
      db.exec('ALTER TABLE kanban_boards__new RENAME TO kanban_boards');
      db.exec('COMMIT');
    } catch (migrationError) {
      db.exec('ROLLBACK');
      db.exec('PRAGMA foreign_keys = ON');
      throw migrationError;
    }
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_boards_project ON kanban_boards(project_id)');
  }

  // Safe for both fresh installs (scope already present) and post-rebuild.
  db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_boards_scope ON kanban_boards(scope)');
};

/**
 * Additive kanban columns for implement/review agents + run role, and enable
 * auto-run on the default In Progress / Review columns for existing boards.
 */
const ensureKanbanAgentWorkflowSchema = (db: Database): void => {
  if (tableExists(db, 'kanban_tasks')) {
    let taskColumns = getTableInfo(db, 'kanban_tasks').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'kanban_tasks', taskColumns, 'review_provider', 'TEXT');
    taskColumns = getTableInfo(db, 'kanban_tasks').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'kanban_tasks', taskColumns, 'implement_profile_id', 'TEXT');
    taskColumns = getTableInfo(db, 'kanban_tasks').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'kanban_tasks', taskColumns, 'review_profile_id', 'TEXT');
  }

  if (tableExists(db, 'kanban_runs')) {
    const runColumns = getTableInfo(db, 'kanban_runs').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'kanban_runs', runColumns, 'role', "TEXT DEFAULT 'implement'");
  }

  if (!tableExists(db, 'kanban_boards')) {
    return;
  }

  // Ensure default lifecycle columns auto-run on existing boards that were
  // created before runOnEnter was the default for in_progress / review.
  const boards = db
    .prepare(`SELECT board_id, columns_json FROM kanban_boards`)
    .all() as { board_id: string; columns_json: string }[];

  const update = db.prepare(
    `UPDATE kanban_boards SET columns_json = ?, updated_at = CURRENT_TIMESTAMP WHERE board_id = ?`,
  );

  for (const board of boards) {
    let columns: Array<{ id?: string; runOnEnter?: boolean; [key: string]: unknown }>;
    try {
      const parsed = JSON.parse(board.columns_json);
      if (!Array.isArray(parsed)) {
        continue;
      }
      columns = parsed;
    } catch {
      continue;
    }

    let changed = false;
    const next = columns.map((col) => {
      if (col.id === 'in_progress' && col.runOnEnter !== true) {
        changed = true;
        return { ...col, runOnEnter: true };
      }
      if (col.id === 'review' && col.runOnEnter !== true) {
        changed = true;
        return { ...col, runOnEnter: true };
      }
      return col;
    });

    if (changed) {
      update.run(JSON.stringify(next), board.board_id);
    }
  }
};

/**
 * Creates the per-project memory table linking a project path to its Obsidian
 * vault folder. Additive and idempotent (guarded by IF NOT EXISTS), so it is
 * safe on both fresh installs and upgrades. Must run after the projects table
 * has been rebuilt into its final `project_path` shape because of the FK.
 */
const ensureProjectMemorySchema = (db: Database): void => {
  db.exec(PROJECT_MEMORY_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_memory_enabled ON project_memory(enabled)');
};

/**
 * Additive Mission Control columns for the kanban bridge: on approve, a section
 * can also create a card on the global kanban backlog, optionally pre-assigning
 * default implementation/review agents. Idempotent.
 */
const ensureMissionControlKanbanBridgeSchema = (db: Database): void => {
  if (!tableExists(db, 'mc_sections')) {
    return;
  }
  let columns = getTableInfo(db, 'mc_sections').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'mc_sections', columns, 'create_kanban_task', 'INTEGER DEFAULT 0');
  columns = getTableInfo(db, 'mc_sections').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'mc_sections', columns, 'kanban_assignee_provider', 'TEXT');
  columns = getTableInfo(db, 'mc_sections').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'mc_sections', columns, 'kanban_review_provider', 'TEXT');
  columns = getTableInfo(db, 'mc_sections').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'mc_sections', columns, 'kanban_mcp_tools_json', "TEXT DEFAULT '[]'");
};

/**
 * Additive kanban task columns for due dates, auto-created git feature branches,
 * and the last escalation sweep timestamp. Idempotent.
 */
const ensureKanbanDueDateAndBranchSchema = (db: Database): void => {
  if (!tableExists(db, 'kanban_tasks')) {
    return;
  }
  let columns = getTableInfo(db, 'kanban_tasks').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'kanban_tasks', columns, 'due_date', 'TEXT');
  columns = getTableInfo(db, 'kanban_tasks').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'kanban_tasks', columns, 'feature_branch', 'TEXT');
  columns = getTableInfo(db, 'kanban_tasks').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'kanban_tasks', columns, 'escalated_at', 'DATETIME');
  columns = getTableInfo(db, 'kanban_tasks').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'kanban_tasks', columns, 'archived_at', 'DATETIME');
};

/**
 * Additive webhook columns: per-source retry/backoff policy + HMAC secret, and
 * per-delivery attempt/next-retry bookkeeping. Idempotent.
 */
const ensureWebhookRetrySchema = (db: Database): void => {
  if (tableExists(db, 'webhook_sources')) {
    let columns = getTableInfo(db, 'webhook_sources').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'webhook_sources', columns, 'retry_max', 'INTEGER DEFAULT 0');
    columns = getTableInfo(db, 'webhook_sources').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'webhook_sources', columns, 'retry_backoff_seconds', 'INTEGER DEFAULT 60');
    columns = getTableInfo(db, 'webhook_sources').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'webhook_sources', columns, 'secret', 'TEXT');
    columns = getTableInfo(db, 'webhook_sources').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'webhook_sources', columns, 'secret_id', 'TEXT');
  }
  if (tableExists(db, 'webhook_deliveries')) {
    let columns = getTableInfo(db, 'webhook_deliveries').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'webhook_deliveries', columns, 'attempt', 'INTEGER DEFAULT 0');
    columns = getTableInfo(db, 'webhook_deliveries').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'webhook_deliveries', columns, 'next_retry_at', 'DATETIME');
  }
};

/**
 * Additive run-spine bridge columns (PRD Appendix A):
 * kanban_tasks.workspace_id, kanban_runs/MC items/webhook deliveries agent_run_id,
 * user_credentials.secret_id. Idempotent.
 */
const ensureRunSpineBridgeSchema = (db: Database): void => {
  if (tableExists(db, 'kanban_tasks')) {
    let columns = getTableInfo(db, 'kanban_tasks').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'kanban_tasks', columns, 'workspace_id', 'TEXT');
  }
  if (tableExists(db, 'kanban_runs')) {
    const columns = getTableInfo(db, 'kanban_runs').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'kanban_runs', columns, 'agent_run_id', 'TEXT');
  }
  if (tableExists(db, 'mc_items')) {
    const columns = getTableInfo(db, 'mc_items').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'mc_items', columns, 'agent_run_id', 'TEXT');
  }
  if (tableExists(db, 'webhook_deliveries')) {
    const columns = getTableInfo(db, 'webhook_deliveries').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'webhook_deliveries', columns, 'agent_run_id', 'TEXT');
  }
  if (tableExists(db, 'user_credentials')) {
    const columns = getTableInfo(db, 'user_credentials').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'user_credentials', columns, 'secret_id', 'TEXT');
  }
  // Cache read/write token split, so cost estimation can price a cache hit
  // far cheaper (and a cache write, which is NOT cheap, correctly) instead of
  // folding both into the plain input total.
  if (tableExists(db, 'agent_runs')) {
    const columns = getTableInfo(db, 'agent_runs').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'agent_runs', columns, 'token_cache_read', 'INTEGER');
    addColumnToTableIfNotExists(db, 'agent_runs', columns, 'token_cache_write', 'INTEGER');
  }
};

/** Additive graph_json / step_states_json for workflow graphs on existing DBs. */
const ensureAutomationGraphSchema = (db: Database): void => {
  if (tableExists(db, 'automation_recipes')) {
    const columns = getTableInfo(db, 'automation_recipes').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'automation_recipes', columns, 'graph_json', 'TEXT');
  }
  if (tableExists(db, 'automation_runs')) {
    const columns = getTableInfo(db, 'automation_runs').map((column) => column.name);
    addColumnToTableIfNotExists(db, 'automation_runs', columns, 'step_states_json', "TEXT DEFAULT '{}'");
  }
};

export const runMigrations = (db: Database) => {
  try {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'totp_secret', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'totp_enabled',
      'BOOLEAN DEFAULT 0'
    );

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');
    db.exec(NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled)');

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);

    migrateLegacyWorkspaceTableIntoProjects(db);
    ensureCategoriesSchema(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    ensureSessionsRuntimeProjectPath(db);
    addProviderSessionIdMapping(db);
    addContinuedFromSessionId(db);
    addInternalSessionVisibility(db);
    ensureProjectsForSessionPaths(db);

    db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_provider_session_id ON sessions(provider_session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_internal ON sessions(is_internal)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    if (tableExists(db, 'workspace_original_paths')) {
      console.log('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    db.exec(LAST_SCANNED_AT_SQL);

    // Per-project Obsidian memory mapping (additive; runs after projects rebuild).
    ensureProjectMemorySchema(db);

    // Named agent run profiles + in-app notification inbox (additive).
    db.exec(AGENT_RUN_PROFILES_TABLE_SCHEMA_SQL);
    ensureAgentProfileSwarmRolesSchema(db);
    db.exec(SYSTEM_NOTIFICATIONS_TABLE_SCHEMA_SQL);
    db.exec(INTERRUPTS_TABLE_SCHEMA_SQL);
    ensureInterruptDedupeSchema(db);
    ensureInterruptLifecycleSchema(db);

    // Kanban orchestration tables (additive; safe to re-exec via IF NOT EXISTS).
    db.exec(KANBAN_SCHEMA_SQL);
    ensureKanbanGlobalBoardSchema(db);
    ensureKanbanAgentWorkflowSchema(db);
    ensureKanbanDueDateAndBranchSchema(db);

    // Mission Control (sections + reviewable items).
    db.exec(MISSION_CONTROL_SCHEMA_SQL);
    ensureMissionControlKanbanBridgeSchema(db);

    // Inbound webhooks (source-routed headless agent runs).
    db.exec(WEBHOOKS_SCHEMA_SQL);
    ensureWebhookRetrySchema(db);

    // Run spine: agent_workspaces, agent_runs, agent_run_events, secrets (P0–P4).
    db.exec(RUN_SPINE_SCHEMA_SQL);
    db.exec(CONTEXT_PACKS_TABLE_SCHEMA_SQL);
    db.exec(AUTOMATION_TABLE_SCHEMA_SQL);
    db.exec(FAILOVER_PLAYBOOKS_TABLE_SCHEMA_SQL);
    db.exec(SWARM_TABLE_SCHEMA_SQL);
    ensureSwarmAgentSchema(db);
    ensureRunSpineBridgeSchema(db);
    ensureAutomationGraphSchema(db);
    db.exec(EVALS_SCHEMA_SQL);

    console.log('Database migrations completed successfully');
  } catch (error: any) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

/**
 * Additive agent_run_profiles.swarm_roles column: JSON array of swarm roles
 * ("explorer" | "implementer" | "reviewer") a profile may serve when the
 * swarm orchestrator auto-selects its roster. NULL = not available to swarms.
 */
function ensureAgentProfileSwarmRolesSchema(db: Database): void {
  if (!tableExists(db, 'agent_run_profiles')) return;
  const columns = getTableInfo(db, 'agent_run_profiles').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'agent_run_profiles', columns, 'swarm_roles', 'TEXT DEFAULT NULL');
  // Capability tier ("basic" | "medium" | "advanced") the orchestrator uses to
  // match seat strength to step difficulty. NULL on upgraded rows = "medium".
  addColumnToTableIfNotExists(db, 'agent_run_profiles', columns, 'swarm_level', 'TEXT DEFAULT NULL');
  // 0 = disabled: excluded from every automatic seat selection (swarm
  // auto-roster, retry reassignment) while staying available for explicit use.
  addColumnToTableIfNotExists(db, 'agent_run_profiles', columns, 'enabled', 'INTEGER NOT NULL DEFAULT 1');
}

/** Durable interrupt dedupe key used by atomic open/snoozed upserts. */
function ensureInterruptDedupeSchema(db: Database): void {
  if (!tableExists(db, 'interrupts')) return;
  const columns = getTableInfo(db, 'interrupts').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'interrupts', columns, 'dedupe_key', 'TEXT');
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_interrupts_active_dedupe
       ON interrupts(dedupe_key)
       WHERE dedupe_key IS NOT NULL AND status IN ('open', 'snoozed')`,
  );
}

/**
 * Additive interrupt lifecycle columns: `expires_at` (approval-gate deadline;
 * past it the interrupt transitions to status 'expired' and stops being
 * actionable) and `read_at` (viewport mark-as-read; read ≠ resolved).
 */
function ensureInterruptLifecycleSchema(db: Database): void {
  if (!tableExists(db, 'interrupts')) return;
  const columns = getTableInfo(db, 'interrupts').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'interrupts', columns, 'expires_at', 'DATETIME');
  addColumnToTableIfNotExists(db, 'interrupts', columns, 'read_at', 'DATETIME');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_interrupts_expiry ON interrupts(status, expires_at)`,
  );
}

/** Additive columns for Agent Swarm orchestration (plan, blackboard, per-agent config). */
function ensureSwarmAgentSchema(db: Database): void {
  if (!tableExists(db, 'swarm_runs')) return;
  const runCols = getTableInfo(db, 'swarm_runs').map((c) => c.name);
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'plan_json', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'blackboard_json', "TEXT DEFAULT '[]'");
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'skills_json', "TEXT DEFAULT '[]'");
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'config_json', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'goal_card_json', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'attachments_json', "TEXT DEFAULT '[]'");
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'workspace_id', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'pr_url', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'feature_branch', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'archived_at', 'DATETIME');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'version', 'INTEGER NOT NULL DEFAULT 0');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'cancel_requested_at', 'DATETIME');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'lease_owner', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'lease_expires_at', 'DATETIME');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'idempotency_key', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_runs', runCols, 'last_error', 'TEXT');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_swarm_runs_created ON swarm_runs(created_at DESC)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_swarm_runs_archived ON swarm_runs(archived_at)`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_runs_idempotency
       ON swarm_runs(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_messages (
      message_id TEXT PRIMARY KEY NOT NULL,
      swarm_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      step_id TEXT,
      at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(swarm_id, seq),
      FOREIGN KEY (swarm_id) REFERENCES swarm_runs(swarm_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_swarm_messages_swarm_seq ON swarm_messages(swarm_id, seq);
    CREATE TABLE IF NOT EXISTS swarm_artifacts (
      artifact_id TEXT PRIMARY KEY NOT NULL,
      swarm_id TEXT NOT NULL,
      step_id TEXT,
      attempt_id TEXT,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      content TEXT,
      path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (swarm_id) REFERENCES swarm_runs(swarm_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_swarm_artifacts_swarm ON swarm_artifacts(swarm_id, created_at);
  `);

  if (!tableExists(db, 'swarm_members')) return;
  const memberCols = getTableInfo(db, 'swarm_members').map((c) => c.name);
  addColumnToTableIfNotExists(db, 'swarm_members', memberCols, 'kind', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_members', memberCols, 'effort', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_members', memberCols, 'permission_mode', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_members', memberCols, 'skills_json', 'TEXT');
  addColumnToTableIfNotExists(db, 'swarm_members', memberCols, 'step_id', 'TEXT');
}
