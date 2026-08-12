import express from 'express';

import { swarmService } from '@/modules/swarm/swarm.service.js';
import type { SwarmAgentSpec, SwarmRoleConfig } from '@/modules/swarm/swarm.types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';
import { CloudError } from '@/shared/run-events.js';

const router = express.Router();

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function optionalString(value: unknown): string | undefined {
  const v = stringValue(value);
  return v || undefined;
}

function mapError(error: unknown): never {
  if (error instanceof CloudError) {
    const statusCode = error.message.includes('not found') ? 404 : 400;
    throw new AppError(error.message, { code: error.code, statusCode });
  }
  throw error;
}

function parseAgents(body: Record<string, unknown>): SwarmAgentSpec[] | undefined {
  if (Array.isArray(body.agents) && body.agents.length > 0) {
    return body.agents as SwarmAgentSpec[];
  }
  if (Array.isArray(body.roles) && body.roles.length > 0) {
    return (body.roles as SwarmRoleConfig[]).map((r) => ({
      id: r.id,
      kind: (r.kind || r.role || 'custom') as string,
      label: r.label || String(r.kind || r.role || 'Agent'),
      provider: r.provider,
      model: r.model,
      effort: r.effort,
      permissionMode: r.permissionMode,
      skills: r.skills,
      focus: r.focus,
    }));
  }
  return undefined;
}

router.get(
  '/swarm',
  asyncHandler(async (req, res) => {
    const projectId = optionalString(req.query.projectId);
    const limitRaw = optionalString(req.query.limit);
    const limit = limitRaw ? Math.min(200, Math.max(1, Number(limitRaw) || 50)) : 50;
    const archivedOnly = req.query.archivedOnly === 'true' || req.query.archivedOnly === '1';
    const includeArchived =
      archivedOnly ||
      req.query.includeArchived === 'true' ||
      req.query.includeArchived === '1';
    // Global list when projectId omitted — Agent Swarm is a first-class surface.
    res.json({
      success: true,
      swarms: swarmService.list(projectId ?? null, limit, {
        includeArchived,
        archivedOnly,
      }),
    });
  }),
);

router.get(
  '/swarm/defaults',
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      roster: swarmService.defaultRoster(),
      kinds: ['orchestrator', 'explorer', 'implementer', 'reviewer', 'tester', 'security', 'docs', 'custom'],
    });
  }),
);

router.post(
  '/swarm',
  asyncHandler(async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const projectId = stringValue(body.projectId);
      const goal = stringValue(body.goal);
      const agents = parseAgents(body);
      const skills = Array.isArray(body.skills)
        ? body.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : undefined;
      const orchestrator =
        body.orchestrator && typeof body.orchestrator === 'object'
          ? (body.orchestrator as SwarmAgentSpec)
          : undefined;

      const swarm = swarmService.start({
        projectId,
        goal,
        agents,
        orchestrator,
        roles: Array.isArray(body.roles) ? (body.roles as SwarmRoleConfig[]) : undefined,
        skills,
        requireApproval: body.requireApproval === true,
        requirePlanApproval: body.requirePlanApproval === true,
        // Orchestrator staffs worker seats from swarm-tagged agent profiles.
        autoRoster:
          body.autoRoster === true ? true : body.autoRoster === false ? false : undefined,
        // Pre-PR stability gate defaults ON; only an explicit false opts out.
        validateBeforePr: body.validateBeforePr === false ? false : undefined,
        // Validation attempt budget (initial run + remediation re-runs).
        validationMaxAttempts:
          typeof body.validationMaxAttempts === 'number' && body.validationMaxAttempts > 0
            ? body.validationMaxAttempts
            : typeof body.validationMaxAttempts === 'string' && Number(body.validationMaxAttempts) > 0
              ? Number(body.validationMaxAttempts)
              : undefined,
        // Red gate still publishes the PR + report unless explicitly opted out.
        prOnRedValidation: body.prOnRedValidation === false ? false : undefined,
        stepTimeoutMs:
          typeof body.stepTimeoutMs === 'number' && body.stepTimeoutMs > 0
            ? body.stepTimeoutMs
            : typeof body.stepTimeoutMs === 'string' && Number(body.stepTimeoutMs) > 0
              ? Number(body.stepTimeoutMs)
              : undefined,
        stallTimeoutMs:
          typeof body.stallTimeoutMs === 'number' && body.stallTimeoutMs > 0
            ? body.stallTimeoutMs
            : typeof body.stallTimeoutMs === 'string' && Number(body.stallTimeoutMs) > 0
              ? Number(body.stallTimeoutMs)
              : undefined,
        stepMaxAttempts:
          typeof body.stepMaxAttempts === 'number' && body.stepMaxAttempts > 0
            ? body.stepMaxAttempts
            : typeof body.stepMaxAttempts === 'string' && Number(body.stepMaxAttempts) > 0
              ? Number(body.stepMaxAttempts)
              : undefined,
        maxConcurrency:
          typeof body.maxConcurrency === 'number' && body.maxConcurrency > 0
            ? body.maxConcurrency
            : typeof body.maxConcurrency === 'string' && Number(body.maxConcurrency) > 0
              ? Number(body.maxConcurrency)
              : undefined,
        parallelWriters: body.parallelWriters === true,
        provider: optionalString(body.provider) ?? null,
        model: optionalString(body.model) ?? null,
        effort: optionalString(body.effort) ?? null,
        permissionMode: optionalString(body.permissionMode) ?? null,
        idempotencyKey:
          optionalString(req.header('Idempotency-Key')) ?? optionalString(body.idempotencyKey) ?? null,
      });
      res.status(201).json({ success: true, swarm });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.get(
  '/swarm/:swarmId/artifacts',
  asyncHandler(async (req, res) => {
    const swarmId = stringValue(req.params.swarmId);
    const swarm = swarmService.get(swarmId);
    if (!swarm) throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    res.json({ success: true, artifacts: swarm.artifacts ?? [] });
  }),
);

router.get(
  '/swarm/:swarmId',
  asyncHandler(async (req, res) => {
    const swarm = swarmService.get(stringValue(req.params.swarmId));
    if (!swarm) throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    res.json({ success: true, swarm });
  }),
);

// Pre-PR validation report (PDF preferred, HTML fallback) written by the
// stability gate under the primary project's tmp/cloudcli/swarm-reports/.
router.get(
  '/swarm/:swarmId/report',
  asyncHandler(async (req, res) => {
    const swarmId = stringValue(req.params.swarmId);
    const report = swarmService.validationReport(swarmId);
    if (!report)
      throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    const file = report.pdfPath ?? report.htmlPath;
    if (!file)
      throw new AppError('No validation report has been generated for this swarm', {
        code: 'SWARM_REPORT_NOT_FOUND',
        statusCode: 404,
      });
    res.sendFile(file);
  }),
);

// Small JSON summary of the validation gate (check statuses, artifact paths).
router.get(
  '/swarm/:swarmId/report/summary',
  asyncHandler(async (req, res) => {
    const swarmId = stringValue(req.params.swarmId);
    const report = swarmService.validationReport(swarmId);
    if (!report)
      throw new AppError('Swarm not found', { code: 'SWARM_NOT_FOUND', statusCode: 404 });
    if (!report.summaryPath)
      throw new AppError('No validation summary has been generated for this swarm', {
        code: 'SWARM_REPORT_NOT_FOUND',
        statusCode: 404,
      });
    res.sendFile(report.summaryPath);
  }),
);

router.post(
  '/swarm/:swarmId/complete-member',
  asyncHandler(async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const memberId = stringValue(body.memberId);
      const findings = stringValue(body.findingsSummary ?? body.findings);
      if (!memberId || !findings)
        throw new AppError('memberId and findingsSummary are required', {
          code: 'SWARM_INVALID',
          statusCode: 400,
        });
      const swarm = swarmService.completeMember(
        stringValue(req.params.swarmId),
        memberId,
        findings,
      );
      res.json({ success: true, swarm });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/swarm/:swarmId/synthesize',
  asyncHandler(async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const swarm = await swarmService.synthesize(
        stringValue(req.params.swarmId),
        body.requireApproval === true ? true : undefined,
      );
      res.json({ success: true, swarm });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/swarm/:swarmId/approve',
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        swarm: swarmService.approve(stringValue(req.params.swarmId)),
      });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/swarm/:swarmId/reject',
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        swarm: swarmService.reject(stringValue(req.params.swarmId)),
      });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/swarm/:swarmId/approve-plan',
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        swarm: swarmService.approvePlan(stringValue(req.params.swarmId)),
      });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/swarm/:swarmId/reject-plan',
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        swarm: swarmService.rejectPlan(stringValue(req.params.swarmId)),
      });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/swarm/:swarmId/abort',
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        swarm: await swarmService.abort(stringValue(req.params.swarmId)),
      });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/swarm/:swarmId/retry-step',
  asyncHandler(async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const stepId = stringValue(body.stepId);
      if (!stepId)
        throw new AppError('stepId is required', { code: 'SWARM_INVALID', statusCode: 400 });
      res.json({
        success: true,
        swarm: await swarmService.retryStep(stringValue(req.params.swarmId), stepId),
      });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.post(
  '/swarm/:swarmId/archive',
  asyncHandler(async (req, res) => {
    try {
      const restore = (req.body as { restore?: boolean } | undefined)?.restore === true;
      const swarm = restore
        ? swarmService.unarchive(stringValue(req.params.swarmId))
        : swarmService.archive(stringValue(req.params.swarmId));
      res.json({ success: true, swarm });
    } catch (error) {
      mapError(error);
    }
  }),
);

router.delete(
  '/swarm/:swarmId',
  asyncHandler(async (req, res) => {
    try {
      swarmService.delete(stringValue(req.params.swarmId));
      res.json({ success: true });
    } catch (error) {
      mapError(error);
    }
  }),
);

export default router;
