import express from 'express';

import { agentRelayService } from '@/modules/agent-relay/agent-relay.service.js';
import {
  AGENT_RELAY_PROVIDERS,
  type AgentRelayApproval,
  type AgentRelayApprovalPolicy,
  type AgentRelayMode,
  type AgentRelayScope,
  type AgentRelaySettingsPatch,
  type AgentRelayTaskInput,
  type AgentRelayWorkerProfile,
} from '@/modules/agent-relay/agent-relay.types.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

export const agentRelayRoutes = express.Router();
export const agentRelayMcpRoutes = express.Router();

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) throw new AppError(`${name} is required.`, { code: 'RELAY_PARAMETER_REQUIRED', statusCode: 400 });
  return result;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function provider(value: unknown): LLMProvider | undefined {
  const result = optionalString(value)?.toLowerCase() as LLMProvider | undefined;
  if (!result) return undefined;
  if (!AGENT_RELAY_PROVIDERS.includes(result)) {
    throw new AppError(`Unsupported provider "${result}".`, { code: 'RELAY_PROVIDER_INVALID', statusCode: 400 });
  }
  return result;
}

function providers(value: unknown): LLMProvider[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AppError('Provider selection must be an array.', { code: 'RELAY_PROVIDERS_INVALID', statusCode: 400 });
  return value.map(provider).filter((entry): entry is LLMProvider => Boolean(entry));
}

function mode(value: unknown): AgentRelayMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'read_only' || value === 'isolated_write') return value;
  throw new AppError('mode must be read_only or isolated_write.', { code: 'RELAY_MODE_INVALID', statusCode: 400 });
}

function approvalPolicy(value: unknown): AgentRelayApprovalPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'manual') return value;
  throw new AppError('approvalPolicy must be auto or manual.', { code: 'RELAY_APPROVAL_POLICY_INVALID', statusCode: 400 });
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AppError('Expected an array of strings.', { code: 'RELAY_LIST_INVALID', statusCode: 400 });
  return value.map((entry, index) => requiredString(entry, `items[${index}]`));
}

function allowedWorkerModels(value: unknown): Partial<Record<LLMProvider, string[]>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('allowedWorkerModels must be an object of provider to model ids.', {
      code: 'RELAY_ALLOWED_MODELS_INVALID',
      statusCode: 400,
    });
  }
  const out: Partial<Record<LLMProvider, string[]>> = {};
  for (const [key, models] of Object.entries(value as Record<string, unknown>)) {
    const parsed = provider(key);
    if (!parsed) continue;
    out[parsed] = [...new Set(stringList(models) ?? [])];
  }
  return out;
}

function workerProfiles(value: unknown): Partial<Record<LLMProvider, AgentRelayWorkerProfile>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('workerProfiles must be an object of provider to profile.', {
      code: 'RELAY_WORKER_PROFILES_INVALID',
      statusCode: 400,
    });
  }
  const out: Partial<Record<LLMProvider, AgentRelayWorkerProfile>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = provider(key);
    if (!parsed) continue;
    if (raw === null) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AppError(`workerProfiles.${parsed} must be an object.`, {
        code: 'RELAY_WORKER_PROFILES_INVALID',
        statusCode: 400,
      });
    }
    const record = raw as Record<string, unknown>;
    const profile: AgentRelayWorkerProfile = {};
    if (record.mcpServers !== undefined) profile.mcpServers = stringList(record.mcpServers) ?? [];
    if (record.defaultMode === null) profile.defaultMode = null;
    else if (record.defaultMode !== undefined) profile.defaultMode = mode(record.defaultMode) ?? null;
    if (record.defaultApprovalPolicy === null) profile.defaultApprovalPolicy = null;
    else if (record.defaultApprovalPolicy !== undefined) {
      profile.defaultApprovalPolicy = approvalPolicy(record.defaultApprovalPolicy) ?? null;
    }
    out[parsed] = profile;
  }
  return out;
}

function optionalIndexList(value: unknown, name: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AppError(`${name} must be an array of task indices.`, { code: 'RELAY_DEPENDS_ON_INVALID', statusCode: 400 });
  return value.map((entry) => {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) {
      throw new AppError(`${name} must contain non-negative integer task indices.`, { code: 'RELAY_DEPENDS_ON_INVALID', statusCode: 400 });
    }
    return entry;
  });
}

function optionalSchema(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(`${name} must be a JSON Schema object.`, { code: 'RELAY_OUTPUT_SCHEMA_INVALID', statusCode: 400 });
  }
  return value as Record<string, unknown>;
}

function parseTasks(value: unknown): AgentRelayTaskInput[] {
  if (!Array.isArray(value)) throw new AppError('tasks must be an array.', { code: 'RELAY_TASKS_INVALID', statusCode: 400 });
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new AppError(`tasks[${index}] must be an object.`, { code: 'RELAY_TASK_INVALID', statusCode: 400 });
    const task = entry as Record<string, unknown>;
    return {
      task: requiredString(task.task, `tasks[${index}].task`),
      label: optionalString(task.label) ?? null,
      provider: provider(task.provider),
      model: optionalString(task.model) ?? null,
      effort: optionalString(task.effort) ?? null,
      mode: mode(task.mode),
      approvalPolicy: approvalPolicy(task.approvalPolicy),
      timeoutMs: optionalNumber(task.timeoutMs),
      mcpServers: stringList(task.mcpServers),
      outputSchema: optionalSchema(task.outputSchema, `tasks[${index}].outputSchema`),
      dependsOn: optionalIndexList(task.dependsOn, `tasks[${index}].dependsOn`),
      retries: optionalNumber(task.retries),
    };
  });
}

function approvalIdParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const approvalId = requiredString(raw, 'approvalId');
  if (!/^rappr_[A-Z0-9]{26}$/i.test(approvalId)) throw new AppError('Invalid approval id.', { code: 'RELAY_APPROVAL_ID_INVALID', statusCode: 400 });
  return approvalId;
}

function relayIdParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const relayId = requiredString(raw, 'relayId');
  if (!/^relay_[A-Z0-9]{26}$/i.test(relayId)) throw new AppError('Invalid relay id.', { code: 'RELAY_ID_INVALID', statusCode: 400 });
  return relayId;
}

/** Keep approval interrupts actionable without echoing multi-kilobyte commands into the lead context. */
function compactApproval(approval: AgentRelayApproval) {
  const truncate = (value: string | null, limit: number) => value && value.length > limit ? `${value.slice(0, limit)}…` : value;
  return {
    ...approval,
    command: truncate(approval.command, 800),
    reason: truncate(approval.reason, 400) ?? approval.reason,
    paths: approval.paths.slice(0, 8),
    pathsTruncated: Math.max(0, approval.paths.length - 8),
  };
}

agentRelayRoutes.get('/settings', (_req, res) => {
  res.json(createApiSuccessResponse({ settings: agentRelayService.getSettings() }));
});

agentRelayRoutes.put('/settings', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: AgentRelaySettingsPatch = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    leadProviders: providers(body.leadProviders),
    workerProviders: providers(body.workerProviders),
    allowedWorkerModels: allowedWorkerModels(body.allowedWorkerModels),
    workerProfiles: workerProfiles(body.workerProfiles),
    maxConcurrency: optionalNumber(body.maxConcurrency),
    defaultTimeoutMs: optionalNumber(body.defaultTimeoutMs),
    defaultMode: mode(body.defaultMode),
    defaultApprovalPolicy: approvalPolicy(body.defaultApprovalPolicy),
    installSkill: typeof body.installSkill === 'boolean' ? body.installSkill : undefined,
    approvalTimeoutMs: optionalNumber(body.approvalTimeoutMs),
  };
  const settings = await agentRelayService.updateSettings(patch);
  res.json(createApiSuccessResponse({ settings }));
}));

agentRelayRoutes.post('/sync', asyncHandler(async (_req, res) => {
  res.json(createApiSuccessResponse(await agentRelayService.syncIntegrations()));
}));

agentRelayRoutes.get('/status', asyncHandler(async (_req, res) => {
  res.json(createApiSuccessResponse({ status: await agentRelayService.getStatus() }));
}));

agentRelayRoutes.get('/capabilities', asyncHandler(async (_req, res) => {
  res.json(createApiSuccessResponse({ capabilities: await agentRelayService.getCapabilities() }));
}));

agentRelayRoutes.post('/delegate', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await agentRelayService.submitBatch({
    projectPath: requiredString(body.projectPath, 'projectPath'),
    sourceSessionId: optionalString(body.sourceSessionId) ?? null,
    tasks: parseTasks(body.tasks),
  });
  res.status(202).json(createApiSuccessResponse(result));
}));

agentRelayRoutes.get('/jobs', (req, res) => {
  // The panel is an operator surface: it may scope to one lead session
  // (the default, so a chat only shows its own workers) or ask for the whole
  // project explicitly.
  const jobs = agentRelayService.list({
    projectId: optionalString(req.query.projectId),
    batchId: optionalString(req.query.batchId),
    // `sessionId` is relevance, not strict ownership: a lead sees what it
    // dispatched, and a worker's transcript shows its own job plus the rest of
    // its batch, so opening one of three workers is not an empty panel.
    relevantToSessionId: optionalString(req.query.sessionId),
    active: req.query.active === 'true' ? true : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  const queuePositions = agentRelayService.queuePositions();
  res.json(createApiSuccessResponse({
    jobs: jobs.map((job) => ({
      ...job,
      queue_position: job.status === 'queued' ? (queuePositions.get(job.relay_id) ?? null) : null,
      usage: agentRelayService.summarize(job).usage,
    })),
  }));
});

agentRelayRoutes.get('/approvals', (req, res) => {
  const sessionId = optionalString(req.query.sessionId);
  const approvals = agentRelayService.listApprovals({
    relayId: optionalString(req.query.relayId) ? relayIdParam(req.query.relayId) : undefined,
    status: req.query.status === 'pending' ? 'pending' : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    scope: sessionId ? { sourceSessionId: sessionId } : { allowUnscoped: true },
  });
  res.json(createApiSuccessResponse({ approvals }));
});

agentRelayRoutes.post('/approvals/:approvalId/decide', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.allow !== 'boolean') {
    throw new AppError('allow must be a boolean.', { code: 'RELAY_APPROVAL_DECISION_INVALID', statusCode: 400 });
  }
  const approval = agentRelayService.decideApproval(approvalIdParam(req.params.approvalId), {
    allow: body.allow,
    reason: optionalString(body.reason) ?? null,
    decidedBy: 'operator',
    scope: { allowUnscoped: true },
  });
  res.json(createApiSuccessResponse({ approval }));
}));

agentRelayRoutes.get('/jobs/:relayId', (req, res) => {
  const relayId = relayIdParam(req.params.relayId);
  const job = agentRelayService.get(relayId);
  if (!job) throw new AppError('Relay job not found.', { code: 'RELAY_NOT_FOUND', statusCode: 404 });
  res.json(createApiSuccessResponse({
    job: {
      ...job,
      queue_position: job.status === 'queued' ? (agentRelayService.queuePositions().get(job.relay_id) ?? null) : null,
      usage: agentRelayService.summarize(job).usage,
    },
  }));
});

agentRelayRoutes.post('/jobs/:relayId/cancel', asyncHandler(async (req, res) => {
  const job = await agentRelayService.cancel(relayIdParam(req.params.relayId), { allowUnscoped: true });
  res.json(createApiSuccessResponse({ job }));
}));

agentRelayRoutes.post('/jobs/:relayId/follow-up', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const job = await agentRelayService.followUp(
    relayIdParam(req.params.relayId),
    requiredString(body.prompt, 'prompt'),
    optionalNumber(body.timeoutMs),
    { allowUnscoped: true },
  );
  res.status(202).json(createApiSuccessResponse({ job }));
}));

agentRelayRoutes.get('/jobs/:relayId/peek', (req, res) => {
  const peek = agentRelayService.peek(relayIdParam(req.params.relayId), {
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    scope: { allowUnscoped: true },
  });
  res.json(createApiSuccessResponse({ peek }));
});

agentRelayRoutes.get('/jobs/:relayId/diff', asyncHandler(async (req, res) => {
  const result = await agentRelayService.diff(
    relayIdParam(req.params.relayId),
    req.query.includePatch === 'true',
    { allowUnscoped: true },
  );
  res.json(createApiSuccessResponse({ diff: result }));
}));

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim() ?? null;
}

agentRelayMcpRoutes.use((req, res, next) => {
  const supplied = readBearerToken(req.headers.authorization) || optionalString(req.headers['x-agent-relay-token']);
  if (!supplied || !agentRelayService.mcpTokenMatches(supplied)) {
    res.status(401).json({ success: false, error: 'Invalid Agent Relay MCP token.' });
    return;
  }
  next();
});

/**
 * The calling lead's identity. The relay MCP process inherits
 * `CLOUDCLI_LEAD_SESSION_ID` from the provider run that launched it and sends
 * it on every call, which is what scopes each chat to its own workers.
 *
 * A caller that cannot prove an identity gets an empty scope, so it sees
 * nothing rather than everything.
 */
function mcpScope(input: Record<string, unknown>): AgentRelayScope {
  return { sourceSessionId: optionalString(input.sourceSessionId) ?? null };
}

function requireMcpScope(input: Record<string, unknown>): AgentRelayScope {
  const scope = mcpScope(input);
  if (!scope.sourceSessionId) {
    throw new AppError(
      'This Agent Relay call could not be attributed to a CloudCLI chat session. Restart the chat so the relay MCP picks up its session id.',
      { code: 'RELAY_SOURCE_SESSION_REQUIRED', statusCode: 400 },
    );
  }
  return scope;
}

agentRelayMcpRoutes.post('/tools/:toolName', asyncHandler(async (req, res) => {
  const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  let data: unknown;
  switch (req.params.toolName) {
    case 'relay_delegate': {
      const scope = requireMcpScope(input);
      const result = await agentRelayService.submitBatch({
        projectPath: optionalString(input.projectPath) ?? process.cwd(),
        sourceSessionId: scope.sourceSessionId ?? null,
        tasks: parseTasks(input.tasks),
      });
      data = { batchId: result.batchId, jobs: result.jobs.map((job) => agentRelayService.summarize(job)) };
      break;
    }
    case 'relay_status': {
      const scope = mcpScope(input);
      const ids = stringList(input.relayIds) ?? (optionalString(input.relayId) ? [requiredString(input.relayId, 'relayId')] : []);
      // With no ids, report every relay this lead owns — that is how a lead
      // reconnects to its own fleet without remembering ids.
      const jobs = ids.length > 0
        ? ids.map((id) => agentRelayService.getForScope(id, scope)).filter((job): job is NonNullable<typeof job> => Boolean(job))
        : agentRelayService.list({ sourceSessionId: scope.sourceSessionId ?? '__unowned__', limit: 50 });
      data = {
        jobs: jobs.map((job) => agentRelayService.summarize(job)),
        pendingApprovals: agentRelayService.listApprovals({ scope, status: 'pending', limit: 50 }).map(compactApproval),
      };
      break;
    }
    case 'relay_wait': {
      const waited = await agentRelayService.wait(stringList(input.relayIds) ?? [], {
        returnWhen: input.returnWhen === 'all' ? 'all' : 'any',
        timeoutMs: optionalNumber(input.timeoutMs),
        scope: requireMcpScope(input),
      });
      data = {
        timedOut: waited.timedOut,
        jobs: waited.jobs.map((job) => agentRelayService.summarize(job)),
        pendingApprovals: waited.pendingApprovals.map(compactApproval),
      };
      break;
    }
    case 'relay_result':
      data = agentRelayService.getResult(requiredString(input.relayId, 'relayId'), {
        includeOutput: input.includeOutput !== false,
        scope: requireMcpScope(input),
      });
      break;
    case 'relay_follow_up':
      data = { job: agentRelayService.summarize(await agentRelayService.followUp(
        requiredString(input.relayId, 'relayId'),
        requiredString(input.prompt, 'prompt'),
        optionalNumber(input.timeoutMs),
        requireMcpScope(input),
      )) };
      break;
    case 'relay_cancel':
      data = { job: agentRelayService.summarize(await agentRelayService.cancel(requiredString(input.relayId, 'relayId'), requireMcpScope(input))) };
      break;
    case 'relay_diff':
      data = { diff: await agentRelayService.diff(
        requiredString(input.relayId, 'relayId'),
        input.includePatch === true,
        requireMcpScope(input),
      ) };
      break;
    case 'relay_peek': {
      const relayId = requiredString(input.relayId, 'relayId');
      const scope = requireMcpScope(input);
      const peek = agentRelayService.peek(relayId, {
        limit: optionalNumber(input.limit),
        scope,
      });
      const job = agentRelayService.getForScope(relayId, scope);
      data = {
        ...peek,
        task: peek.task.length > 400 ? `${peek.task.slice(0, 400)}…` : peek.task,
        result: job ? agentRelayService.summarize(job).result : null,
        pendingApprovals: peek.pendingApprovals.map(compactApproval),
      };
      break;
    }
    case 'relay_pending_approvals':
      data = {
        approvals: agentRelayService.listApprovals({
          relayId: optionalString(input.relayId),
          scope: mcpScope(input),
          status: 'pending',
          limit: 50,
        }).map(compactApproval),
      };
      break;
    case 'relay_approve':
    case 'relay_deny':
      data = {
        approval: agentRelayService.decideApproval(requiredString(input.approvalId, 'approvalId'), {
          allow: req.params.toolName === 'relay_approve',
          reason: optionalString(input.reason) ?? null,
          decidedBy: 'lead',
          scope: requireMcpScope(input),
        }),
      };
      break;
    case 'relay_capabilities':
      data = await agentRelayService.getCapabilities();
      break;
    default:
      throw new AppError(`Unknown Agent Relay tool "${req.params.toolName}".`, { code: 'RELAY_TOOL_NOT_FOUND', statusCode: 404 });
  }
  res.json({ success: true, data });
}));

export default agentRelayRoutes;
