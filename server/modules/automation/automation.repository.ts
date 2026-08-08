import { getConnection } from '@/modules/database/index.js';
import { newAutomationRunId, newRecipeId } from '@/shared/ids.js';
import type {
  AutomationCondition,
  AutomationRecipe,
  AutomationRun,
  AutomationAction,
  AutomationTrigger,
  WorkflowGraph,
  WorkflowStepState,
} from '@/modules/automation/automation.types.js';

type RecipeRow = {
  recipe_id: string;
  name: string;
  enabled: number;
  version: number;
  project_id: string | null;
  trigger_json: string;
  conditions_json: string;
  actions_json: string;
  graph_json: string | null;
  retry_json: string;
  timeout_ms: number | null;
  created_at: string;
  updated_at: string;
};
type RunRow = Omit<AutomationRun, 'trigger_payload' | 'step_states'> & {
  trigger_payload_json: string;
  step_states_json?: string | null;
};

function parse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRecipe(row: RecipeRow): AutomationRecipe {
  return {
    recipe_id: row.recipe_id,
    name: row.name,
    enabled: Boolean(row.enabled),
    version: row.version,
    project_id: row.project_id,
    trigger: parse<AutomationTrigger>(row.trigger_json, { type: 'manual' }),
    conditions: parse<AutomationCondition[]>(row.conditions_json, []),
    actions: parse<AutomationAction[]>(row.actions_json, []),
    graph: parse<WorkflowGraph | null>(row.graph_json, null),
    retry: parse<{ max: number; backoffMs?: number }>(row.retry_json, { max: 0 }),
    timeout_ms: row.timeout_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapRun(row: RunRow): AutomationRun {
  const { trigger_payload_json, step_states_json, ...rest } = row;
  return {
    ...rest,
    trigger_payload: parse<Record<string, unknown>>(trigger_payload_json, {}),
    step_states: parse<Record<string, WorkflowStepState>>(step_states_json, {}),
  };
}

export type CreateRecipeDbInput = {
  name: string;
  enabled: boolean;
  projectId: string | null;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  graph: WorkflowGraph | null;
  retry: { max: number; backoffMs?: number };
  timeoutMs: number | null;
};

export type UpdateRecipeDbPatch = Partial<{
  name: string;
  enabled: boolean;
  projectId: string | null;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  graph: WorkflowGraph | null;
  retry: { max: number; backoffMs?: number };
  timeoutMs: number | null;
}>;

export const automationDb = {
  create(input: CreateRecipeDbInput): AutomationRecipe {
    const id = newRecipeId();
    getConnection()
      .prepare(
        `INSERT INTO automation_recipes (recipe_id, name, enabled, project_id, trigger_json, conditions_json, actions_json, graph_json, retry_json, timeout_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.enabled ? 1 : 0,
        input.projectId,
        JSON.stringify(input.trigger),
        JSON.stringify(input.conditions),
        JSON.stringify(input.actions),
        input.graph ? JSON.stringify(input.graph) : null,
        JSON.stringify(input.retry),
        input.timeoutMs,
      );
    return this.get(id)!;
  },
  get(recipeId: string): AutomationRecipe | null {
    const row = getConnection()
      .prepare(`SELECT * FROM automation_recipes WHERE recipe_id = ?`)
      .get(recipeId) as RecipeRow | undefined;
    return row ? mapRecipe(row) : null;
  },
  list(projectId?: string): AutomationRecipe[] {
    const rows = projectId
      ? getConnection()
          .prepare(
            `SELECT * FROM automation_recipes WHERE project_id = ? OR project_id IS NULL ORDER BY name ASC`,
          )
          .all(projectId)
      : getConnection().prepare(`SELECT * FROM automation_recipes ORDER BY name ASC`).all();
    return (rows as RecipeRow[]).map(mapRecipe);
  },
  update(recipeId: string, patch: UpdateRecipeDbPatch): AutomationRecipe | null {
    const current = this.get(recipeId);
    if (!current) return null;
    const graph =
      patch.graph !== undefined ? patch.graph : current.graph;
    getConnection()
      .prepare(
        `UPDATE automation_recipes SET name = ?, enabled = ?, project_id = ?, trigger_json = ?, conditions_json = ?, actions_json = ?, graph_json = ?, retry_json = ?, timeout_ms = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE recipe_id = ?`,
      )
      .run(
        patch.name ?? current.name,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        patch.projectId !== undefined ? patch.projectId : current.project_id,
        JSON.stringify(patch.trigger ?? current.trigger),
        JSON.stringify(patch.conditions ?? current.conditions),
        JSON.stringify(patch.actions ?? current.actions),
        graph ? JSON.stringify(graph) : null,
        JSON.stringify(patch.retry ?? current.retry),
        patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeout_ms,
        recipeId,
      );
    return this.get(recipeId);
  },
  delete(recipeId: string): boolean {
    return getConnection().prepare(`DELETE FROM automation_recipes WHERE recipe_id = ?`).run(recipeId)
      .changes > 0;
  },
  createRun(recipeId: string, payload: Record<string, unknown>, attempt = 1): AutomationRun {
    const id = newAutomationRunId();
    getConnection()
      .prepare(
        `INSERT INTO automation_runs (automation_run_id, recipe_id, status, attempt, trigger_payload_json, step_states_json, started_at)
         VALUES (?, ?, 'running', ?, ?, '{}', CURRENT_TIMESTAMP)`,
      )
      .run(id, recipeId, attempt, JSON.stringify(payload));
    return this.getRun(id)!;
  },
  getRun(id: string): AutomationRun | null {
    const row = getConnection()
      .prepare(`SELECT * FROM automation_runs WHERE automation_run_id = ?`)
      .get(id) as RunRow | undefined;
    return row ? mapRun(row) : null;
  },
  setRunStatus(id: string, status: string, error?: string | null, agentRunId?: string | null): void {
    getConnection()
      .prepare(
        `UPDATE automation_runs SET status = ?, error = ?, agent_run_id = COALESCE(?, agent_run_id), finished_at = CASE WHEN ? IN ('succeeded', 'failed') THEN CURRENT_TIMESTAMP ELSE finished_at END WHERE automation_run_id = ?`,
      )
      .run(status, error ?? null, agentRunId ?? null, status, id);
  },
  setRunAttempt(id: string, attempt: number): void {
    getConnection()
      .prepare(`UPDATE automation_runs SET attempt = ? WHERE automation_run_id = ?`)
      .run(attempt, id);
  },
  setStepStates(id: string, stepStates: Record<string, WorkflowStepState>): void {
    getConnection()
      .prepare(`UPDATE automation_runs SET step_states_json = ? WHERE automation_run_id = ?`)
      .run(JSON.stringify(stepStates), id);
  },
  listRuns(recipeId: string, limit = 50): AutomationRun[] {
    return (
      getConnection()
        .prepare(
          `SELECT * FROM automation_runs WHERE recipe_id = ? ORDER BY started_at DESC LIMIT ?`,
        )
        .all(recipeId, limit) as RunRow[]
    ).map(mapRun);
  },
};
