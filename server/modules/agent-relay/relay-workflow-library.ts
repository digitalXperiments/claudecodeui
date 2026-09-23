import type {
  AgentRelayJob,
  AgentRelayJobSummary,
  AgentRelayMode,
  AgentRelayTaskInput,
} from '@/modules/agent-relay/agent-relay.types.js';
import { AGENT_RELAY_PROVIDERS, type AgentRelayApprovalPolicy } from '@/modules/agent-relay/agent-relay.types.js';
import type { LLMProvider } from '@/shared/types.js';

/** The built-in workflow ids are intentionally stable API identifiers. */
export type RelayWorkflowTemplateId =
  | 'investigate'
  | 'implement-test-review'
  | 'adversarial-review';

export type RelayWorkflowInputs = {
  objective: string;
  context?: string;
  acceptanceCriteria?: string[];
  provider?: LLMProvider;
  model?: string | null;
  effort?: string | null;
  approvalPolicy?: AgentRelayApprovalPolicy;
  timeoutMs?: number;
  retries?: number;
  mcpServers?: string[];
};

export type RelayWorkflowTemplate = {
  id: RelayWorkflowTemplateId;
  version: 1;
  name: string;
  description: string;
  inputs: {
    required: ['objective'];
    optional: string[];
  };
  taskLabels: readonly string[];
};

type EvidenceRecord = {
  claim: string;
  source: 'worker_report' | 'worker_test' | 'worker_observation';
  hostVerified: false;
};

const evidenceItemSchema = {
  type: 'object',
  required: ['claim', 'source', 'hostVerified'],
  properties: {
    claim: { type: 'string', minLength: 1 },
    source: { enum: ['worker_report', 'worker_test', 'worker_observation'] },
    // A worker may report a claim, but only the host can verify it later.
    hostVerified: { enum: [false] },
  },
  additionalProperties: false,
} as const;

const workflowOutputSchema = (kind: string) => ({
  type: 'object',
  required: ['outcome', 'summary', 'evidence'],
  properties: {
    outcome: { enum: ['success', 'blocked', 'failed'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: evidenceItemSchema },
    kind: { enum: [kind] },
  },
  additionalProperties: false,
});

const TEMPLATE_DEFINITIONS: readonly RelayWorkflowTemplate[] = [
  {
    id: 'investigate',
    version: 1,
    name: 'Investigate',
    description: 'Gather evidence in parallel-friendly investigation and synthesize a bounded finding.',
    inputs: {
      required: ['objective'],
      optional: ['context', 'acceptanceCriteria', 'provider', 'model', 'effort', 'approvalPolicy', 'timeoutMs', 'retries', 'mcpServers'],
    },
    taskLabels: ['investigate:collect', 'investigate:synthesize'],
  },
  {
    id: 'implement-test-review',
    version: 1,
    name: 'Implement, test, review',
    description: 'Implement a change, run focused tests, and review the resulting worktree.',
    inputs: {
      required: ['objective'],
      optional: ['context', 'acceptanceCriteria', 'provider', 'model', 'effort', 'approvalPolicy', 'timeoutMs', 'retries', 'mcpServers'],
    },
    taskLabels: ['implement:change', 'test:focused', 'review:implementation'],
  },
  {
    id: 'adversarial-review',
    version: 1,
    name: 'Adversarial review',
    description: 'Review a change, challenge the review with an independent pass, and consolidate evidence.',
    inputs: {
      required: ['objective'],
      optional: ['context', 'acceptanceCriteria', 'provider', 'model', 'effort', 'approvalPolicy', 'timeoutMs', 'retries', 'mcpServers'],
    },
    taskLabels: ['review:primary', 'review:adversarial', 'review:consolidate'],
  },
] as const;

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 8_000;
const MAX_ACCEPTANCE_CRITERIA = 20;
const MAX_CRITERION_CHARS = 1_000;
const MAX_MODEL_CHARS = 300;
const MAX_EFFORT_CHARS = 100;
const MAX_MCP_SERVERS = 30;
const MAX_MCP_SERVER_CHARS = 120;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_RETRIES = 2;
const MAX_TASK_CHARS = 12_000;

function cloneSchema<T>(schema: T): T {
  return JSON.parse(JSON.stringify(schema)) as T;
}

function nonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
  return result;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return nonEmptyString(value, field, maxLength);
}

function validateInputs(raw: RelayWorkflowInputs): Required<Pick<RelayWorkflowInputs, 'objective'>> & Omit<RelayWorkflowInputs, 'objective'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workflow inputs must be an object');
  const objective = nonEmptyString(raw.objective, 'objective', MAX_OBJECTIVE_CHARS);
  const context = optionalText(raw.context, 'context', MAX_CONTEXT_CHARS);
  if (raw.acceptanceCriteria !== undefined) {
    if (!Array.isArray(raw.acceptanceCriteria) || raw.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) {
      throw new Error(`acceptanceCriteria must contain at most ${MAX_ACCEPTANCE_CRITERIA} items`);
    }
  }
  const acceptanceCriteria = raw.acceptanceCriteria?.map((criterion, index) =>
    nonEmptyString(criterion, `acceptanceCriteria[${index}]`, MAX_CRITERION_CHARS));

  if (raw.provider !== undefined && !AGENT_RELAY_PROVIDERS.includes(raw.provider)) {
    throw new Error(`provider must be one of: ${AGENT_RELAY_PROVIDERS.join(', ')}`);
  }
  const model = optionalText(raw.model, 'model', MAX_MODEL_CHARS) ?? null;
  const effort = optionalText(raw.effort, 'effort', MAX_EFFORT_CHARS) ?? null;
  if (raw.approvalPolicy !== undefined && !['auto', 'manual'].includes(raw.approvalPolicy)) {
    throw new Error('approvalPolicy must be "auto" or "manual"');
  }
  if (raw.timeoutMs !== undefined && (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < MIN_TIMEOUT_MS || raw.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new Error(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  if (raw.retries !== undefined && (!Number.isInteger(raw.retries) || raw.retries < 0 || raw.retries > MAX_RETRIES)) {
    throw new Error(`retries must be an integer between 0 and ${MAX_RETRIES}`);
  }
  if (raw.mcpServers !== undefined) {
    if (!Array.isArray(raw.mcpServers) || raw.mcpServers.length > MAX_MCP_SERVERS) {
      throw new Error(`mcpServers must contain at most ${MAX_MCP_SERVERS} items`);
    }
    for (const [index, name] of raw.mcpServers.entries()) {
      nonEmptyString(name, `mcpServers[${index}]`, MAX_MCP_SERVER_CHARS);
    }
  }
  return {
    objective,
    ...(context === undefined ? {} : { context }),
    ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    ...(raw.provider === undefined ? {} : { provider: raw.provider }),
    model,
    effort,
    ...(raw.approvalPolicy === undefined ? {} : { approvalPolicy: raw.approvalPolicy }),
    ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
    ...(raw.retries === undefined ? {} : { retries: raw.retries }),
    ...(raw.mcpServers === undefined ? {} : { mcpServers: [...new Set(raw.mcpServers)] }),
  };
}

function brief(inputs: ReturnType<typeof validateInputs>): string {
  const parts = [`Objective:\n${inputs.objective}`];
  if (inputs.context) parts.push(`Context:\n${inputs.context}`);
  if (inputs.acceptanceCriteria?.length) {
    parts.push(`Acceptance criteria:\n${inputs.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

function makeTask(
  inputs: ReturnType<typeof validateInputs>,
  label: string,
  task: string,
  outputSchema: Record<string, unknown>,
  options: Pick<AgentRelayTaskInput, 'dependsOn' | 'mode'> = {},
): AgentRelayTaskInput {
  if (task.length > MAX_TASK_CHARS) throw new Error(`${label} task exceeds ${MAX_TASK_CHARS} characters`);
  return {
    task,
    label,
    ...(inputs.provider === undefined ? {} : { provider: inputs.provider }),
    ...(inputs.model === null ? {} : { model: inputs.model }),
    ...(inputs.effort === null ? {} : { effort: inputs.effort }),
    ...(inputs.approvalPolicy === undefined ? {} : { approvalPolicy: inputs.approvalPolicy }),
    ...(inputs.timeoutMs === undefined ? {} : { timeoutMs: inputs.timeoutMs }),
    ...(inputs.mcpServers === undefined ? {} : { mcpServers: [...inputs.mcpServers] }),
    ...(inputs.retries === undefined ? {} : { retries: inputs.retries }),
    mode: options.mode ?? 'read_only',
    outputSchema: cloneSchema(outputSchema),
    ...(options.dependsOn === undefined ? {} : { dependsOn: [...options.dependsOn] }),
  };
}

/** List immutable metadata for the three built-in, versioned workflows. */
export function listRelayTemplates(): RelayWorkflowTemplate[] {
  return TEMPLATE_DEFINITIONS.map((template) => ({
    ...template,
    inputs: { required: [...template.inputs.required] as ['objective'], optional: [...template.inputs.optional] },
    taskLabels: [...template.taskLabels],
  }));
}

/** Instantiate a template as a valid AgentRelayTaskInput DAG. */
export function instantiateRelayTemplate(
  id: RelayWorkflowTemplateId | string,
  rawInputs: RelayWorkflowInputs,
): AgentRelayTaskInput[] {
  const template = TEMPLATE_DEFINITIONS.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`unknown relay workflow template: ${id}`);
  const inputs = validateInputs(rawInputs);
  const context = brief(inputs);
  const evidenceInstruction = 'For every claim, include evidence objects with source and hostVerified:false; worker claims are never host-verified.';

  switch (template.id) {
    case 'investigate':
      return [
        makeTask(inputs, 'investigate:collect', `Investigate the objective below. Collect concrete repository or runtime evidence, identify unknowns, and do not make changes.\n\n${context}\n\n${evidenceInstruction}`, workflowOutputSchema('investigation'), { mode: 'read_only' }),
        makeTask(inputs, 'investigate:synthesize', `Synthesize the investigation prerequisite into a concise finding. Separate observed evidence from worker interpretation, call out blockers, and recommend next steps without changing files.\n\n${context}\n\n${evidenceInstruction}`, workflowOutputSchema('synthesis'), { dependsOn: [0], mode: 'read_only' }),
      ];
    case 'implement-test-review':
      return [
        makeTask(inputs, 'implement:change', `Implement the requested change in the isolated worktree. Keep the change scoped to the objective and report files changed plus evidence.\n\n${context}\n\n${evidenceInstruction}`, workflowOutputSchema('implementation'), { mode: 'isolated_write' }),
        makeTask(inputs, 'test:focused', `Run focused checks for the implementation prerequisite. Diagnose failures rather than hiding them, and report exact commands and observed results. Do not claim host verification beyond the checks actually run.\n\n${context}\n\n${evidenceInstruction}`, workflowOutputSchema('tests'), { dependsOn: [0], mode: 'isolated_write' }),
        makeTask(inputs, 'review:implementation', `Review the implementation and test prerequisites for correctness, scope, regressions, and missing coverage. Treat prerequisite worker claims as unverified unless independently observed.\n\n${context}\n\n${evidenceInstruction}`, workflowOutputSchema('review'), { dependsOn: [1], mode: 'read_only' }),
      ];
    case 'adversarial-review':
      return [
        makeTask(inputs, 'review:primary', `Perform a careful primary review of the objective. Find concrete correctness, security, compatibility, and testability issues, with evidence and severity. Do not change files.\n\n${context}\n\n${evidenceInstruction}`, workflowOutputSchema('primary-review'), { mode: 'read_only' }),
        makeTask(inputs, 'review:adversarial', `Adversarially challenge the primary review prerequisite. Try to refute its findings with independent evidence; if uncertain, mark the claim unresolved rather than host-verified. Do not change files.\n\n${context}\n\n${evidenceInstruction}`, workflowOutputSchema('adversarial-review'), { dependsOn: [0], mode: 'read_only' }),
        makeTask(inputs, 'review:consolidate', `Consolidate the primary and adversarial reviews. Distinguish confirmed observations, disputed worker claims, and unresolved questions; provide a bounded recommendation. Do not change files.\n\n${context}\n\n${evidenceInstruction}`, workflowOutputSchema('consolidated-review'), { dependsOn: [0, 1], mode: 'read_only' }),
      ];
  }
}

type RelayUsage = NonNullable<AgentRelayJobSummary['usage']>;
type RelayScorecardRecord = AgentRelayJob | AgentRelayJobSummary;

export type RelayScorecard = {
  totalJobs: number;
  outcomes: { success: number; blocked: number; failed: number };
  validationFailures: number;
  retries: { jobsRetried: number; totalRetryCount: number; totalSchemaRetryCount: number };
  durationMs: { median: number | null; known: number };
  cost: {
    coverage: { knownJobs: number; unknownJobs: number; ratio: number | null };
    knownTotalUsd: number | null;
    costPerKnownCostSuccessUsd: number | null;
  };
  providerBreakdown: Record<string, RelayScorecardBreakdown>;
  modelBreakdown: Record<string, RelayScorecardBreakdown>;
  evidence: {
    source: 'host_aggregated_relay_job_records';
    workerClaimsHostVerified: false;
    hostObservedFields: string[];
  };
};

export type RelayScorecardBreakdown = {
  jobs: number;
  success: number;
  blocked: number;
  failed: number;
  validationFailures: number;
  retries: number;
  knownCostJobs: number;
  knownCostTotalUsd: number | null;
};

function isSummary(job: RelayScorecardRecord): job is AgentRelayJobSummary {
  return 'relayId' in job;
}

function usageFor(job: RelayScorecardRecord): RelayUsage | null {
  return isSummary(job) ? job.usage : null;
}

function outcomeFor(job: RelayScorecardRecord): keyof RelayScorecard['outcomes'] {
  const resultStatus = job.result?.status;
  if (resultStatus === 'completed') return 'success';
  if (resultStatus === 'blocked') return 'blocked';
  if (resultStatus === 'failed') return 'failed';
  if (job.status === 'completed') return 'success';
  if (job.status === 'queued' || job.status === 'running' || job.status === 'waiting_approval') return 'blocked';
  return 'failed';
}

function durationMsFor(job: RelayScorecardRecord): number | null {
  const startedAt = isSummary(job) ? job.startedAt : job.started_at;
  const finishedAt = isSummary(job) ? job.finishedAt : job.finished_at;
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return null;
  return finish - start;
}

function breakdown(): RelayScorecardBreakdown {
  return { jobs: 0, success: 0, blocked: 0, failed: 0, validationFailures: 0, retries: 0, knownCostJobs: 0, knownCostTotalUsd: null };
}

function addBreakdown(target: RelayScorecardBreakdown, outcome: keyof RelayScorecard['outcomes'], validationFailure: boolean, retries: number, cost: number | null): void {
  target.jobs += 1;
  target[outcome] += 1;
  if (validationFailure) target.validationFailures += 1;
  target.retries += retries;
  if (cost !== null) {
    target.knownCostJobs += 1;
    target.knownCostTotalUsd = (target.knownCostTotalUsd ?? 0) + cost;
  }
}

function modelFor(job: RelayScorecardRecord): string {
  if (isSummary(job)) return job.runtimeResolvedModel ?? job.selectedModel ?? job.model ?? job.requestedModel ?? 'unknown';
  return job.runtime_resolved_model ?? job.model ?? job.requested_model ?? 'unknown';
}

/** Aggregate only durable relay records; null cost remains unknown, never zero. */
export function aggregateRelayScorecard(jobs: readonly RelayScorecardRecord[]): RelayScorecard {
  const outcomes = { success: 0, blocked: 0, failed: 0 };
  const durations: number[] = [];
  const providerBreakdown: Record<string, RelayScorecardBreakdown> = {};
  const modelBreakdown: Record<string, RelayScorecardBreakdown> = {};
  let validationFailures = 0;
  let jobsRetried = 0;
  let totalRetryCount = 0;
  let totalSchemaRetryCount = 0;
  let knownCostJobs = 0;
  let knownTotalUsd: number | null = null;
  let knownCostSuccesses = 0;
  let knownCostSuccessUsd = 0;

  for (const job of jobs) {
    const outcome = outcomeFor(job);
    outcomes[outcome] += 1;
    const validationFailure = job.result?.outputValidation?.valid === false;
    if (validationFailure) validationFailures += 1;
    const retryCount = isSummary(job) ? job.retryCount : job.retry_count;
    const schemaRetryCount = isSummary(job) ? 0 : job.schema_retry_count;
    if (retryCount > 0) jobsRetried += 1;
    totalRetryCount += retryCount;
    totalSchemaRetryCount += schemaRetryCount;
    const duration = durationMsFor(job);
    if (duration !== null) durations.push(duration);
    const usage = usageFor(job);
    const cost = typeof usage?.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : null;
    if (cost !== null) {
      knownCostJobs += 1;
      knownTotalUsd = (knownTotalUsd ?? 0) + cost;
      if (outcome === 'success') {
        knownCostSuccesses += 1;
        knownCostSuccessUsd += cost;
      }
    }
    const provider = job.provider;
    const model = modelFor(job);
    providerBreakdown[provider] ??= breakdown();
    modelBreakdown[model] ??= breakdown();
    addBreakdown(providerBreakdown[provider]!, outcome, validationFailure, retryCount, cost);
    addBreakdown(modelBreakdown[model]!, outcome, validationFailure, retryCount, cost);
  }

  durations.sort((left, right) => left - right);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length === 0
    ? null
    : durations.length % 2 === 1
      ? durations[middle]!
      : (durations[middle - 1]! + durations[middle]!) / 2;

  return {
    totalJobs: jobs.length,
    outcomes,
    validationFailures,
    retries: { jobsRetried, totalRetryCount, totalSchemaRetryCount },
    durationMs: { median, known: durations.length },
    cost: {
      coverage: {
        knownJobs: knownCostJobs,
        unknownJobs: jobs.length - knownCostJobs,
        ratio: jobs.length === 0 ? null : knownCostJobs / jobs.length,
      },
      knownTotalUsd: knownTotalUsd,
      costPerKnownCostSuccessUsd: knownCostSuccesses === 0 ? null : knownCostSuccessUsd / knownCostSuccesses,
    },
    providerBreakdown,
    modelBreakdown,
    evidence: {
      source: 'host_aggregated_relay_job_records',
      workerClaimsHostVerified: false,
      hostObservedFields: ['status', 'result.status', 'result.outputValidation', 'retry_count', 'schema_retry_count', 'started_at', 'finished_at', 'usage.costUsd'],
    },
  };
}

export type { EvidenceRecord };
