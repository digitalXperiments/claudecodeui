/** Eval Center contracts shared by persistence, generation, routes and orchestration. */

export const EVAL_SUITE_SCOPES = [
  'agent_profile',
  'chat',
  'kanban',
  'swarm_plan',
  'swarm_step',
  'swarm',
  'browser',
  'mission_control',
  'custom',
] as const;

export type EvalSuiteScope = (typeof EVAL_SUITE_SCOPES)[number];

export const EVAL_SUITE_TRIGGERS = [
  'manual',
  'before_run',
  'after_run',
  'after_plan',
  'after_step',
  'before_handoff',
  'after_delivery',
] as const;

export type EvalSuiteTrigger = (typeof EVAL_SUITE_TRIGGERS)[number];
export type EvalSuiteStatus = 'draft' | 'active' | 'archived';
export type EvalSuiteSource = 'manual' | 'ai';
export type EvalDifficulty = 'basic' | 'medium' | 'advanced';

export const EVAL_GRADER_TYPES = [
  'command',
  'json_schema',
  'diff_scope',
  'workspace_diff',
  'tool_policy',
  'model_rubric',
  'browser_state',
  'human_review',
] as const;

export type EvalGraderType = (typeof EVAL_GRADER_TYPES)[number];

export type EvalAction =
  | 'continue'
  | 'retry_with_feedback'
  | 'reassign_stronger_profile'
  | 'replan'
  | 'block'
  | 'request_human';

export type EvalActionPolicy = {
  onPass: EvalAction;
  onFailure: EvalAction[];
  onLowConfidence: EvalAction;
  maxAutomaticAttempts: number;
  minimumScore: number;
};

export type EvalGrader = {
  grader_id: string;
  suite_id: string;
  case_id: string | null;
  name: string;
  type: EvalGraderType;
  config: Record<string, unknown>;
  required: boolean;
  weight: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type EvalCase = {
  case_id: string;
  suite_id: string;
  name: string;
  description: string;
  prompt: string;
  difficulty: EvalDifficulty;
  expected_outcome: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  graders: EvalGrader[];
};

export type EvalSuite = {
  suite_id: string;
  project_id: string | null;
  name: string;
  description: string;
  objective: string;
  scope: EvalSuiteScope;
  trigger: EvalSuiteTrigger;
  status: EvalSuiteStatus;
  source: EvalSuiteSource;
  version: number;
  generator_provider: string | null;
  generator_model: string | null;
  generator_run_id: string | null;
  action_policy: EvalActionPolicy;
  tags: string[];
  created_at: string;
  updated_at: string;
  cases: EvalCase[];
};

export type EvalGraderDraft = {
  name: string;
  type: EvalGraderType;
  config: Record<string, unknown>;
  required: boolean;
  weight: number;
};

export type EvalCaseDraft = {
  name: string;
  description: string;
  prompt: string;
  difficulty: EvalDifficulty;
  expectedOutcome: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown>;
  graders: EvalGraderDraft[];
};

export type EvalSuiteDraft = {
  name: string;
  description: string;
  objective: string;
  scope: EvalSuiteScope;
  trigger: EvalSuiteTrigger;
  actionPolicy: EvalActionPolicy;
  tags: string[];
  cases: EvalCaseDraft[];
};

export type CreateEvalSuiteInput = EvalSuiteDraft & {
  projectId?: string | null;
  status?: EvalSuiteStatus;
  source?: EvalSuiteSource;
  generatorProvider?: string | null;
  generatorModel?: string | null;
  generatorRunId?: string | null;
};

export type EvalCenterSummary = {
  totalSuites: number;
  activeSuites: number;
  draftSuites: number;
  archivedSuites: number;
  totalCases: number;
  totalGraders: number;
  deterministicGraders: number;
  modelGraders: number;
  totalTrials: number;
  passedTrials: number;
  failedTrials: number;
};

export const DEFAULT_EVAL_ACTION_POLICY: EvalActionPolicy = {
  onPass: 'continue',
  onFailure: ['retry_with_feedback', 'reassign_stronger_profile', 'replan'],
  onLowConfidence: 'request_human',
  maxAutomaticAttempts: 3,
  minimumScore: 0.8,
};

export function defaultTriggerForScope(scope: EvalSuiteScope): EvalSuiteTrigger {
  if (scope === 'swarm_plan') return 'after_plan';
  if (scope === 'swarm_step') return 'after_step';
  if (scope === 'swarm') return 'before_handoff';
  return 'after_run';
}
