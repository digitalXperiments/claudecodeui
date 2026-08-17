import express from 'express';

import {
  EVAL_SUITE_SCOPES,
  EVAL_SUITE_TRIGGERS,
  type EvalSuiteScope,
  type EvalSuiteStatus,
  type EvalSuiteTrigger,
} from '@/modules/evals/evals.types.js';
import { evalsService, normalizeEvalSuiteDraft } from '@/modules/evals/evals.service.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();
const STATUSES: EvalSuiteStatus[] = ['draft', 'active', 'archived'];
const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'kilo', 'cline', 'grok', 'kimi', 'qwencode', 'pi'];

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const result = string(value);
  return result || undefined;
}

function scope(value: unknown): EvalSuiteScope {
  if (!EVAL_SUITE_SCOPES.includes(value as EvalSuiteScope)) {
    throw new AppError(`Invalid eval scope: ${String(value)}`, { code: 'EVAL_SCOPE_INVALID', statusCode: 400 });
  }
  return value as EvalSuiteScope;
}

function trigger(value: unknown): EvalSuiteTrigger {
  if (!EVAL_SUITE_TRIGGERS.includes(value as EvalSuiteTrigger)) {
    throw new AppError(`Invalid eval trigger: ${String(value)}`, { code: 'EVAL_TRIGGER_INVALID', statusCode: 400 });
  }
  return value as EvalSuiteTrigger;
}

router.get('/summary', asyncHandler(async (_req, res) => {
  res.json({ success: true, summary: evalsService.summary() });
}));

router.get('/suites', asyncHandler(async (req, res) => {
  const statusRaw = optionalString(req.query.status);
  const scopeRaw = optionalString(req.query.scope);
  if (statusRaw && !STATUSES.includes(statusRaw as EvalSuiteStatus)) {
    throw new AppError(`Invalid eval status: ${statusRaw}`, { code: 'EVAL_STATUS_INVALID', statusCode: 400 });
  }
  res.json({
    success: true,
    suites: evalsService.list({
      projectId: optionalString(req.query.projectId),
      status: statusRaw as EvalSuiteStatus | undefined,
      scope: scopeRaw ? scope(scopeRaw) : undefined,
    }),
  });
}));

router.get('/suites/:suiteId', asyncHandler(async (req, res) => {
  const suite = evalsService.get(string(req.params.suiteId));
  if (!suite) throw new AppError('Eval suite not found.', { code: 'EVAL_SUITE_NOT_FOUND', statusCode: 404 });
  res.json({ success: true, suite });
}));

router.post('/suites', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const objective = string(body.objective) || string((body.suite as Record<string, unknown> | undefined)?.objective);
  const selectedScope = scope(body.scope ?? (body.suite as Record<string, unknown> | undefined)?.scope);
  const draft = normalizeEvalSuiteDraft(body, { objective, scope: selectedScope });
  const suite = evalsService.create({
    ...draft,
    projectId: optionalString(body.projectId) ?? null,
    status: 'draft',
    source: 'manual',
  });
  res.status(201).json({ success: true, suite });
}));

router.put('/suites/:suiteId', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof evalsService.update>[1] = {};
  if (body.name !== undefined) patch.name = string(body.name);
  if (body.description !== undefined) patch.description = string(body.description);
  if (body.objective !== undefined) patch.objective = string(body.objective);
  if (body.scope !== undefined) patch.scope = scope(body.scope);
  if (body.trigger !== undefined) patch.trigger = trigger(body.trigger);
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as EvalSuiteStatus)) {
      throw new AppError(`Invalid eval status: ${String(body.status)}`, { code: 'EVAL_STATUS_INVALID', statusCode: 400 });
    }
    patch.status = body.status as EvalSuiteStatus;
  }
  if (body.actionPolicy && typeof body.actionPolicy === 'object') {
    const current = evalsService.get(string(req.params.suiteId));
    if (!current) throw new AppError('Eval suite not found.', { code: 'EVAL_SUITE_NOT_FOUND', statusCode: 404 });
    patch.action_policy = { ...current.action_policy, ...body.actionPolicy as Record<string, unknown> } as typeof current.action_policy;
  }
  if (body.tags !== undefined) {
    patch.tags = Array.isArray(body.tags) ? body.tags.filter((item): item is string => typeof item === 'string') : [];
  }
  const suite = evalsService.update(string(req.params.suiteId), patch);
  if (!suite) throw new AppError('Eval suite not found.', { code: 'EVAL_SUITE_NOT_FOUND', statusCode: 404 });
  res.json({ success: true, suite });
}));

router.delete('/suites/:suiteId', asyncHandler(async (req, res) => {
  if (!evalsService.delete(string(req.params.suiteId))) {
    throw new AppError('Eval suite not found.', { code: 'EVAL_SUITE_NOT_FOUND', statusCode: 404 });
  }
  res.json({ success: true });
}));

router.post('/generate', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const provider = string(body.provider) as LLMProvider;
  if (!PROVIDERS.includes(provider)) {
    throw new AppError(`Invalid provider: ${provider || '(empty)'}`, { code: 'EVAL_PROVIDER_INVALID', statusCode: 400 });
  }
  const suite = await evalsService.generate({
    provider,
    model: optionalString(body.model) ?? null,
    projectId: optionalString(body.projectId) ?? null,
    objective: string(body.objective),
    scope: scope(body.scope),
    trigger: body.trigger ? trigger(body.trigger) : undefined,
    caseCount: typeof body.caseCount === 'number' ? body.caseCount : Number(body.caseCount),
    constraints: optionalString(body.constraints),
  });
  res.status(201).json({ success: true, suite });
}));

export default router;
