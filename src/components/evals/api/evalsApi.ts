import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

export const EVAL_SUITE_SCOPES = [
  'agent_profile', 'chat', 'kanban', 'swarm_plan', 'swarm_step',
  'swarm', 'browser', 'mission_control', 'custom',
] as const;
export type EvalSuiteScope = (typeof EVAL_SUITE_SCOPES)[number];

export const EVAL_SUITE_TRIGGERS = [
  'manual', 'before_run', 'after_run', 'after_plan', 'after_step', 'before_handoff', 'after_delivery',
] as const;
export type EvalSuiteTrigger = (typeof EVAL_SUITE_TRIGGERS)[number];
export type EvalSuiteStatus = 'draft' | 'active' | 'archived';
export type EvalGraderType =
  | 'command' | 'json_schema' | 'diff_scope' | 'workspace_diff'
  | 'tool_policy' | 'model_rubric' | 'browser_state' | 'human_review';

export type EvalActionPolicy = {
  onPass: string;
  onFailure: string[];
  onLowConfidence: string;
  maxAutomaticAttempts: number;
  minimumScore: number;
};

export type EvalGrader = {
  grader_id: string;
  name: string;
  type: EvalGraderType;
  config: Record<string, unknown>;
  required: boolean;
  weight: number;
};

export type EvalCase = {
  case_id: string;
  name: string;
  description: string;
  prompt: string;
  difficulty: 'basic' | 'medium' | 'advanced';
  expected_outcome: Record<string, unknown>;
  tags: string[];
  enabled: boolean;
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
  source: 'manual' | 'ai';
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

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (payload as { error?: unknown }).error;
    const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : typeof error === 'string' ? error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

const BASE = '/api/evals';

export const evalsApi = {
  async summary(): Promise<EvalCenterSummary> {
    const response = await authenticatedFetch(`${BASE}/summary`);
    return (await parse<{ summary: EvalCenterSummary }>(response)).summary;
  },

  async list(filter?: { projectId?: string; status?: EvalSuiteStatus; scope?: EvalSuiteScope }): Promise<EvalSuite[]> {
    const params = new URLSearchParams();
    if (filter?.projectId) params.set('projectId', filter.projectId);
    if (filter?.status) params.set('status', filter.status);
    if (filter?.scope) params.set('scope', filter.scope);
    const query = params.toString();
    const response = await authenticatedFetch(`${BASE}/suites${query ? `?${query}` : ''}`);
    return (await parse<{ suites: EvalSuite[] }>(response)).suites;
  },

  async generate(input: {
    provider: LLMProvider;
    model?: string;
    projectId?: string;
    objective: string;
    scope: EvalSuiteScope;
    trigger: EvalSuiteTrigger;
    caseCount: number;
    constraints?: string;
  }): Promise<EvalSuite> {
    const response = await authenticatedFetch(`${BASE}/generate`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return (await parse<{ suite: EvalSuite }>(response)).suite;
  },

  async update(suiteId: string, patch: Partial<{
    name: string;
    description: string;
    objective: string;
    scope: EvalSuiteScope;
    trigger: EvalSuiteTrigger;
    status: EvalSuiteStatus;
    actionPolicy: Partial<EvalActionPolicy>;
    tags: string[];
  }>): Promise<EvalSuite> {
    const response = await authenticatedFetch(`${BASE}/suites/${encodeURIComponent(suiteId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return (await parse<{ suite: EvalSuite }>(response)).suite;
  },

  async remove(suiteId: string): Promise<void> {
    const response = await authenticatedFetch(`${BASE}/suites/${encodeURIComponent(suiteId)}`, { method: 'DELETE' });
    await parse(response);
  },
};
