import { getConnection } from '@/modules/database/index.js';
import {
  newEvalCaseId,
  newEvalGraderId,
  newEvalSuiteId,
} from '@/shared/ids.js';
import type {
  CreateEvalSuiteInput,
  EvalActionPolicy,
  EvalCase,
  EvalCenterSummary,
  EvalGrader,
  EvalGraderType,
  EvalSuite,
  EvalSuiteScope,
  EvalSuiteStatus,
  EvalSuiteTrigger,
} from '@/modules/evals/evals.types.js';

type SuiteRow = Omit<EvalSuite, 'action_policy' | 'tags' | 'cases'> & {
  action_policy_json: string;
  tags_json: string;
};

type CaseRow = Omit<EvalCase, 'expected_outcome' | 'tags' | 'metadata' | 'enabled' | 'graders'> & {
  expected_outcome_json: string;
  tags_json: string;
  metadata_json: string;
  enabled: number;
};

type GraderRow = Omit<EvalGrader, 'config' | 'required'> & {
  config_json: string;
  required: number;
};

function jsonObject(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function jsonArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapGrader(row: GraderRow): EvalGrader {
  const { config_json, required, ...rest } = row;
  return { ...rest, type: rest.type as EvalGraderType, config: jsonObject(config_json), required: required !== 0 };
}

function mapCase(row: CaseRow, graders: EvalGrader[]): EvalCase {
  const { expected_outcome_json, tags_json, metadata_json, enabled, ...rest } = row;
  return {
    ...rest,
    expected_outcome: jsonObject(expected_outcome_json),
    tags: jsonArray(tags_json),
    metadata: jsonObject(metadata_json),
    enabled: enabled !== 0,
    graders,
  };
}

function hydrateSuite(row: SuiteRow): EvalSuite {
  const db = getConnection();
  const graderRows = db
    .prepare(`SELECT * FROM eval_graders WHERE suite_id = ? ORDER BY sort_order, created_at`)
    .all(row.suite_id) as GraderRow[];
  const graders = graderRows.map(mapGrader);
  const cases = (db
    .prepare(`SELECT * FROM eval_cases WHERE suite_id = ? ORDER BY sort_order, created_at`)
    .all(row.suite_id) as CaseRow[]).map((item) =>
      mapCase(item, graders.filter((grader) => grader.case_id === item.case_id || grader.case_id === null)),
    );
  const { action_policy_json, tags_json, ...rest } = row;
  return {
    ...rest,
    scope: rest.scope as EvalSuiteScope,
    trigger: rest.trigger as EvalSuiteTrigger,
    status: rest.status as EvalSuiteStatus,
    source: rest.source === 'ai' ? 'ai' : 'manual',
    action_policy: jsonObject(action_policy_json) as EvalActionPolicy,
    tags: jsonArray(tags_json),
    cases,
  };
}

export const evalsDb = {
  list(filter: { projectId?: string; status?: EvalSuiteStatus; scope?: EvalSuiteScope } = {}): EvalSuite[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) {
      clauses.push('(project_id = ? OR project_id IS NULL)');
      params.push(filter.projectId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.scope) {
      clauses.push('scope = ?');
      params.push(filter.scope);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = getConnection()
      .prepare(`SELECT * FROM eval_suites ${where} ORDER BY updated_at DESC, created_at DESC`)
      .all(...params) as SuiteRow[];
    return rows.map(hydrateSuite);
  },

  get(suiteId: string): EvalSuite | null {
    const row = getConnection().prepare(`SELECT * FROM eval_suites WHERE suite_id = ?`).get(suiteId) as SuiteRow | undefined;
    return row ? hydrateSuite(row) : null;
  },

  create(input: CreateEvalSuiteInput): EvalSuite {
    const db = getConnection();
    const suiteId = newEvalSuiteId();
    const insert = db.transaction(() => {
      db.prepare(
        `INSERT INTO eval_suites (
          suite_id, project_id, name, description, objective, scope, trigger,
          status, source, version, generator_provider, generator_model,
          generator_run_id, action_policy_json, tags_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).run(
        suiteId,
        input.projectId ?? null,
        input.name,
        input.description,
        input.objective,
        input.scope,
        input.trigger,
        input.status ?? 'draft',
        input.source ?? 'manual',
        input.generatorProvider ?? null,
        input.generatorModel ?? null,
        input.generatorRunId ?? null,
        JSON.stringify(input.actionPolicy),
        JSON.stringify(input.tags),
      );

      input.cases.forEach((item, caseIndex) => {
        const caseId = newEvalCaseId();
        db.prepare(
          `INSERT INTO eval_cases (
            case_id, suite_id, name, description, prompt, difficulty,
            expected_outcome_json, tags_json, metadata_json, sort_order, enabled
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ).run(
          caseId,
          suiteId,
          item.name,
          item.description,
          item.prompt,
          item.difficulty,
          JSON.stringify(item.expectedOutcome),
          JSON.stringify(item.tags),
          JSON.stringify(item.metadata),
          caseIndex,
        );
        item.graders.forEach((grader, graderIndex) => {
          db.prepare(
            `INSERT INTO eval_graders (
              grader_id, suite_id, case_id, name, type, config_json,
              required, weight, sort_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            newEvalGraderId(),
            suiteId,
            caseId,
            grader.name,
            grader.type,
            JSON.stringify(grader.config),
            grader.required ? 1 : 0,
            grader.weight,
            graderIndex,
          );
        });
      });
    });
    insert();
    return evalsDb.get(suiteId)!;
  },

  update(
    suiteId: string,
    patch: Partial<Pick<EvalSuite, 'name' | 'description' | 'objective' | 'scope' | 'trigger' | 'status' | 'action_policy' | 'tags'>>,
  ): EvalSuite | null {
    const existing = evalsDb.get(suiteId);
    if (!existing) return null;
    getConnection().prepare(
      `UPDATE eval_suites SET
        name = ?, description = ?, objective = ?, scope = ?, trigger = ?,
        status = ?, action_policy_json = ?, tags_json = ?,
        version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE suite_id = ?`,
    ).run(
      patch.name ?? existing.name,
      patch.description ?? existing.description,
      patch.objective ?? existing.objective,
      patch.scope ?? existing.scope,
      patch.trigger ?? existing.trigger,
      patch.status ?? existing.status,
      JSON.stringify(patch.action_policy ?? existing.action_policy),
      JSON.stringify(patch.tags ?? existing.tags),
      suiteId,
    );
    return evalsDb.get(suiteId);
  },

  delete(suiteId: string): boolean {
    return getConnection().prepare(`DELETE FROM eval_suites WHERE suite_id = ?`).run(suiteId).changes > 0;
  },

  summary(): EvalCenterSummary {
    const row = getConnection().prepare(`
      SELECT
        (SELECT COUNT(*) FROM eval_suites) AS totalSuites,
        (SELECT COUNT(*) FROM eval_suites WHERE status = 'active') AS activeSuites,
        (SELECT COUNT(*) FROM eval_suites WHERE status = 'draft') AS draftSuites,
        (SELECT COUNT(*) FROM eval_suites WHERE status = 'archived') AS archivedSuites,
        (SELECT COUNT(*) FROM eval_cases) AS totalCases,
        (SELECT COUNT(*) FROM eval_graders) AS totalGraders,
        (SELECT COUNT(*) FROM eval_graders WHERE type <> 'model_rubric' AND type <> 'human_review') AS deterministicGraders,
        (SELECT COUNT(*) FROM eval_graders WHERE type = 'model_rubric') AS modelGraders,
        (SELECT COUNT(*) FROM eval_trials) AS totalTrials,
        (SELECT COUNT(*) FROM eval_trials WHERE decision = 'pass') AS passedTrials,
        (SELECT COUNT(*) FROM eval_trials WHERE decision = 'fail') AS failedTrials
    `).get() as EvalCenterSummary;
    return row;
  },
};
